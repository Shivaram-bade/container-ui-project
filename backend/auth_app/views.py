from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework import status
from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from django.contrib.auth.hashers import check_password, make_password
from django.utils import timezone
from rest_framework.authtoken.models import Token
import jwt
import json
import base64
import binascii
from datetime import datetime, timedelta
from django.conf import settings
from django.core import signing
import os
import posixpath
import platform
import re
import select
import signal
import shlex
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from functools import wraps
from pathlib import Path
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

from .models import (
    Agent, AgentCommand, Deployment, DeploymentJob, RBACGroup, RecycledContainer, RegistryImage,
    UserProfile, LoginHistory
)
from .serializers import (
    RegisterSerializer, LoginSerializer, UserSerializer,
    LoginHistorySerializer, AgentSerializer, DeploymentJobSerializer, RecycledContainerSerializer, RegistryImageSerializer
)
from .deployment_service import create_deployment_job, mark_deployment_job_complete, mark_deployment_job_running
from .registry_service import (
    RegistryClientError, build_registry_reference, get_default_registry_push_host,
    sync_registry_images, list_registry_tags,
)
import pty
import fcntl
import struct
import termios

BUILD_JOBS = {}
BUILD_JOBS_LOCK = threading.Lock()

DEPLOY_JOBS = {}
DEPLOY_JOBS_LOCK = threading.Lock()

CONTAINER_SHELLS = {}
CONTAINER_SHELLS_LOCK = threading.Lock()

RECYCLED_CONTAINER_SNAPSHOT_KEY = '_vitel_recycle_snapshot'
VOLUME_HELPER_IMAGE = 'alpine:latest'

TERMINAL_CONTROL_SEQUENCE_RE = re.compile(
    r'\x1B(?:'
    r'\][^\x07]*(?:\x07|\x1B\\)|'
    r'\[[0-?]*[ -/]*[@-~]|'
    r'[@-Z\\-_]'
    r')'
)

ADMINISTRATOR_OPERATION = 'administrator'

OPERATION_PERMISSIONS = [
    {"code": ADMINISTRATOR_OPERATION, "label": "Administrator - full access", "category": "Administration"},
    {"code": "create_rbac_user", "label": "Create new user", "category": "Administration"},
    {"code": "create_rbac_group", "label": "Create new group", "category": "Administration"},
    {"code": "change_password", "label": "Change password", "category": "Account"},
    {"code": "view_server_info", "label": "Server health", "category": "Monitoring"},
    {"code": "view_monitoring", "label": "Container monitoring", "category": "Monitoring"},
    {"code": "view_running_containers", "label": "Running containers", "category": "Containers"},
    {"code": "view_stopped_containers", "label": "Stopped containers", "category": "Containers"},
    {"code": "view_recycle_bin", "label": "Container recycle bin", "category": "Containers"},
    {"code": "create_container", "label": "Create container", "category": "Containers"},
    {"code": "delete_container", "label": "Delete container", "category": "Containers"},
    {"code": "connect_container", "label": "Connect to container", "category": "Containers"},
    {"code": "view_images", "label": "Existing images", "category": "Images"},
    {"code": "build_images", "label": "Build images", "category": "Images"},
    {"code": "delete_images", "label": "Delete images", "category": "Images"},
    {"code": "view_networks", "label": "Existing networks", "category": "Networks"},
    {"code": "create_network", "label": "Create network", "category": "Networks"},
    {"code": "delete_network", "label": "Delete network", "category": "Networks"},
    {"code": "view_volumes", "label": "Existing volumes", "category": "Volumes"},
    {"code": "create_volume", "label": "Create volume", "category": "Volumes"},
    {"code": "delete_volume", "label": "Delete volume", "category": "Volumes"},
    {"code": "view_deployments", "label": "Existing deployments", "category": "Deployments"},
    {"code": "create_deployment", "label": "Create deployment", "category": "Deployments"},
    {"code": "delete_deployment", "label": "Delete deployment", "category": "Deployments"},
    {"code": "registry_deploy", "label": "Registry deploy", "category": "Deployments"},
    {"code": "view_connected_agent", "label": "Connected agents", "category": "Agents"},
    {"code": "create_agent", "label": "Create agent", "category": "Agents"},
    {"code": "manage_agents", "label": "Manage agents", "category": "Agents"},
    {"code": "delete_agents", "label": "Delete agents", "category": "Agents"},
]
OPERATION_CODES = {operation['code'] for operation in OPERATION_PERMISSIONS}


def parse_operations(value):
    if not value:
        return []
    if isinstance(value, list):
        items = value
    else:
        try:
            items = json.loads(value)
        except (TypeError, json.JSONDecodeError):
            items = str(value).split(',')
    return [str(item).strip() for item in items if str(item).strip() in OPERATION_CODES]


def dump_operations(operations):
    return json.dumps(sorted(set(parse_operations(operations))))


def expand_operation_codes(operations):
    operation_codes = set(parse_operations(operations))
    if ADMINISTRATOR_OPERATION in operation_codes:
        return set(OPERATION_CODES)
    return operation_codes


def rbac_is_configured():
    return RBACGroup.objects.exists() or UserProfile.objects.filter(operations_configured=True).exists()


def get_user_operation_codes(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return set()
    if user.is_staff or user.is_superuser:
        return set(OPERATION_CODES)

    profile, _ = UserProfile.objects.get_or_create(user=user)
    group_operations = set()
    for group in user.rbac_groups.all():
        group_operations.update(parse_operations(group.operations))
    if group_operations:
        return set(OPERATION_CODES) if ADMINISTRATOR_OPERATION in group_operations else group_operations

    direct_operations = expand_operation_codes(profile.operations)
    if direct_operations:
        return direct_operations

    if profile.operations_configured:
        return set()

    return set(OPERATION_CODES)


def user_has_operation(user, operation):
    return operation in get_user_operation_codes(user)


def user_has_any_operation(user, operations):
    return bool(set(operations) & get_user_operation_codes(user))


def user_can_view_running_containers(user):
    return user_has_any_operation(user, [
        'view_running_containers', 'delete_container', 'connect_container', 'view_monitoring',
    ])


def user_can_view_stopped_containers(user):
    return user_has_any_operation(user, [
        'view_stopped_containers', 'create_container', 'delete_container', 'connect_container', 'view_monitoring',
    ])


def docker_summary_is_running(container):
    state = str(container.get('State') or container.get('state') or '').strip().lower()
    status_text = str(container.get('Status') or container.get('status') or '').strip().lower()
    return state == 'running' or status_text.startswith('up')


def require_operation(operation):
    def decorator(view_func):
        @wraps(view_func)
        def wrapped(request, *args, **kwargs):
            if not user_has_operation(request.user, operation):
                return Response({
                    'success': False,
                    'error': 'You do not have permission for this operation.',
                    'required_operation': operation,
                }, status=status.HTTP_403_FORBIDDEN)
            return view_func(request, *args, **kwargs)
        return wrapped
    return decorator


DOCKER_RUNTIME_HOME = Path('/tmp/vitel-docker-home')
DOCKER_RUNTIME_CONFIG = Path('/tmp/vitel-docker-config')
DOCKER_BUILDX_CONFIG = Path('/tmp/vitel-docker-buildx')
AGENT_DOCKER_NETWORK = 'agent_nt'
AGENT_DOCKER_VOLUME = 'agent_vol'
LOCAL_AGENT_IMAGE = 'agent:latest'
REMOTE_AGENT_CONTAINER_NAME = os.getenv('VITEL_AGENT_CONTAINER_NAME', 'docker-agent')
LEGACY_REMOTE_AGENT_CONTAINER_NAME = 'vitel-agent'
REMOTE_AGENT_IMAGE = os.getenv('VITEL_AGENT_IMAGE', 'yourrepo/vitel-agent:latest')
AGENT_IMAGE_SOURCE = os.getenv('VITEL_AGENT_SOURCE_IMAGE', 'container-ui-project-backend:latest')
AGENT_IMAGE_SOURCE_CANDIDATES = tuple(dict.fromkeys(filter(None, [
    AGENT_IMAGE_SOURCE,
    'container-ui-project-backend:latest',
    'container-ui-project-backend',
    'vitel-container-backend:latest',
    'vitel-container-backend',
    'vitel-backend:latest',
    'vitel-backend',
])))
AGENT_IMAGE_TOKEN_SALT = 'vitel-agent-image-download'
AGENT_IMAGE_TOKEN_MAX_AGE = 24 * 60 * 60
CONTROLLER_CONTAINER_NAME = 'vitel-backend'
SSH_USERNAME_FALLBACKS = (
    'ubuntu',
    'ec2-user',
    'admin',
    'debian',
    'centos',
    'rocky',
    'fedora',
    'oracle',
    'cloud-user',
    'azureuser',
    'vitel',
    'docker',
    'user',
)
LINUX_USERNAME_RE = re.compile(r'^[a-z_][a-z0-9_-]{0,31}$')


def clean_terminal_output(output):
    """Remove terminal control codes before returning shell output to the UI."""
    if not output:
        return ''
    output = TERMINAL_CONTROL_SEQUENCE_RE.sub('', output)
    return output.replace('\r\n', '\n').replace('\r', '')


def get_docker_subprocess_env():
    """Use writable Docker client paths because /root is mounted read-only."""
    for path in [DOCKER_RUNTIME_HOME, DOCKER_RUNTIME_CONFIG, DOCKER_BUILDX_CONFIG]:
        path.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env.update({
        'HOME': str(DOCKER_RUNTIME_HOME),
        'DOCKER_CONFIG': str(DOCKER_RUNTIME_CONFIG),
        'BUILDX_CONFIG': str(DOCKER_BUILDX_CONFIG),
    })
    return env


def run_docker_command(command, timeout=120):
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=get_docker_subprocess_env(),
        )
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or '') + '\n' + (exc.stderr or '')).strip()
        return {
            'success': False,
            'return_code': None,
            'command': ' '.join(command),
            'output': output or f"Command timed out after {timeout} seconds.",
        }
    except OSError as exc:
        return {
            'success': False,
            'return_code': None,
            'command': ' '.join(command),
            'output': str(exc),
        }

    output = (result.stdout + '\n' + result.stderr).strip()
    return {
        'success': result.returncode == 0,
        'return_code': result.returncode,
        'command': ' '.join(command),
        'output': output,
    }



def clean_volume_browser_path(value):
    raw_path = str(value or '').replace('\\', '/').strip()
    if '\x00' in raw_path:
        raise ValueError('Path contains invalid characters.')
    if raw_path in {'', '/'}:
        return ''

    parts = []
    for part in raw_path.split('/'):
        if part in {'', '.'}:
            continue
        if part == '..':
            raise ValueError('Parent directory traversal is not allowed.')
        parts.append(part)
    return '/'.join(parts)


def get_volume_request_value(request, key):
    if request.method == 'GET':
        return request.query_params.get(key, '')
    return request.data.get(key, '')


def get_verified_volume_mount(request):
    container_id = str(get_volume_request_value(request, 'container_id') or '').strip()
    mount_source = str(get_volume_request_value(request, 'source') or '').strip()
    mount_name = str(get_volume_request_value(request, 'name') or '').strip()
    mount_destination = str(get_volume_request_value(request, 'destination') or '').strip()

    if not container_id:
        return None, None, None, Response({'error': 'Container ID is required.'}, status=status.HTTP_400_BAD_REQUEST)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return None, None, None, None, error_response

    inspect_result = run_target_docker_command(
        agent,
        password,
        remote_agent,
        ['docker', 'inspect', container_id, '--format', '{{json .}}'],
        timeout=30,
    )
    if not inspect_result['success']:
        return None, None, None, None, Response({
            **inspect_result,
            'error': inspect_result['output'] or 'Unable to inspect container.',
        }, status=status.HTTP_400_BAD_REQUEST)

    try:
        container_data = json.loads(inspect_result['output'].splitlines()[0])
    except (json.JSONDecodeError, IndexError):
        return None, None, None, None, Response({
            'success': False,
            'error': 'Failed to read container details before opening volume GUI.',
        }, status=status.HTTP_400_BAD_REQUEST)

    matching_mount = None
    for mount in container_data.get('Mounts', []):
        source_matches = mount_source and mount.get('Source') == mount_source
        name_matches = mount_name and mount.get('Name') == mount_name
        destination_matches = mount_destination and mount.get('Destination') == mount_destination
        if source_matches or name_matches or destination_matches:
            matching_mount = mount
            break

    if not matching_mount:
        return None, None, None, None, Response({
            'success': False,
            'error': 'Selected volume mount was not found on this container.',
        }, status=status.HTTP_400_BAD_REQUEST)

    if not matching_mount.get('Source'):
        return None, None, None, None, Response({
            'success': False,
            'error': 'Selected mount does not expose a Docker volume source path.',
        }, status=status.HTTP_400_BAD_REQUEST)

    target_context = {
        'agent': agent,
        'password': password,
        'remote_agent': remote_agent,
    }
    return container_id, container_data, matching_mount, target_context, None


def ensure_volume_helper_image(agent=None, password='', remote_agent=False):
    inspect_result = run_target_docker_command(
        agent,
        password,
        remote_agent,
        ['docker', 'image', 'inspect', VOLUME_HELPER_IMAGE],
        timeout=30,
    )
    if inspect_result['success']:
        return inspect_result
    return run_target_docker_command(
        agent,
        password,
        remote_agent,
        ['docker', 'pull', VOLUME_HELPER_IMAGE],
        timeout=300,
    )


def remove_volume_helper_image(agent=None, password='', remote_agent=False):
    quoted_image = shlex.quote(VOLUME_HELPER_IMAGE)
    cleanup_script = (
        f'if ! docker image inspect {quoted_image} >/dev/null 2>&1; then exit 0; fi; '
        'attempt=0; '
        'while [ "$attempt" -lt 5 ]; do '
        f'  docker image rm {quoted_image} >/dev/null 2>&1 && exit 0; '
        '  attempt=$((attempt + 1)); sleep 1; '
        'done; '
        f'! docker image inspect {quoted_image} >/dev/null 2>&1'
    )
    return run_target_docker_command(
        agent,
        password,
        remote_agent,
        ['sh', '-lc', cleanup_script],
        timeout=15,
    )


def run_volume_browser_command(mount_source, script, env_vars=None, timeout=60, target_context=None):
    target_context = target_context or {}
    agent = target_context.get('agent')
    password = target_context.get('password', '')
    remote_agent = bool(target_context.get('remote_agent'))
    image_result = ensure_volume_helper_image(agent, password, remote_agent)
    if not image_result['success']:
        return image_result

    command = ['docker', 'run', '--rm', '-v', f'{mount_source}:{mount_source}']
    merged_env = {'VOLUME_ROOT': mount_source, **(env_vars or {})}
    for key, value in merged_env.items():
        command.extend(['-e', f'{key}={value}'])
    command.extend(['--pull=never', VOLUME_HELPER_IMAGE, 'sh', '-lc', script])
    return run_target_docker_command(agent, password, remote_agent, command, timeout=timeout)


def volume_command_error(result, fallback):
    marker = '__VITEL_ERROR__:'
    for line in (result.get('output') or '').splitlines():
        if line.startswith(marker):
            return line[len(marker):].strip() or fallback
    return result.get('error') or result.get('output') or fallback

def count_docker_resources():
    resources = {
        'containers_count': 0,
        'images_count': 0,
        'networks_count': 0,
        'volumes_count': 0,
    }
    commands = {
        'containers_count': ['docker', 'ps', '-aq'],
        'images_count': ['docker', 'image', 'ls', '-q'],
        'networks_count': ['docker', 'network', 'ls', '-q'],
        'volumes_count': ['docker', 'volume', 'ls', '-q'],
    }

    for key, command in commands.items():
        result = run_docker_command(command, timeout=20)
        if result['success']:
            resources[key] = len([line for line in result['output'].splitlines() if line.strip()])

    return resources


def get_request_browser_hostname(request):
    if hasattr(request, 'data'):
        browser_hostname = str(request.data.get('browser_hostname', '') or '').strip()
        if browser_hostname:
            return browser_hostname

    if hasattr(request, 'query_params'):
        browser_hostname = str(request.query_params.get('browser_hostname', '') or '').strip()
        if browser_hostname:
            return browser_hostname

    origin = request.META.get('HTTP_ORIGIN') or request.META.get('HTTP_REFERER') or ''
    parsed_origin = urlparse(origin) if origin else None
    return parsed_origin.hostname if parsed_origin and parsed_origin.hostname else ''


def get_local_application_host(request):
    browser_hostname = get_request_browser_hostname(request)
    request_host = request.get_host().split(':')[0]
    internal_hosts = {'backend', 'vitel-backend', 'localhost', '127.0.0.1', '::1'}
    if browser_hostname and request_host in internal_hosts:
        return browser_hostname
    return request_host


def get_controller_base_url(request):
    browser_hostname = ''
    if hasattr(request, 'data'):
        browser_hostname = str(request.data.get('browser_hostname', '') or '').strip()

    origin = request.META.get('HTTP_ORIGIN') or request.META.get('HTTP_REFERER') or ''
    parsed_origin = urlparse(origin) if origin else None
    request_host = request.get_host().split(':')[0]
    internal_hosts = {'backend', 'vitel-backend', 'localhost', '127.0.0.1'}

    public_port = os.getenv('VITEL_BACKEND_PUBLIC_PORT', '8000').strip() or '8000'
    port_suffix = f':{public_port}'

    if browser_hostname and request_host in internal_hosts:
        scheme = parsed_origin.scheme if parsed_origin and parsed_origin.scheme else request.scheme
        return f'{scheme}://{browser_hostname}{port_suffix}'

    if parsed_origin and parsed_origin.hostname and request_host in {'backend', 'vitel-backend'}:
        return f'{parsed_origin.scheme}://{parsed_origin.hostname}{port_suffix}'

    return request.build_absolute_uri('/').rstrip('/')


def get_agent_control_server_url(request):
    configured_url = (
        os.getenv('CONTROL_SERVER_URL', '').strip()
        or os.getenv('VITEL_CONTROL_SERVER_URL', '').strip()
    )
    if configured_url:
        return configured_url.rstrip('/')

    return get_controller_base_url(request).rstrip('/')


def get_agent_control_server_ws_url(request):
    configured_url = (
        os.getenv('CONTROL_SERVER_WS_URL', '').strip()
        or os.getenv('VITEL_CONTROL_SERVER_WS_URL', '').strip()
    )
    if configured_url:
        return configured_url.rstrip('/')

    control_url = get_agent_control_server_url(request)
    parsed = urlparse(control_url)
    scheme = 'wss' if parsed.scheme == 'https' else 'ws'
    netloc = parsed.netloc or parsed.path
    path = parsed.path if parsed.netloc else ''
    base = f'{scheme}://{netloc}{path}'.rstrip('/')
    return f'{base}/agents'


def build_agent_commands(agent, password, request):
    script = build_agent_script(agent, password, request)
    agent_dir = '~/.vitel-agent'
    controller = get_controller_base_url(request)
    return [
        "mkdir -p ~/.vitel-agent",
        "cat > ~/.vitel-agent/vitel-agent.sh <<'EOF'\n" + script + "EOF",
        "chmod +x ~/.vitel-agent/vitel-agent.sh",
        "nohup sh ~/.vitel-agent/vitel-agent.sh > ~/.vitel-agent/vitel-agent.log 2>&1 & echo $! > ~/.vitel-agent/vitel-agent.pid",
        f"echo 'Agent {agent.name} started in the background and will report to {controller}.'",
        f"echo 'Logs: {agent_dir}/vitel-agent.log'",
    ]


def build_pull_agent_client_source():
    return r'''#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import time
from urllib import request as urllib_request
from urllib import error as urllib_error
from urllib.parse import urlparse


AGENT_ID = os.environ.get('VITEL_AGENT_ID', '')
AGENT_NAME = os.environ.get('VITEL_AGENT_NAME', 'vitel-agent')
AGENT_PASSWORD = os.environ.get('VITEL_AGENT_PASSWORD', '')
REPORTED_IP = os.environ.get('VITEL_AGENT_REPORTED_IP', '')
HEARTBEAT_URL = os.environ.get('VITEL_AGENT_URL', '')
COMMAND_URL = os.environ.get('VITEL_AGENT_COMMAND_URL', '')
COMMAND_RESULT_URL = os.environ.get('VITEL_AGENT_COMMAND_RESULT_URL', '')
DEPLOYMENT_POLL_URL = os.environ.get('VITEL_AGENT_DEPLOYMENT_POLL_URL', '')
DEPLOYMENT_RESULT_URL = os.environ.get('VITEL_AGENT_DEPLOYMENT_RESULT_URL', '')


def log(message):
    print(message, flush=True)


def post_json(url, payload, timeout=30):
    body = json.dumps(payload).encode('utf-8')
    req = urllib_request.Request(url, data=body, headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib_request.urlopen(req, timeout=timeout) as response:
            text = response.read().decode('utf-8')
            return response.status, json.loads(text) if text else {}
    except urllib_error.HTTPError as exc:
        text = exc.read().decode('utf-8', errors='replace')
        try:
            data = json.loads(text) if text else {}
        except json.JSONDecodeError:
            data = {'error': text or str(exc)}
        return exc.code, data
    except (urllib_error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return 0, {'error': str(exc)}


def count_lines(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if result.returncode != 0:
        return 0
    return len([line for line in result.stdout.splitlines() if line.strip()])


def get_server_ip():
    if REPORTED_IP:
        return REPORTED_IP
    try:
        result = subprocess.run(['hostname', '-I'], capture_output=True, text=True, timeout=5, check=False)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.split()[0]
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ''


def auth_payload(extra=None):
    payload = {'agent_id': AGENT_ID, 'name': AGENT_NAME, 'password': AGENT_PASSWORD}
    if extra:
        payload.update(extra)
    return payload


def heartbeat():
    if not HEARTBEAT_URL:
        return False
    payload = auth_payload({
        'server_ip': get_server_ip(),
        'hostname': os.uname().nodename if hasattr(os, 'uname') else '',
        'containers_count': count_lines(['docker', 'ps', '-aq']),
        'images_count': count_lines(['docker', 'image', 'ls', '-q']),
        'networks_count': count_lines(['docker', 'network', 'ls', '-q']),
        'volumes_count': count_lines(['docker', 'volume', 'ls', '-q']),
    })
    status, data = post_json(HEARTBEAT_URL, payload, timeout=30)
    if 200 <= status < 300:
        log('Heartbeat accepted at %s' % time.strftime('%Y-%m-%d %H:%M:%S'))
        return True
    log('Heartbeat failed status=%s %s' % (status, data.get('error') or data))
    return False


def command_to_process(command):
    if isinstance(command, list):
        command = [str(part) for part in command if str(part)]
        return command, ' '.join(command)
    command = str(command or '').strip()
    return ['sh', '-lc', command], command


def post_command_result(command_id, success, return_code, command, output):
    status, data = post_json(COMMAND_RESULT_URL, auth_payload({
        'command_id': command_id,
        'success': bool(success),
        'return_code': return_code,
        'command': command,
        'output': output or '',
    }), timeout=30)
    if 200 <= status < 300:
        log('Command %s result posted.' % command_id)
        return True
    log('Command %s result post failed status=%s %s' % (command_id, status, data.get('error') or data))
    return False


def poll_command():
    if not COMMAND_URL or not COMMAND_RESULT_URL:
        return False
    status, data = post_json(COMMAND_URL, auth_payload(), timeout=30)
    if status == 204:
        return False
    if not (200 <= status < 300):
        log('Command poll failed status=%s %s' % (status, data.get('error') or data))
        return False
    command_payload = data.get('command')
    if not command_payload:
        return False
    command_id = command_payload.get('id')
    command = command_payload.get('command')
    try:
        timeout = max(1, min(int(command_payload.get('timeout') or 120), 1800))
    except (TypeError, ValueError):
        timeout = 120
    popen_command, display_command = command_to_process(command)
    if not command_id or not popen_command:
        return False
    log('Running pulled command %s: %s' % (command_id, display_command))
    try:
        result = subprocess.run(popen_command, capture_output=True, text=True, timeout=timeout, check=False)
        output = ((result.stdout or '') + '\n' + (result.stderr or '')).strip()
        post_command_result(command_id, result.returncode == 0, result.returncode, display_command, output)
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or '') + '\n' + (exc.stderr or '')).strip()
        post_command_result(command_id, False, None, display_command, output or 'Command timed out after %s seconds.' % timeout)
    except OSError as exc:
        post_command_result(command_id, False, None, display_command, str(exc))
    return True


def run_process(command, timeout=600, input_text=None):
    display = ' '.join(command)
    try:
        result = subprocess.run(
            command,
            input=input_text,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
        output = ((result.stdout or '') + '\n' + (result.stderr or '')).strip()
        return result.returncode == 0, result.returncode, display, output
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or '') + '\n' + (exc.stderr or '')).strip()
        return False, None, display, output or 'Command timed out after %s seconds.' % timeout
    except OSError as exc:
        return False, None, display, str(exc)


def registry_host(image_reference):
    first = str(image_reference or '').split('/')[0]
    return first if ('.' in first or ':' in first or first == 'localhost') else ''


def post_deployment_result(job_id, success, output, error=''):
    status, data = post_json(DEPLOYMENT_RESULT_URL, auth_payload({
        'job_id': job_id,
        'success': bool(success),
        'output': output or '',
        'error': error or '',
    }), timeout=30)
    if 200 <= status < 300:
        log('Deployment job %s result posted.' % job_id)
        return True
    log('Deployment result post failed status=%s %s' % (status, data.get('error') or data))
    return False


def run_deployment(job):
    job_id = job.get('id')
    image_reference = str(job.get('image_reference') or '').strip()
    container_name = str(job.get('container_name') or '').strip()
    run_args = job.get('run_args') if isinstance(job.get('run_args'), list) else []
    username = str(job.get('registry_username') or '').strip()
    password = str(job.get('registry_password') or '')
    output_parts = []

    if not job_id or not image_reference or not container_name:
        post_deployment_result(job_id, False, '', 'Deployment job is missing image or container details.')
        return True

    host = registry_host(image_reference)
    if username and password and host:
        ok, _, display, output = run_process(['docker', 'login', host, '-u', username, '--password-stdin'], timeout=60, input_text=password + '\n')
        output_parts.append('$ ' + display.replace(password, '********'))
        output_parts.append(output.replace(password, '********'))
        if not ok:
            post_deployment_result(job_id, False, '\n'.join(output_parts), 'Docker registry login failed.')
            return True

    for command in [
        ['docker', 'pull', image_reference],
        ['docker', 'rm', '-f', container_name],
        ['docker', 'run', '-d', '--name', container_name, '--restart', 'unless-stopped', *[str(arg) for arg in run_args], image_reference],
    ]:
        ok, _, display, output = run_process(command, timeout=900)
        output_parts.append('$ ' + display)
        if output:
            output_parts.append(output)
        if command[:3] == ['docker', 'rm', '-f']:
            continue
        if not ok:
            post_deployment_result(job_id, False, '\n'.join(output_parts), output or 'Deployment command failed.')
            return True

    post_deployment_result(job_id, True, '\n'.join(output_parts), '')
    return True


def poll_deployment():
    if not DEPLOYMENT_POLL_URL or not DEPLOYMENT_RESULT_URL:
        return False
    status, data = post_json(DEPLOYMENT_POLL_URL, auth_payload(), timeout=30)
    if status == 204:
        return False
    if not (200 <= status < 300):
        log('Deployment poll failed status=%s %s' % (status, data.get('error') or data))
        return False
    job = data.get('job')
    if not job:
        return False
    log('Running deployment job %s: %s' % (job.get('id'), job.get('image_reference')))
    return run_deployment(job)


def main():
    last_heartbeat = 0
    last_deployment_poll = 0
    heartbeat()
    last_heartbeat = time.time()
    while True:
        now = time.time()
        if now - last_heartbeat >= 5:
            heartbeat()
            last_heartbeat = now
        handled = poll_command()
        if now - last_deployment_poll >= 30:
            handled = poll_deployment() or handled
            last_deployment_poll = now
        time.sleep(0.1 if handled else 0.25)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
'''

def build_agent_server_source():
    return r'''#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer


AGENT_NAME = os.environ.get('VITEL_AGENT_NAME', 'vitel-agent')
AGENT_PASSWORD = os.environ.get('VITEL_AGENT_PASSWORD', '')


class AgentHandler(BaseHTTPRequestHandler):
    server_version = 'VitelAgent/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - - [%s] %s\n' % (
            self.address_string(),
            self.log_date_time_string(),
            fmt % args,
        ))

    def send_json(self, status, payload):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_payload(self):
        try:
            length = int(self.headers.get('Content-Length', '0') or '0')
        except ValueError:
            length = 0
        if length < 1 or length > 1024 * 1024:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode('utf-8'))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def do_GET(self):
        if self.path not in ('/', '/health'):
            self.send_json(404, {'success': False, 'error': 'Not found'})
            return
        self.send_json(200, {'success': True, 'agent': AGENT_NAME})

    def do_POST(self):
        if self.path != '/run-command':
            self.send_json(404, {'success': False, 'error': 'Not found'})
            return

        payload = self.read_payload()
        if payload.get('password') != AGENT_PASSWORD:
            self.send_json(403, {'success': False, 'error': 'Invalid agent password.'})
            return

        command = payload.get('command')
        if isinstance(command, list):
            command = [str(part) for part in command if str(part)]
            popen_command = command
            display_command = ' '.join(command)
        elif isinstance(command, str) and command.strip():
            popen_command = ['sh', '-lc', command]
            display_command = command
        else:
            self.send_json(400, {'success': False, 'error': 'Command is required.'})
            return

        try:
            timeout = max(1, min(int(payload.get('timeout') or 120), 900))
        except (TypeError, ValueError):
            timeout = 120

        try:
            result = subprocess.run(
                popen_command,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
            output = ((result.stdout or '') + '\n' + (result.stderr or '')).strip()
            self.send_json(200, {
                'success': result.returncode == 0,
                'return_code': result.returncode,
                'command': display_command,
                'output': output,
            })
        except subprocess.TimeoutExpired as exc:
            output = ((exc.stdout or '') + '\n' + (exc.stderr or '')).strip()
            self.send_json(504, {
                'success': False,
                'return_code': None,
                'command': display_command,
                'output': output or 'Command timed out after %s seconds.' % timeout,
            })
        except OSError as exc:
            self.send_json(500, {
                'success': False,
                'return_code': None,
                'command': display_command,
                'output': str(exc),
            })


def main():
    try:
        port = int(sys.argv[1])
    except (IndexError, TypeError, ValueError):
        port = 19541
    HTTPServer(('0.0.0.0', port), AgentHandler).serve_forever()


if __name__ == '__main__':
    main()
'''


def build_agent_script(agent, password, request, controller=None, reported_ip=''):
    controller = controller or get_controller_base_url(request)
    heartbeat_url = f'{controller}/api/auth/agent-heartbeat/'
    command_url = f'{controller}/api/auth/agent-command/'
    command_result_url = f'{controller}/api/auth/agent-command-result/'
    deployment_poll_url = f'{controller}/api/registry/deployment-poll/'
    deployment_result_url = f'{controller}/api/registry/deployment-result/'
    agent_server_b64 = base64.b64encode(build_agent_server_source().encode('utf-8')).decode('ascii')
    agent_client_b64 = base64.b64encode(build_pull_agent_client_source().encode('utf-8')).decode('ascii')
    return f"""#!/bin/sh
set -u
VITEL_AGENT_ID={agent.id}
VITEL_AGENT_URL={shlex.quote(heartbeat_url)}
VITEL_AGENT_COMMAND_URL={shlex.quote(command_url)}
VITEL_AGENT_COMMAND_RESULT_URL={shlex.quote(command_result_url)}
VITEL_AGENT_DEPLOYMENT_POLL_URL={shlex.quote(deployment_poll_url)}
VITEL_AGENT_DEPLOYMENT_RESULT_URL={shlex.quote(deployment_result_url)}
VITEL_AGENT_NAME={shlex.quote(agent.name)}
VITEL_AGENT_PASSWORD={shlex.quote(password)}
VITEL_AGENT_PORT={agent.port}
VITEL_AGENT_REPORTED_IP={shlex.quote(reported_ip or '')}
VITEL_AGENT_SERVER_B64={shlex.quote(agent_server_b64)}
VITEL_AGENT_CLIENT_B64={shlex.quote(agent_client_b64)}
AGENT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PORT_PID_FILE="$AGENT_DIR/vitel-agent-port.pid"
PORT_SERVER_FILE="$AGENT_DIR/vitel-agent-server.py"
CLIENT_PID_FILE="$AGENT_DIR/vitel-agent-client.pid"
CLIENT_FILE="$AGENT_DIR/vitel-agent-client.py"

count_lines() {{
  "$@" 2>/dev/null | wc -l | tr -d ' '
}}

cleanup() {{
  if [ -f "$PORT_PID_FILE" ]; then
    kill "$(cat "$PORT_PID_FILE")" 2>/dev/null || true
    rm -f "$PORT_PID_FILE"
  fi
  if [ -f "$CLIENT_PID_FILE" ]; then
    kill "$(cat "$CLIENT_PID_FILE")" 2>/dev/null || true
    rm -f "$CLIENT_PID_FILE"
  fi
}}

trap cleanup INT TERM EXIT

start_port_listener() {{
  case "$VITEL_AGENT_PORT" in
    ''|*[!0-9]*|0) return ;;
  esac

  if [ -f "$PORT_PID_FILE" ] && kill -0 "$(cat "$PORT_PID_FILE")" >/dev/null 2>&1; then
    return
  fi

  printf "%s" "$VITEL_AGENT_SERVER_B64" | base64 -d > "$PORT_SERVER_FILE"
  chmod +x "$PORT_SERVER_FILE"

  if command -v python3 >/dev/null 2>&1; then
    (cd "$AGENT_DIR" && VITEL_AGENT_NAME="$VITEL_AGENT_NAME" VITEL_AGENT_PASSWORD="$VITEL_AGENT_PASSWORD" python3 "$PORT_SERVER_FILE" "$VITEL_AGENT_PORT") >> "$AGENT_DIR/vitel-agent-port.log" 2>&1 &
    echo $! > "$PORT_PID_FILE"
    echo "Agent command port listening on $VITEL_AGENT_PORT"
  elif command -v python >/dev/null 2>&1; then
    (cd "$AGENT_DIR" && VITEL_AGENT_NAME="$VITEL_AGENT_NAME" VITEL_AGENT_PASSWORD="$VITEL_AGENT_PASSWORD" python "$PORT_SERVER_FILE" "$VITEL_AGENT_PORT") >> "$AGENT_DIR/vitel-agent-port.log" 2>&1 &
    echo $! > "$PORT_PID_FILE"
    echo "Agent command port listening on $VITEL_AGENT_PORT"
  else
    echo "Python is not available, so the agent command port $VITEL_AGENT_PORT cannot be opened."
  fi
}}

start_pull_client() {{
  if [ -f "$CLIENT_PID_FILE" ] && kill -0 "$(cat "$CLIENT_PID_FILE")" >/dev/null 2>&1; then
    return 0
  fi

  printf "%s" "$VITEL_AGENT_CLIENT_B64" | base64 -d > "$CLIENT_FILE"
  chmod +x "$CLIENT_FILE"

  PYTHON_BIN=""
  if command -v python3 >/dev/null 2>&1; then PYTHON_BIN=python3; elif command -v python >/dev/null 2>&1; then PYTHON_BIN=python; fi
  if [ -z "$PYTHON_BIN" ]; then
    echo "Python is not available, so pull-based commands and registry deployments cannot run."
    return 1
  fi

  (cd "$AGENT_DIR" && \
    VITEL_AGENT_ID="$VITEL_AGENT_ID" \
    VITEL_AGENT_NAME="$VITEL_AGENT_NAME" \
    VITEL_AGENT_PASSWORD="$VITEL_AGENT_PASSWORD" \
    VITEL_AGENT_REPORTED_IP="$VITEL_AGENT_REPORTED_IP" \
    VITEL_AGENT_URL="$VITEL_AGENT_URL" \
    VITEL_AGENT_COMMAND_URL="$VITEL_AGENT_COMMAND_URL" \
    VITEL_AGENT_COMMAND_RESULT_URL="$VITEL_AGENT_COMMAND_RESULT_URL" \
    VITEL_AGENT_DEPLOYMENT_POLL_URL="$VITEL_AGENT_DEPLOYMENT_POLL_URL" \
    VITEL_AGENT_DEPLOYMENT_RESULT_URL="$VITEL_AGENT_DEPLOYMENT_RESULT_URL" \
    "$PYTHON_BIN" "$CLIENT_FILE") >> "$AGENT_DIR/vitel-agent-client.log" 2>&1 &
  echo $! > "$CLIENT_PID_FILE"
  echo "Agent pull client started. It polls deployment jobs every 30 seconds."
  return 0
}}

start_port_listener
start_pull_client || true

while true; do
  start_port_listener
  if start_pull_client; then
    sleep 30
    continue
  fi

  if [ -n "$VITEL_AGENT_REPORTED_IP" ]; then
    SERVER_IP="$VITEL_AGENT_REPORTED_IP"
  else
    SERVER_IP=$(hostname -I 2>/dev/null | awk '{{print $1}}')
  fi
  HOSTNAME=$(hostname)
  CONTAINERS=$(count_lines docker ps -aq)
  IMAGES=$(count_lines docker image ls -q)
  NETWORKS=$(count_lines docker network ls -q)
  VOLUMES=$(count_lines docker volume ls -q)

  RESPONSE=$(curl -sS -w "\n%{{http_code}}" -X POST "$VITEL_AGENT_URL" \
    -H "Content-Type: application/json" \
    --data "{{\"agent_id\":{agent.id},\"name\":\"$VITEL_AGENT_NAME\",\"password\":\"$VITEL_AGENT_PASSWORD\",\"server_ip\":\"$SERVER_IP\",\"hostname\":\"$HOSTNAME\",\"containers_count\":$CONTAINERS,\"images_count\":$IMAGES,\"networks_count\":$NETWORKS,\"volumes_count\":$VOLUMES}}" 2>&1)
  CURL_STATUS=$?
  HTTP_STATUS=$(printf "%s" "$RESPONSE" | tail -n 1)
  BODY=$(printf "%s" "$RESPONSE" | sed '$d')
  if [ "$CURL_STATUS" -eq 0 ] && [ "$HTTP_STATUS" -ge 200 ] && [ "$HTTP_STATUS" -lt 300 ]; then
    echo "Heartbeat accepted at $(date)"
  else
    echo "Heartbeat failed at $(date) status=$HTTP_STATUS curl=$CURL_STATUS"
    printf "%s\n" "$BODY"
  fi
  sleep 60
done
"""

def build_agent_uninstall_commands(agent):
    return build_remote_agent_uninstall_command(agent).splitlines()


def decode_agent_password(value, encoding=''):
    """Decode browser-wrapped agent secrets before hashing them."""
    if encoding != 'base64':
        return value

    try:
        return base64.b64decode(value, validate=True).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ''


try:
    from cryptography.fernet import Fernet, InvalidToken
except ImportError:  # pragma: no cover - fallback keeps older dev installs running.
    Fernet = None
    InvalidToken = Exception


def get_agent_secret_cipher():
    if Fernet is None:
        return None
    digest = __import__('hashlib').sha256(settings.SECRET_KEY.encode('utf-8')).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encode_agent_secret(value):
    if not value:
        return ''
    cipher = get_agent_secret_cipher()
    if cipher:
        return 'fernet:' + cipher.encrypt(value.encode('utf-8')).decode('ascii')
    return 'base64:' + base64.urlsafe_b64encode(value.encode('utf-8')).decode('ascii')


def decode_agent_secret(value):
    if not value:
        return ''
    if value.startswith('fernet:'):
        cipher = get_agent_secret_cipher()
        if not cipher:
            return ''
        try:
            return cipher.decrypt(value.split(':', 1)[1].encode('ascii')).decode('utf-8')
        except (InvalidToken, UnicodeDecodeError, ValueError):
            return ''
    if value.startswith('base64:'):
        value = value.split(':', 1)[1]
    try:
        return base64.urlsafe_b64decode(value.encode('ascii')).decode('utf-8')
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return ''


def mask_secret(output, secret):
    if not output or not secret:
        return output or ''
    return output.replace(secret, '********')


def with_ssh_auth_guidance(result, agent):
    output = result.get('output', '') or ''
    normalized_output = output.lower()
    if (
        'permission denied' in normalized_output
        or 'ssh authentication failed' in normalized_output
    ):
        username = get_agent_ssh_username(agent)
        message = (
            f"SSH authentication failed for {username}@{agent.server_ip}. "
            "Verify the SSH username and password. If you are using root, the target server may block "
            "root password login. If your terminal command is ssh someuser@server, enter that exact "
            "user in SSH Username instead of root. For root automation, the target SSH server must allow "
            "PasswordAuthentication yes and PermitRootLogin yes."
        )
        result = {
            **result,
            'output': f"{output}\n\n{message}".strip(),
            'error': message,
        }
    return result



def build_ssh_automation_failure(agent, output='', operation='install'):
    username = get_agent_ssh_username(agent)
    message = (
        f'Automatic agent {operation} requires working SSH login for {username}@{agent.server_ip}. '
        f'The target server rejected the supplied credentials, so the controller cannot {operation} anything there. '
        'Use the same SSH username that works in your terminal, for example ubuntu@server, or enable PasswordAuthentication yes and PermitRootLogin yes for root automation.'
    )
    requirements = (
        'Automation requirements:\n'
        f'- SSH must accept login for {username}@{agent.server_ip} on port {get_agent_ssh_port(agent)}.\n'
        '- The SSH user must be root or be able to run sudo without an interactive prompt for package installation.\n'
        '- Docker must be installed, or the SSH user must be able to install/use Docker.\n'
        '- The server must allow outbound HTTP access back to this controller on port 8000 for heartbeat.\n'
        '- If your working terminal command is ssh username@server, enter that username in SSH Username. Do not leave it as root.\n'
        '- For root password login, sshd_config must allow PasswordAuthentication yes and PermitRootLogin yes.'
    )
    return {
        'success': False,
        'return_code': None,
        'command': f'ssh automatic agent {operation}',
        'output': '\n\n'.join([part for part in [output.strip(), message, requirements] if part]).strip(),
        'error': message,
    }

def is_ssh_auth_failure(result):
    output = (result.get('output', '') or '').lower()
    error = (result.get('error', '') or '').lower()
    return (
        'ssh authentication failed' in output
        or 'ssh authentication failed' in error
        or 'permission denied' in output
        or 'permission denied' in error
    )


def get_agent_ssh_username(agent):
    return getattr(agent, 'ssh_username', '') or 'root'


def parse_ssh_target(server_value, username_value='', port_value=''):
    target = str(server_value or '').strip()
    username = str(username_value or '').strip()
    port = str(port_value or '').strip()

    if target.startswith('ssh '):
        parts = target.split()
        target = ''
        for index, part in enumerate(parts[1:], start=1):
            if part == '-p' and index + 1 < len(parts):
                port = port or parts[index + 1]
                continue
            if parts[index - 1] == '-p':
                continue
            if '@' in part or re.match(r'^[0-9a-fA-F:.]+$', part):
                target = part
                break

    if '@' in target:
        possible_username, possible_target = target.split('@', 1)
        possible_username = possible_username.strip()
        # A pasted SSH target such as ubuntu@server should win over the legacy
        # default root value that older frontend bundles may still submit.
        if possible_username:
            username = possible_username
        target = possible_target.strip()

    if target.count(':') == 1:
        possible_host, possible_port = target.rsplit(':', 1)
        if possible_port.isdigit():
            target = possible_host
            port = port or possible_port

    return target.strip(), username.strip(), port.strip()


def get_agent_ssh_port(agent):
    try:
        return int(getattr(agent, 'ssh_port', 22) or 22)
    except (TypeError, ValueError):
        return 22


def get_agent_ssh_auth_type(agent):
    auth_type = str(getattr(agent, 'ssh_auth_type', '') or 'password').strip().lower()
    return auth_type if auth_type in {'password', 'key', 'manual'} else 'password'


def get_agent_ssh_private_key(agent):
    return decode_agent_secret(getattr(agent, 'ssh_key_secret', ''))


def get_agent_ssh_key_passphrase(agent):
    return decode_agent_secret(getattr(agent, 'ssh_key_passphrase_secret', ''))


def normalize_private_key(value):
    key = str(value or '').strip()
    if not key:
        return ''
    key = key.replace('\r\n', '\n').replace('\r', '\n')
    if 'BEGIN ' not in key or 'PRIVATE KEY' not in key or 'END ' not in key:
        return ''
    return key if key.endswith('\n') else key + '\n'


def generate_controller_ssh_key_pair():
    key_dir = tempfile.mkdtemp(prefix='vitel-controller-key-')
    key_path = Path(key_dir) / 'id_ed25519'
    try:
        result = subprocess.run(
            ['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'vitel-controller-agent-recovery', '-f', str(key_path)],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            return '', '', (result.stderr or result.stdout or 'ssh-keygen failed.').strip()
        private_key = key_path.read_text()
        public_key = key_path.with_suffix('.pub').read_text().strip()
        return private_key, public_key, ''
    except (OSError, subprocess.TimeoutExpired) as exc:
        return '', '', str(exc)
    finally:
        for candidate in [key_path, key_path.with_suffix('.pub')]:
            try:
                candidate.unlink()
            except OSError:
                pass
        try:
            Path(key_dir).rmdir()
        except OSError:
            pass


def run_ssh_command(agent, password, remote_command, timeout=120, private_key='', key_passphrase=''):
    username = get_agent_ssh_username(agent)
    ssh_port = get_agent_ssh_port(agent)
    host = f'{username}@{agent.server_ip}'
    key_file = None
    private_key = normalize_private_key(private_key)
    uses_private_key = bool(private_key)
    display_auth = 'private key' if uses_private_key else 'password'
    display_command = f"ssh -p {ssh_port} {host} sh -lc <remote command> ({display_auth} auth)"

    command = [
        'ssh',
        '-tt',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-p', str(ssh_port),
    ]

    if uses_private_key:
        key_handle = tempfile.NamedTemporaryFile('w', prefix='vitel-ssh-key-', delete=False)
        key_file = key_handle.name
        key_handle.write(private_key)
        key_handle.close()
        os.chmod(key_file, 0o600)
        command.extend([
            '-i', key_file,
            '-o', 'IdentitiesOnly=yes',
            '-o', 'PreferredAuthentications=publickey',
            '-o', 'PubkeyAuthentication=yes',
            '-o', 'PasswordAuthentication=no',
            '-o', 'KbdInteractiveAuthentication=no',
            '-o', 'BatchMode=no' if key_passphrase else 'BatchMode=yes',
        ])
    else:
        command.extend([
            '-o', 'PreferredAuthentications=password,keyboard-interactive',
            '-o', 'PubkeyAuthentication=no',
            '-o', 'KbdInteractiveAuthentication=yes',
            '-o', 'NumberOfPasswordPrompts=3',
            '-o', 'BatchMode=no',
        ])

    command.extend([
        host,
        'sh',
        '-lc',
        shlex.quote(remote_command),
    ])

    master_fd = None
    slave_fd = None
    process = None
    output = ''
    password_prompts = 0
    passphrase_prompts = 0
    prompt_window = ''
    secrets_to_mask = [secret for secret in [password, private_key, key_passphrase] if secret]

    def masked(value):
        for secret in secrets_to_mask:
            value = mask_secret(value, secret)
        return value

    try:
        master_fd, slave_fd = pty.openpty()
        process = subprocess.Popen(
            command,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = None

        deadline = time.monotonic() + timeout
        while True:
            if time.monotonic() > deadline:
                process.kill()
                return {
                    'success': False,
                    'return_code': None,
                    'command': display_command,
                    'output': masked(output + f'\nSSH command timed out after {timeout} seconds.').strip(),
                }

            readable, _, _ = select.select([master_fd], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    chunk = b''
                if chunk:
                    text = chunk.decode(errors='replace')
                    output += text
                    prompt_window = (prompt_window + text)[-4096:]
                    lower_prompt = prompt_window.lower()
                    if 'are you sure you want to continue connecting' in lower_prompt:
                        os.write(master_fd, b'yes\n')
                        prompt_window = ''
                    elif 'enter passphrase for key' in lower_prompt:
                        if not key_passphrase or passphrase_prompts >= 2:
                            process.kill()
                            return {
                                'success': False,
                                'return_code': None,
                                'command': display_command,
                                'output': masked(clean_terminal_output(output).strip() or 'SSH private key requires a passphrase.'),
                            }
                        os.write(master_fd, (key_passphrase + '\n').encode('utf-8'))
                        passphrase_prompts += 1
                        prompt_window = ''
                    elif 'password:' in lower_prompt or 'password for' in lower_prompt:
                        if uses_private_key:
                            process.kill()
                            return {
                                'success': False,
                                'return_code': None,
                                'command': display_command,
                                'output': masked(
                                    clean_terminal_output(output).strip()
                                    or 'SSH key authentication reached a password prompt. Use a key accepted by the target server and passwordless sudo, or use password authentication.'
                                ),
                            }
                        if password_prompts >= 2:
                            process.kill()
                            return {
                                'success': False,
                                'return_code': None,
                                'command': display_command,
                                'output': masked(clean_terminal_output(output).strip() or 'SSH authentication failed.'),
                            }
                        os.write(master_fd, (password + '\n').encode('utf-8'))
                        password_prompts += 1
                        prompt_window = ''

            if process.poll() is not None:
                while True:
                    readable, _, _ = select.select([master_fd], [], [], 0)
                    if not readable:
                        break
                    try:
                        chunk = os.read(master_fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output += chunk.decode(errors='replace')
                break

        clean_output = clean_terminal_output(output).strip()
        return {
            'success': process.returncode == 0,
            'return_code': process.returncode,
            'command': display_command,
            'output': masked(clean_output),
        }
    except OSError as exc:
        return {
            'success': False,
            'return_code': None,
            'command': display_command,
            'output': str(exc),
        }
    finally:
        if slave_fd is not None:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        if key_file:
            try:
                os.unlink(key_file)
            except OSError:
                pass

def ensure_local_ssh_client():
    if shutil.which('ssh'):
        return {
            'success': True,
            'output': 'Controller SSH client is installed.',
        }

    install_commands = [
        (['apt-get', 'update'], ['apt-get', 'install', '-y', 'openssh-client']),
        (['dnf', 'install', '-y', 'openssh-clients'], None),
        (['yum', 'install', '-y', 'openssh-clients'], None),
        (['apk', 'add', '--no-cache', 'openssh-client'], None),
        (['zypper', '--non-interactive', 'install', 'openssh'], None),
    ]
    output = ['Controller SSH client is missing. Attempting to install it before connecting to the server.']

    for first_command, second_command in install_commands:
        if not shutil.which(first_command[0]):
            continue
        for command in [first_command, second_command]:
            if not command:
                continue
            output.append(f"$ {shlex.join(command)}")
            try:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=180,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                output.append(str(exc))
                return {
                    'success': False,
                    'output': '\n'.join(output),
                }
            command_output = (result.stdout + '\n' + result.stderr).strip()
            if command_output:
                output.append(command_output)
            if result.returncode != 0:
                return {
                    'success': False,
                    'output': '\n'.join(output),
                }
        return {
            'success': bool(shutil.which('ssh')),
            'output': '\n'.join(output + ['Controller SSH client is installed.']),
        }

    return {
        'success': False,
        'output': '\n'.join(output + ['No supported package manager was found to install openssh-client.']),
    }


def get_agent_command_url(agent):
    host = str(agent.server_ip)
    if ':' in host and not host.startswith('['):
        host = f'[{host}]'
    return f'http://{host}:{getattr(agent, "port", 19541) or 19541}/run-command'


def run_agent_http_command(agent, password, command, timeout=120):
    url = get_agent_command_url(agent)
    command_display = shlex.join(command) if isinstance(command, list) else str(command)
    payload = json.dumps({
        'password': password,
        'command': command,
        'timeout': timeout,
    }).encode('utf-8')
    request = urllib_request.Request(
        url,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    display_command = f"agent {agent.name} POST {url}: {command_display}"

    try:
        with urllib_request.urlopen(request, timeout=min(timeout + 5, 905)) as response:
            response_body = response.read().decode('utf-8')
    except urllib_error.HTTPError as exc:
        response_body = exc.read().decode('utf-8', errors='replace')
        try:
            data = json.loads(response_body)
        except json.JSONDecodeError:
            data = {'output': response_body or str(exc)}
        if exc.code in {404, 405, 501}:
            message = (
                'The selected agent does not expose the container command endpoint. '
                'Recreate the agent so it uses the latest agent service, then try again.'
            )
            return {
                'success': False,
                'return_code': None,
                'command': display_command,
                'output': mask_secret(f"{data.get('output', '').strip()}\n\n{message}".strip(), password),
                'error': message,
            }
        return {
            'success': False,
            'return_code': data.get('return_code'),
            'command': display_command,
            'output': mask_secret(data.get('output') or data.get('error') or str(exc), password),
            'error': data.get('error') or data.get('output') or str(exc),
        }
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        return {
            'success': False,
            'return_code': None,
            'command': display_command,
            'output': f'Unable to reach agent command endpoint at {url}: {exc}',
            'error': 'Unable to reach the selected agent. Recreate the agent so it has the latest command endpoint, or verify the agent port is reachable.',
        }

    try:
        data = json.loads(response_body)
    except json.JSONDecodeError:
        return {
            'success': False,
            'return_code': None,
            'command': display_command,
            'output': response_body or 'Agent returned an invalid response.',
            'error': 'Agent returned an invalid response.',
        }

    output = mask_secret(data.get('output', ''), password)
    return {
        'success': bool(data.get('success')),
        'return_code': data.get('return_code'),
        'command': display_command,
        'output': output,
        **({'error': data.get('error')} if data.get('error') else {}),
    }




def normalize_agent_command(command):
    if isinstance(command, list):
        return [str(part) for part in command if str(part)]
    return str(command or '')


def get_agent_command_display(command):
    normalized = normalize_agent_command(command)
    if isinstance(normalized, list):
        return shlex.join(normalized)
    return normalized


def authenticate_agent_request_payload(request):
    name = str(request.data.get('name', '') or '').strip()
    password = str(request.data.get('password', '') or '').strip()
    agent_id = request.data.get('agent_id')

    if not name or not password:
        return None, password, Response({
            'success': False,
            'error': 'Agent name and password are required.',
        }, status=status.HTTP_400_BAD_REQUEST)

    agent_query = Agent.objects.filter(id=agent_id, is_deleted=False) if agent_id else Agent.objects.filter(name=name, is_deleted=False)
    agent = agent_query.first()
    if not agent or not check_password(password, agent.password_hash):
        return None, password, Response({
            'success': False,
            'error': 'Invalid agent credentials.',
        }, status=status.HTTP_403_FORBIDDEN)

    return agent, password, None


def run_agent_pull_command(agent, password, command, timeout=120):
    normalized_command = normalize_agent_command(command)
    command_display = get_agent_command_display(normalized_command)
    display_command = f"agent {agent.name} pull-command: {command_display}"
    try:
        timeout_value = max(1, min(int(timeout or 120), 1800))
    except (TypeError, ValueError):
        timeout_value = 120

    command_record = AgentCommand.objects.create(
        agent=agent,
        command=json.dumps(normalized_command),
        command_display=command_display,
        timeout=timeout_value,
    )

    deadline = time.monotonic() + timeout_value + 45
    while time.monotonic() < deadline:
        command_record.refresh_from_db()
        if command_record.status in {AgentCommand.STATUS_COMPLETED, AgentCommand.STATUS_FAILED}:
            return {
                'success': bool(command_record.success),
                'return_code': command_record.return_code,
                'command': display_command,
                'output': mask_secret(command_record.output, password),
                **({} if command_record.success else {'error': command_record.output or 'Agent command failed.'}),
            }
        time.sleep(0.1)

    command_record.status = AgentCommand.STATUS_FAILED
    command_record.output = (
        f'Agent did not return command {command_record.id} before the {timeout_value + 45} second wait limit. '
        'Make sure the agent was redeployed with pull-based command support and is heartbeating.'
    )
    command_record.completed_at = timezone.now()
    command_record.save(update_fields=['status', 'output', 'completed_at', 'updated_at'])
    return {
        'success': False,
        'return_code': None,
        'command': display_command,
        'output': command_record.output,
        'error': command_record.output,
    }


def agent_http_endpoint_reachable(agent, timeout=0.75):
    try:
        with socket.create_connection((str(agent.server_ip), int(agent.port or 19541)), timeout=timeout):
            return True
    except (OSError, TypeError, ValueError):
        return False


def run_agent_command(agent, password, command, timeout=120):
    if agent_http_endpoint_reachable(agent):
        http_result = run_agent_http_command(agent, password, command, timeout=timeout)
        output = http_result.get('output', '')
        should_fallback_to_pull = (
            'Unable to reach agent command endpoint' in output
            or 'does not expose the container command endpoint' in output
        )
        if http_result.get('success') or not should_fallback_to_pull:
            return http_result

    return run_agent_pull_command(agent, password, command, timeout=timeout)

def run_local_shell_command(command_text, password='', timeout=120):
    display_command = 'sh -lc <local agent command>'
    try:
        result = subprocess.run(
            ['sh', '-lc', command_text],
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or '') + '\n' + (exc.stderr or '')).strip()
        return {
            'success': False,
            'return_code': None,
            'command': display_command,
            'output': mask_secret(output + f'\nLocal command timed out after {timeout} seconds.', password).strip(),
        }
    except OSError as exc:
        return {
            'success': False,
            'return_code': None,
            'command': display_command,
            'output': str(exc),
        }

    output = clean_terminal_output((result.stdout + '\n' + result.stderr).strip())
    return {
        'success': result.returncode == 0,
        'return_code': result.returncode,
        'command': display_command,
        'output': mask_secret(output, password),
    }


def truthy_request_value(value):
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


def get_request_host_candidates(request):
    candidates = {'localhost', '127.0.0.1', '::1'}

    for value in [
        request.get_host().split(':')[0],
        request.META.get('HTTP_HOST', '').split(':')[0],
        request.META.get('HTTP_X_FORWARDED_HOST', '').split(':')[0],
        request.data.get('browser_hostname', '') if hasattr(request, 'data') else '',
    ]:
        if value:
            candidates.add(value.strip().lower())

    origin = request.META.get('HTTP_ORIGIN') or request.META.get('HTTP_REFERER') or ''
    if origin:
        parsed = urlparse(origin)
        if parsed.hostname:
            candidates.add(parsed.hostname.lower())

    try:
        hostname = socket.gethostname()
        candidates.add(hostname.lower())
        for address in socket.gethostbyname_ex(hostname)[2]:
            candidates.add(address.lower())
    except OSError:
        pass

    return {candidate for candidate in candidates if candidate}


def is_local_agent_target(request, server_ip):
    return str(server_ip or '').strip().lower() in get_request_host_candidates(request)


def get_local_agent_dir(agent):
    return f'/tmp/vitel-agent/{agent.owner_id}-{agent.id}'


def get_local_agent_container_name(agent):
    return 'agent-runner'


def get_legacy_local_agent_container_name(agent):
    return f'vitel-agent-{agent.owner_id}-{agent.id}'


def get_local_agent_container_id(agent):
    result = run_docker_command([
        'docker', 'ps', '-aq',
        '--filter', f'name=^/{get_local_agent_container_name(agent)}$',
    ], timeout=10)
    return result['output'].splitlines()[0].strip() if result['success'] and result['output'].strip() else ''


def local_agent_container_exists(agent):
    return bool(get_local_agent_container_id(agent))


def local_agent_container_is_running(agent):
    container_id = get_local_agent_container_id(agent)
    if not container_id:
        return False
    result = run_docker_command(['docker', 'inspect', '-f', '{{.State.Running}}', container_id], timeout=10)
    return result['success'] and result['output'].strip().lower() == 'true'


def ensure_agent_docker_network():
    result = run_docker_command(['docker', 'network', 'inspect', AGENT_DOCKER_NETWORK], timeout=10)
    if result['success']:
        return True
    create_result = run_docker_command(['docker', 'network', 'create', AGENT_DOCKER_NETWORK], timeout=20)
    return create_result['success']


def get_controller_container_candidates():
    candidates = [CONTROLLER_CONTAINER_NAME]
    try:
        candidates.append(socket.gethostname())
    except OSError:
        pass
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def docker_container_exists(container):
    result = run_docker_command(['docker', 'container', 'inspect', container], timeout=10)
    return result['success']


def get_docker_container_networks(container):
    result = run_docker_command([
        'docker', 'inspect', '-f',
        '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}',
        container,
    ], timeout=10)
    if not result['success']:
        return set()
    return {line.strip() for line in result['output'].splitlines() if line.strip()}


def ensure_container_on_agent_network(container):
    if not ensure_agent_docker_network():
        return False
    if AGENT_DOCKER_NETWORK in get_docker_container_networks(container):
        return True
    result = run_docker_command(['docker', 'network', 'connect', AGENT_DOCKER_NETWORK, container], timeout=20)
    return result['success'] or 'already exists' in result.get('output', '').lower()


def ensure_controller_on_agent_network():
    for container in get_controller_container_candidates():
        if docker_container_exists(container):
            return ensure_container_on_agent_network(container)
    return False


def ensure_local_agent_uses_agent_network_only(agent):
    container = get_local_agent_container_id(agent)
    if not container:
        return
    if not ensure_container_on_agent_network(container):
        return
    for network in get_docker_container_networks(container):
        if network != AGENT_DOCKER_NETWORK:
            run_docker_command(['docker', 'network', 'disconnect', network, container], timeout=20)


def local_agent_port_is_reachable(agent):
    hosts = []
    if local_agent_container_exists(agent):
        hosts.append(get_local_agent_container_name(agent))
    hosts.append(str(agent.server_ip))

    for host in hosts:
        try:
            with socket.create_connection((host, int(agent.port)), timeout=1.5):
                return True
        except (OSError, TypeError, ValueError):
            continue

    return False


def get_local_agent_publish_address(agent):
    return '127.0.0.1'


def is_local_loopback_address(value):
    return str(value or '').strip().lower() in {'localhost', '127.0.0.1', '::1'}


def get_local_agent_port_mapping(agent):
    return f'{get_local_agent_publish_address(agent)}:{int(agent.port)}:{int(agent.port)}'


def local_agent_host_display(agent):
    host = get_local_agent_publish_address(agent)
    return f'{host}:{int(agent.port)}->{int(agent.port)}/tcp'


def local_agent_host_check(agent):
    host = get_local_agent_publish_address(agent)
    if host == '0.0.0.0':
        return f'ss -tunlp | grep :{int(agent.port)}'
    return f'ss -tunlp | grep {host}:{int(agent.port)}'


def cleanup_orphan_local_agent_containers(user):
    # Agent containers may outlive the controller process or database reload.
    # Never remove installed agents during passive refresh; only explicit delete
    # requests should uninstall them.
    return


def should_manage_agent_locally(request, agent):
    return is_local_agent_target(request, agent.server_ip) or local_agent_container_exists(agent)


def sync_local_agent_container_states(request, agents):
    visible_agents = []
    for agent in agents:
        if get_agent_ssh_auth_type(agent) == 'manual':
            visible_agents.append(agent)
            continue

        if local_agent_container_exists(agent):
            ensure_controller_on_agent_network()
            ensure_local_agent_uses_agent_network_only(agent)
            running = local_agent_container_is_running(agent)
            port_reachable = local_agent_port_is_reachable(agent) if running else False
            if not running or not port_reachable:
                if agent.connected:
                    agent.connected = False
                    agent.save(update_fields=['connected', 'updated_at'])
                visible_agents.append(agent)
                continue
            if not agent.connected:
                agent.connected = True
                agent.save(update_fields=['connected', 'updated_at'])
        elif is_local_agent_target(request, agent.server_ip):
            if agent.connected:
                agent.connected = False
                agent.save(update_fields=['connected', 'updated_at'])
            visible_agents.append(agent)
            continue

        visible_agents.append(agent)

    return visible_agents


def build_local_agent_container_install_command(agent, password, request):
    script = build_agent_script(
        agent,
        password,
        request,
        controller='http://vitel-backend:8000',
        reported_ip=agent.server_ip,
    )
    script_b64 = base64.b64encode(script.encode('utf-8')).decode('ascii')
    container_name = get_local_agent_container_name(agent)
    legacy_container_name = get_legacy_local_agent_container_name(agent)
    port_mapping = get_local_agent_port_mapping(agent)
    return "\n".join([
        "set -eu",
        f"AGENT_CONTAINER={shlex.quote(container_name)}",
        f"LEGACY_AGENT_CONTAINER={shlex.quote(legacy_container_name)}",
        f"AGENT_IMAGE={shlex.quote(LOCAL_AGENT_IMAGE)}",
        f"AGENT_PORT={int(agent.port)}",
        f"AGENT_PORT_MAPPING={shlex.quote(port_mapping)}",
        f"AGENT_NETWORK={shlex.quote(AGENT_DOCKER_NETWORK)}",
        f"AGENT_VOLUME={shlex.quote(AGENT_DOCKER_VOLUME)}",
        f"CONTROLLER_CONTAINER={shlex.quote(CONTROLLER_CONTAINER_NAME)}",
        'CONTROLLER_HOSTNAME=$(hostname)',
        'echo "Preparing local Docker image: $AGENT_IMAGE"',
        'prepare_agent_image() {',
        '  if docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then echo "Docker image exists: $AGENT_IMAGE"; return 0; fi',
        '  for CONTROLLER_CANDIDATE in "$CONTROLLER_CONTAINER" "$CONTROLLER_HOSTNAME"; do',
        '    if [ -z "$CONTROLLER_CANDIDATE" ]; then continue; fi',
        "    for SOURCE_IMAGE in $(docker container inspect -f '{{.Image}} {{.Config.Image}}' \"$CONTROLLER_CANDIDATE\" 2>/dev/null || true); do",
        '      if [ -z "$SOURCE_IMAGE" ] || [ "$SOURCE_IMAGE" = "$AGENT_IMAGE" ]; then continue; fi',
        '      echo "Trying Docker image source: $SOURCE_IMAGE"',
        '      if docker tag "$SOURCE_IMAGE" "$AGENT_IMAGE"; then echo "Prepared $AGENT_IMAGE from $SOURCE_IMAGE."; return 0; fi',
        '    done',
        '  done',
        f'  for SOURCE_IMAGE in {" ".join(shlex.quote(candidate) for candidate in AGENT_IMAGE_SOURCE_CANDIDATES)}; do',
        '    if [ -z "$SOURCE_IMAGE" ] || [ "$SOURCE_IMAGE" = "$AGENT_IMAGE" ]; then continue; fi',
        '    echo "Trying Docker image source: $SOURCE_IMAGE"',
        '    if docker tag "$SOURCE_IMAGE" "$AGENT_IMAGE"; then echo "Prepared $AGENT_IMAGE from $SOURCE_IMAGE."; return 0; fi',
        '  done',
        '  echo "Unable to prepare $AGENT_IMAGE. Build the application backend image first, or set VITEL_AGENT_SOURCE_IMAGE to an existing local image."',
        '  return 1',
        '}',
        'prepare_agent_image',
        'echo "Checking Docker network: $AGENT_NETWORK"',
        'if docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1; then echo "Docker network exists: $AGENT_NETWORK"; else docker network create "$AGENT_NETWORK"; fi',
        'connect_controller_to_agent_network() {',
        '  for CONTROLLER_CANDIDATE in "$CONTROLLER_CONTAINER" "$CONTROLLER_HOSTNAME"; do',
        '    if [ -z "$CONTROLLER_CANDIDATE" ]; then continue; fi',
        '    if docker container inspect "$CONTROLLER_CANDIDATE" >/dev/null 2>&1; then',
        "      if docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' \"$CONTROLLER_CANDIDATE\" | grep -qx \"$AGENT_NETWORK\"; then",
        '        echo "Controller container already connected to $AGENT_NETWORK: $CONTROLLER_CANDIDATE"',
        '      else',
        '        docker network connect "$AGENT_NETWORK" "$CONTROLLER_CANDIDATE"',
        '        echo "Controller container connected to $AGENT_NETWORK: $CONTROLLER_CANDIDATE"',
        '      fi',
        '      return 0',
        '    fi',
        '  done',
        '  echo "Unable to find the controller container to connect it to $AGENT_NETWORK."',
        '  return 1',
        '}',
        'echo "Connecting controller container to Docker network $AGENT_NETWORK"',
        'connect_controller_to_agent_network',
        'echo "Checking Docker volume: $AGENT_VOLUME"',
        'if docker volume inspect "$AGENT_VOLUME" >/dev/null 2>&1; then echo "Docker volume exists: $AGENT_VOLUME"; else docker volume create "$AGENT_VOLUME"; fi',
        'echo "Removing any previous agent containers."',
        'docker rm -f "$AGENT_CONTAINER" "$LEGACY_AGENT_CONTAINER" >/dev/null 2>&1 || true',
        'for OLD_AGENT in $(docker ps -aq --filter "name=^/vitel-agent-"); do echo "Removing old agent container: $OLD_AGENT"; docker rm -f "$OLD_AGENT" >/dev/null 2>&1 || true; done',
        'echo "Starting agent container: $AGENT_CONTAINER"',
        'docker run -d \\',
        '  --name "$AGENT_CONTAINER" \\',
        '  --privileged \\',
        '  --pid host \\',
        '  --network "$AGENT_NETWORK" \\',
        '  -p "$AGENT_PORT_MAPPING" \\',
        '  -v /var/run/docker.sock:/var/run/docker.sock \\',
        '  -v /:/hostfs \\',
        '  -v /proc:/hostproc:ro \\',
        '  -v "$AGENT_VOLUME:/tmp/vitel-agent" \\',
        f"  -e VITEL_AGENT_SCRIPT_B64={shlex.quote(script_b64)} \\",
        '  "$AGENT_IMAGE" sh -lc \'mkdir -p /tmp/vitel-agent && printf "%s" "$VITEL_AGENT_SCRIPT_B64" | base64 -d > /tmp/vitel-agent/vitel-agent.sh && chmod +x /tmp/vitel-agent/vitel-agent.sh && exec sh /tmp/vitel-agent/vitel-agent.sh\'',
        'echo "Connecting $AGENT_CONTAINER to Docker network $AGENT_NETWORK"',
        'docker network connect "$AGENT_NETWORK" "$AGENT_CONTAINER" 2>/dev/null || echo "Agent container is already connected to $AGENT_NETWORK or Docker skipped the duplicate connection."',
        'sleep 1',
        'if [ "$(docker inspect -f \'{{.State.Running}}\' "$AGENT_CONTAINER" 2>/dev/null)" = "true" ]; then',
        f"  echo 'Agent {agent.name} is running in Docker container {container_name} on {local_agent_host_display(agent)}.'",
        '  echo "Container: $AGENT_CONTAINER"',
        f"  echo 'Host check: {local_agent_host_check(agent)}'",
        'else',
        "  echo 'Agent container failed to start. Recent log output:'",
        '  docker logs --tail 60 "$AGENT_CONTAINER" 2>/dev/null || true',
        '  exit 1',
        'fi',
    ])


def build_local_agent_container_uninstall_command(agent):
    container_name = get_local_agent_container_name(agent)
    legacy_container_name = get_legacy_local_agent_container_name(agent)
    return "\n".join([
        "set +e",
        f"AGENT_CONTAINER={shlex.quote(container_name)}",
        f"LEGACY_AGENT_CONTAINER={shlex.quote(legacy_container_name)}",
        f"AGENT_IMAGE={shlex.quote(LOCAL_AGENT_IMAGE)}",
        f"AGENT_PORT={int(agent.port)}",
        f"AGENT_NETWORK={shlex.quote(AGENT_DOCKER_NETWORK)}",
        f"AGENT_VOLUME={shlex.quote(AGENT_DOCKER_VOLUME)}",
        f"CONTROLLER_CONTAINER={shlex.quote(CONTROLLER_CONTAINER_NAME)}",
        'CONTROLLER_HOSTNAME=$(hostname)',
        'docker rm -f "$AGENT_CONTAINER" "$LEGACY_AGENT_CONTAINER" >/dev/null 2>&1',
        'for OLD_AGENT in $(docker ps -aq --filter "name=^/vitel-agent-"); do docker rm -f "$OLD_AGENT" >/dev/null 2>&1 || true; done',
        'disconnect_controller_from_agent_network() {',
        '  for CONTROLLER_CANDIDATE in "$CONTROLLER_CONTAINER" "$CONTROLLER_HOSTNAME"; do',
        '    if [ -z "$CONTROLLER_CANDIDATE" ]; then continue; fi',
        '    if docker container inspect "$CONTROLLER_CANDIDATE" >/dev/null 2>&1; then',
        '      docker network disconnect "$AGENT_NETWORK" "$CONTROLLER_CANDIDATE" >/dev/null 2>&1 && echo "Controller container disconnected from $AGENT_NETWORK: $CONTROLLER_CANDIDATE" || true',
        '    fi',
        '  done',
        '}',
        'echo "Disconnecting controller container from Docker network $AGENT_NETWORK"',
        'disconnect_controller_from_agent_network',
        'echo "Removing Docker network: $AGENT_NETWORK"',
        'if docker network inspect "$AGENT_NETWORK" >/dev/null 2>&1; then docker network rm "$AGENT_NETWORK" >/dev/null 2>&1 && echo "Docker network removed: $AGENT_NETWORK" || echo "Docker network could not be removed, possibly because another container is still attached: $AGENT_NETWORK"; else echo "Docker network not found: $AGENT_NETWORK"; fi',
        'echo "Removing Docker volume: $AGENT_VOLUME"',
        'if docker volume inspect "$AGENT_VOLUME" >/dev/null 2>&1; then docker volume rm "$AGENT_VOLUME" >/dev/null 2>&1 && echo "Docker volume removed: $AGENT_VOLUME" || echo "Docker volume could not be removed, possibly because it is still in use: $AGENT_VOLUME"; else echo "Docker volume not found: $AGENT_VOLUME"; fi',
        'echo "Removing Docker image: $AGENT_IMAGE"',
        'if docker image inspect "$AGENT_IMAGE" >/dev/null 2>&1; then docker image rm "$AGENT_IMAGE" >/dev/null 2>&1 && echo "Docker image removed: $AGENT_IMAGE" || echo "Docker image could not be removed, possibly because it is still in use: $AGENT_IMAGE"; else echo "Docker image not found: $AGENT_IMAGE"; fi',
        'sleep 1',
        'if [ -n "$(docker ps -aq --filter "name=^/${AGENT_CONTAINER}$")" ]; then',
        '  echo "Agent container still exists: $AGENT_CONTAINER"',
        '  exit 1',
        'fi',
        f"echo 'Agent {agent.name} stopped and removed from this server.'",
        'echo "Container removed: $AGENT_CONTAINER"',
        'echo "Port $AGENT_PORT is no longer published by this agent."',
        'echo "Agent Docker network cleanup requested: $AGENT_NETWORK"',
        'echo "Agent Docker volume cleanup requested: $AGENT_VOLUME"',
        "echo 'No selected agent process remains.'",
    ])


def get_agent_image_download_token(agent):
    return signing.dumps({
        'agent_id': agent.id,
        'owner_id': agent.owner_id,
    }, salt=AGENT_IMAGE_TOKEN_SALT)


def get_agent_image_download_url(request, agent):
    token = get_agent_image_download_token(agent)
    return f'{get_controller_base_url(request)}/api/auth/agent-image/?token={token}'


def unique_nonempty_values(values):
    seen = set()
    unique_values = []
    for value in values:
        value = str(value or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        unique_values.append(value)
    return unique_values


def get_controller_image_source_candidates():
    candidates = []
    for container in get_controller_container_candidates():
        inspect_result = run_docker_command([
            "docker", "container", "inspect", "-f",
            "{{.Image}}\n{{.Config.Image}}",
            container,
        ], timeout=15)
        if not inspect_result.get("success"):
            continue
        candidates.extend(inspect_result.get("output", "").splitlines())
    return unique_nonempty_values(candidates)


def get_agent_image_source_candidates():
    candidates = unique_nonempty_values([
        *get_controller_image_source_candidates(),
        *AGENT_IMAGE_SOURCE_CANDIDATES,
    ])
    return [image for image in candidates if image != LOCAL_AGENT_IMAGE]


def ensure_local_agent_image():
    inspect_result = run_docker_command(['docker', 'image', 'inspect', LOCAL_AGENT_IMAGE], timeout=20)
    attempted_outputs = []
    if not inspect_result.get('success'):
        attempted_outputs.append(inspect_result.get('output', ''))

    last_result = inspect_result
    source_candidates = get_agent_image_source_candidates()
    for source_image in source_candidates:
        tag_result = run_docker_command(['docker', 'tag', source_image, LOCAL_AGENT_IMAGE], timeout=60)
        last_result = tag_result
        attempted_outputs.append(f'$ docker tag {source_image} {LOCAL_AGENT_IMAGE}')
        if tag_result.get('output'):
            attempted_outputs.append(tag_result['output'])
        if tag_result['success']:
            return {
                **tag_result,
                'output': '\n'.join([
                    f'Prepared {LOCAL_AGENT_IMAGE} from {source_image}.',
                    tag_result.get('output', ''),
                ]).strip(),
            }

    if inspect_result.get('success'):
        candidates = ', '.join(source_candidates) or '(none)'
        return {
            **inspect_result,
            'output': '\n'.join([
                f'Using existing {LOCAL_AGENT_IMAGE}.',
                f'No configured backend image source could be tagged. Tried source images: {candidates}',
            ]).strip(),
        }

    candidates = ', '.join(source_candidates) or '(none)'
    return {
        **last_result,
        'output': '\n'.join([
            item for item in attempted_outputs
            if item
        ] + [
            f'Unable to prepare {LOCAL_AGENT_IMAGE}. Build the application backend image first, or set VITEL_AGENT_SOURCE_IMAGE to one of the existing local backend images.',
            f'Tried source images: {candidates}',
        ]).strip(),
        'error': f'Unable to prepare {LOCAL_AGENT_IMAGE} from any known backend image.',
    }


def get_registry_pull_host_for_request(request):
    configured_host = os.getenv('VITEL_REGISTRY_PULL_HOST', '').strip()
    if configured_host:
        return configured_host.rstrip('/')
    controller_url = get_controller_base_url(request)
    hostname = urlparse(controller_url).hostname or get_local_application_host(request)
    port = os.getenv('VITEL_REGISTRY_PORT', '5000').strip() or '5000'
    if ':' in hostname and not hostname.startswith('['):
        hostname = f'[{hostname}]'
    return f'{hostname}:{port}'


def get_agent_registry_repository():
    return os.getenv('VITEL_AGENT_REGISTRY_REPOSITORY', 'vitel-agent').strip() or 'vitel-agent'


def get_agent_registry_tag():
    return os.getenv('VITEL_AGENT_REGISTRY_TAG', 'v1').strip() or 'v1'


def get_agent_registry_push_reference():
    return build_registry_reference(
        get_agent_registry_repository(),
        get_agent_registry_tag(),
        pull_host=get_default_registry_push_host(),
    )


def get_agent_registry_pull_reference(request):
    return build_registry_reference(
        get_agent_registry_repository(),
        get_agent_registry_tag(),
        pull_host=get_registry_pull_host_for_request(request),
    )


def ensure_agent_image_in_registry(request):
    local_result = ensure_local_agent_image()
    if not local_result.get('success'):
        return local_result

    push_reference = get_agent_registry_push_reference()
    tag_result = run_docker_command(['docker', 'tag', LOCAL_AGENT_IMAGE, push_reference], timeout=60)
    if not tag_result.get('success'):
        return {
            **tag_result,
            'error': f'Unable to tag {LOCAL_AGENT_IMAGE} for registry push.',
        }

    push_result = run_docker_command(['docker', 'push', push_reference], timeout=900)
    if not push_result.get('success'):
        return {
            **push_result,
            'error': 'Unable to push the agent image to the local registry. Make sure vitel-registry is running on port 5000.',
        }

    return {
        'success': True,
        'return_code': push_result.get('return_code'),
        'command': f'docker tag {LOCAL_AGENT_IMAGE} {push_reference} && docker push {push_reference}',
        'output': '\n'.join([
            local_result.get('output', ''),
            tag_result.get('output', ''),
            push_result.get('output', ''),
            f'Agent image is available from {get_agent_registry_pull_reference(request)}',
        ]).strip(),
    }

def get_manual_agent_bind_host(request, agent):
    if is_local_agent_target(request, agent.server_ip):
        return '127.0.0.1'
    return str(agent.server_ip or '').strip() or '127.0.0.1'


def build_shell_single_quoted(value):
    return "'" + str(value).replace("'", "'\\''") + "'"


def build_docker_agent_token(agent):
    now = datetime.utcnow()
    environment_id = f'{agent.owner_id}-{agent.id}'
    payload = {
        'sub': f'agent:{environment_id}',
        'environmentId': environment_id,
        'scope': 'docker-agent',
        'jti': str(uuid.uuid4()),
        'iat': now,
        'exp': now + timedelta(days=30),
        'aud': 'docker-agent',
        'iss': 'docker-control',
    }
    return jwt.encode(payload, settings.SECRET_KEY, algorithm='HS256')


AGENT_INSTALL_WITH_DAEMON_JSON = 'with_daemon_json'
AGENT_INSTALL_WITHOUT_DAEMON_JSON = 'without_daemon_json'
AGENT_INSTALL_MODES = {AGENT_INSTALL_WITH_DAEMON_JSON, AGENT_INSTALL_WITHOUT_DAEMON_JSON}


def get_requested_agent_install_mode(request):
    install_mode = str(request.data.get('daemon_json_mode') or AGENT_INSTALL_WITHOUT_DAEMON_JSON).strip()
    return install_mode if install_mode in AGENT_INSTALL_MODES else AGENT_INSTALL_WITHOUT_DAEMON_JSON


def build_manual_agent_docker_run_command(agent, password, request):
    port = int(agent.port)
    container_name = REMOTE_AGENT_CONTAINER_NAME
    pull_reference = get_agent_registry_pull_reference(request)
    control_url = get_agent_control_server_url(request)
    control_ws_url = get_agent_control_server_ws_url(request)
    agent_token = password or build_docker_agent_token(agent)
    return "\n".join([
        'docker run -d \\',
        '  --name ' + shlex.quote(container_name) + ' \\',
        '  --restart unless-stopped \\',
        '  --privileged \\',
        '  --pid host \\',
        '  --network host \\',
        '  -v /var/run/docker.sock:/var/run/docker.sock \\',
        '  -v /:/hostfs \\',
        '  -v /proc:/hostproc:ro \\',
        '  -e AGENT_RUN_AS_ROOT=true \\',
        '  -e AGENT_HOST_FS_ROOT=/hostfs \\',
        '  -e AGENT_APPLICATION_FILESYSTEM_ALLOWED_ROOTS=/ \\',
        '  -e AGENT_HOST_PROC_ROOT=/hostproc \\',
        f'  -e AGENT_PORT={port} \\',
        '  -e CONTROL_SERVER_URL=' + build_shell_single_quoted(control_url) + ' \\',
        '  -e CONTROL_SERVER_WS_URL=' + build_shell_single_quoted(control_ws_url) + ' \\',
        '  -e AGENT_TOKEN=' + build_shell_single_quoted(agent_token) + ' \\',
        '  -e AGENT_ID=' + build_shell_single_quoted(agent.name) + ' \\',
        '  ' + shlex.quote(pull_reference),
    ])


def get_agent_registry_insecure_host(request):
    return get_agent_registry_pull_reference(request).split('/', 1)[0]


def build_manual_agent_daemon_install_command(agent, password, request):
    registry_host = get_agent_registry_insecure_host(request)
    docker_run_command = build_manual_agent_docker_run_command(agent, password, request)
    return "\n".join([
        '# Vitel agent install script starts',
        'set -eu',
        '',
        'REGISTRY_HOST=' + build_shell_single_quoted(registry_host),
        'DAEMON_FILE=/etc/docker/daemon.json',
        'BACKUP_FILE=',
        'DAEMON_CHANGED=0',
        'CREATED_DAEMON_FILE=0',
        'RUNNING_CONTAINERS="$(docker ps -q 2>/dev/null || true)"',
        '',
        'rollback_agent_setup() {',
        '  status="$1"',
        '  if [ "$status" -eq 0 ]; then return 0; fi',
        '  echo "Agent setup failed. Rolling back daemon.json changes made by this script." >&2',
        '  if [ "$DAEMON_CHANGED" = "1" ]; then',
        '    if [ -n "$BACKUP_FILE" ] && [ -f "$BACKUP_FILE" ]; then',
        '      cp "$BACKUP_FILE" "$DAEMON_FILE"',
        '    elif [ "$CREATED_DAEMON_FILE" = "1" ]; then',
        '      rm -f "$DAEMON_FILE"',
        '    fi',
        '    systemctl daemon-reload >/dev/null 2>&1 || true',
        '    systemctl restart docker >/dev/null 2>&1 || true',
        '    for container_id in $RUNNING_CONTAINERS; do',
        '      docker start "$container_id" >/dev/null 2>&1 || true',
        '    done',
        '  fi',
        '}',
        '',
        'finish_agent_setup() {',
        '  status="$?"',
        '  rollback_agent_setup "$status"',
        '  exit "$status"',
        '}',
        'trap finish_agent_setup EXIT',
        '',
        'if [ "$(id -u)" -ne 0 ]; then',
        '  echo "Run this script as root because it may update /etc/docker/daemon.json and restart Docker." >&2',
        '  exit 1',
        'fi',
        'command -v docker >/dev/null 2>&1 || { echo "docker command was not found." >&2; exit 1; }',
        'command -v systemctl >/dev/null 2>&1 || { echo "systemctl command was not found." >&2; exit 1; }',
        'PYTHON_BIN="$(command -v python3 || command -v python || true)"',
        'if [ -z "$PYTHON_BIN" ]; then',
        '  echo "python3 or python is required to safely merge daemon.json." >&2',
        '  exit 1',
        'fi',
        '',
        'NEEDS_DAEMON_UPDATE="$("$PYTHON_BIN" - "$DAEMON_FILE" "$REGISTRY_HOST" <<\'PY\'',
        'import json, os, sys',
        'path, registry = sys.argv[1], sys.argv[2]',
        'if not os.path.exists(path) or os.path.getsize(path) == 0:',
        '    print("yes")',
        '    raise SystemExit(0)',
        'with open(path, "r", encoding="utf-8") as handle:',
        '    data = json.load(handle)',
        'if not isinstance(data, dict):',
        '    raise SystemExit("daemon.json must contain a JSON object.")',
        'registries = data.get("insecure-registries", [])',
        'if not isinstance(registries, list):',
        '    raise SystemExit("daemon.json insecure-registries must be a list.")',
        'print("no" if registry in registries else "yes")',
        'PY',
        ')"',
        '',
        'if [ "$NEEDS_DAEMON_UPDATE" = "yes" ]; then',
        '  mkdir -p /etc/docker',
        '  if [ -f "$DAEMON_FILE" ]; then',
        '    BACKUP_FILE="$DAEMON_FILE.vitel-backup-$(date +%Y%m%d%H%M%S)"',
        '    cp -p "$DAEMON_FILE" "$BACKUP_FILE"',
        '    echo "Backed up existing daemon.json to $BACKUP_FILE"',
        '  else',
        '    CREATED_DAEMON_FILE=1',
        '    printf "{}\\n" > "$DAEMON_FILE"',
        '  fi',
        '  "$PYTHON_BIN" - "$DAEMON_FILE" "$REGISTRY_HOST" <<\'PY\'',
        'import json, sys',
        'path, registry = sys.argv[1], sys.argv[2]',
        'with open(path, "r", encoding="utf-8") as handle:',
        '    content = handle.read().strip()',
        'data = json.loads(content) if content else {}',
        'if not isinstance(data, dict):',
        '    raise SystemExit("daemon.json must contain a JSON object.")',
        'registries = data.get("insecure-registries", [])',
        'if not isinstance(registries, list):',
        '    raise SystemExit("daemon.json insecure-registries must be a list.")',
        'if registry not in registries:',
        '    registries.append(registry)',
        'data["insecure-registries"] = registries',
        'with open(path, "w", encoding="utf-8") as handle:',
        '    json.dump(data, handle, indent=2)',
        '    handle.write("\\n")',
        'PY',
        '  DAEMON_CHANGED=1',
        '  echo "Added $REGISTRY_HOST to daemon.json insecure-registries."',
        '  systemctl daemon-reload',
        '  systemctl restart docker',
        '  DOCKER_READY=0',
        '  for attempt in $(seq 1 30); do',
        '    if docker info >/dev/null 2>&1; then',
        '      DOCKER_READY=1',
        '      break',
        '    fi',
        '    sleep 2',
        '  done',
        '  if [ "$DOCKER_READY" != "1" ]; then',
        '    echo "Docker did not become healthy after restart." >&2',
        '    exit 1',
        '  fi',
        '  for container_id in $RUNNING_CONTAINERS; do',
        '    if ! docker ps -q --no-trunc | grep -q "^$container_id"; then',
        '      docker start "$container_id" >/dev/null 2>&1 || true',
        '    fi',
        '  done',
        'else',
        '  echo "$REGISTRY_HOST already exists in daemon.json insecure-registries. Docker restart skipped."',
        'fi',
        '',
        docker_run_command,
        '',
        'trap - EXIT',
        'echo "Agent container start command completed."',
        '# Vitel agent install script ends',
    ])


def build_manual_agent_install_command(agent, password, request, install_mode=AGENT_INSTALL_WITHOUT_DAEMON_JSON):
    if install_mode == AGENT_INSTALL_WITH_DAEMON_JSON:
        return build_manual_agent_daemon_install_command(agent, password, request)
    return build_manual_agent_docker_run_command(agent, password, request)


def build_manual_agent_install_output(agent, password, request, install_mode=AGENT_INSTALL_WITHOUT_DAEMON_JSON):
    registry_host = get_agent_registry_insecure_host(request)
    if install_mode == AGENT_INSTALL_WITH_DAEMON_JSON:
        intro = [
            'Run this script on the target server as root. It checks /etc/docker/daemon.json, adds the controller registry only if missing, reloads systemd, restarts Docker, waits for Docker health, then starts the agent container.',
            'If the script changes daemon.json and a later step fails, it restores the previous daemon.json and attempts to restart containers that were running before the script began.',
        ]
    else:
        intro = [
            'Run this command on the target server to start the agent container.',
            f'Before running it, make sure /etc/docker/daemon.json already contains "{registry_host}" in insecure-registries so Docker can pull from this controller registry.',
        ]

    return "\n".join([
        f'Agent record created for {agent.name} ({agent.server_ip}:{agent.port}).',
        *intro,
        '',
        build_manual_agent_install_command(agent, password, request, install_mode),
        '',
        f'The agent container uses host networking and AGENT_PORT={agent.port}.',
        'Make sure the control server URLs in the command are reachable from the target server.',
        'After the container starts, it will heartbeat back to this controller, poll deployment jobs every 30 seconds, and appear as connected.',
    ])


def build_manual_agent_cleanup_command():
    repository = shlex.quote(get_agent_registry_repository())
    return "\n".join([
        'docker rm -f ' + shlex.quote(REMOTE_AGENT_CONTAINER_NAME) + ' ' + shlex.quote(LEGACY_REMOTE_AGENT_CONTAINER_NAME) + ' >/dev/null 2>&1 || true',
        'docker image rm -f ' + shlex.quote(LOCAL_AGENT_IMAGE) + ' ' + repository + ' >/dev/null 2>&1 || true',
        "for AGENT_IMAGE in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '/" + get_agent_registry_repository() + ":" + get_agent_registry_tag() + "$' || true); do docker image rm -f \"$AGENT_IMAGE\" >/dev/null 2>&1 || true; done",
    ])


def build_manual_agent_cleanup_output(result=None):
    previous_output = (result or {}).get('output', '')
    return "\n".join([
        previous_output,
        'Agent record removed from this app. Run these commands on the target server to remove agent resources:',
        '',
        build_manual_agent_cleanup_command(),
    ]).strip()


def build_remote_agent_install_command(agent, password, request, agent_dir=None, controller_public_key=''):
    script = build_agent_script(agent, password, request, reported_ip=str(agent.server_ip))
    script_b64 = base64.b64encode(script.encode('utf-8')).decode('ascii')
    agent_dir_value = shlex.quote(agent_dir) if agent_dir else '$HOME/.vitel-agent'
    container_name = REMOTE_AGENT_CONTAINER_NAME
    image_name = get_agent_registry_pull_reference(request)
    return "\n".join([
        "set -eu",
        f"AGENT_DIR={agent_dir_value}",
        f"AGENT_CONTAINER={shlex.quote(container_name)}",
        f"AGENT_IMAGE={shlex.quote(image_name)}",
        f"AGENT_PORT={int(agent.port)}",
        f"CONTROLLER_SSH_PUBLIC_KEY={shlex.quote(controller_public_key)}",
        'if [ -n "$CONTROLLER_SSH_PUBLIC_KEY" ]; then',
        '  echo "Installing controller SSH recovery key for future redeploys."',
        '  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"',
        '  touch "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"',
        '  if grep -qxF "$CONTROLLER_SSH_PUBLIC_KEY" "$HOME/.ssh/authorized_keys"; then echo "Controller SSH recovery key already exists."; else printf "%s\n" "$CONTROLLER_SSH_PUBLIC_KEY" >> "$HOME/.ssh/authorized_keys"; echo "Controller SSH recovery key installed."; fi',
        'fi',
        'SUDO=""; if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; fi',
        'if [ -n "$SUDO" ]; then echo "Validating sudo access for automation."; $SUDO -v; fi',
        'if ! command -v docker >/dev/null 2>&1; then echo "Docker is required on the target server before creating an agent."; exit 1; fi',
        'DOCKER="$SUDO docker"',
        'echo "Checking Docker access on the target server."',
        'if ! $DOCKER ps >/dev/null 2>&1; then echo "Docker is installed, but this SSH user cannot access it through ${SUDO:-direct} docker."; exit 1; fi',
        'echo "Preparing Dockerized Vitel agent: $AGENT_CONTAINER"',
        'mkdir -p "$AGENT_DIR"',
        'stop_existing_pid() { TARGET_PID="$1"; kill "$TARGET_PID" 2>/dev/null || { [ -n "$SUDO" ] && $SUDO -n kill "$TARGET_PID" 2>/dev/null; } || true; }',
        'if [ -f "$AGENT_DIR/vitel-agent.pid" ]; then stop_existing_pid "$(cat "$AGENT_DIR/vitel-agent.pid")"; fi',
        'if [ -f "$AGENT_DIR/vitel-agent-port.pid" ]; then stop_existing_pid "$(cat "$AGENT_DIR/vitel-agent-port.pid")"; fi',
        'rm -f "$AGENT_DIR/vitel-agent.pid" "$AGENT_DIR/vitel-agent-port.pid"',
        'echo "Removing previous agent container if it exists."',
        '$DOCKER rm -f "$AGENT_CONTAINER" >/dev/null 2>&1 || true',
        'echo "Pulling agent image: $AGENT_IMAGE"',
        '$DOCKER pull "$AGENT_IMAGE"',
        'echo "Starting agent container: $AGENT_CONTAINER"',
        '$DOCKER run -d \\',
        '  --name "$AGENT_CONTAINER" \\',
        '  --restart unless-stopped \\',
        '  --privileged \\',
        '  --pid host \\',
        '  --network host \\',
        '  -v /var/run/docker.sock:/var/run/docker.sock \\',
        '  -v /:/hostfs \\',
        '  -v /proc:/hostproc:ro \\',
        f"  -e VITEL_AGENT_SCRIPT_B64={shlex.quote(script_b64)} \\",
        '  "$AGENT_IMAGE" sh -lc \'mkdir -p /tmp/vitel-agent && printf "%s" "$VITEL_AGENT_SCRIPT_B64" | base64 -d > /tmp/vitel-agent/vitel-agent.sh && chmod +x /tmp/vitel-agent/vitel-agent.sh && exec sh /tmp/vitel-agent/vitel-agent.sh\'',
        'sleep 1',
        'if [ "$(docker inspect -f \'{{.State.Running}}\' "$AGENT_CONTAINER" 2>/dev/null)" = "true" ]; then',
        f"  echo 'Agent {agent.name} is running in Docker container {container_name} on port {agent.port}.'",
        '  echo "Container: $AGENT_CONTAINER"',
        '  echo "Image: $AGENT_IMAGE"',
        'else',
        '  echo "Agent container failed to start. Recent log output:"',
        '  $DOCKER logs --tail 80 "$AGENT_CONTAINER" 2>/dev/null || true',
        '  exit 1',
        'fi',
    ])


def build_remote_agent_async_uninstall_command(agent, agent_dir=None):
    return "\n".join([
        'set -e',
        f'AGENT_CONTAINER={shlex.quote(REMOTE_AGENT_CONTAINER_NAME)}',
        f'LEGACY_AGENT_CONTAINER={shlex.quote(LEGACY_REMOTE_AGENT_CONTAINER_NAME)}',
        f'CLEANUP_CONTAINER={shlex.quote(f"vitel-agent-cleanup-{agent.id}")}',
        'AGENT_IMAGE_REF=$(docker inspect -f \'{{.Config.Image}}\' "$AGENT_CONTAINER" 2>/dev/null || true)',
        'AGENT_IMAGE_ID=$(docker inspect -f \'{{.Image}}\' "$AGENT_CONTAINER" 2>/dev/null || true)',
        'docker rm -f "$CLEANUP_CONTAINER" >/dev/null 2>&1 || true',
        'docker pull docker:27-cli >/dev/null',
        'docker run -d --rm \\',
        '  --name "$CLEANUP_CONTAINER" \\',
        '  -v /var/run/docker.sock:/var/run/docker.sock \\',
        '  -e AGENT_CONTAINER="$AGENT_CONTAINER" \\',
        '  -e LEGACY_AGENT_CONTAINER="$LEGACY_AGENT_CONTAINER" \\',
        '  -e AGENT_IMAGE_REF="$AGENT_IMAGE_REF" \\',
        '  -e AGENT_IMAGE_ID="$AGENT_IMAGE_ID" \\',
        '  docker:27-cli sh -lc \'sleep 2; docker rm -f "$AGENT_CONTAINER" "$LEGACY_AGENT_CONTAINER" >/dev/null 2>&1 || true; sleep 1; [ -n "$AGENT_IMAGE_REF" ] && docker image rm -f "$AGENT_IMAGE_REF" >/dev/null 2>&1 || true; [ -n "$AGENT_IMAGE_ID" ] && docker image rm -f "$AGENT_IMAGE_ID" >/dev/null 2>&1 || true\'',
        f"echo 'Agent {agent.name} container and image cleanup queued on the selected server.'",
    ])


def build_remote_agent_uninstall_command(agent, agent_dir=None):
    agent_dir_value = shlex.quote(agent_dir) if agent_dir else '$HOME/.vitel-agent'
    return "\n".join([
        "set +e",
        f"AGENT_DIR={agent_dir_value}",
        f"AGENT_CONTAINER={shlex.quote(REMOTE_AGENT_CONTAINER_NAME)}",
        f"LEGACY_AGENT_CONTAINER={shlex.quote(LEGACY_REMOTE_AGENT_CONTAINER_NAME)}",
        'SUDO=""; if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO=sudo; $SUDO -v 2>/dev/null || true; fi',
        'DOCKER="docker"; if [ -n "$SUDO" ]; then DOCKER="$SUDO -n docker"; fi',
        'AGENT_IMAGE_REF=$($DOCKER inspect -f \'{{.Config.Image}}\' "$AGENT_CONTAINER" 2>/dev/null || true)',
        'AGENT_IMAGE_ID=$($DOCKER inspect -f \'{{.Image}}\' "$AGENT_CONTAINER" 2>/dev/null || true)',
        'AGENT_PID=""',
        'PORT_PID=""',
        'stop_pid() { TARGET_PID="$1"; kill "$TARGET_PID" 2>/dev/null || { [ -n "$SUDO" ] && $SUDO -n kill "$TARGET_PID" 2>/dev/null; } || true; }',
        'pid_is_running() { TARGET_PID="$1"; kill -0 "$TARGET_PID" >/dev/null 2>&1 || { [ -n "$SUDO" ] && $SUDO -n kill -0 "$TARGET_PID" >/dev/null 2>&1; }; }',
        'echo "Removing Dockerized agent container: $AGENT_CONTAINER"',
        'if command -v docker >/dev/null 2>&1; then $DOCKER rm -f "$AGENT_CONTAINER" "$LEGACY_AGENT_CONTAINER" >/dev/null 2>&1 && echo "Container removed: $AGENT_CONTAINER" || echo "Agent container not found or could not be removed: $AGENT_CONTAINER"; else echo "Docker is not installed; skipping agent container removal."; fi',
        'if [ -n "$AGENT_IMAGE_REF" ]; then $DOCKER image rm -f "$AGENT_IMAGE_REF" >/dev/null 2>&1 && echo "Image removed: $AGENT_IMAGE_REF" || true; fi',
        'if [ -n "$AGENT_IMAGE_ID" ]; then $DOCKER image rm -f "$AGENT_IMAGE_ID" >/dev/null 2>&1 || true; fi',
        'if [ -f "$AGENT_DIR/vitel-agent.pid" ]; then AGENT_PID=$(cat "$AGENT_DIR/vitel-agent.pid"); stop_pid "$AGENT_PID"; fi',
        'if [ -f "$AGENT_DIR/vitel-agent-port.pid" ]; then PORT_PID=$(cat "$AGENT_DIR/vitel-agent-port.pid"); stop_pid "$PORT_PID"; fi',
        'sleep 1',
        'if [ -n "$PORT_PID" ] && pid_is_running "$PORT_PID"; then stop_pid "$PORT_PID"; fi',
        'if [ -n "$AGENT_PID" ] && pid_is_running "$AGENT_PID"; then stop_pid "$AGENT_PID"; fi',
        'rm -rf "$AGENT_DIR"',
        f"echo 'Agent {agent.name} stopped and removed from this server.'",
        'echo "Agent directory removed: $AGENT_DIR"',
        'if command -v docker >/dev/null 2>&1 && $DOCKER ps -aq --filter "name=^/${AGENT_CONTAINER}$" | grep -q .; then echo "Agent container still exists: $AGENT_CONTAINER"; exit 1; fi',
        'if [ -n "$AGENT_PID" ] && pid_is_running "$AGENT_PID"; then echo "Legacy agent process still running: $AGENT_PID"; exit 1; fi',
        'if [ -n "$PORT_PID" ] && pid_is_running "$PORT_PID"; then echo "Legacy agent port process still running: $PORT_PID"; exit 1; fi',
        "echo 'No selected agent process remains.'",
    ])



def build_container_run_command(request):
    image = request.data.get('image', '').strip()
    name = request.data.get('name', '').strip()
    restart_policy = request.data.get('restart_policy', '').strip()
    network = request.data.get('network', 'bridge').strip() or 'bridge'
    command_args = as_list(request.data.get('command_args'))
    command = ['docker', 'run', '-d']

    if name:
        command.extend(['--name', name])
    if restart_policy:
        command.extend(['--restart', restart_policy])
    if network:
        command.extend(['--network', network])

    for port in as_list(request.data.get('ports')):
        if isinstance(port, dict):
            host_port = str(port.get('host_port', '')).strip()
            container_port = str(port.get('container_port', '')).strip()
            protocol = str(port.get('protocol', 'tcp')).strip()
            if host_port and container_port:
                command.extend(['-p', f'{host_port}:{container_port}/{protocol}'])
        elif str(port).strip():
            command.extend(['-p', str(port).strip()])

    for volume in as_list(request.data.get('volumes')):
        if isinstance(volume, dict):
            source = str(volume.get('source', '')).strip()
            target = str(volume.get('target', '')).strip()
            mode = str(volume.get('mode', '')).strip()
            if source and target:
                mount = f'{source}:{target}'
                if mode:
                    mount += f':{mode}'
                command.extend(['-v', mount])
        elif str(volume).strip():
            command.extend(['-v', str(volume).strip()])

    for env in as_list(request.data.get('environment')):
        if isinstance(env, dict):
            for key, value in env.items():
                command.extend(['-e', f'{key}={value}'])
        elif str(env).strip():
            command.extend(['-e', str(env).strip()])

    command.append(image)
    command.extend(str(arg) for arg in command_args if str(arg).strip())
    return command


def get_dockerfile_build_command(image_name, dockerfile_path, local=True):
    if local:
        dockerfile = Path(dockerfile_path).expanduser().resolve()
        if not dockerfile.is_file():
            return None, f'Dockerfile not found: {dockerfile}'
        return ['docker', 'build', '-t', image_name, '-f', str(dockerfile), str(dockerfile.parent)], ''

    requested_path = posixpath.normpath('/' + str(dockerfile_path or '').strip().lstrip('/'))
    dockerfile = '/hostfs' + requested_path
    context_dir = os.path.dirname(dockerfile.rstrip('/')) or '.'
    return ['docker', 'build', '-t', image_name, '-f', dockerfile, context_dir], ''


def merge_docker_step_results(results):
    output = []
    commands = []
    for result in results:
        command = result.get('command', '')
        if command:
            commands.append(command)
            output.append(f'$ {command}')
        if result.get('output'):
            output.append(result['output'])
    final = results[-1] if results else {'success': False, 'return_code': None}
    return {
        **final,
        'command': ' && '.join(commands),
        'output': '\n'.join(output).strip(),
    }


def get_request_value(request, key, default=''):
    source = request.GET if request.method == 'GET' else request.data
    return source.get(key, default)


def get_docker_target_context(request):
    server_id = str(get_request_value(request, 'server_id', 'local') or 'local').strip()
    if not server_id or server_id == 'local':
        return None, '', False, None

    try:
        agent = Agent.objects.get(owner=request.user, id=server_id, is_deleted=False)
    except (Agent.DoesNotExist, ValueError):
        return None, '', False, Response({
            'success': False,
            'error': 'Selected server was not found.',
        }, status=status.HTTP_404_NOT_FOUND)

    password = decode_agent_secret(getattr(agent, 'password_secret', ''))
    if not password:
        return None, '', False, Response({
            'success': False,
            'error': 'Stored agent password is unavailable. Recreate the agent before running remote Docker operations.',
        }, status=status.HTTP_400_BAD_REQUEST)

    return agent, password, not should_manage_agent_locally(request, agent), None


def run_target_docker_command(agent, password, remote_agent, command, timeout=180):
    if remote_agent:
        return run_agent_command(agent, password, command, timeout=timeout)
    return run_docker_command(command, timeout=timeout)


def get_container_shell(container_id, prompt_name="container"):
    """Return the best available shell command for a container."""
    result = run_docker_command(
        ['docker', 'exec', container_id, 'sh', '-lc', 'command -v bash || command -v sh'],
        timeout=10,
    )
    prompt_name = re.sub(r"[^a-zA-Z0-9_.-]+", "-", prompt_name or "container").strip("-") or "container"
    prompt = f"root@{prompt_name}:/# "
    if result['success'] and result['output']:
        shell = result['output'].splitlines()[0].strip()
        if shell:
            if shell.endswith('bash'):
                return [
                    'env',
                    'TERM=dumb',
                    f'PS1={prompt}',
                    shell,
                    '--noprofile',
                    '--norc',
                    '-i',
                ]
            return ['env', 'TERM=dumb', f'PS1={prompt}', shell, '-i']
    return ['env', 'TERM=dumb', f'PS1={prompt}', '/bin/sh', '-i']


def start_container_shell(container_id, container_name="container", user=None):
    """Start an interactive shell session in a container."""
    master_fd = None
    slave_fd = None
    try:
        shell_command = get_container_shell(container_id, container_name)
        master_fd, slave_fd = pty.openpty()
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))

        process = subprocess.Popen(
            ['docker', 'exec', '-it', container_id, *shell_command],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = None

        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        startup_output = ""
        startup_deadline = time.time() + 5
        while time.time() < startup_deadline:
            if process.poll() is not None:
                break
            readable, _, _ = select.select([master_fd], [], [], 0.1)
            if not readable:
                continue
            while True:
                try:
                    chunk = os.read(master_fd, 4096)
                except BlockingIOError:
                    break
                except OSError:
                    break
                if not chunk:
                    break
                startup_output += chunk.decode(errors="replace")
            if startup_output.strip():
                break

        startup_output = clean_terminal_output(startup_output)
        if process.poll() is not None:
            raise RuntimeError(startup_output.strip() or "Container shell exited before it was ready.")

        session_id = uuid.uuid4().hex
        
        with CONTAINER_SHELLS_LOCK:
            CONTAINER_SHELLS[session_id] = {
                'process': process,
                'fd': master_fd,
                'container_id': container_id,
                'user_id': getattr(user, 'id', None),
                'shell': ' '.join(shell_command),
                'output_buffer': '',
                'closed': False,
                'startup_output': startup_output,
            }
        
        return session_id, startup_output, None
    except Exception as exc:
        if slave_fd is not None:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        return None, "", str(exc)


def start_remote_volume_shell(
    container_id,
    mount_source,
    mount_name="",
    mount_destination="",
    user=None,
    agent=None,
    password="",
):
    safe_label = re.sub(r"[^a-zA-Z0-9_.-]+", "-", mount_name or mount_destination or "volume").strip("-")[:48] or "volume"
    session_container_name = f"vitel-volume-shell-{safe_label}-{uuid.uuid4().hex[:8]}"
    terminal_path = mount_source if mount_source.startswith("/") else "/" + mount_source.lstrip("/")
    volume_spec = f"{mount_source}:{terminal_path}"
    image_result = ensure_volume_helper_image(agent, password, True)
    if not image_result['success']:
        return None, "", "", "", "", image_result.get('output') or 'Failed to pull the volume helper image.'

    display_command = [
        "docker", "run", "--rm", "-d",
        "--name", session_container_name,
        "-v", volume_spec,
        "--pull=never",
        VOLUME_HELPER_IMAGE,
        "sh", "-lc", "while :; do sleep 3600; done",
    ]
    start_result = run_target_docker_command(agent, password, True, display_command, timeout=60)
    if not start_result['success']:
        remove_volume_helper_image(agent, password, True)
        return None, "", "", "", "", start_result.get('output') or 'Failed to start the remote volume helper container.'

    path_result = run_target_docker_command(
        agent,
        password,
        True,
        [
            "docker", "exec", session_container_name, "sh", "-lc",
            'target="$1"; if [ -d "$target" ]; then cd "$target"; '
            'elif [ -e "$target" ]; then cd "$(dirname "$target")"; else cd /; fi; pwd',
            "sh", terminal_path,
        ],
        timeout=30,
    )
    current_path = path_result.get('output', '').splitlines()[0].strip() if path_result['success'] and path_result.get('output') else '/'
    session_id = uuid.uuid4().hex

    with CONTAINER_SHELLS_LOCK:
        CONTAINER_SHELLS[session_id] = {
            "remote_volume": True,
            "agent": agent,
            "password": password,
            "container_id": container_id,
            "user_id": getattr(user, "id", None),
            "shell": shlex.join(display_command),
            "output_buffer": "",
            "closed": False,
            "temporary_container": session_container_name,
            "temporary_image": VOLUME_HELPER_IMAGE,
            "terminal_path": current_path,
            "startup_output": "",
        }

    return session_id, session_container_name, current_path, shlex.join(display_command), "", None


def start_volume_shell(
    container_id,
    mount_source,
    mount_name="",
    mount_destination="",
    user=None,
    agent=None,
    password="",
    remote_agent=False,
):
    """Start an interactive Alpine shell with one mounted container volume."""
    if remote_agent:
        return start_remote_volume_shell(
            container_id,
            mount_source,
            mount_name,
            mount_destination,
            user,
            agent,
            password,
        )

    master_fd = None
    slave_fd = None
    session_container_name = ""
    try:
        image_result = ensure_volume_helper_image()
        if not image_result['success']:
            raise RuntimeError(image_result.get('output') or 'Failed to pull the volume helper image.')

        safe_label = re.sub(r"[^a-zA-Z0-9_.-]+", "-", mount_name or mount_destination or "volume").strip("-")[:48] or "volume"
        session_container_name = f"vitel-volume-shell-{safe_label}-{uuid.uuid4().hex[:8]}"
        terminal_path = mount_source if mount_source.startswith("/") else "/" + mount_source.lstrip("/")
        volume_spec = f"{mount_source}:{terminal_path}"
        display_command = [
            "docker", "run", "--rm", "-it",
            "-v", volume_spec,
            "--pull=never", VOLUME_HELPER_IMAGE, "sh",
        ]
        shell_display = shlex.join(display_command)

        master_fd, slave_fd = pty.openpty()
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))

        quoted_terminal_path = shlex.quote(terminal_path)
        quoted_terminal_prompt = shlex.quote(f"{terminal_path} # ")
        shell_startup_command = (
            f"target={quoted_terminal_path}; "
            "if [ -d \"$target\" ]; then cd \"$target\"; "
            "elif [ -e \"$target\" ]; then cd \"$(dirname \"$target\")\"; "
            "else cd /; fi; "
            f"export PS1={quoted_terminal_prompt}; "
            "exec sh -i"
        )
        process = subprocess.Popen(
            [
                "docker", "run", "--rm", "-it",
                "--name", session_container_name,
                "-v", volume_spec,
                "-e", "TERM=dumb",
                "--pull=never", VOLUME_HELPER_IMAGE, "sh", "-lc",
                shell_startup_command,
            ],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = None

        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        startup_output = ""
        startup_deadline = time.time() + 5
        while time.time() < startup_deadline:
            if process.poll() is not None:
                break
            readable, _, _ = select.select([master_fd], [], [], 0.1)
            if not readable:
                continue
            while True:
                try:
                    chunk = os.read(master_fd, 4096)
                except BlockingIOError:
                    break
                except OSError:
                    break
                if not chunk:
                    break
                startup_output += chunk.decode(errors="replace")
            if startup_output.strip():
                break

        startup_output = clean_terminal_output(startup_output)
        if process.poll() is not None:
            raise RuntimeError(startup_output.strip() or "Volume shell exited before it was ready.")

        session_id = uuid.uuid4().hex

        with CONTAINER_SHELLS_LOCK:
            CONTAINER_SHELLS[session_id] = {
                "process": process,
                "fd": master_fd,
                "container_id": container_id,
                "user_id": getattr(user, "id", None),
                "shell": shell_display,
                "output_buffer": "",
                "closed": False,
                "temporary_container": session_container_name,
                "temporary_image": VOLUME_HELPER_IMAGE,
                "terminal_path": terminal_path,
                "startup_output": startup_output,
            }

        return session_id, session_container_name, terminal_path, shell_display, startup_output, None
    except Exception as exc:
        if session_container_name:
            run_docker_command(["docker", "rm", "-f", session_container_name], timeout=10)
        remove_volume_helper_image()
        if slave_fd is not None:
            try:
                os.close(slave_fd)
            except OSError:
                pass
        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass
        return None, "", "", "", "", str(exc)


def shell_session_is_owned_by_user(session, user):
    owner_id = session.get('user_id')
    return owner_id is None or (user and getattr(user, 'id', None) == owner_id)


TERMINAL_COMPLETION_SCRIPT = r'''
prefix="$1"
mode="$2"
requested_cwd="$3"
cd -- "$requested_cwd" 2>/dev/null || cd /

if [ "$mode" = "command" ]; then
  old_ifs="$IFS"
  IFS=:
  for path_dir in $PATH; do
    [ -d "$path_dir" ] || continue
    for candidate in "$path_dir"/"$prefix"*; do
      [ -f "$candidate" ] && [ -x "$candidate" ] && basename "$candidate"
    done
  done
  IFS="$old_ifs"
  for builtin_name in cd echo exit export help history jobs kill logout printf pwd read set source test type ulimit umask unset wait; do
    case "$builtin_name" in "$prefix"*) printf '%s\n' "$builtin_name";; esac
  done
  exit 0
fi

case "$prefix" in
  */*) directory_part="${prefix%/*}"; base_part="${prefix##*/}"; [ -n "$directory_part" ] || directory_part="/";;
  *) directory_part="."; base_part="$prefix";;
esac

for candidate in "$directory_part"/"$base_part"*; do
  [ -e "$candidate" ] || continue
  if [ "$directory_part" = "." ]; then
    display_name="${candidate#./}"
  elif [ "$directory_part" = "/" ]; then
    display_name="/${candidate##*/}"
  else
    display_name="${directory_part%/}/${candidate##*/}"
  fi
  [ -d "$candidate" ] && display_name="${display_name}/"
  printf '%s\n' "$display_name"
done
'''


def parse_terminal_completion_input(input_text):
    text = str(input_text or '')
    token_match = re.search(r'(^|[\s;&|])([^\s;&|]*)$', text)
    token = token_match.group(2) if token_match else ''
    token_start = token_match.start(2) if token_match else len(text)
    before_token = text[:token_start]
    mode = 'command' if not before_token.strip() or re.search(r'(?:^|[;&|])\s*$', before_token) else 'path'
    return text, token, token_start, mode


def format_terminal_completions(input_text, token, token_start, mode, output):
    matches = sorted(set(line.strip() for line in str(output or '').splitlines() if line.strip()))[:200]
    if not matches:
        return {'input': input_text, 'matches': [], 'completed': False}

    common_prefix = os.path.commonprefix(matches)
    replacement = common_prefix if len(common_prefix) > len(token) else token
    if len(matches) == 1:
        replacement = matches[0]
        if not replacement.endswith('/'):
            replacement += ' '

    return {
        'input': input_text[:token_start] + replacement,
        'matches': matches,
        'completed': replacement != token,
        'mode': mode,
    }


def run_terminal_completion_command(command, cwd='/', agent=None, password='', remote_agent=False):
    if remote_agent:
        return run_target_docker_command(agent, password, True, command, timeout=30)
    if command and command[0] == 'docker':
        return run_docker_command(command, timeout=30)
    try:
        process = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        return {
            'success': process.returncode == 0,
            'return_code': process.returncode,
            'output': ((process.stdout or '') + ('\n' if process.stdout and process.stderr else '') + (process.stderr or '')).strip(),
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {'success': False, 'return_code': None, 'output': str(exc)}


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def terminal_autocomplete(request):
    """Return command or path completions for a server, container, or volume terminal."""
    input_text, token, token_start, mode = parse_terminal_completion_input(request.data.get('input'))
    session_id = str(request.data.get('session_id') or '').strip()
    cwd = str(request.data.get('cwd') or '/').strip() or '/'

    if session_id:
        with CONTAINER_SHELLS_LOCK:
            session = CONTAINER_SHELLS.get(session_id)
            if not session or not shell_session_is_owned_by_user(session, request.user) or session.get('closed'):
                return Response({'error': 'Session not found.'}, status=status.HTTP_404_NOT_FOUND)
            container_id = session.get('temporary_container') or session.get('container_id')
            session_cwd = session.get('terminal_path') or cwd
            agent = session.get('agent')
            password = session.get('password', '')
            remote_agent = bool(session.get('remote_volume'))

        command = [
            'docker', 'exec',
            container_id, 'sh', '-lc', TERMINAL_COMPLETION_SCRIPT,
            'vitel-complete', token, mode, session_cwd,
        ]
        result = run_terminal_completion_command(command, session_cwd, agent, password, remote_agent)
    else:
        if not user_has_operation(request.user, 'manage_agents'):
            return Response({'error': 'You do not have permission to use server terminal completion.'}, status=status.HTTP_403_FORBIDDEN)
        agent, password, remote_agent, error_response = get_docker_target_context(request)
        if error_response:
            return error_response
        command = ['sh', '-lc', TERMINAL_COMPLETION_SCRIPT, 'vitel-complete', token, mode, cwd]
        result = run_terminal_completion_command(command, cwd, agent, password, remote_agent)

    if not result.get('success'):
        return Response({
            'error': result.get('output') or 'Unable to calculate terminal completions.',
        }, status=status.HTTP_400_BAD_REQUEST)
    return Response(format_terminal_completions(input_text, token, token_start, mode, result.get('output')))


def send_shell_command(session_id, command, user=None):
    """Send a command to the container shell."""
    with CONTAINER_SHELLS_LOCK:
        session = CONTAINER_SHELLS.get(session_id)
        if not session:
            return False, 'Session not found'
        if not shell_session_is_owned_by_user(session, user):
            return False, 'Session not found'
        
        if session['closed']:
            return False, 'Session is closed'

        if session.get('remote_volume'):
            agent = session.get('agent')
            password = session.get('password', '')
            temporary_container = session.get('temporary_container')
            current_path = session.get('terminal_path') or '/'
        else:
            agent = None
            password = ''
            temporary_container = ''
            current_path = ''

        fd = session.get('fd')

    if temporary_container:
        cwd_marker = f"__VITEL_CWD_{uuid.uuid4().hex}__"
        command_script = (
            f"{command}\n"
            "command_status=$?\n"
            f"printf '\\n{cwd_marker}\\n'\n"
            "pwd\n"
            'exit "$command_status"'
        )
        result = run_target_docker_command(
            agent,
            password,
            True,
            [
                'docker', 'exec', '-w', current_path,
                temporary_container, 'sh', '-lc', command_script,
            ],
            timeout=180,
        )
        output = result.get('output', '')
        next_path = current_path
        marker_index = output.rfind(cwd_marker)
        if marker_index >= 0:
            path_output = output[marker_index + len(cwd_marker):].strip().splitlines()
            if path_output:
                next_path = path_output[0].strip() or current_path
            output = output[:marker_index].rstrip()
        with CONTAINER_SHELLS_LOCK:
            active_session = CONTAINER_SHELLS.get(session_id)
            if active_session:
                active_session['terminal_path'] = next_path
                if output:
                    active_session['output_buffer'] += output + '\n'
        if result.get('return_code') is None:
            return False, result.get('output') or 'Remote shell command failed.'
        return True, None

    try:
        os.write(fd, (command + '\n').encode())
        return True, None
    except (BrokenPipeError, OSError) as exc:
        return False, str(exc)


def read_shell_output(session_id, user=None, timeout=0.5):
    """Read available output from the container shell."""
    with CONTAINER_SHELLS_LOCK:
        session = CONTAINER_SHELLS.get(session_id)
        if not session:
            return None, 'Session not found'
        if not shell_session_is_owned_by_user(session, user):
            return None, 'Session not found'
        
        if session.get('remote_volume'):
            output = session.get('output_buffer', '')
            session['output_buffer'] = ''
            return output, None

        process = session['process']
        fd = session['fd']
    
    try:
        import select
        readable, _, _ = select.select([fd], [], [], timeout)
        
        output = ''
        if readable:
            while True:
                try:
                    chunk = os.read(fd, 4096)
                except BlockingIOError:
                    break
                except OSError:
                    break
                if not chunk:
                    break
                output += chunk.decode(errors='replace')

        output = clean_terminal_output(output)
        
        if process.poll() is not None:
            with CONTAINER_SHELLS_LOCK:
                session['closed'] = True
            return output, 'process_ended'
        
        return output, None
    except Exception as exc:
        return '', str(exc)


def close_shell_session(session_id, user=None):
    """Close a container shell session."""
    with CONTAINER_SHELLS_LOCK:
        session = CONTAINER_SHELLS.get(session_id)
        if not session:
            return False, 'Session not found'
        if not shell_session_is_owned_by_user(session, user):
            return False, 'Session not found'
        CONTAINER_SHELLS.pop(session_id, None)
        
        remote_volume = bool(session.get('remote_volume'))
        process = session.get('process')
        fd = session.get('fd')
        temporary_container = session.get('temporary_container')
        temporary_image = session.get('temporary_image')
        agent = session.get('agent')
        password = session.get('password', '')
        session['closed'] = True

    if remote_volume:
        if temporary_container:
            run_target_docker_command(
                agent,
                password,
                True,
                ['docker', 'rm', '-f', temporary_container],
                timeout=30,
            )
        if temporary_image:
            remove_volume_helper_image(agent, password, True)
        return True, None

    try:
        process.terminate()
        process.wait(timeout=2)
    except Exception as exc:
        try:
            process.kill()
        except Exception:
            pass
    finally:
        if temporary_container:
            run_docker_command(['docker', 'rm', '-f', temporary_container], timeout=10)
        if temporary_image:
            remove_volume_helper_image()
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
    return True, None



def parse_json_lines(output):
    items = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            items.append({'raw': line})
    return items


def serialize_deployment(deployment):
    target = deployment.target_agent
    return {
        'id': deployment.id,
        'name': deployment.name,
        'project_name': deployment.project_name,
        'compose_file': deployment.compose_file,
        'target_agent': AgentSerializer(target).data if target else None,
        'status': deployment.status,
        'last_output': deployment.last_output,
        'created_at': deployment.created_at.isoformat() if deployment.created_at else None,
        'updated_at': deployment.updated_at.isoformat() if deployment.updated_at else None,
    }


def normalize_compose_project_name(name):
    project = re.sub(r'[^a-zA-Z0-9_-]+', '-', name.strip().lower()).strip('-_')
    return project or f'deployment-{uuid.uuid4().hex[:8]}'


def get_compose_command():
    docker_compose = shutil.which('docker-compose')
    if docker_compose:
        result = run_docker_command([docker_compose, 'version'], timeout=10)
        if result['success']:
            return [docker_compose]

    docker = shutil.which('docker') or 'docker'
    result = run_docker_command([docker, 'compose', 'version'], timeout=10)
    if result['success']:
        return [docker, 'compose']

    return None


def get_deployment_for_user(user, deployment_id):
    try:
        return Deployment.objects.get(owner=user, id=deployment_id)
    except (Deployment.DoesNotExist, ValueError):
        return None


def validate_compose_path(value, local=True):
    raw_value = str(value or '').strip()
    if not raw_value:
        return '', 'Docker Compose file path is required.'
    if Path(raw_value).suffix.lower() not in ['.yml', '.yaml']:
        return '', 'Select a Docker Compose .yml or .yaml file.'
    if not local:
        return raw_value, ''
    compose_file = Path(raw_value).expanduser().resolve()
    if not compose_file.is_file():
        return '', f'Docker Compose file not found: {compose_file}'
    return str(compose_file), ''

def append_deploy_job_output(job_id, text):
    with DEPLOY_JOBS_LOCK:
        job = DEPLOY_JOBS.get(job_id)
        if job:
            job['output'] += text


def run_local_deploy_step(command, timeout=1800):
    display = shlex.join(command)
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            env=get_docker_subprocess_env(),
        )
        return {
            'success': result.returncode == 0,
            'return_code': result.returncode,
            'command': display,
            'output': ((result.stdout or '') + '\n' + (result.stderr or '')).strip(),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            'success': False,
            'return_code': None,
            'command': display,
            'output': ((exc.stdout or '') + '\n' + (exc.stderr or '') + f'\nCommand timed out after {timeout} seconds.').strip(),
        }
    except OSError as exc:
        return {'success': False, 'return_code': None, 'command': display, 'output': str(exc)}


def run_deploy_step(deployment, password, remote_agent, label, command):
    display = shlex.join(command) if isinstance(command, list) else str(command)
    if remote_agent:
        result = run_agent_command(deployment.target_agent, password, display, timeout=1800)
    else:
        result = run_local_deploy_step(command, timeout=1800)
    return label, display, result


def get_deploy_step_commands(deployment, remote_agent):
    compose = ['docker', 'compose'] if remote_agent else (get_compose_command() or ['docker', 'compose'])
    base = [*compose, '-p', deployment.project_name, '-f', deployment.compose_file]
    return [
        ('Validate compose file', [*base, 'config']),
        ('Build compose images', [*base, 'build', '--progress', 'plain']),
        ('Create networks, volumes, and containers', [*base, 'up', '-d', '--remove-orphans']),
    ]


def get_deployment_down_command(deployment, remote_agent):
    compose = ['docker', 'compose'] if remote_agent else (get_compose_command() or ['docker', 'compose'])
    return [*compose, '-p', deployment.project_name, '-f', deployment.compose_file, 'down', '--remove-orphans']


def remove_deployment_runtime(deployment):
    remote_agent = bool(deployment.target_agent_id)
    password = ''
    if remote_agent:
        if not deployment.target_agent.connected:
            return {
                'success': False,
                'output': 'Target server agent is down. Redeploy the agent before deleting this deployment.',
            }
        password = decode_agent_secret(getattr(deployment.target_agent, 'password_secret', ''))
        if not password:
            return {
                'success': False,
                'output': 'Stored agent password is unavailable. Redeploy the agent first.',
            }
    elif not get_compose_command():
        return {
            'success': False,
            'output': 'Docker Compose is not installed in the backend container.',
        }

    command = get_deployment_down_command(deployment, remote_agent)
    step_name, display, result = run_deploy_step(deployment, password, remote_agent, 'Remove deployment runtime', command)
    output = f'== {step_name} ==' + chr(10) + '$ ' + display + chr(10)
    if result.get('output'):
        output += result['output'].rstrip() + chr(10)
    return {**result, 'output': output.strip()}


def run_deploy_job(job_id, deployment_id):
    try:
        deployment = Deployment.objects.get(id=deployment_id)
    except Deployment.DoesNotExist:
        append_deploy_job_output(job_id, '\nDeployment record was removed.\n')
        with DEPLOY_JOBS_LOCK:
            if job_id in DEPLOY_JOBS:
                DEPLOY_JOBS[job_id]['running'] = False
                DEPLOY_JOBS[job_id]['success'] = False
        return

    password = ''
    remote_agent = bool(deployment.target_agent_id)
    if remote_agent:
        password = decode_agent_secret(getattr(deployment.target_agent, 'password_secret', ''))
        if not password:
            append_deploy_job_output(job_id, '\nStored agent password is unavailable. Redeploy the agent first.\n')
            success = False
            return_code = None
        else:
            success = True
            return_code = 0
    else:
        success = True
        return_code = 0

    if success:
        for label, command in get_deploy_step_commands(deployment, remote_agent):
            step_name, display, result = run_deploy_step(deployment, password, remote_agent, label, command)
            append_deploy_job_output(job_id, f'\n== {step_name} ==\n$ {display}\n')
            if result.get('output'):
                append_deploy_job_output(job_id, result['output'].rstrip() + '\n')
            if not result.get('success'):
                success = False
                return_code = result.get('return_code')
                append_deploy_job_output(job_id, f'\nDeployment failed during step: {step_name}.\n')
                break

    with DEPLOY_JOBS_LOCK:
        job = DEPLOY_JOBS.get(job_id)
        stopped = job.get('stopped', False) if job else False
        if job:
            job['running'] = False
            job['success'] = bool(success and not stopped)
            job['return_code'] = return_code
            job['process'] = None
            if stopped:
                job['output'] += '\nDeployment stopped.\n'
            elif success:
                job['output'] += '\nDeployment completed.\n'
            else:
                job['output'] += '\nDeployment failed.\n'
            deployment.last_output = job['output']
            deployment.status = 'stopped' if stopped else ('running' if success else 'failed')
            deployment.save(update_fields=['last_output', 'status', 'updated_at'])

def list_compose_containers(project_name, agent=None, password=''):
    remote_agent = bool(agent)
    result = run_target_docker_command(agent, password, remote_agent, [
        'docker', 'ps', '-a',
        '--filter', f'label=com.docker.compose.project={project_name}',
        '--format', '{{json .}}',
    ])
    return parse_json_lines(result['output']) if result['success'] else []


def inspect_container(container_id, agent=None, password=''):
    remote_agent = bool(agent)
    result = run_target_docker_command(agent, password, remote_agent, ['docker', 'inspect', container_id])
    if not result['success']:
        return None
    try:
        data = json.loads(result['output'])
        return data[0] if data else None
    except (json.JSONDecodeError, IndexError):
        return None


def summarize_container(container, agent=None, password='', application_host=''):
    container_id = container.get('ID') or container.get('Id') or container.get('id')
    detail = inspect_container(container_id, agent, password) if container_id else None
    networks = []
    mounts = []
    ports = []
    access_urls = []
    image = container.get('Image') or ''
    image_id = container.get('ImageID') or ''
    name = (container.get('Names') or container.get('Name') or '').lstrip('/')
    running = False

    if detail:
        name = detail.get('Name', '').lstrip('/') or name
        image = detail.get('Config', {}).get('Image') or image
        image_id = detail.get('Image', '') or image_id
        running = bool(detail.get('State', {}).get('Running'))
        networks = [
            {
                'name': network_name,
                'id': network.get('NetworkID', ''),
                'ip_address': network.get('IPAddress', ''),
            }
            for network_name, network in detail.get('NetworkSettings', {}).get('Networks', {}).items()
        ]
        mounts = [
            {
                'type': mount.get('Type', ''),
                'name': mount.get('Name') or Path(mount.get('Source', '')).name,
                'source': mount.get('Source', ''),
                'destination': mount.get('Destination', ''),
                'mode': mount.get('Mode', ''),
            }
            for mount in detail.get('Mounts', [])
        ]
        seen_ports = set()
        seen_access_urls = set()
        for container_port, bindings in (detail.get('NetworkSettings', {}).get('Ports') or {}).items():
            private_port, _, protocol = str(container_port).partition('/')
            port_protocol = protocol or 'tcp'
            if not bindings:
                port_key = (private_port, port_protocol, '', '')
                if port_key not in seen_ports:
                    seen_ports.add(port_key)
                    ports.append({
                        'container_port': private_port,
                        'protocol': port_protocol,
                        'host_ip': '',
                        'host_port': '',
                        'published': False,
                    })
                continue
            for binding in bindings:
                host_port = str(binding.get('HostPort', '') or '')
                host_ip = str(binding.get('HostIp', '') or '')
                port_key = (private_port, port_protocol, host_ip, host_port)
                if port_key in seen_ports:
                    continue
                seen_ports.add(port_key)
                port_data = {
                    'container_port': private_port,
                    'protocol': port_protocol,
                    'host_ip': host_ip,
                    'host_port': host_port,
                    'published': bool(host_port),
                }
                ports.append(port_data)
                if host_port and application_host:
                    url = f'http://{application_host}:{host_port}'
                    if url not in seen_access_urls:
                        seen_access_urls.add(url)
                        access_urls.append({
                            **port_data,
                            'url': url,
                        })

    return {
        'id': container_id,
        'name': name,
        'image': image,
        'image_id': image_id,
        'status': container.get('Status', ''),
        'running': running,
        'networks': networks,
        'mounts': mounts,
        'ports': ports,
        'access_urls': access_urls,
    }

def as_list(value):
    if not value:
        return []
    if isinstance(value, list):
        return value
    return [value]


def generate_jwt_tokens(user):
    """Generate JWT access and refresh tokens"""
    payload = {
        'user_id': user.id,
        'username': user.username,
        'exp': datetime.utcnow() + timedelta(hours=24),
        'iat': datetime.utcnow(),
    }
    access_token = jwt.encode(
        payload,
        settings.SECRET_KEY,
        algorithm='HS256'
    )
    
    refresh_payload = {
        'user_id': user.id,
        'exp': datetime.utcnow() + timedelta(days=7),
        'iat': datetime.utcnow(),
    }
    refresh_token = jwt.encode(
        refresh_payload,
        settings.SECRET_KEY,
        algorithm='HS256'
    )
    
    return access_token, refresh_token


def get_client_ip(request):
    """Get client IP address from request"""
    x_forwarded_for = request.META.get('HTTP_X_FORWARDED_FOR')
    if x_forwarded_for:
        ip = x_forwarded_for.split(',')[0]
    else:
        ip = request.META.get('REMOTE_ADDR')
    return ip


def get_percent(used, total):
    if not total:
        return 'Unavailable'
    return f'{(used / total) * 100:.1f}%'


def get_memory_info():
    """Return server memory information without requiring extra packages."""
    memory = {
        'total': 'Unavailable',
        'available': 'Unavailable',
        'used': 'Unavailable',
        'used_percent': 'Unavailable',
    }

    try:
        with open('/proc/meminfo', 'r', encoding='utf-8') as meminfo:
            values = {}
            for line in meminfo:
                key, value = line.split(':', 1)
                values[key] = int(value.strip().split()[0]) * 1024

        total = values.get('MemTotal')
        available = values.get('MemAvailable')
        if total:
            memory['total'] = format_bytes(total)
        if available:
            memory['available'] = format_bytes(available)
        if total and available:
            used = total - available
            memory['used'] = format_bytes(used)
            memory['used_percent'] = get_percent(used, total)
    except (OSError, ValueError, IndexError):
        pass

    return memory


def format_bytes(size):
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return f'{size:.1f} {unit}'
        size /= 1024
    return f'{size:.1f} PB'


def get_load_average():
    try:
        one_minute, five_minutes, fifteen_minutes = os.getloadavg()
        return {
            'one_minute': f'{one_minute:.2f}',
            'five_minutes': f'{five_minutes:.2f}',
            'fifteen_minutes': f'{fifteen_minutes:.2f}',
        }
    except OSError:
        return {
            'one_minute': 'Unavailable',
            'five_minutes': 'Unavailable',
            'fifteen_minutes': 'Unavailable',
        }


REMOTE_SERVER_INFO_SCRIPT = r'''
import json
import os
import platform
import shutil
import subprocess

host_proc = '/hostproc' if os.path.isdir('/hostproc') else '/proc'
host_root = '/hostfs' if os.path.isdir('/hostfs') else '/'


def format_bytes(size):
    size = float(size or 0)
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size < 1024:
            return '%.1f %s' % (size, unit)
        size /= 1024
    return '%.1f PB' % size


def percent(used, total):
    return '%.1f%%' % ((used / total) * 100) if total else 'Unavailable'


def count_lines(command):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return 0
    if result.returncode != 0:
        return 0
    return len([line for line in result.stdout.splitlines() if line.strip()])


memory = {
    'total': 'Unavailable',
    'available': 'Unavailable',
    'used': 'Unavailable',
    'used_percent': 'Unavailable',
}
try:
    values = {}
    with open(os.path.join(host_proc, 'meminfo'), 'r', encoding='utf-8') as meminfo:
        for line in meminfo:
            key, value = line.split(':', 1)
            values[key] = int(value.strip().split()[0]) * 1024
    total = values.get('MemTotal')
    available = values.get('MemAvailable')
    if total:
        memory['total'] = format_bytes(total)
    if available:
        memory['available'] = format_bytes(available)
    if total and available:
        used = total - available
        memory['used'] = format_bytes(used)
        memory['used_percent'] = percent(used, total)
except (OSError, ValueError, IndexError):
    pass

load_average = {
    'one_minute': 'Unavailable',
    'five_minutes': 'Unavailable',
    'fifteen_minutes': 'Unavailable',
}
try:
    with open(os.path.join(host_proc, 'loadavg'), 'r', encoding='utf-8') as loadavg:
        values = loadavg.read().split()
    load_average = {
        'one_minute': '%.2f' % float(values[0]),
        'five_minutes': '%.2f' % float(values[1]),
        'fifteen_minutes': '%.2f' % float(values[2]),
    }
except (OSError, ValueError, IndexError):
    pass

processor = platform.processor() or 'Unavailable'
try:
    with open(os.path.join(host_proc, 'cpuinfo'), 'r', encoding='utf-8') as cpuinfo:
        for line in cpuinfo:
            if line.lower().startswith(('model name', 'hardware')):
                processor = line.split(':', 1)[1].strip() or processor
                break
except (OSError, IndexError):
    pass

disk = shutil.disk_usage(host_root)
payload = {
    'operating_system': {
        'system': platform.system(),
        'release': platform.release(),
        'version': platform.version(),
        'platform': platform.platform(),
        'architecture': platform.machine(),
        'processor': processor,
    },
    'resources': {
        'cpu_count': os.cpu_count(),
        'load_average': load_average,
        'memory': memory,
        'disk': {
            'total': format_bytes(disk.total),
            'used': format_bytes(disk.used),
            'free': format_bytes(disk.free),
            'used_percent': percent(disk.used, disk.total),
        },
    },
    'docker': {
        'containers_count': count_lines(['docker', 'ps', '-aq']),
        'images_count': count_lines(['docker', 'image', 'ls', '-q']),
        'networks_count': count_lines(['docker', 'network', 'ls', '-q']),
        'volumes_count': count_lines(['docker', 'volume', 'ls', '-q']),
    },
}
print(json.dumps(payload))
'''


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def server_info(request):
    """Return operating system and live resource details for the selected server."""
    if not user_has_operation(request.user, 'view_server_info'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if remote_agent:
        result = run_agent_command(
            agent,
            password,
            ['python3', '-c', REMOTE_SERVER_INFO_SCRIPT],
            timeout=30,
        )
        if not result.get('success'):
            return Response({
                'success': False,
                'error': result.get('error') or result.get('output') or 'Unable to collect health information from the selected agent.',
            }, status=status.HTTP_400_BAD_REQUEST)

        try:
            response_data = next(
                json.loads(line)
                for line in reversed(result.get('output', '').splitlines())
                if line.strip().startswith('{')
            )
        except (StopIteration, json.JSONDecodeError):
            return Response({
                'success': False,
                'error': 'The selected agent returned invalid health information.',
            }, status=status.HTTP_400_BAD_REQUEST)

        response_data.update({
            'server_id': str(agent.id),
            'server_name': agent.name,
            'checked_at': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'),
        })
        return Response(response_data)

    disk = shutil.disk_usage(settings.BASE_DIR)

    return Response({
        'server_id': str(agent.id) if agent else 'local',
        'server_name': agent.name if agent else 'Application server',
        'operating_system': {
            'system': platform.system(),
            'release': platform.release(),
            'version': platform.version(),
            'platform': platform.platform(),
            'architecture': platform.machine(),
            'processor': platform.processor() or 'Unavailable',
        },
        'resources': {
            'cpu_count': os.cpu_count(),
            'load_average': get_load_average(),
            'memory': get_memory_info(),
            'disk': {
                'total': format_bytes(disk.total),
                'used': format_bytes(disk.used),
                'free': format_bytes(disk.free),
                'used_percent': get_percent(disk.used, disk.total),
            },
        },
        'docker': count_docker_resources(),
        'checked_at': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC'),
    })


REMOTE_AGENT_TERMINAL_SCRIPT = r'''
import base64
import json
import os
import shutil
import subprocess
import sys

command = base64.b64decode(sys.argv[1]).decode('utf-8', errors='replace')
requested_cwd = base64.b64decode(sys.argv[2]).decode('utf-8', errors='replace') or '/'
requested_cwd = os.path.normpath('/' + requested_cwd.lstrip('/'))
host_root = '/hostfs'
host_cwd = os.path.join(host_root, requested_cwd.lstrip('/'))
if not os.path.isdir(host_cwd):
    requested_cwd = '/'
    host_cwd = host_root

shell_script = """
cd -- "$1" 2>/dev/null || cd /
eval "$2"
return_code=$?
printf "\\n__VITEL_TERMINAL_CWD__:%s\\n" "$PWD"
exit "$return_code"
"""

if os.path.isdir(host_root) and shutil.which('chroot'):
    host_shell = '/bin/bash' if os.path.isfile(os.path.join(host_root, 'bin/bash')) else '/bin/sh'
    process = subprocess.run(
        ['chroot', host_root, host_shell, '-lc', shell_script, 'vitel-terminal', requested_cwd, command],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
else:
    process = subprocess.run(
        ['/bin/bash' if os.path.isfile('/bin/bash') else '/bin/sh', '-lc', shell_script, 'vitel-terminal', host_cwd, command],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )

output = ((process.stdout or '') + ('\n' if process.stdout and process.stderr else '') + (process.stderr or '')).strip()
cwd_marker = '__VITEL_TERMINAL_CWD__:'
next_cwd = requested_cwd
clean_lines = []
for line in output.splitlines():
    if line.startswith(cwd_marker):
        next_cwd = line[len(cwd_marker):].strip() or '/'
    else:
        clean_lines.append(line)

print(json.dumps({
    'output': '\n'.join(clean_lines).rstrip(),
    'cwd': next_cwd,
    'return_code': process.returncode,
}))
'''


def run_local_terminal_command(command, cwd):
    requested_cwd = os.path.normpath('/' + str(cwd or '/').lstrip('/'))
    if not os.path.isdir(requested_cwd):
        requested_cwd = '/'
    shell = '/bin/bash' if os.path.isfile('/bin/bash') else '/bin/sh'
    shell_script = '''
cd -- "$1" 2>/dev/null || cd /
eval "$2"
return_code=$?
printf "\\n__VITEL_TERMINAL_CWD__:%s\\n" "$PWD"
exit "$return_code"
'''
    try:
        process = subprocess.run(
            [shell, '-lc', shell_script, 'vitel-terminal', requested_cwd, command],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        output = ((exc.stdout or '') + '\n' + (exc.stderr or '')).strip()
        return {
            'output': output or 'Command timed out after 120 seconds.',
            'cwd': requested_cwd,
            'return_code': None,
        }

    output = ((process.stdout or '') + ('\n' if process.stdout and process.stderr else '') + (process.stderr or '')).strip()
    marker = '__VITEL_TERMINAL_CWD__:'
    next_cwd = requested_cwd
    clean_lines = []
    for line in output.splitlines():
        if line.startswith(marker):
            next_cwd = line[len(marker):].strip() or '/'
        else:
            clean_lines.append(line)
    return {
        'output': '\n'.join(clean_lines).rstrip(),
        'cwd': next_cwd,
        'return_code': process.returncode,
    }


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def agent_terminal(request):
    """Run a Linux command on the selected application or agent server."""
    if not user_has_operation(request.user, 'manage_agents'):
        return Response({'error': 'You do not have permission to open server terminals.'}, status=status.HTTP_403_FORBIDDEN)

    command = str(request.data.get('command') or '')
    cwd = str(request.data.get('cwd') or '/')
    if not command.strip():
        return Response({'error': 'Command is required.'}, status=status.HTTP_400_BAD_REQUEST)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if not agent:
        result = run_local_terminal_command(command, cwd)
        return Response({
            'success': True,
            'server_id': 'local',
            'server_name': 'Application server',
            **result,
        })

    encoded_command = base64.b64encode(command.encode('utf-8')).decode('ascii')
    encoded_cwd = base64.b64encode(cwd.encode('utf-8')).decode('ascii')
    result = run_agent_command(
        agent,
        password,
        ['python3', '-c', REMOTE_AGENT_TERMINAL_SCRIPT, encoded_command, encoded_cwd],
        timeout=130,
    )
    if not result.get('success'):
        return Response({
            'success': False,
            'error': result.get('error') or result.get('output') or 'Unable to run the command on the selected agent.',
        }, status=status.HTTP_400_BAD_REQUEST)

    try:
        terminal_result = next(
            json.loads(line)
            for line in reversed(result.get('output', '').splitlines())
            if line.strip().startswith('{')
        )
    except (StopIteration, json.JSONDecodeError):
        return Response({
            'success': False,
            'error': 'The selected agent returned an invalid terminal response.',
        }, status=status.HTTP_400_BAD_REQUEST)

    return Response({
        'success': True,
        'server_id': str(agent.id),
        'server_name': agent.name,
        **terminal_result,
    })




def is_valid_linux_username(value):
    return bool(LINUX_USERNAME_RE.match(str(value or '').strip()))


def build_ssh_username_candidates(request, agent):
    candidates = []

    def add(value):
        value = str(value or '').strip()
        if value and is_valid_linux_username(value) and value not in candidates:
            candidates.append(value)

    add(get_agent_ssh_username(agent))
    try:
        add(getattr(request.user, 'username', ''))
    except Exception:
        pass
    try:
        add(request.data.get('name', ''))
    except Exception:
        pass
    for username in SSH_USERNAME_FALLBACKS:
        add(username)
    return candidates


def run_agent_install_ssh_attempt(request, agent, agent_secret, controller_public_key='', timeout=180):
    return with_ssh_auth_guidance(
        run_ssh_command(
            agent,
            agent_secret,
            build_remote_agent_install_command(
                agent,
                agent_secret,
                request,
                controller_public_key=controller_public_key,
            ),
            timeout=timeout,
        ),
        agent,
    )


def try_password_ssh_username_fallbacks(request, agent, agent_secret, controller_public_key='', initial_output=''):
    original_username = get_agent_ssh_username(agent)
    candidates = [candidate for candidate in build_ssh_username_candidates(request, agent) if candidate != original_username]
    if not candidates:
        return None

    output_parts = [initial_output.strip()] if initial_output else []
    output_parts.append(
        f'SSH login failed for {original_username}. Trying common SSH usernames with the same password: '
        + ', '.join(candidates)
    )

    for username in candidates:
        agent.ssh_username = username
        result = run_agent_install_ssh_attempt(
            request,
            agent,
            agent_secret,
            controller_public_key=controller_public_key,
            timeout=180,
        )
        output_parts.append(f'--- SSH username attempt: {username} ---')
        output_parts.append(result.get('output', ''))
        if result.get('success'):
            agent.save(update_fields=['ssh_username', 'updated_at'])
            result['output'] = '\n'.join(part for part in output_parts if part).strip()
            return result

    agent.ssh_username = original_username
    output_parts.append(
        'No automatic username matched this password. Enter the exact Linux SSH username used in your terminal, for example ubuntu, ec2-user, admin, or your custom server account.'
    )
    return {
        'success': False,
        'return_code': None,
        'command': 'ssh automatic agent install',
        'output': '\n'.join(part for part in output_parts if part).strip(),
        'error': 'SSH authentication failed for all attempted usernames.',
    }


def install_agent_on_target(request, agent, agent_secret, created=False, ssh_private_key='', ssh_key_passphrase='', controller_public_key=''):
    local_install = is_local_agent_target(request, agent.server_ip)
    if local_install:
        result = run_local_shell_command(
            build_local_agent_container_install_command(agent, agent_secret, request),
            password=agent_secret,
            timeout=90,
        )
    else:
        ssh_client_result = ensure_local_ssh_client()
        if not ssh_client_result['success']:
            result = {
                'success': False,
                'return_code': None,
                'command': 'ssh client preflight',
                'output': ssh_client_result['output'],
            }
        else:
            if ssh_private_key:
                result = with_ssh_auth_guidance(
                    run_ssh_command(
                        agent,
                        agent_secret,
                        build_remote_agent_install_command(agent, agent_secret, request, controller_public_key=controller_public_key),
                        timeout=180,
                        private_key=ssh_private_key,
                        key_passphrase=ssh_key_passphrase,
                    ),
                    agent,
                )
            else:
                result = run_agent_install_ssh_attempt(
                    request,
                    agent,
                    agent_secret,
                    controller_public_key=controller_public_key,
                    timeout=180,
                )
            result['output'] = '\n'.join([
                ssh_client_result.get('output', ''),
                result.get('output', ''),
            ]).strip()
            if is_ssh_auth_failure(result) and not ssh_private_key:
                fallback_result = try_password_ssh_username_fallbacks(
                    request,
                    agent,
                    agent_secret,
                    controller_public_key=controller_public_key,
                    initial_output=result.get('output', ''),
                )
                if fallback_result:
                    result = fallback_result
            if is_ssh_auth_failure(result):
                result = build_ssh_automation_failure(agent, result.get('output', ''))
    return result, local_install


def serialize_local_agent(request):
    docker = count_docker_resources()
    return {
        'id': 'local',
        'name': 'Application server',
        'server_ip': request.get_host().split(':')[0],
        'hostname': platform.node() or 'local',
        'connected': True,
        'last_seen': timezone.now().isoformat(),
        **docker,
    }


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def agents(request):
    """Create agents and list connected agent summaries."""
    if request.method == 'GET' and not user_has_any_operation(request.user, [
        'view_connected_agent', 'create_agent', 'manage_agents', 'delete_agents',
        'view_running_containers', 'view_stopped_containers', 'view_recycle_bin',
        'create_container', 'delete_container', 'connect_container', 'view_monitoring',
        'view_images', 'build_images', 'delete_images', 'view_networks', 'create_network',
        'delete_network', 'view_volumes', 'create_volume', 'delete_volume',
        'view_deployments', 'create_deployment', 'delete_deployment', 'registry_deploy', 'view_server_info',
    ]):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'GET':
        stale_cutoff = timezone.now() - timedelta(minutes=2)
        Agent.objects.filter(
            owner=request.user,
            is_deleted=False,
            connected=True,
            last_seen__lt=stale_cutoff,
        ).update(connected=False)
        cleanup_orphan_local_agent_containers(request.user)
        registered_agents = sync_local_agent_container_states(
            request,
            list(Agent.objects.filter(owner=request.user, is_deleted=False)),
        )
        deleted_agents = Agent.objects.filter(owner=request.user, is_deleted=True).order_by('-deleted_at', 'name')
        return Response({
            'agents': [
                serialize_local_agent(request),
                *AgentSerializer(registered_agents, many=True).data,
            ],
            'deleted_agents': AgentSerializer(deleted_agents, many=True).data,
        })

    if request.method == 'DELETE' and not user_has_operation(request.user, 'delete_agents'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    redeploy_agent_id = request.data.get('redeploy_id')
    if redeploy_agent_id and not user_has_operation(request.user, 'manage_agents'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if redeploy_agent_id:
        try:
            agent = Agent.objects.get(owner=request.user, id=redeploy_agent_id)
        except Agent.DoesNotExist:
            return Response({
                'error': 'Agent not found.',
            }, status=status.HTTP_404_NOT_FOUND)

        agent_was_deleted = agent.is_deleted

        agent_secret = decode_agent_secret(getattr(agent, 'password_secret', ''))
        if not agent_secret:
            return Response({
                'success': False,
                'error': 'Stored agent secret is unavailable. Recreate the agent before redeploying it.',
            }, status=status.HTTP_400_BAD_REQUEST)

        if get_agent_ssh_auth_type(agent) == 'manual':
            agent.connected = False
            agent.hostname = ''
            agent.save(update_fields=['connected', 'hostname', 'updated_at'])
            image_result = ensure_agent_image_in_registry(request)
            if not image_result.get('success'):
                return Response({
                    **image_result,
                    'success': False,
                    'error': image_result.get('error') or 'Unable to publish the agent image to the local registry.',
                }, status=status.HTTP_400_BAD_REQUEST)
            output = '\n'.join([image_result.get('output', ''), build_manual_agent_install_output(agent, agent_secret, request)]).strip()
            if agent_was_deleted:
                agent.is_deleted = False
                agent.deleted_at = None
                agent.save(update_fields=['is_deleted', 'deleted_at', 'updated_at'])
            return Response({
                'success': True,
                'created': False,
                'redeployed': True,
                'manual_install': True,
                'agent': AgentSerializer(agent).data,
                'command': 'manual docker agent install',
                'output': output,
                'local_install': False,
            }, status=status.HTTP_200_OK)

        ssh_private_key = get_agent_ssh_private_key(agent) if get_agent_ssh_auth_type(agent) == 'key' else ''
        ssh_key_passphrase = get_agent_ssh_key_passphrase(agent) if ssh_private_key else ''
        if get_agent_ssh_auth_type(agent) == 'key' and not ssh_private_key:
            return Response({
                'success': False,
                'error': 'Stored SSH private key is unavailable. Recreate the agent with SSH key credentials before redeploying it.',
            }, status=status.HTTP_400_BAD_REQUEST)

        agent.connected = False
        agent.hostname = ''
        agent.save(update_fields=['connected', 'hostname', 'updated_at'])
        image_result = ensure_agent_image_in_registry(request)
        if not image_result.get('success'):
            return Response({
                **image_result,
                'success': False,
                'error': image_result.get('error') or 'Unable to publish the agent image to the local registry.',
            }, status=status.HTTP_400_BAD_REQUEST)

        result, local_install = install_agent_on_target(
            request,
            agent,
            agent_secret,
            created=False,
            ssh_private_key=ssh_private_key,
            ssh_key_passphrase=ssh_key_passphrase,
        )
        if not result['success']:
            return Response({
                **result,
                'success': False,
                'agent': AgentSerializer(agent).data,
                'error': result.get('error') or 'Unable to redeploy the agent on the selected server.',
            }, status=status.HTTP_400_BAD_REQUEST)

        if agent_was_deleted:
            agent.is_deleted = False
            agent.deleted_at = None
            agent.save(update_fields=['is_deleted', 'deleted_at', 'updated_at'])

        return Response({
            'success': True,
            'created': False,
            'redeployed': True,
            'agent': AgentSerializer(agent).data,
            'command': result['command'],
            'output': result['output'] or f'Agent {agent.name} redeployed.',
            'local_install': local_install,
        }, status=status.HTTP_200_OK)

    if request.method == 'DELETE':
        agent_id = request.data.get('id')
        if not agent_id:
            return Response({
                'error': 'Agent ID is required.',
            }, status=status.HTTP_400_BAD_REQUEST)

        purge_deleted = request.data.get('purge_deleted') in [True, 1, '1', 'true', 'True']
        if purge_deleted:
            try:
                agent = Agent.objects.get(owner=request.user, id=agent_id, is_deleted=True)
            except Agent.DoesNotExist:
                return Response({
                    'error': 'Deleted agent not found.',
                }, status=status.HTTP_404_NOT_FOUND)

            agent_name = agent.name
            agent.delete()
            return Response({
                'success': True,
                'removed': True,
                'message': f'{agent_name} permanently removed from deleted agents.',
            }, status=status.HTTP_200_OK)

        try:
            agent = Agent.objects.get(owner=request.user, id=agent_id, is_deleted=False)
        except Agent.DoesNotExist:
            return Response({
                'error': 'Agent not found.',
            }, status=status.HTTP_404_NOT_FOUND)

        agent_secret = decode_agent_secret(getattr(agent, 'password_secret', ''))
        if not agent_secret:
            return Response({
                'success': False,
                'error': 'Stored agent secret is unavailable. Recreate the agent before deleting it remotely.',
            }, status=status.HTTP_400_BAD_REQUEST)

        ssh_private_key = get_agent_ssh_private_key(agent) if get_agent_ssh_auth_type(agent) == 'key' else ''
        ssh_key_passphrase = get_agent_ssh_key_passphrase(agent) if ssh_private_key else ''
        agent_data = AgentSerializer(agent).data
        remote_cleanup_skipped = False
        if get_agent_ssh_auth_type(agent) == 'manual':
            if should_manage_agent_locally(request, agent):
                result = run_local_shell_command(
                    build_manual_agent_cleanup_command(),
                    password=agent_secret,
                    timeout=60,
                )
            elif not agent.connected and not agent_http_endpoint_reachable(agent):
                result = {
                    'success': False,
                    'command': 'remote agent cleanup',
                    'output': (
                        'The manual agent is offline, so its Docker container and image cannot be removed safely. '
                        'Start the agent on the target server, refresh the agent list, and delete it again.'
                    ),
                }
            else:
                result = run_agent_command(
                    agent,
                    agent_secret,
                    build_remote_agent_async_uninstall_command(agent),
                    timeout=60,
                )
        elif should_manage_agent_locally(request, agent):
            result = run_local_shell_command(
                build_local_agent_container_uninstall_command(agent),
                password=agent_secret,
                timeout=60,
            )
        else:
            result = run_agent_command(
                agent,
                agent_secret,
                build_remote_agent_async_uninstall_command(agent),
                timeout=30,
            )
            if not result['success']:
                http_output = result.get('output', '')
                ssh_result = with_ssh_auth_guidance(
                    run_ssh_command(
                        agent,
                        agent_secret,
                        build_remote_agent_uninstall_command(agent),
                        timeout=60,
                        private_key=ssh_private_key,
                        key_passphrase=ssh_key_passphrase,
                    ),
                    agent,
                )
                if is_ssh_auth_failure(ssh_result):
                    result = build_ssh_automation_failure(
                        agent,
                        '\n'.join([http_output, ssh_result.get('output', '')]).strip(),
                        operation='cleanup',
                    )
                else:
                    result = ssh_result

        if not result['success']:
            return Response({
                **result,
                'success': False,
                'error': 'Unable to delete the agent from the selected server.',
            }, status=status.HTTP_400_BAD_REQUEST)

        agent.connected = False
        agent.hostname = ''
        agent.containers_count = 0
        agent.images_count = 0
        agent.networks_count = 0
        agent.volumes_count = 0
        agent.is_deleted = True
        agent.deleted_at = timezone.now()
        agent.save(update_fields=[
            'connected', 'hostname', 'containers_count', 'images_count',
            'networks_count', 'volumes_count', 'is_deleted', 'deleted_at', 'updated_at',
        ])
        return Response({
            'success': True,
            'agent': AgentSerializer(agent).data,
            'command': result['command'],
            'output': result['output'] or f'Agent {agent_data["name"]} deleted.',
            'remote_cleanup_skipped': remote_cleanup_skipped,
        }, status=status.HTTP_200_OK)

    if not user_has_operation(request.user, 'create_agent'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    name = request.data.get('name', '').strip()
    server_ip = request.data.get('server_ip', '').strip()
    try:
        port = int(request.data.get('port') or 19541)
    except (TypeError, ValueError):
        port = 19541
    install_mode = get_requested_agent_install_mode(request)

    if not name or not server_ip:
        return Response({
            'error': 'Agent name and server IP are required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    if port < 1 or port > 65535:
        return Response({
            'error': 'Agent port must be between 1 and 65535.',
        }, status=status.HTTP_400_BAD_REQUEST)

    existing_agent = Agent.objects.filter(owner=request.user, name=name).first()
    previous_agent_values = None
    if existing_agent:
        previous_agent_values = {
            'server_ip': existing_agent.server_ip,
            'ssh_username': existing_agent.ssh_username,
            'ssh_port': existing_agent.ssh_port,
            'ssh_auth_type': existing_agent.ssh_auth_type,
            'ssh_key_secret': existing_agent.ssh_key_secret,
            'ssh_key_passphrase_secret': existing_agent.ssh_key_passphrase_secret,
            'port': existing_agent.port,
            'password_hash': existing_agent.password_hash,
            'password_secret': existing_agent.password_secret,
            'connected': existing_agent.connected,
            'hostname': existing_agent.hostname,
            'is_deleted': existing_agent.is_deleted,
            'deleted_at': existing_agent.deleted_at,
        }

    temporary_secret = uuid.uuid4().hex + uuid.uuid4().hex
    agent, created = Agent.objects.update_or_create(
        owner=request.user,
        name=name,
        defaults={
            'server_ip': server_ip,
            'ssh_username': 'manual',
            'ssh_port': 22,
            'ssh_auth_type': 'manual',
            'ssh_key_secret': '',
            'ssh_key_passphrase_secret': '',
            'port': port,
            'password_hash': make_password(temporary_secret),
            'password_secret': encode_agent_secret(temporary_secret),
            'connected': False,
            'is_deleted': False,
            'deleted_at': None,
            'hostname': '',
        },
    )
    agent_secret = build_docker_agent_token(agent)
    agent.password_hash = make_password(agent_secret)
    agent.password_secret = encode_agent_secret(agent_secret)
    agent.save(update_fields=['password_hash', 'password_secret', 'updated_at'])

    image_result = ensure_agent_image_in_registry(request)
    if not image_result.get('success'):
        if created:
            agent.delete()
        elif previous_agent_values:
            for field, value in previous_agent_values.items():
                setattr(agent, field, value)
            agent.save(update_fields=[*previous_agent_values.keys(), 'updated_at'])
        return Response({
            **image_result,
            'success': False,
            'error': image_result.get('error') or 'Unable to publish the agent image to the local registry.',
        }, status=status.HTTP_400_BAD_REQUEST)

    output = build_manual_agent_install_output(agent, agent_secret, request, install_mode)
    return Response({
        'success': True,
        'created': created,
        'manual_install': True,
        'daemon_json_mode': install_mode,
        'agent': AgentSerializer(agent).data,
        'command': 'docker control agent install',
        'output': output,
        'local_install': False,
    }, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)



@api_view(['GET'])
@permission_classes([AllowAny])
def agent_image(request):
    token = str(request.query_params.get('token', '') or '').strip()
    if not token:
        return Response({'error': 'Agent image token is required.'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        payload = signing.loads(token, salt=AGENT_IMAGE_TOKEN_SALT, max_age=AGENT_IMAGE_TOKEN_MAX_AGE)
    except signing.SignatureExpired:
        return Response({'error': 'Agent image token has expired. Create the agent again to get fresh install steps.'}, status=status.HTTP_403_FORBIDDEN)
    except signing.BadSignature:
        return Response({'error': 'Invalid agent image token.'}, status=status.HTTP_403_FORBIDDEN)

    try:
        agent = Agent.objects.get(id=payload.get('agent_id'), owner_id=payload.get('owner_id'), is_deleted=False)
    except Agent.DoesNotExist:
        return Response({'error': 'Agent was not found for this token.'}, status=status.HTTP_404_NOT_FOUND)

    if not decode_agent_secret(getattr(agent, 'password_secret', '')):
        return Response({'error': 'Agent credentials are unavailable. Recreate the agent to get fresh install steps.'}, status=status.HTTP_400_BAD_REQUEST)

    image_result = ensure_agent_image_in_registry(request)
    if not image_result.get('success'):
        return Response({
            'success': False,
            'error': image_result.get('error') or 'Unable to publish the agent image to the local registry.',
            'output': image_result.get('output', ''),
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    return Response({
        'success': True,
        'image': get_agent_registry_pull_reference(request),
        'repository': get_agent_registry_repository(),
        'tag': get_agent_registry_tag(),
        'output': image_result.get('output', ''),
    })

@api_view(['POST'])
@permission_classes([AllowAny])
def agent_heartbeat(request):
    """Receive periodic resource updates from a remote agent script."""
    name = request.data.get('name', '').strip()
    password = request.data.get('password', '').strip()
    agent_id = request.data.get('agent_id')

    if not name or not password:
        return Response({
            'error': 'Agent name and password are required.',
        }, status=status.HTTP_400_BAD_REQUEST)

    agent_query = Agent.objects.filter(id=agent_id, is_deleted=False) if agent_id else Agent.objects.filter(name=name, is_deleted=False)
    agent = agent_query.first()
    if not agent or not check_password(password, agent.password_hash):
        return Response({
            'error': 'Invalid agent credentials.',
        }, status=status.HTTP_403_FORBIDDEN)

    def as_count(field):
        try:
            return max(0, int(request.data.get(field, 0)))
        except (TypeError, ValueError):
            return 0

    if get_agent_ssh_auth_type(agent) != 'manual':
        agent.server_ip = request.data.get('server_ip') or get_client_ip(request) or agent.server_ip
    agent.hostname = request.data.get('hostname', '').strip()
    agent.containers_count = as_count('containers_count')
    agent.images_count = as_count('images_count')
    agent.networks_count = as_count('networks_count')
    agent.volumes_count = as_count('volumes_count')
    agent.connected = True
    agent.last_seen = timezone.now()
    agent.save(update_fields=[
        'server_ip', 'hostname', 'containers_count', 'images_count',
        'networks_count', 'volumes_count', 'connected', 'last_seen', 'updated_at',
    ])

    return Response({
        'success': True,
        'agent': AgentSerializer(agent).data,
    })


@api_view(['POST'])
@permission_classes([AllowAny])
def agent_command(request):
    agent, password, error_response = authenticate_agent_request_payload(request)
    if error_response:
        return error_response

    command_record = AgentCommand.objects.filter(
        agent=agent,
        status=AgentCommand.STATUS_PENDING,
    ).order_by('created_at').first()
    if not command_record:
        return Response(status=status.HTTP_204_NO_CONTENT)

    command_record.status = AgentCommand.STATUS_RUNNING
    command_record.started_at = timezone.now()
    command_record.save(update_fields=['status', 'started_at', 'updated_at'])
    try:
        command = json.loads(command_record.command)
    except json.JSONDecodeError:
        command = command_record.command
    return Response({
        'success': True,
        'command': {
            'id': command_record.id,
            'command': command,
            'timeout': command_record.timeout,
        },
    })


@api_view(['POST'])
@permission_classes([AllowAny])
def agent_command_result(request):
    agent, password, error_response = authenticate_agent_request_payload(request)
    if error_response:
        return error_response

    command_id = request.data.get('command_id')
    try:
        command_record = AgentCommand.objects.get(agent=agent, id=command_id)
    except (AgentCommand.DoesNotExist, ValueError):
        return Response({'success': False, 'error': 'Command was not found.'}, status=status.HTTP_404_NOT_FOUND)

    command_record.status = AgentCommand.STATUS_COMPLETED if request.data.get('success') else AgentCommand.STATUS_FAILED
    command_record.success = bool(request.data.get('success'))
    command_record.return_code = request.data.get('return_code')
    command_record.output = str(request.data.get('output') or '')
    command_record.completed_at = timezone.now()
    command_record.save(update_fields=['status', 'success', 'return_code', 'output', 'completed_at', 'updated_at'])
    return Response({'success': True})


@api_view(['POST'])
@permission_classes([AllowAny])
def registry_deployment_poll(request):
    agent, password, error_response = authenticate_agent_request_payload(request)
    if error_response:
        return error_response

    job = DeploymentJob.objects.filter(agent=agent, status=DeploymentJob.STATUS_PENDING).order_by('created_at').first()
    if not job:
        return Response(status=status.HTTP_204_NO_CONTENT)

    mark_deployment_job_running(job)
    return Response({
        'success': True,
        'job': {
            'id': job.id,
            'image_reference': job.image_reference,
            'container_name': job.container_name,
            'run_args': job.run_args or [],
            'registry_username': job.registry_username,
            'registry_password': decode_agent_secret(job.registry_password_secret),
        },
    })


@api_view(['POST'])
@permission_classes([AllowAny])
def registry_deployment_result(request):
    agent, password, error_response = authenticate_agent_request_payload(request)
    if error_response:
        return error_response

    try:
        job = DeploymentJob.objects.get(agent=agent, id=request.data.get('job_id'))
    except (DeploymentJob.DoesNotExist, ValueError):
        return Response({'success': False, 'error': 'Deployment job was not found.'}, status=status.HTTP_404_NOT_FOUND)

    success = bool(request.data.get('success'))
    output = str(request.data.get('output') or '')
    error_text = str(request.data.get('error') or '')
    mark_deployment_job_complete(job, success, output=output, error=error_text)
    return Response({'success': True, 'job': DeploymentJobSerializer(job).data})


def parse_run_args(value):
    if value in (None, ''):
        return []
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    try:
        parsed = json.loads(value)
        if isinstance(parsed, list):
            return [str(item) for item in parsed if str(item).strip()]
    except (TypeError, json.JSONDecodeError):
        pass
    return shlex.split(str(value))


def normalize_deploy_container_name(value, image_name):
    raw = str(value or '').strip() or str(image_name or '').split('/')[-1]
    name = re.sub(r'[^a-zA-Z0-9_.-]+', '-', raw).strip('-_.')
    return name[:120] or f'deploy-{uuid.uuid4().hex[:8]}'


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def registry_images(request):
    if not user_has_operation(request.user, 'registry_deploy'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    try:
        pull_host = get_registry_pull_host_for_request(request)
        images = sync_registry_images(owner=request.user, pull_host=pull_host)
    except RegistryClientError as exc:
        return Response({'success': False, 'error': str(exc), 'images': []}, status=status.HTTP_400_BAD_REQUEST)

    return Response({'success': True, 'images': RegistryImageSerializer(images, many=True).data})


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def registry_tags(request):
    if not user_has_operation(request.user, 'registry_deploy'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    repository_name = str(request.query_params.get('image') or request.query_params.get('repository') or '').strip()
    if not repository_name:
        try:
            pull_host = get_registry_pull_host_for_request(request)
            images = sync_registry_images(owner=request.user, pull_host=pull_host)
        except RegistryClientError as exc:
            return Response({'success': False, 'error': str(exc), 'tags': []}, status=status.HTTP_400_BAD_REQUEST)
        return Response({
            'success': True,
            'tags': [
                {
                    'image': image.name,
                    'tag': image.tag,
                    'reference': image.reference,
                    'repository': image.repository.name,
                }
                for image in images
            ],
        })
    try:
        tags = list_registry_tags(repository_name)
    except RegistryClientError as exc:
        return Response({'success': False, 'error': str(exc), 'tags': []}, status=status.HTTP_400_BAD_REQUEST)
    return Response({'success': True, 'image': repository_name, 'tags': tags})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def registry_deploy(request):
    if not user_has_operation(request.user, 'registry_deploy'):
        return Response({'success': False, 'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    agent_id = request.data.get('agent_id') or request.data.get('server_id')
    if not agent_id or str(agent_id) == 'local':
        return Response({'success': False, 'error': 'Select a connected agent for registry deployment.'}, status=status.HTTP_400_BAD_REQUEST)

    try:
        agent = Agent.objects.get(owner=request.user, id=agent_id, is_deleted=False)
    except (Agent.DoesNotExist, ValueError):
        return Response({'success': False, 'error': 'Selected agent was not found.'}, status=status.HTTP_404_NOT_FOUND)
    if not agent.connected:
        return Response({'success': False, 'error': 'Selected agent is down.'}, status=status.HTTP_400_BAD_REQUEST)

    image = None
    image_id = request.data.get('image_id')
    if image_id:
        try:
            image = RegistryImage.objects.select_related('repository').get(id=image_id)
        except (RegistryImage.DoesNotExist, ValueError):
            return Response({'success': False, 'error': 'Selected registry image was not found.'}, status=status.HTTP_404_NOT_FOUND)
    else:
        image_name = str(request.data.get('image') or request.data.get('image_name') or '').strip()
        tag = str(request.data.get('tag') or '').strip()
        if not image_name or not tag:
            return Response({'success': False, 'error': 'Image and tag are required.'}, status=status.HTTP_400_BAD_REQUEST)
        image = RegistryImage.objects.select_related('repository').filter(name=image_name, tag=tag).first()
        if not image:
            try:
                sync_registry_images(owner=request.user, pull_host=get_registry_pull_host_for_request(request))
            except RegistryClientError:
                pass
            image = RegistryImage.objects.select_related('repository').filter(name=image_name, tag=tag).first()
        if not image:
            return Response({'success': False, 'error': 'Image tag was not found in the registry.'}, status=status.HTTP_404_NOT_FOUND)

    image.repository.pull_host = get_registry_pull_host_for_request(request)
    image.repository.save(update_fields=['pull_host', 'updated_at'])
    container_name = normalize_deploy_container_name(request.data.get('container_name'), image.name)
    registry_password = str(request.data.get('registry_password') or '')
    job = create_deployment_job(
        owner=request.user,
        agent=agent,
        image=image,
        image_reference=image.reference,
        container_name=container_name,
        run_args=parse_run_args(request.data.get('run_args')),
        registry_username=str(request.data.get('registry_username') or '').strip(),
        registry_password_secret=encode_agent_secret(registry_password),
    )
    return Response({'success': True, 'job': DeploymentJobSerializer(job).data}, status=status.HTTP_201_CREATED)


@api_view(['GET', 'POST'])
@permission_classes([IsAuthenticated])
def manual_create_container(request):
    """List containers or manually create a Docker container."""
    if request.method == 'POST' and not user_has_operation(request.user, 'create_container'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'GET':
        can_view_running = user_can_view_running_containers(request.user)
        can_view_stopped = user_can_view_stopped_containers(request.user)
        if not (can_view_running or can_view_stopped):
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        agent, password, remote_agent, error_response = get_docker_target_context(request)
        if error_response:
            return error_response
        result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'ps', '-a',
            '--format', '{{json .}}',
        ])
        containers = parse_json_lines(result['output']) if result['success'] else []
        if not can_view_running:
            containers = [container for container in containers if not docker_summary_is_running(container)]
        if not can_view_stopped:
            containers = [container for container in containers if docker_summary_is_running(container)]
        return Response({
            **result,
            'containers': containers,
        }, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    image = request.data.get('image', '').strip()
    image_source = request.data.get('image_source', 'dockerhub').strip().lower()
    dockerfile_path = request.data.get('dockerfile_path', '').strip()

    if not image:
        return Response({
            'error': 'Image is required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    if image_source == 'dockerfile' and not dockerfile_path:
        return Response({
            'error': 'Dockerfile path is required when Registry is Dockerfile.',
        }, status=status.HTTP_400_BAD_REQUEST)

    command = build_container_run_command(request)
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    step_results = []
    if image_source == 'dockerfile':
        build_command, build_error = get_dockerfile_build_command(
            image,
            dockerfile_path,
            local=not remote_agent,
        )
        if build_error:
            return Response({
                'success': False,
                'error': build_error,
                'output': build_error,
            }, status=status.HTTP_400_BAD_REQUEST)
        build_result = run_target_docker_command(agent, password, remote_agent, build_command, timeout=900)
        step_results.append(build_result)
        if not build_result['success']:
            result = merge_docker_step_results(step_results)
            return Response(result, status=status.HTTP_400_BAD_REQUEST)
    else:
        pull_result = run_target_docker_command(agent, password, remote_agent, ['docker', 'pull', image], timeout=600)
        step_results.append(pull_result)
        if not pull_result['success']:
            result = merge_docker_step_results(step_results)
            return Response(result, status=status.HTTP_400_BAD_REQUEST)

    step_results.append(run_target_docker_command(agent, password, remote_agent, command, timeout=180))
    result = merge_docker_step_results(step_results)
    return Response({
        **result,
        'container_id': step_results[-1]['output'].splitlines()[-1] if result['success'] and step_results[-1].get('output') else '',
    }, status=status.HTTP_201_CREATED if result['success'] else status.HTTP_400_BAD_REQUEST)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def container_detail(request):
    if not (user_can_view_running_containers(request.user) or user_can_view_stopped_containers(request.user)):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    """Get container details (inspect) including networks and volumes."""
    container_id = request.GET.get('id', '').strip()
    
    if not container_id:
        return Response({
            'error': 'Container ID is required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    result = run_target_docker_command(agent, password, remote_agent, [
        'docker', 'inspect', container_id,
        '--format', '{{json .}}',
    ])
    
    if not result['success']:
        return Response({
            **result,
            'container': None,
        }, status=status.HTTP_400_BAD_REQUEST)
    
    try:
        container_data = json.loads(result['output'].splitlines()[0])
    except (json.JSONDecodeError, IndexError):
        return Response({
            'success': False,
            'error': 'Failed to parse container details.',
            'container': None,
        }, status=status.HTTP_400_BAD_REQUEST)

    application_host = str(agent.server_ip) if agent else get_local_application_host(request)
    ports = []
    access_urls = []
    seen_ports = set()
    seen_access_urls = set()
    for container_port, bindings in (container_data.get('NetworkSettings', {}).get('Ports') or {}).items():
        private_port, _, protocol = str(container_port).partition('/')
        port_protocol = protocol or 'tcp'
        if not bindings:
            port_key = (private_port, port_protocol, '', '')
            if port_key not in seen_ports:
                seen_ports.add(port_key)
                ports.append({
                    'container_port': private_port,
                    'protocol': port_protocol,
                    'host_ip': '',
                    'host_port': '',
                    'published': False,
                })
            continue
        for binding in bindings:
            host_port = str(binding.get('HostPort', '') or '')
            host_ip = str(binding.get('HostIp', '') or '')
            port_key = (private_port, port_protocol, host_ip, host_port)
            if port_key in seen_ports:
                continue
            seen_ports.add(port_key)
            port_data = {
                'container_port': private_port,
                'protocol': port_protocol,
                'host_ip': host_ip,
                'host_port': host_port,
                'published': bool(host_port),
            }
            ports.append(port_data)
            if host_port and application_host:
                url = f'http://{application_host}:{host_port}'
                if url not in seen_access_urls:
                    seen_access_urls.add(url)
                    access_urls.append({
                        **port_data,
                        'url': url,
                    })

    container_data['ports'] = ports
    container_data['access_urls'] = access_urls

    return Response({
        'success': True,
        'container': container_data,
    }, status=status.HTTP_200_OK)


def build_container_monitoring_record(container_data, stats_data=None):
    state = container_data.get("State") or {}
    config = container_data.get("Config") or {}
    networks_data = (container_data.get("NetworkSettings") or {}).get("Networks") or {}
    health_data = state.get("Health") or {}
    running = bool(state.get("Running"))
    status_value = str(state.get("Status") or ("running" if running else "stopped")).strip().lower()
    health_value = str(health_data.get("Status") or "").strip().lower()
    if not health_value:
        health_value = "not-configured" if running else "unavailable"

    networks = []
    ip_addresses = []
    for network_name, network in networks_data.items():
        ip_address = str(network.get("IPAddress") or "").strip()
        networks.append({
            "name": network_name,
            "id": network.get("NetworkID") or "",
            "ip_address": ip_address,
        })
        if ip_address:
            ip_addresses.append(ip_address)

    mounts = [
        {
            "type": mount.get("Type") or "",
            "name": mount.get("Name") or "",
            "source": mount.get("Source") or "",
            "destination": mount.get("Destination") or "",
        }
        for mount in container_data.get("Mounts") or []
    ]
    stats = stats_data or {}
    return {
        "id": container_data.get("Id") or "",
        "name": str(container_data.get("Name") or "").lstrip("/") or "Unknown",
        "status": status_value,
        "running": running,
        "health": health_value,
        "image": config.get("Image") or "",
        "image_id": container_data.get("Image") or "",
        "cpu_percent": stats.get("CPUPerc") or "0%",
        "memory_usage": stats.get("MemUsage") or "0B / 0B",
        "memory_percent": stats.get("MemPerc") or "0%",
        "network_io": stats.get("NetIO") or "0B / 0B",
        "block_io": stats.get("BlockIO") or "0B / 0B",
        "pids": stats.get("PIDs") or "0",
        "started_at": state.get("StartedAt") or "",
        "finished_at": state.get("FinishedAt") or "",
        "restarts": container_data.get("RestartCount") or 0,
        "ip_address": ", ".join(ip_addresses),
        "created": container_data.get("Created") or "",
        "networks": networks,
        "mounts": mounts,
    }


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def container_monitoring(request):
    # Return lightweight inventory for attachment indicators and detailed stats for Monitoring.
    container_id = str(request.GET.get('id') or '').strip()
    if container_id and not user_has_operation(request.user, 'view_monitoring'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if not container_id and not user_has_any_operation(request.user, [
        'view_monitoring', 'view_images', 'view_networks', 'view_volumes',
    ]):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if container_id:
        inspect_result = run_target_docker_command(
            agent, password, remote_agent,
            ["docker", "inspect", container_id, "--format", "{{json .}}"],
            timeout=30,
        )
        if not inspect_result["success"]:
            return Response({
                **inspect_result,
                "success": False,
                "error": inspect_result.get("output") or "Unable to inspect the selected container.",
            }, status=status.HTTP_404_NOT_FOUND)

        try:
            container_data = json.loads(inspect_result["output"].splitlines()[0])
        except (json.JSONDecodeError, IndexError):
            return Response({
                "success": False,
                "error": "Docker returned invalid monitoring details.",
            }, status=status.HTTP_400_BAD_REQUEST)

        stats_data = {}
        if (container_data.get("State") or {}).get("Running"):
            stats_result = run_target_docker_command(
                agent, password, remote_agent,
                ["docker", "stats", "--no-stream", "--format", "{{json .}}", container_id],
                timeout=30,
            )
            if stats_result["success"] and stats_result.get("output"):
                try:
                    stats_data = json.loads(stats_result["output"].splitlines()[0])
                except (json.JSONDecodeError, IndexError):
                    stats_data = {}

        return Response({
            "success": True,
            "container": build_container_monitoring_record(container_data, stats_data),
        }, status=status.HTTP_200_OK)

    list_result = run_target_docker_command(
        agent, password, remote_agent,
        ["docker", "ps", "-aq"],
        timeout=30,
    )
    if not list_result["success"]:
        return Response({**list_result, "containers": []}, status=status.HTTP_400_BAD_REQUEST)

    container_ids = [line.strip() for line in list_result.get("output", "").splitlines() if line.strip()]
    containers = []
    if container_ids:
        inspect_result = run_target_docker_command(
            agent, password, remote_agent,
            ["docker", "inspect", *container_ids],
            timeout=60,
        )
        if not inspect_result["success"]:
            return Response({**inspect_result, "containers": []}, status=status.HTTP_400_BAD_REQUEST)
        try:
            containers = [
                build_container_monitoring_record(container_data)
                for container_data in json.loads(inspect_result.get("output") or "[]")
            ]
        except json.JSONDecodeError:
            return Response({
                "success": False,
                "error": "Docker returned invalid container inventory data.",
                "containers": [],
            }, status=status.HTTP_400_BAD_REQUEST)

    return Response({"success": True, "containers": containers}, status=status.HTTP_200_OK)


def normalize_container_inspect_name(container_data, fallback='container'):
    name = str(container_data.get('Name') or fallback or 'container').strip().lstrip('/')
    name = re.sub(r'[^a-zA-Z0-9_.-]+', '-', name).strip('-_.')
    return name[:120] or f'container-{uuid.uuid4().hex[:8]}'


def get_recycle_source_fields(agent):
    if agent:
        return {
            'agent_name': agent.name or '',
            'agent_server_ip': str(agent.server_ip or ''),
        }
    return {
        'agent_name': 'Application server',
        'agent_server_ip': '',
    }


def build_recycled_container_snapshot_image(container_data, container_id=''):
    config = container_data.get('Config') or {}
    original_image = str(config.get('Image') or container_data.get('Image') or '').strip()
    repository = original_image
    original_tag = 'latest'

    if '@' in repository:
        repository = repository.split('@', 1)[0]
        original_tag = 'digest'
    else:
        last_slash = repository.rfind('/')
        last_colon = repository.rfind(':')
        if last_colon > last_slash:
            repository, original_tag = repository[:last_colon], repository[last_colon + 1:]

    container_name = normalize_container_inspect_name(container_data, container_id).lower()
    safe_container_name = (re.sub(r'[^a-z0-9_.-]+', '-', container_name).strip('-_.') or 'container')[:48]
    safe_original_tag = re.sub(r'[^A-Za-z0-9_.-]+', '-', original_tag).strip('-_.') or 'latest'
    if not repository or repository.startswith('sha256'):
        repository = f'recycled-container/{safe_container_name}'

    timestamp = timezone.now().strftime('%Y%m%d%H%M%S')
    unique_id = str(container_data.get('Id') or container_id or uuid.uuid4().hex).replace('sha256:', '')[:12]
    suffix = f'-recycle-{safe_container_name}-{timestamp}-{unique_id}'
    max_original_tag_length = max(1, 128 - len(suffix))
    snapshot_tag = safe_original_tag[:max_original_tag_length].rstrip('-_.') + suffix
    return f'{repository}:{snapshot_tag}'


def set_recycled_container_snapshot(container_data, snapshot_image):
    container_data[RECYCLED_CONTAINER_SNAPSHOT_KEY] = {
        'image': snapshot_image,
        'created_at': timezone.now().isoformat(),
    }


def get_recycled_container_snapshot_image(inspect_data):
    metadata = (inspect_data or {}).get(RECYCLED_CONTAINER_SNAPSHOT_KEY) or {}
    return str(metadata.get('image') or '').strip()


def create_recycled_container_record(request, agent, container_id, container_data):
    container_name = normalize_container_inspect_name(container_data, container_id)
    config = container_data.get('Config') or {}
    return RecycledContainer.objects.create(
        owner=request.user,
        agent=agent,
        target_server_id=str(agent.id) if agent else 'local',
        container_id=str(container_data.get('Id') or container_id),
        container_name=container_name,
        image=str(config.get('Image') or container_data.get('Image') or ''),
        status=str(container_data.get('State', {}).get('Status') or container_data.get('State', {}).get('Running') or ''),
        inspect_data=container_data,
        **get_recycle_source_fields(agent),
    )


def append_recycled_port_args(command, inspect_data):
    port_bindings = (inspect_data.get('HostConfig') or {}).get('PortBindings') or {}
    for container_port, bindings in port_bindings.items():
        private_port, _, protocol = str(container_port).partition('/')
        protocol = protocol or 'tcp'
        for binding in bindings or []:
            host_port = str(binding.get('HostPort') or '').strip()
            host_ip = str(binding.get('HostIp') or '').strip()
            if not host_port or not private_port:
                continue
            if host_ip and host_ip not in {'0.0.0.0', '::'}:
                command.extend(['-p', f'{host_ip}:{host_port}:{private_port}/{protocol}'])
            else:
                command.extend(['-p', f'{host_port}:{private_port}/{protocol}'])


def append_recycled_volume_args(command, inspect_data):
    binds = (inspect_data.get('HostConfig') or {}).get('Binds') or []
    seen_targets = set()
    for bind in binds:
        bind_text = str(bind or '').strip()
        if not bind_text:
            continue
        parts = bind_text.split(':')
        if len(parts) >= 2:
            seen_targets.add(parts[1])
        command.extend(['-v', bind_text])

    for mount in inspect_data.get('Mounts') or []:
        target = str(mount.get('Destination') or '').strip()
        if not target or target in seen_targets:
            continue
        source = str(mount.get('Name') or mount.get('Source') or '').strip()
        if not source:
            continue
        mount_arg = f'{source}:{target}'
        if mount.get('RW') is False:
            mount_arg += ':ro'
        command.extend(['-v', mount_arg])
        seen_targets.add(target)


def get_recycled_network_names(inspect_data):
    networks = list(((inspect_data.get('NetworkSettings') or {}).get('Networks') or {}).keys())
    return [network for network in networks if network and network != 'none']


def normalize_restore_image_name(value, fallback=''):
    image = str(value or fallback or '').strip()
    if not image:
        raise ValueError('Enter a Docker image name for the restored container.')
    if len(image) > 512 or image.startswith('-') or '@' in image or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*', image):
        raise ValueError('Enter a valid Docker image name, for example nginx:latest.')
    if image.rfind(':') <= image.rfind('/'):
        image += ':latest'
    return image


def build_recycled_container_restore_script(record, restore_image=''):
    inspect_data = record.inspect_data or {}
    config = inspect_data.get('Config') or {}
    host_config = inspect_data.get('HostConfig') or {}
    snapshot_image = get_recycled_container_snapshot_image(inspect_data)
    original_image = str(config.get('Image') or record.image or '').strip()
    source_image = snapshot_image or original_image
    target_image = normalize_restore_image_name(restore_image, original_image)
    name = normalize_container_inspect_name(inspect_data, record.container_name)
    if not source_image:
        raise ValueError('Deleted container image is missing, so it cannot be restored.')

    command = ['docker', 'run', '-d', '--name', name]
    restart_policy = host_config.get('RestartPolicy') or {}
    restart_name = str(restart_policy.get('Name') or '').strip()
    restart_max = restart_policy.get('MaximumRetryCount')
    if restart_name and restart_name != 'no':
        restart_value = restart_name
        if restart_name == 'on-failure' and restart_max:
            restart_value = f'{restart_name}:{restart_max}'
        command.extend(['--restart', restart_value])

    network_mode = str(host_config.get('NetworkMode') or '').strip()
    networks = get_recycled_network_names(inspect_data)
    primary_network = network_mode if network_mode and not network_mode.startswith('container:') else ''
    if primary_network in {'default'}:
        primary_network = ''
    if not primary_network and networks:
        primary_network = networks[0]
    if primary_network and primary_network != 'none':
        command.extend(['--network', primary_network])

    user = str(config.get('User') or '').strip()
    if user:
        command.extend(['--user', user])
    workdir = str(config.get('WorkingDir') or '').strip()
    if workdir:
        command.extend(['--workdir', workdir])

    for env in config.get('Env') or []:
        env_text = str(env or '').strip()
        if env_text:
            command.extend(['-e', env_text])

    append_recycled_port_args(command, inspect_data)
    append_recycled_volume_args(command, inspect_data)

    command.append(target_image)
    for arg in config.get('Cmd') or []:
        if str(arg).strip():
            command.append(str(arg))

    if snapshot_image:
        image_prepare_command = (
            shlex.join(['docker', 'image', 'inspect', snapshot_image])
            + ' >/dev/null 2>&1 || { echo '
            + shlex.quote('The preserved container snapshot is missing on this server. Restore cannot continue without its saved data.')
            + '; exit 1; }'
        )
    else:
        image_prepare_command = (
            shlex.join(['docker', 'image', 'inspect', source_image])
            + ' >/dev/null 2>&1 || '
            + shlex.join(['docker', 'pull', source_image])
        )

    script_lines = ['set -e', image_prepare_command]
    if source_image != target_image:
        script_lines.append(shlex.join(['docker', 'image', 'tag', source_image, target_image]))
    script_lines.append(shlex.join(command))
    extra_networks = [network for network in networks if network != primary_network]
    for network in extra_networks:
        script_lines.append(shlex.join(['docker', 'network', 'connect', network, name]) + ' || true')
    if snapshot_image and snapshot_image != target_image:
        script_lines.append(shlex.join(['docker', 'image', 'rm', '-f', snapshot_image]))
    script_lines.append('echo ' + shlex.quote(f'Restored container image: {target_image}'))
    return '\n'.join(script_lines)


def selected_server_matches_recycled_record(server_id, record):
    normalized = str(server_id or 'local').strip() or 'local'
    expected = str(record.target_server_id or record.agent_id or 'local')
    return normalized == expected


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def container_action(request):
    """Stop, restart, start, or safely recycle a container."""
    container_id = request.data.get('id', '').strip()
    action = request.data.get('action', '').strip().lower()
    if action == 'delete' and not user_has_operation(request.user, 'delete_container'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    if not container_id:
        return Response({
            'error': 'Container ID is required.',
        }, status=status.HTTP_400_BAD_REQUEST)

    if action not in ['stop', 'restart', 'start', 'delete']:
        return Response({
            'error': f'Invalid action. Must be one of: stop, restart, start, delete.',
        }, status=status.HTTP_400_BAD_REQUEST)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if action != 'delete':
        result = run_target_docker_command(agent, password, remote_agent, ['docker', action, container_id])
        return Response(result, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    inspect_result = run_target_docker_command(agent, password, remote_agent, [
        'docker', 'inspect', container_id,
        '--format', '{{json .}}',
    ], timeout=30)
    if not inspect_result['success']:
        return Response({
            **inspect_result,
            'success': False,
            'error': 'Unable to inspect the container. It was not deleted because its data could not be preserved.',
        }, status=status.HTTP_400_BAD_REQUEST)

    try:
        container_data = json.loads(inspect_result['output'].splitlines()[0])
    except (json.JSONDecodeError, IndexError):
        return Response({
            'success': False,
            'error': 'Docker returned invalid container details. The container was not deleted because its data could not be preserved.',
            'output': inspect_result.get('output', ''),
        }, status=status.HTTP_400_BAD_REQUEST)

    snapshot_image = build_recycled_container_snapshot_image(container_data, container_id)
    snapshot_result = run_target_docker_command(
        agent, password, remote_agent,
        ['docker', 'commit', container_id, snapshot_image],
        timeout=900,
    )
    if not snapshot_result['success']:
        return Response({
            **snapshot_result,
            'success': False,
            'error': 'Unable to preserve the container filesystem. The container was not deleted.',
        }, status=status.HTTP_400_BAD_REQUEST)

    set_recycled_container_snapshot(container_data, snapshot_image)
    try:
        recycled_record = create_recycled_container_record(request, agent, container_id, container_data)
    except Exception:
        run_target_docker_command(agent, password, remote_agent, ['docker', 'image', 'rm', '-f', snapshot_image], timeout=120)
        return Response({
            'success': False,
            'error': 'Unable to save the container recycle-bin record. The original container was not deleted.',
        }, status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    result = run_target_docker_command(agent, password, remote_agent, ['docker', 'rm', '-f', container_id])
    if not result['success']:
        recycled_record.delete()
        cleanup_result = run_target_docker_command(
            agent, password, remote_agent,
            ['docker', 'image', 'rm', '-f', snapshot_image],
            timeout=120,
        )
        cleanup_output = cleanup_result.get('output', '').strip()
        if cleanup_output:
            result['output'] = '\n'.join(filter(None, [result.get('output', '').strip(), cleanup_output]))
        return Response(result, status=status.HTTP_400_BAD_REQUEST)

    return Response({
        **result,
        'output': '\n'.join(filter(None, [
            snapshot_result.get('output', '').strip(),
            result.get('output', '').strip(),
            'Container filesystem and mounted data references were preserved for restore.',
        ])),
        'recycled_container': RecycledContainerSerializer(recycled_record).data,
    }, status=status.HTTP_200_OK)


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def container_recycle_bin(request):
    if request.method == 'GET' and not user_has_operation(request.user, 'view_recycle_bin'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'GET':
        records = RecycledContainer.objects.filter(owner=request.user, restored=False).select_related('agent')
        return Response({
            'success': True,
            'containers': RecycledContainerSerializer(records, many=True).data,
        })

    if request.method == 'DELETE':
        if not user_has_operation(request.user, 'delete_container'):
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        record_id = request.data.get('id') or request.data.get('recycle_id')
        try:
            record = RecycledContainer.objects.get(owner=request.user, id=record_id, restored=False)
        except (RecycledContainer.DoesNotExist, ValueError):
            return Response({'success': False, 'error': 'Recycle bin container was not found.'}, status=status.HTTP_404_NOT_FOUND)
        container_name = record.container_name
        snapshot_image = get_recycled_container_snapshot_image(record.inspect_data)
        if snapshot_image:
            selected_server_id = str(request.data.get('server_id') or 'local').strip() or 'local'
            if not selected_server_matches_recycled_record(selected_server_id, record):
                return Response({
                    'success': False,
                    'error': f'Please select {record.source_label}, the server holding this container snapshot, before deleting it permanently.',
                    'expected_server_id': record.target_server_id or record.agent_id or 'local',
                }, status=status.HTTP_400_BAD_REQUEST)

            agent, password, remote_agent, error_response = get_docker_target_context(request)
            if error_response:
                return error_response
            cleanup_result = run_target_docker_command(
                agent, password, remote_agent,
                ['docker', 'image', 'rm', '-f', snapshot_image],
                timeout=120,
            )
            if not cleanup_result['success']:
                return Response({
                    **cleanup_result,
                    'success': False,
                    'error': 'Unable to remove the preserved container snapshot. The recycle-bin record was kept so its data is not orphaned.',
                }, status=status.HTTP_400_BAD_REQUEST)

        record.delete()
        return Response({
            'success': True,
            'container_name': container_name,
            'output': f'Container {container_name} and its preserved snapshot were permanently deleted from the recycle bin.',
        })

    if not user_has_operation(request.user, 'create_container'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    record_id = request.data.get('id') or request.data.get('recycle_id')
    try:
        record = RecycledContainer.objects.select_related('agent').get(owner=request.user, id=record_id, restored=False)
    except (RecycledContainer.DoesNotExist, ValueError):
        return Response({'success': False, 'error': 'Recycle bin container was not found.'}, status=status.HTTP_404_NOT_FOUND)

    selected_server_id = str(request.data.get('server_id') or 'local').strip() or 'local'
    if not selected_server_matches_recycled_record(selected_server_id, record):
        return Response({
            'success': False,
            'error': f'Please select {record.source_label}, the server this container was deleted from, before restoring.',
            'expected_server_id': record.target_server_id or record.agent_id or 'local',
        }, status=status.HTTP_400_BAD_REQUEST)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    try:
        restore_image = normalize_restore_image_name(request.data.get('image'), record.image)
        restore_script = build_recycled_container_restore_script(record, restore_image)
    except ValueError as exc:
        return Response({'success': False, 'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    result = run_target_docker_command(agent, password, remote_agent, ['sh', '-lc', restore_script], timeout=900)
    if result['success']:
        record.restored = True
        record.restored_at = timezone.now()
        record.image = restore_image
    record.restore_output = result.get('output', '')
    record.save(update_fields=['image', 'restored', 'restored_at', 'restore_output', 'updated_at'])
    return Response({
        **result,
        'restored_image': restore_image,
        'container': RecycledContainerSerializer(record).data,
    }, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def container_network(request):
    """Attach or detach a network from a container."""
    if request.method == 'POST' and not user_has_operation(request.user, 'create_network'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'DELETE' and not user_has_operation(request.user, 'delete_network'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    container_id = request.data.get('container_id', '').strip()
    network_id = request.data.get('network_id', '').strip()
    
    if not container_id or not network_id:
        return Response({
            'error': 'Container ID and network ID are required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if request.method == 'POST':
        # Attach network
        result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'network', 'connect', network_id, container_id
        ])
        return Response(result, status=status.HTTP_201_CREATED if result['success'] else status.HTTP_400_BAD_REQUEST)
    else:
        # Detach network
        result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'network', 'disconnect', network_id, container_id
        ])
        return Response(result, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def connect_container(request):
    """Start an interactive shell session in a container."""
    if not user_has_operation(request.user, 'connect_container'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    container_id = request.data.get('id', '').strip()
    
    if not container_id:
        return Response({
            'error': 'Container ID is required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    inspect_result = run_docker_command([
        'docker', 'inspect', container_id,
        '--format', '{{json .}}',
    ])
    
    container_name = 'container'
    if not inspect_result['success']:
        return Response({
            **inspect_result,
            'error': inspect_result['output'] or 'Unable to inspect container.',
        }, status=status.HTTP_400_BAD_REQUEST)

    try:
        container_data = json.loads(inspect_result['output'].splitlines()[0])
        container_name = container_data.get('Name', '').lstrip('/') or container_name
        if not container_data.get('State', {}).get('Running'):
            return Response({
                'success': False,
                'error': f'Container {container_name} is not running. Start it before connecting.',
            }, status=status.HTTP_400_BAD_REQUEST)
    except (json.JSONDecodeError, IndexError):
        return Response({
            'success': False,
            'error': 'Failed to read container details before connecting.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    # Start interactive shell session
    session_id, startup_output, error = start_container_shell(container_id, container_name, request.user)
    
    if error:
        return Response({
            'success': False,
            'error': f'Failed to start shell: {error}',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    return Response({
        'success': True,
        'session_id': session_id,
        'container_id': container_id,
        'container_name': container_name,
        'terminal_prompt': f'root@{container_name}:/# ',
        'output': startup_output,
    }, status=status.HTTP_201_CREATED)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def connect_volume(request):
    """Start a temporary shell with a mounted volume from an existing container."""
    if not user_has_operation(request.user, 'connect_container'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    container_id = request.data.get('container_id', '').strip()
    mount_source = request.data.get('source', '').strip()
    mount_name = request.data.get('name', '').strip()
    mount_destination = request.data.get('destination', '').strip()

    if not container_id:
        return Response({'error': 'Container ID is required.'}, status=status.HTTP_400_BAD_REQUEST)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    inspect_result = run_target_docker_command(
        agent,
        password,
        remote_agent,
        ['docker', 'inspect', container_id, '--format', '{{json .}}'],
        timeout=30,
    )
    if not inspect_result['success']:
        return Response({
            **inspect_result,
            'error': inspect_result['output'] or 'Unable to inspect container.',
        }, status=status.HTTP_400_BAD_REQUEST)

    try:
        container_data = json.loads(inspect_result['output'].splitlines()[0])
    except (json.JSONDecodeError, IndexError):
        return Response({
            'success': False,
            'error': 'Failed to read container details before connecting volume.',
        }, status=status.HTTP_400_BAD_REQUEST)

    matching_mount = None
    for mount in container_data.get('Mounts', []):
        source_matches = mount_source and mount.get('Source') == mount_source
        name_matches = mount_name and mount.get('Name') == mount_name
        destination_matches = mount_destination and mount.get('Destination') == mount_destination
        if source_matches or name_matches or destination_matches:
            matching_mount = mount
            break

    if not matching_mount:
        return Response({
            'success': False,
            'error': 'Selected volume mount was not found on this container.',
        }, status=status.HTTP_400_BAD_REQUEST)

    mount_source = matching_mount.get('Source', '')
    if not mount_source:
        return Response({
            'success': False,
            'error': 'Selected mount does not expose a Docker volume source path.',
        }, status=status.HTTP_400_BAD_REQUEST)

    session_id, temp_container, terminal_path, shell_display, startup_output, error = start_volume_shell(
        container_id,
        mount_source,
        matching_mount.get('Name', ''),
        matching_mount.get('Destination', ''),
        request.user,
        agent,
        password,
        remote_agent,
    )
    if error:
        return Response({
            'success': False,
            'error': f'Failed to start volume shell: {error}',
        }, status=status.HTTP_400_BAD_REQUEST)

    volume_label = matching_mount.get("Name") or Path(mount_source).name or mount_source
    terminal_prompt = f"{terminal_path} #"
    initial_output = startup_output

    return Response({
        'success': True,
        'session_id': session_id,
        'container_id': container_id,
        'container_name': container_data.get('Name', '').lstrip('/') or 'container',
        'volume_name': volume_label,
        'volume_source': mount_source,
        'volume_destination': matching_mount.get('Destination', ''),
        'temporary_container': temp_container,
        'terminal_path': terminal_path,
        'terminal_prompt': terminal_prompt,
        'uses_native_prompt': not remote_agent,
        'shell_command': shell_display,
        'output': initial_output,
    }, status=status.HTTP_201_CREATED)


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def volume_files(request):
    """Browse and mutate files inside a selected container volume mount."""
    if not user_has_operation(request.user, 'connect_container'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'DELETE':
        agent, password, remote_agent, error_response = get_docker_target_context(request)
        if error_response:
            return error_response
        cleanup_result = remove_volume_helper_image(agent, password, remote_agent)
        return Response({
            'success': cleanup_result['success'],
            'image': VOLUME_HELPER_IMAGE,
            'image_removed': cleanup_result['success'],
        }, status=status.HTTP_200_OK if cleanup_result['success'] else status.HTTP_409_CONFLICT)

    container_id, container_data, matching_mount, target_context, error_response = get_verified_volume_mount(request)
    if error_response:
        return error_response

    mount_source = matching_mount.get('Source', '')
    volume_label = matching_mount.get('Name') or Path(mount_source).name or mount_source

    try:
        rel_path = clean_volume_browser_path(get_volume_request_value(request, 'path'))
    except ValueError as exc:
        return Response({'success': False, 'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

    if request.method == 'GET':
        if str(request.query_params.get('download', '')).lower() in {'1', 'true', 'yes'}:
            if not rel_path:
                return Response({'success': False, 'error': 'Select a file to download.'}, status=status.HTTP_400_BAD_REQUEST)
            script = """
root="$VOLUME_ROOT"
target="$root"
if [ ! -d "$root" ]; then
  mount_name=$(basename "$root")
  if [ "$VOLUME_PATH" != "$mount_name" ]; then echo "__VITEL_ERROR__:Path not found."; exit 2; fi
else
  if [ -n "$VOLUME_PATH" ]; then target="$root/$VOLUME_PATH"; fi
fi
if [ ! -e "$target" ]; then echo "__VITEL_ERROR__:Path not found."; exit 2; fi
if [ ! -f "$target" ]; then echo "__VITEL_ERROR__:Selected item is not a regular file."; exit 3; fi
base64 "$target"
"""
            result = run_volume_browser_command(
                mount_source,
                script,
                {'VOLUME_PATH': rel_path},
                timeout=60,
                target_context=target_context,
            )
            if not result['success']:
                return Response({
                    'success': False,
                    'error': volume_command_error(result, 'Failed to read file from volume.'),
                }, status=status.HTTP_400_BAD_REQUEST)
            return Response({
                'success': True,
                'path': rel_path,
                'filename': posixpath.basename(rel_path),
                'content_base64': ''.join(result.get('output', '').splitlines()),
            })

        script = """
root="$VOLUME_ROOT"
if [ ! -d "$root" ]; then
  if [ -n "$VOLUME_PATH" ]; then echo "__VITEL_ERROR__:Selected path is not a directory."; exit 3; fi
  item="$root"
  item_name_raw=$(basename "$root")
  item_type="file"
  [ -L "$item" ] && item_type="link"
  item_size="0"
  if [ -f "$item" ]; then item_size=$(wc -c < "$item" 2>/dev/null | tr -d ' '); fi
  item_modified=$(date -r "$item" +%s 2>/dev/null || echo 0)
  item_name=$(printf "%s" "$item_name_raw" | base64 | tr -d '\n')
  printf "%s\t%s\t%s\t%s\n" "$item_type" "$item_size" "$item_modified" "$item_name"
  exit 0
fi
target="$root"
if [ -n "$VOLUME_PATH" ]; then target="$root/$VOLUME_PATH"; fi
if [ ! -e "$target" ]; then echo "__VITEL_ERROR__:Path not found."; exit 2; fi
if [ ! -d "$target" ]; then echo "__VITEL_ERROR__:Selected path is not a directory."; exit 3; fi
cd "$target" || exit 4
for item in .[^.]* ..?* *; do
  [ -e "$item" ] || [ -L "$item" ] || continue
  item_type="file"
  [ -d "$item" ] && item_type="directory"
  [ -L "$item" ] && item_type="link"
  item_size="0"
  if [ -f "$item" ]; then item_size=$(wc -c < "$item" 2>/dev/null | tr -d ' '); fi
  item_modified=$(date -r "$item" +%s 2>/dev/null || echo 0)
  item_name=$(printf "%s" "$item" | base64 | tr -d '\n')
  printf "%s\t%s\t%s\t%s\n" "$item_type" "$item_size" "$item_modified" "$item_name"
done
"""
        result = run_volume_browser_command(
            mount_source,
            script,
            {'VOLUME_PATH': rel_path},
            timeout=45,
            target_context=target_context,
        )
        if not result['success']:
            return Response({
                'success': False,
                'error': volume_command_error(result, 'Failed to list files in volume.'),
            }, status=status.HTTP_400_BAD_REQUEST)

        entries = []
        for line in result.get('output', '').splitlines():
            parts = line.split('\t', 3)
            if len(parts) != 4:
                continue
            try:
                name = base64.b64decode(parts[3]).decode('utf-8', errors='replace')
            except (binascii.Error, ValueError):
                continue
            try:
                size = int(parts[1] or 0)
            except ValueError:
                size = 0
            try:
                modified = int(parts[2] or 0)
            except ValueError:
                modified = 0
            entries.append({
                'name': name,
                'type': parts[0] if parts[0] in {'directory', 'file', 'link'} else 'file',
                'size': size,
                'modified': modified,
            })
        entries.sort(key=lambda item: (item['type'] != 'directory', item['name'].lower()))

        return Response({
            'success': True,
            'container_id': container_id,
            'container_name': container_data.get('Name', '').lstrip('/') or 'container',
            'volume_name': volume_label,
            'volume_source': mount_source,
            'volume_destination': matching_mount.get('Destination', ''),
            'path': rel_path,
            'display_path': posixpath.join(mount_source, rel_path) if rel_path else mount_source,
            'entries': entries,
        })

    action = str(request.data.get('action', '') or '').strip()
    env_vars = {'VOLUME_PATH': rel_path}

    if action == 'mkdir':
        if not rel_path:
            return Response({'success': False, 'error': 'Folder name is required.'}, status=status.HTTP_400_BAD_REQUEST)
        script = """
root="$VOLUME_ROOT"
if [ ! -d "$root" ]; then echo "__VITEL_ERROR__:Cannot create folders inside a file mount."; exit 3; fi
target="$root/$VOLUME_PATH"
mkdir -p "$target"
"""
    elif action == 'delete':
        if not rel_path:
            return Response({'success': False, 'error': 'Root volume path cannot be deleted.'}, status=status.HTTP_400_BAD_REQUEST)
        script = """
root="$VOLUME_ROOT"
if [ ! -d "$root" ]; then
  mount_name=$(basename "$root")
  if [ "$VOLUME_PATH" != "$mount_name" ]; then echo "__VITEL_ERROR__:Path not found."; exit 2; fi
  target="$root"
else
  target="$root/$VOLUME_PATH"
fi
if [ ! -e "$target" ] && [ ! -L "$target" ]; then echo "__VITEL_ERROR__:Path not found."; exit 2; fi
rm -rf "$target"
"""
    elif action == 'rename':
        try:
            new_path = clean_volume_browser_path(request.data.get('new_path', ''))
        except ValueError as exc:
            return Response({'success': False, 'error': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        if not rel_path or not new_path:
            return Response({'success': False, 'error': 'Source and new path are required.'}, status=status.HTTP_400_BAD_REQUEST)
        env_vars['VOLUME_NEW_PATH'] = new_path
        script = """
root="$VOLUME_ROOT"
if [ ! -d "$root" ]; then echo "__VITEL_ERROR__:Cannot rename a file mount from the volume GUI."; exit 3; fi
old_target="$root/$VOLUME_PATH"
new_target="$root/$VOLUME_NEW_PATH"
if [ ! -e "$old_target" ] && [ ! -L "$old_target" ]; then echo "__VITEL_ERROR__:Path not found."; exit 2; fi
if [ -e "$new_target" ] || [ -L "$new_target" ]; then echo "__VITEL_ERROR__:A file or folder already exists with that name."; exit 3; fi
mv "$old_target" "$new_target"
"""
    elif action == 'write_file':
        content_base64 = str(request.data.get('content_base64', '') or '')
        if not rel_path:
            return Response({'success': False, 'error': 'File path is required.'}, status=status.HTTP_400_BAD_REQUEST)
        if len(content_base64) > 14 * 1024 * 1024:
            return Response({'success': False, 'error': 'File is too large for the browser upload limit.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            base64.b64decode(content_base64 or '', validate=True)
        except (binascii.Error, ValueError):
            return Response({'success': False, 'error': 'Uploaded file content is invalid.'}, status=status.HTTP_400_BAD_REQUEST)
        env_vars['VOLUME_CONTENT_B64'] = content_base64
        script = """
root="$VOLUME_ROOT"
if [ ! -d "$root" ]; then echo "__VITEL_ERROR__:Cannot upload files inside a file mount."; exit 3; fi
target="$root/$VOLUME_PATH"
parent=$(dirname "$target")
mkdir -p "$parent"
printf "%s" "$VOLUME_CONTENT_B64" | base64 -d > "$target"
"""
    else:
        return Response({'success': False, 'error': 'Unsupported file operation.'}, status=status.HTTP_400_BAD_REQUEST)

    result = run_volume_browser_command(
        mount_source,
        script,
        env_vars,
        timeout=60,
        target_context=target_context,
    )
    if not result['success']:
        return Response({
            'success': False,
            'error': volume_command_error(result, 'Volume file operation failed.'),
        }, status=status.HTTP_400_BAD_REQUEST)

    return Response({'success': True})


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def shell_command(request):
    """Send a command to the container shell."""
    session_id = request.data.get('session_id', '').strip()
    command = request.data.get('command', '')
    
    if not session_id:
        return Response({
            'error': 'Session ID is required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    success, error = send_shell_command(session_id, command, request.user)
    
    if not success:
        return Response({
            'success': False,
            'error': error,
        }, status=status.HTTP_400_BAD_REQUEST)
    
    return Response({
        'success': True,
    }, status=status.HTTP_200_OK)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def shell_output(request):
    """Read output from the container shell."""
    session_id = request.GET.get('session_id', '').strip()
    
    if not session_id:
        return Response({
            'error': 'Session ID is required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    output, info = read_shell_output(session_id, request.user)
    
    if output is None:
        return Response({
            'error': info,
        }, status=status.HTTP_404_NOT_FOUND)
    
    with CONTAINER_SHELLS_LOCK:
        session = CONTAINER_SHELLS.get(session_id)
        terminal_path = session.get('terminal_path', '') if session else ''

    return Response({
        'success': True,
        'output': output,
        'status': info or 'ok',
        'terminal_path': terminal_path,
    }, status=status.HTTP_200_OK)


@api_view(['DELETE'])
@permission_classes([IsAuthenticated])
def shell_session(request):
    """Close a container shell session."""
    session_id = request.data.get('session_id', '').strip()
    
    if not session_id:
        return Response({
            'error': 'Session ID is required.',
        }, status=status.HTTP_400_BAD_REQUEST)
    
    success, error = close_shell_session(session_id, request.user)
    
    if not success:
        return Response({
            'success': False,
            'error': error,
        }, status=status.HTTP_400_BAD_REQUEST)
    
    with CONTAINER_SHELLS_LOCK:
        CONTAINER_SHELLS.pop(session_id, None)
    
    return Response({
        'success': True,
    }, status=status.HTTP_200_OK)


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def network(request):
    """List, create, or delete Docker networks."""
    if request.method == 'GET' and not user_has_any_operation(request.user, ['view_networks', 'create_network', 'create_container', 'create_deployment']):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'POST' and not user_has_operation(request.user, 'create_network'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'DELETE' and not user_has_operation(request.user, 'delete_network'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if request.method == 'GET':
        result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'network', 'ls',
            '--format', '{{json .}}',
        ])
        return Response({
            **result,
            'networks': parse_json_lines(result['output']) if result['success'] else [],
        }, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    if request.method == 'DELETE':
        network_id = request.data.get('id', '').strip()
        name = request.data.get('name', '').strip()
        target = network_id or name

        if not target:
            return Response({
                'error': 'Network name or ID is required.',
            }, status=status.HTTP_400_BAD_REQUEST)

        inspect_result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'network', 'inspect', target, '--format', '{{.Name}}',
        ])
        if not inspect_result['success']:
            return Response(inspect_result, status=status.HTTP_400_BAD_REQUEST)

        inspected_name = inspect_result['output'].splitlines()[0].strip().lower()
        if inspected_name in {'bridge', 'host', 'none'}:
            return Response({
                'success': False,
                'error': f'Docker built-in network "{inspected_name}" is protected and cannot be deleted.',
            }, status=status.HTTP_400_BAD_REQUEST)
        result = run_target_docker_command(agent, password, remote_agent, ['docker', 'network', 'rm', target])
        return Response(result, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    name = request.data.get('name', '').strip()
    driver = request.data.get('driver', '').strip()
    subnet = request.data.get('subnet', '').strip()
    gateway = request.data.get('gateway', '').strip()

    if not name:
        return Response({
            'error': 'Network name is required.',
        }, status=status.HTTP_400_BAD_REQUEST)

    command = ['docker', 'network', 'create']
    if driver:
        command.extend(['--driver', driver])
    if subnet:
        command.extend(['--subnet', subnet])
    if gateway:
        command.extend(['--gateway', gateway])

    for label in as_list(request.data.get('labels')):
        if isinstance(label, dict):
            for key, value in label.items():
                command.extend(['--label', f'{key}={value}'])
        elif str(label).strip():
            command.extend(['--label', str(label).strip()])

    command.append(name)
    result = run_target_docker_command(agent, password, remote_agent, command)
    return Response(result, status=status.HTTP_201_CREATED if result['success'] else status.HTTP_400_BAD_REQUEST)


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def volume(request):
    """List, create, or delete Docker volumes."""
    if request.method == 'GET' and not user_has_any_operation(request.user, ['view_volumes', 'create_volume', 'create_container', 'create_deployment']):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'POST' and not user_has_operation(request.user, 'create_volume'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'DELETE' and not user_has_operation(request.user, 'delete_volume'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if request.method == 'GET':
        result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'volume', 'ls',
            '--format', '{{json .}}',
        ])
        return Response({
            **result,
            'volumes': parse_json_lines(result['output']) if result['success'] else [],
        }, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    if request.method == 'DELETE':
        name = request.data.get('name', '').strip()

        if not name:
            return Response({
                'error': 'Volume name is required.',
            }, status=status.HTTP_400_BAD_REQUEST)

        result = run_target_docker_command(agent, password, remote_agent, ['docker', 'volume', 'rm', name])
        return Response(result, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    name = request.data.get('name', '').strip()
    driver = request.data.get('driver', '').strip()

    if not name:
        return Response({
            'error': 'Volume name is required.',
        }, status=status.HTTP_400_BAD_REQUEST)

    command = ['docker', 'volume', 'create']
    if driver:
        command.extend(['--driver', driver])

    for label in as_list(request.data.get('labels')):
        if isinstance(label, dict):
            for key, value in label.items():
                command.extend(['--label', f'{key}={value}'])
        elif str(label).strip():
            command.extend(['--label', str(label).strip()])

    command.append(name)
    result = run_target_docker_command(agent, password, remote_agent, command)
    return Response(result, status=status.HTTP_201_CREATED if result['success'] else status.HTTP_400_BAD_REQUEST)


REMOTE_DOCKERFILE_BROWSER_SCRIPT = r'''
import json
import os
import posixpath
import sys

root = '/hostfs'
requested = sys.argv[1] if len(sys.argv) > 1 else '/'
display_path = posixpath.normpath('/' + str(requested or '/').lstrip('/'))
current_path = root if display_path == '/' else root + display_path
error = ''

if not os.path.isdir(root):
    error = 'The agent cannot access the server filesystem. Redeploy this agent to enable remote file browsing.'
elif os.path.islink(current_path):
    error = 'Symbolic-link paths are not available in the remote browser.'
else:
    while not os.path.exists(current_path) and current_path != root:
        current_path = os.path.dirname(current_path)
    if os.path.isfile(current_path):
        current_path = os.path.dirname(current_path)

directories = []
dockerfiles = []

if not error:
    try:
        entries = sorted(
            os.scandir(current_path),
            key=lambda entry: (not entry.is_dir(follow_symlinks=False), entry.name.lower()),
        )
        for entry in entries[:500]:
            if entry.is_symlink():
                continue
            relative = os.path.relpath(entry.path, root)
            entry_path = '/' if relative == '.' else '/' + relative.replace(os.sep, '/')
            if entry.is_dir(follow_symlinks=False):
                directories.append({'name': entry.name, 'path': entry_path})
            elif entry.is_file(follow_symlinks=False) and entry.name.lower().startswith('dockerfile'):
                dockerfiles.append({'name': entry.name, 'path': entry_path})
    except PermissionError:
        error = "Permission denied: Cannot read '%s'" % display_path
    except OSError as exc:
        error = 'Error reading directory: %s' % exc

relative_current = os.path.relpath(current_path, root)
current_display = '/' if relative_current == '.' else '/' + relative_current.replace(os.sep, '/')
parent_display = '' if current_display == '/' else posixpath.dirname(current_display) or '/'
payload = {
    'current_path': current_display,
    'parent_path': parent_display,
    'directories': directories,
    'dockerfiles': dockerfiles,
}
if error:
    payload['error'] = error
print(json.dumps(payload))
'''


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def browse_dockerfiles(request):
    """Browse Dockerfile candidates on the selected application or agent server."""
    if not user_has_any_operation(request.user, ['build_images', 'create_container']):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    requested_path = request.GET.get('path') or '/'
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if remote_agent:
        result = run_agent_command(
            agent,
            password,
            ['python3', '-c', REMOTE_DOCKERFILE_BROWSER_SCRIPT, requested_path],
            timeout=45,
        )
        if not result.get('success'):
            return Response({
                'success': False,
                'error': result.get('error') or result.get('output') or 'Unable to browse files on the selected agent.',
                'current_path': requested_path,
                'parent_path': '',
                'directories': [],
                'dockerfiles': [],
            }, status=status.HTTP_400_BAD_REQUEST)

        try:
            response_data = next(
                json.loads(line)
                for line in reversed(result.get('output', '').splitlines())
                if line.strip().startswith('{')
            )
        except (StopIteration, json.JSONDecodeError):
            return Response({
                'success': False,
                'error': 'The selected agent returned an invalid file-browser response.',
                'current_path': requested_path,
                'parent_path': '',
                'directories': [],
                'dockerfiles': [],
            }, status=status.HTTP_400_BAD_REQUEST)

        response_data['server_id'] = str(agent.id)
        response_data['server_name'] = agent.name
        return Response(response_data)
    
    # Try to resolve the requested path
    try:
        current_path = Path(requested_path).expanduser().resolve()
    except (OSError, ValueError):
        current_path = Path('/').resolve()

    # Check if path exists and is accessible
    if not current_path.exists():
        # Try parent path if current doesn't exist
        if current_path.parent != current_path:
            current_path = current_path.parent
        else:
            current_path = Path('/').resolve()

    # If it's a file, show parent directory
    if current_path.is_file():
        current_path = current_path.parent

    # Try to list directory contents
    directories = []
    dockerfiles = []
    error_msg = None
    
    try:
        if not current_path.is_dir():
            error_msg = f"'{current_path}' is not a directory"
        else:
            try:
                entries = list(current_path.iterdir())
                entries.sort(key=lambda path: (not path.is_dir(), path.name.lower()))
            except PermissionError:
                error_msg = f"Permission denied: Cannot read '{current_path}'"
                entries = []
            except OSError as exc:
                error_msg = f"Error reading directory: {str(exc)}"
                entries = []

            # Process entries (limit to 500 for performance)
            for entry in entries[:500]:
                try:
                    # Check if we can access the entry
                    if entry.is_symlink():
                        try:
                            entry.resolve(strict=True)
                        except (OSError, RuntimeError):
                            # Skip broken or inaccessible symlinks
                            continue
                    
                    if entry.is_dir():
                        directories.append({
                            'name': entry.name,
                            'path': str(entry),
                        })
                    elif entry.is_file() and entry.name.lower().startswith('dockerfile'):
                        dockerfiles.append({
                            'name': entry.name,
                            'path': str(entry),
                        })
                except (OSError, PermissionError):
                    # Skip entries we can't access
                    continue

    except Exception as exc:
        error_msg = f"Unexpected error: {str(exc)}"

    response_data = {
        'current_path': str(current_path),
        'parent_path': str(current_path.parent) if current_path.parent != current_path else '',
        'directories': directories,
        'dockerfiles': dockerfiles,
        'server_id': str(agent.id) if agent else 'local',
        'server_name': agent.name if agent else 'Application server',
    }
    
    if error_msg:
        response_data['error'] = error_msg

    return Response(response_data)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def browse_compose_files(request):
    """Browse folders and select Docker Compose YAML files."""
    requested_path = request.GET.get('path') or '/'

    try:
        current_path = Path(requested_path).expanduser().resolve()
    except (OSError, ValueError):
        current_path = Path('/').resolve()

    if not current_path.exists():
        if current_path.parent != current_path:
            current_path = current_path.parent
        else:
            current_path = Path('/').resolve()

    if current_path.is_file():
        current_path = current_path.parent

    directories = []
    compose_files = []
    error_msg = None

    try:
        if not current_path.is_dir():
            error_msg = f"'{current_path}' is not a directory"
        else:
            try:
                entries = list(current_path.iterdir())
                entries.sort(key=lambda path: (not path.is_dir(), path.name.lower()))
            except PermissionError:
                error_msg = f"Permission denied: Cannot read '{current_path}'"
                entries = []
            except OSError as exc:
                error_msg = f"Error reading directory: {str(exc)}"
                entries = []

            for entry in entries[:500]:
                try:
                    if entry.is_symlink():
                        try:
                            entry.resolve(strict=True)
                        except (OSError, RuntimeError):
                            continue

                    if entry.is_dir():
                        directories.append({
                            'name': entry.name,
                            'path': str(entry),
                        })
                    elif entry.is_file() and entry.suffix.lower() in ['.yml', '.yaml']:
                        compose_files.append({
                            'name': entry.name,
                            'path': str(entry),
                        })
                except (OSError, PermissionError):
                    continue
    except Exception as exc:
        error_msg = f"Unexpected error: {str(exc)}"

    response_data = {
        'current_path': str(current_path),
        'parent_path': str(current_path.parent) if current_path.parent != current_path else '',
        'directories': directories,
        'compose_files': compose_files,
    }
    if error_msg:
        response_data['error'] = error_msg

    return Response(response_data)


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def deployments(request):
    """List, create, or delete Compose deployments."""
    if request.method == 'GET' and not user_has_any_operation(request.user, ['view_deployments', 'create_deployment', 'delete_deployment']):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'GET':
        return Response({
            'deployments': [
                serialize_deployment(deployment)
                for deployment in Deployment.objects.filter(owner=request.user)
            ],
        })

    if request.method == 'DELETE':
        if not user_has_operation(request.user, 'delete_deployment'):
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        deployment_id = request.data.get('id')
        deployment = get_deployment_for_user(request.user, deployment_id)
        if not deployment:
            return Response({'error': 'Deployment not found.'}, status=status.HTTP_404_NOT_FOUND)
        removal = remove_deployment_runtime(deployment)
        if not removal.get('success'):
            return Response({
                'success': False,
                'error': 'Unable to delete deployment from the target server.',
                'output': removal.get('output', ''),
            }, status=status.HTTP_400_BAD_REQUEST)
        deployment.delete()
        return Response({'success': True, 'output': removal.get('output', '')})

    if not user_has_operation(request.user, 'create_deployment'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    name = request.data.get('name', '').strip()
    server_id = request.data.get('server_id') or 'local'
    target_agent = None
    local_target = not server_id or str(server_id) == 'local'
    if not local_target:
        try:
            target_agent = Agent.objects.get(owner=request.user, id=server_id, is_deleted=False)
        except (Agent.DoesNotExist, ValueError):
            return Response({'error': 'Target server agent not found.'}, status=status.HTTP_404_NOT_FOUND)
        if not target_agent.connected:
            return Response({'error': 'Target server agent is down. Redeploy the agent before deploying.'}, status=status.HTTP_400_BAD_REQUEST)

    compose_path, compose_error = validate_compose_path(request.data.get('compose_file', ''), local=local_target)

    if not name:
        return Response({'error': 'Deployment name is required.'}, status=status.HTTP_400_BAD_REQUEST)
    if compose_error:
        return Response({'error': compose_error}, status=status.HTTP_400_BAD_REQUEST)

    if local_target and not get_compose_command():
        return Response({
            'success': False,
            'error': 'Docker Compose is not installed in the backend container.',
            'output': 'Install the Docker Compose CLI plugin or rebuild the backend image with Compose support.',
        }, status=status.HTTP_400_BAD_REQUEST)

    project_name = normalize_compose_project_name(name)
    deployment, _ = Deployment.objects.update_or_create(
        owner=request.user,
        name=name,
        defaults={
            'project_name': project_name,
            'compose_file': compose_path,
            'target_agent': target_agent,
            'status': 'deploying',
        },
    )

    job_id = uuid.uuid4().hex
    command_display = f"docker compose -p {project_name} -f {compose_path} config && build && up -d --remove-orphans"
    with DEPLOY_JOBS_LOCK:
        DEPLOY_JOBS[job_id] = {
            'deployment_id': deployment.id,
            'command': command_display,
            'output': (
                f"Starting Docker Compose deployment on "
                f"{target_agent.name if target_agent else 'Application server'}...\n"
            ),
            'running': True,
            'success': None,
            'return_code': None,
            'process': None,
            'stopped': False,
        }

    thread = threading.Thread(target=run_deploy_job, args=(job_id, deployment.id), daemon=True)
    thread.start()

    return Response({
        'job_id': job_id,
        'running': True,
        'success': None,
        'deployment': serialize_deployment(deployment),
        'command': command_display,
        'output': DEPLOY_JOBS[job_id]['output'],
    }, status=status.HTTP_202_ACCEPTED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def deployment_output(request, job_id):
    with DEPLOY_JOBS_LOCK:
        job = DEPLOY_JOBS.get(job_id)
        if not job:
            return Response({'error': 'Deployment job not found.'}, status=status.HTTP_404_NOT_FOUND)

        return Response({
            'job_id': job_id,
            'deployment_id': job['deployment_id'],
            'command': job['command'],
            'output': job['output'],
            'running': job['running'],
            'success': job['success'],
            'return_code': job['return_code'],
            'stopped': job.get('stopped', False),
        })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def stop_deployment(request, job_id):
    with DEPLOY_JOBS_LOCK:
        job = DEPLOY_JOBS.get(job_id)
        if not job:
            return Response({'error': 'Deployment job not found.'}, status=status.HTTP_404_NOT_FOUND)
        process = job.get('process')
        job['stopped'] = True

    if process and process.poll() is None:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except OSError:
            process.terminate()

    with DEPLOY_JOBS_LOCK:
        job = DEPLOY_JOBS.get(job_id)
        return Response({
            'job_id': job_id,
            'running': bool(job and job.get('running')),
            'output': job.get('output', '') if job else '',
            'stopped': True,
        })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def deployment_detail(request, deployment_id=None):
    if not (user_has_any_operation(request.user, ['view_deployments', 'create_deployment', 'delete_deployment'])):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    deployment_id = deployment_id or request.query_params.get('id')
    deployment = get_deployment_for_user(request.user, deployment_id)
    if not deployment:
        return Response({'error': 'Deployment not found.'}, status=status.HTTP_404_NOT_FOUND)

    password = decode_agent_secret(getattr(deployment.target_agent, 'password_secret', '')) if deployment.target_agent_id else ''
    application_host = str(deployment.target_agent.server_ip) if deployment.target_agent_id else get_local_application_host(request)
    containers = [
        summarize_container(container, deployment.target_agent, password, application_host)
        for container in list_compose_containers(deployment.project_name, deployment.target_agent, password)
    ]
    images = sorted({container['image'] for container in containers if container.get('image')})
    networks = sorted({
        network['name']
        for container in containers
        for network in container.get('networks', [])
        if network.get('name')
    })
    volumes = sorted({
        mount['name']
        for container in containers
        for mount in container.get('mounts', [])
        if mount.get('type') == 'volume' and mount.get('name')
    })

    application_urls = []
    seen_application_urls = set()
    for container in containers:
        for access_url in container.get('access_urls', []):
            url = access_url.get('url') if isinstance(access_url, dict) else str(access_url or '')
            if not url or url in seen_application_urls:
                continue
            seen_application_urls.add(url)
            application_urls.append(access_url)

    return Response({
        'deployment': serialize_deployment(deployment),
        'containers': containers,
        'images': images,
        'networks': networks,
        'volumes': volumes,
        'application_host': application_host,
        'application_urls': application_urls,
    })


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def container_logs(request):
    if not (user_can_view_running_containers(request.user) or user_can_view_stopped_containers(request.user)):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    container_id = request.GET.get('id', '').strip()
    if not container_id:
        return Response({'error': 'Container ID is required.'}, status=status.HTTP_400_BAD_REQUEST)

    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    result = run_target_docker_command(agent, password, remote_agent, ['docker', 'logs', '--tail', '300', container_id], timeout=60)
    return Response(result, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)


@api_view(['POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def container_volume(request):
    """Report Docker's volume limitation in a structured endpoint."""
    return Response({
        'success': False,
        'error': 'Docker cannot attach or detach container volumes after a container is created. Update the Compose file and redeploy to change volumes.',
        'output': 'Volume attach/detach requires recreating the container from Docker Compose.',
    }, status=status.HTTP_400_BAD_REQUEST)


def get_docker_image_id(image_name):
    try:
        result = subprocess.run(
            ['docker', 'image', 'inspect', image_name, '--format', '{{.Id}}'],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
            env=get_docker_subprocess_env(),
        )
    except (OSError, subprocess.TimeoutExpired):
        return ''

    return result.stdout.strip() if result.returncode == 0 else ''


def run_build_job(job_id, command, image_name):
    previous_image_id = get_docker_image_id(image_name)

    with BUILD_JOBS_LOCK:
        BUILD_JOBS[job_id]['running'] = True
        BUILD_JOBS[job_id]['output'] = f"$ {' '.join(command)}\n"
        if previous_image_id:
            BUILD_JOBS[job_id]['output'] += f"Existing image found: {previous_image_id}\n"

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            start_new_session=True,
            env=get_docker_subprocess_env(),
        )

        with BUILD_JOBS_LOCK:
            BUILD_JOBS[job_id]['process'] = process

        for line in process.stdout:
            with BUILD_JOBS_LOCK:
                BUILD_JOBS[job_id]['output'] += line

        return_code = process.wait()
        with BUILD_JOBS_LOCK:
            stopped = BUILD_JOBS[job_id].get('stopped', False)
            BUILD_JOBS[job_id]['running'] = False
            BUILD_JOBS[job_id]['success'] = return_code == 0 and not stopped
            BUILD_JOBS[job_id]['return_code'] = return_code
            BUILD_JOBS[job_id]['process'] = None
            if stopped:
                BUILD_JOBS[job_id]['output'] += '\nDocker image build stopped.\n'
            elif return_code == 0:
                current_image_id = get_docker_image_id(image_name)
                if previous_image_id and current_image_id == previous_image_id:
                    BUILD_JOBS[job_id]['output'] += '\nImage is up to date. Docker reused cached layers and no new image changes were created.\n'
                else:
                    BUILD_JOBS[job_id]['output'] += '\nDocker image build completed. New or changed layers were applied.\n'
            else:
                BUILD_JOBS[job_id]['output'] += f'\nDocker image build failed with exit code {return_code}.\n'
    except OSError as exc:
        with BUILD_JOBS_LOCK:
            BUILD_JOBS[job_id]['running'] = False
            BUILD_JOBS[job_id]['success'] = False
            BUILD_JOBS[job_id]['return_code'] = None
            BUILD_JOBS[job_id]['process'] = None
            BUILD_JOBS[job_id]['output'] += f'\n{exc}\n'


def run_remote_build_job(job_id, agent, password, command):
    with BUILD_JOBS_LOCK:
        BUILD_JOBS[job_id]['running'] = True
        BUILD_JOBS[job_id]['output'] = (
            f'Building image on agent {agent.name} ({agent.server_ip}).\n'
            f"$ {' '.join(command)}\n"
        )

    try:
        result = run_agent_command(agent, password, command, timeout=1800)
    except Exception as exc:
        result = {
            'success': False,
            'return_code': None,
            'output': str(exc),
        }

    with BUILD_JOBS_LOCK:
        job = BUILD_JOBS.get(job_id)
        if not job:
            return
        stopped = job.get('stopped', False)
        if result.get('output'):
            job['output'] += result['output'].rstrip() + '\n'
        job['running'] = False
        job['success'] = bool(result.get('success')) and not stopped
        job['return_code'] = result.get('return_code')
        job['process'] = None
        if stopped:
            job['output'] += '\nRemote image build was marked as stopped.\n'
        elif result.get('success'):
            job['output'] += '\nDocker image build completed on the selected agent.\n'
        else:
            job['output'] += '\nDocker image build failed on the selected agent.\n'


@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def build_image(request):
    """List, build, or delete Docker images."""
    if request.method == 'GET' and not user_has_any_operation(request.user, ['view_images', 'build_images', 'create_container']):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'POST' and not user_has_operation(request.user, 'build_images'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    if request.method == 'DELETE' and not user_has_operation(request.user, 'delete_images'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    agent, password, remote_agent, error_response = get_docker_target_context(request)
    if error_response:
        return error_response

    if request.method == 'GET':
        result = run_target_docker_command(agent, password, remote_agent, [
            'docker', 'image', 'ls',
            '--format', '{{json .}}',
        ])
        return Response({
            **result,
            'images': parse_json_lines(result['output']) if result['success'] else [],
        }, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    if request.method == 'DELETE':
        image_id = request.data.get('id', '').strip()
        name = request.data.get('name', '').strip()
        target = image_id or name

        if not target:
            return Response({
                'error': 'Image name or ID is required.',
            }, status=status.HTTP_400_BAD_REQUEST)

        result = run_target_docker_command(agent, password, remote_agent, ['docker', 'image', 'rm', target])
        return Response(result, status=status.HTTP_200_OK if result['success'] else status.HTTP_400_BAD_REQUEST)

    image_name = request.data.get('image_name', '').strip()
    dockerfile_path = request.data.get('dockerfile_path', '').strip()

    if not image_name or not dockerfile_path:
        return Response({
            'error': 'Image name and Dockerfile path are required.',
        }, status=status.HTTP_400_BAD_REQUEST)

    command, build_error = get_dockerfile_build_command(
        image_name,
        dockerfile_path,
        local=not remote_agent,
    )
    if build_error:
        return Response({
            'error': build_error,
        }, status=status.HTTP_400_BAD_REQUEST)

    job_id = uuid.uuid4().hex

    with BUILD_JOBS_LOCK:
        BUILD_JOBS[job_id] = {
            'command': ' '.join(command),
            'output': 'Starting Docker image build...\n',
            'running': True,
            'success': None,
            'return_code': None,
            'process': None,
            'stopped': False,
            'remote': remote_agent,
            'server_id': str(agent.id) if agent else 'local',
        }

    if remote_agent:
        thread = threading.Thread(
            target=run_remote_build_job,
            args=(job_id, agent, password, command),
            daemon=True,
        )
    else:
        thread = threading.Thread(target=run_build_job, args=(job_id, command, image_name), daemon=True)
    thread.start()

    return Response({
        'job_id': job_id,
        'running': True,
        'success': None,
        'command': ' '.join(command),
        'output': 'Starting Docker image build...\n',
    }, status=status.HTTP_202_ACCEPTED)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def build_image_output(request, job_id):
    with BUILD_JOBS_LOCK:
        job = BUILD_JOBS.get(job_id)
        if not job:
            return Response({
                'error': 'Build job not found.',
            }, status=status.HTTP_404_NOT_FOUND)

        return Response({
            'job_id': job_id,
            'command': job['command'],
            'output': job['output'],
            'running': job['running'],
            'success': job['success'],
            'return_code': job['return_code'],
            'stopped': job.get('stopped', False),
        })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def stop_build_image(request, job_id):
    with BUILD_JOBS_LOCK:
        job = BUILD_JOBS.get(job_id)
        if not job:
            return Response({
                'error': 'Build job not found.',
            }, status=status.HTTP_404_NOT_FOUND)

        process = job.get('process')
        job['stopped'] = True
        job['output'] += '\nStopping Docker image build...\n'
        if job.get('remote') and not process:
            job['running'] = False
            job['success'] = False
            job['output'] += (
                'The controller stopped tracking this remote build. '
                'The Docker command may continue on the agent until it exits.\n'
            )

    if process and process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except OSError:
            process.terminate()

    with BUILD_JOBS_LOCK:
        return Response({
            'job_id': job_id,
            'command': job['command'],
            'output': job['output'],
            'running': job['running'],
            'success': job['success'],
            'return_code': job['return_code'],
            'stopped': job.get('stopped', False),
        })



@api_view(['GET', 'POST', 'DELETE'])
@permission_classes([IsAuthenticated])
def rbac_management(request):
    """Create/list/delete RBAC users and groups with operation assignments."""
    can_create_rbac_user = user_has_operation(request.user, 'create_rbac_user')
    can_create_rbac_group = user_has_operation(request.user, 'create_rbac_group')
    if not (can_create_rbac_user or can_create_rbac_group):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)

    if request.method == 'GET':
        users = []
        for user in User.objects.all().order_by('username'):
            profile, _ = UserProfile.objects.get_or_create(user=user)
            groups = list(user.rbac_groups.all())
            users.append({
                'id': user.id,
                'username': user.username,
                'is_admin': bool(user.is_staff or user.is_superuser),
                'operations': sorted(get_user_operation_codes(user)),
                'direct_operations': parse_operations(profile.operations),
                'operations_configured': profile.operations_configured,
                'groups': [{'id': group.id, 'name': group.name} for group in groups],
            })
        return Response({
            'operations': OPERATION_PERMISSIONS,
            'users': users,
            'groups': [
                {
                    'id': group.id,
                    'name': group.name,
                    'operations': parse_operations(group.operations),
                    'user_count': group.users.count(),
                }
                for group in RBACGroup.objects.all()
            ],
        })

    if request.method == 'DELETE':
        item_type = request.data.get('type', '').strip()
        if item_type == 'user' and not can_create_rbac_user:
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        if item_type == 'group' and not can_create_rbac_group:
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        item_id = request.data.get('id')
        if item_type == 'user':
            if str(item_id) == str(request.user.id):
                return Response({'error': 'You cannot delete your own user.'}, status=status.HTTP_400_BAD_REQUEST)
            try:
                User.objects.get(id=item_id).delete()
            except (User.DoesNotExist, ValueError):
                return Response({'error': 'User not found.'}, status=status.HTTP_404_NOT_FOUND)
            return Response({'success': True})
        if item_type == 'group':
            try:
                RBACGroup.objects.get(id=item_id).delete()
            except (RBACGroup.DoesNotExist, ValueError):
                return Response({'error': 'Group not found.'}, status=status.HTTP_404_NOT_FOUND)
            return Response({'success': True})
        return Response({'error': 'type must be user or group.'}, status=status.HTTP_400_BAD_REQUEST)

    item_type = request.data.get('type', '').strip()
    if item_type == 'group':
        if not can_create_rbac_group:
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        name = request.data.get('name', '').strip()
        operations = parse_operations(request.data.get('operations', []))
        if not name:
            return Response({'error': 'Group name is required.'}, status=status.HTTP_400_BAD_REQUEST)
        group, created = RBACGroup.objects.update_or_create(
            name=name,
            defaults={'operations': dump_operations(operations)},
        )
        return Response({'success': True, 'created': created, 'group': {
            'id': group.id,
            'name': group.name,
            'operations': parse_operations(group.operations),
            'user_count': group.users.count(),
        }}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    if item_type == 'user':
        if not can_create_rbac_user:
            return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
        username = request.data.get('username', '').strip()
        password = request.data.get('password', '')
        confirm_password = request.data.get('confirm_password', '')
        group_id = request.data.get('group_id')
        operations = parse_operations(request.data.get('operations', []))
        if not username or not password:
            return Response({'error': 'Username and password are required.'}, status=status.HTTP_400_BAD_REQUEST)
        if password != confirm_password:
            return Response({'error': 'Password and confirm password do not match.'}, status=status.HTTP_400_BAD_REQUEST)
        if User.objects.filter(username=username).exists():
            return Response({'error': 'Username already exists.'}, status=status.HTTP_400_BAD_REQUEST)
        user = User.objects.create_user(username=username, password=password)
        profile, _ = UserProfile.objects.get_or_create(user=user)
        if group_id:
            try:
                group = RBACGroup.objects.get(id=group_id)
            except (RBACGroup.DoesNotExist, ValueError):
                user.delete()
                return Response({'error': 'Selected group not found.'}, status=status.HTTP_400_BAD_REQUEST)
            user.rbac_groups.add(group)
            profile.operations = ''
        else:
            profile.operations = dump_operations(operations)
        profile.operations_configured = True
        profile.save(update_fields=['operations', 'operations_configured', 'updated_at'])
        return Response({'success': True, 'user': UserSerializer(user).data}, status=status.HTTP_201_CREATED)

    return Response({'error': 'type must be user or group.'}, status=status.HTTP_400_BAD_REQUEST)


@api_view(['POST'])
@permission_classes([AllowAny])
def register(request):
    """User registration endpoint"""
    serializer = RegisterSerializer(data=request.data)
    if serializer.is_valid():
        user = serializer.save()
        
        # Handle profile image
        if 'profile_image' in request.FILES:
            profile = user.profile
            profile.profile_image = request.FILES['profile_image']
            profile.save()
        
        access_token, refresh_token = generate_jwt_tokens(user)
        user_serializer = UserSerializer(user)
        
        return Response({
            'access_token': access_token,
            'refresh_token': refresh_token,
            'user': user_serializer.data,
            'message': 'User registered successfully'
        }, status=status.HTTP_201_CREATED)
    
    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


@api_view(['POST'])
@permission_classes([AllowAny])
def login(request):
    """User login endpoint"""
    serializer = LoginSerializer(data=request.data)
    if serializer.is_valid():
        username = serializer.validated_data['username']
        password = serializer.validated_data['password']
        
        user = authenticate(username=username, password=password)
        
        if user is not None:
            # Update profile image if provided
            if 'profile_image' in request.FILES:
                profile = user.profile
                profile.profile_image = request.FILES['profile_image']
                profile.save()
            
            # Log login history
            ip_address = get_client_ip(request)
            user_agent = request.META.get('HTTP_USER_AGENT', '')
            LoginHistory.objects.create(
                user=user,
                ip_address=ip_address,
                user_agent=user_agent
            )
            
            access_token, refresh_token = generate_jwt_tokens(user)
            user_serializer = UserSerializer(user)
            
            return Response({
                'access_token': access_token,
                'refresh_token': refresh_token,
                'user': user_serializer.data,
                'message': 'Login successful'
            }, status=status.HTTP_200_OK)
        else:
            return Response({
                'error': 'Invalid credentials'
            }, status=status.HTTP_401_UNAUTHORIZED)
    
    return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


@api_view(['GET', 'PUT'])
@permission_classes([IsAuthenticated])
def user_detail(request):
    """Get or update user profile details."""
    user = request.user
    profile, _ = UserProfile.objects.get_or_create(user=user)

    if request.method == 'GET':
        serializer = UserSerializer(user)
        return Response(serializer.data)

    user_data = request.data.copy()

    if 'profile_image' in request.FILES:
        profile.profile_image = request.FILES['profile_image']
        user_data.pop('profile_image', None)

    if 'name' in user_data:
        user.first_name = str(user_data.get('name', '')).strip()
    if 'email' in user_data:
        user.email = str(user_data.get('email', '')).strip()
    if 'mobile_number' in user_data:
        profile.mobile_number = str(user_data.get('mobile_number', '')).strip()
    if 'gender' in user_data:
        gender = str(user_data.get('gender', '')).strip()
        allowed_genders = {choice[0] for choice in UserProfile._meta.get_field('gender').choices}
        if gender not in allowed_genders:
            return Response({'error': 'Select a valid gender option.'}, status=status.HTTP_400_BAD_REQUEST)
        profile.gender = gender

    user.save()
    profile.save()
    serializer = UserSerializer(user)
    return Response(serializer.data)


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def change_password(request):
    """Update the signed-in user's password after checking the current password."""
    if not user_has_operation(request.user, 'change_password'):
        return Response({'error': 'You do not have permission for this operation.'}, status=status.HTTP_403_FORBIDDEN)
    user = request.user
    current_password = request.data.get('current_password', '')
    new_password = request.data.get('new_password', '')
    confirm_password = request.data.get('confirm_password', '')

    if not current_password or not new_password or not confirm_password:
        return Response({'error': 'Current password, new password, and confirm password are required.'}, status=status.HTTP_400_BAD_REQUEST)
    if not user.check_password(current_password):
        return Response({'error': 'Current password is incorrect.'}, status=status.HTTP_400_BAD_REQUEST)
    if new_password != confirm_password:
        return Response({'error': 'New password and confirm password do not match.'}, status=status.HTTP_400_BAD_REQUEST)
    if len(new_password) < 8:
        return Response({'error': 'New password must be at least 8 characters.'}, status=status.HTTP_400_BAD_REQUEST)

    user.set_password(new_password)
    user.save(update_fields=['password'])
    access_token, refresh_token = generate_jwt_tokens(user)
    return Response({
        'message': 'Password updated successfully.',
        'access_token': access_token,
        'refresh_token': refresh_token,
    })


@api_view(['POST'])
@permission_classes([IsAuthenticated])
def logout(request):
    """User logout endpoint"""
    # In JWT-based systems, logout is typically handled on the client side
    # by removing the token from localStorage
    return Response({
        'message': 'Logout successful'
    }, status=status.HTTP_200_OK)


@api_view(['GET'])
@permission_classes([IsAuthenticated])
def login_history(request):
    """Get user login history"""
    user = request.user
    history = LoginHistory.objects.filter(user=user).order_by('-timestamp')[:10]
    serializer = LoginHistorySerializer(history, many=True)
    return Response(serializer.data)


@api_view(['POST'])
@permission_classes([AllowAny])
def refresh_token(request):
    """Refresh JWT token"""
    refresh_token = request.data.get('refresh_token')
    
    if not refresh_token:
        return Response({
            'error': 'Refresh token required'
        }, status=status.HTTP_400_BAD_REQUEST)
    
    try:
        payload = jwt.decode(
            refresh_token,
            settings.SECRET_KEY,
            algorithms=['HS256']
        )
        user = User.objects.get(id=payload['user_id'])
        access_token, new_refresh_token = generate_jwt_tokens(user)
        
        return Response({
            'access_token': access_token,
            'refresh_token': new_refresh_token,
        }, status=status.HTTP_200_OK)
    except jwt.ExpiredSignatureError:
        return Response({
            'error': 'Refresh token expired'
        }, status=status.HTTP_401_UNAUTHORIZED)
    except (jwt.DecodeError, User.DoesNotExist):
        return Response({
            'error': 'Invalid refresh token'
        }, status=status.HTTP_401_UNAUTHORIZED)
