#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib import error as urllib_error
from urllib import request as urllib_request


AGENT_ID = os.environ.get('AGENT_ID', 'docker-agent')
AGENT_TOKEN = os.environ.get('AGENT_TOKEN', '')
AGENT_PORT = int(os.environ.get('AGENT_PORT') or 19541)
CONTROL_SERVER_URL = os.environ.get('CONTROL_SERVER_URL', '').rstrip('/')


def log(message):
    print(message, flush=True)


def endpoint(path):
    return f'{CONTROL_SERVER_URL}{path}' if CONTROL_SERVER_URL else ''


def post_json(url, payload, timeout=30):
    if not url:
        return 0, {'error': 'CONTROL_SERVER_URL is not configured.'}
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


def auth_payload(extra=None):
    payload = {'name': AGENT_ID, 'password': AGENT_TOKEN}
    if extra:
        payload.update(extra)
    return payload


def run_process(command, timeout=600, input_text=None):
    display = ' '.join(command) if isinstance(command, list) else str(command)
    popen_command = command if isinstance(command, list) else ['sh', '-lc', str(command)]
    try:
        result = subprocess.run(
            popen_command,
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
        return False, None, display, output or f'Command timed out after {timeout} seconds.'
    except OSError as exc:
        return False, None, display, str(exc)


def count_lines(command):
    ok, _, _, output = run_process(command, timeout=20)
    return len([line for line in output.splitlines() if line.strip()]) if ok else 0


def get_server_ip():
    ok, _, _, output = run_process(['hostname', '-I'], timeout=5)
    return output.split()[0] if ok and output.split() else ''


def heartbeat():
    status, data = post_json(endpoint('/api/auth/agent-heartbeat/'), auth_payload({
        'server_ip': get_server_ip(),
        'hostname': os.uname().nodename if hasattr(os, 'uname') else '',
        'containers_count': count_lines(['docker', 'ps', '-aq']),
        'images_count': count_lines(['docker', 'image', 'ls', '-q']),
        'networks_count': count_lines(['docker', 'network', 'ls', '-q']),
        'volumes_count': count_lines(['docker', 'volume', 'ls', '-q']),
    }), timeout=30)
    if 200 <= status < 300:
        log(f'Heartbeat accepted at {time.strftime("%Y-%m-%d %H:%M:%S")}')
        return True
    log(f'Heartbeat failed status={status} {data.get("error") or data}')
    return False


def command_to_process(command):
    if isinstance(command, list):
        command = [str(part) for part in command if str(part)]
        return command, ' '.join(command)
    command = str(command or '').strip()
    return ['sh', '-lc', command], command


def post_command_result(command_id, success, return_code, command, output):
    status, data = post_json(endpoint('/api/auth/agent-command-result/'), auth_payload({
        'command_id': command_id,
        'success': bool(success),
        'return_code': return_code,
        'command': command,
        'output': output or '',
    }), timeout=30)
    if 200 <= status < 300:
        log(f'Command {command_id} result posted.')
        return True
    log(f'Command {command_id} result post failed status={status} {data.get("error") or data}')
    return False


def poll_command():
    status, data = post_json(endpoint('/api/auth/agent-command/'), auth_payload(), timeout=30)
    if status == 204:
        return False
    if not (200 <= status < 300):
        log(f'Command poll failed status={status} {data.get("error") or data}')
        return False
    command_payload = data.get('command') or {}
    command_id = command_payload.get('id')
    command = command_payload.get('command')
    try:
        timeout = max(1, min(int(command_payload.get('timeout') or 120), 1800))
    except (TypeError, ValueError):
        timeout = 120
    popen_command, display_command = command_to_process(command)
    if not command_id or not popen_command:
        return False
    log(f'Running pulled command {command_id}: {display_command}')
    success, return_code, _, output = run_process(popen_command, timeout=timeout)
    post_command_result(command_id, success, return_code, display_command, output)
    return True


def registry_host(image_reference):
    first = str(image_reference or '').split('/')[0]
    return first if ('.' in first or ':' in first or first == 'localhost') else ''


def post_deployment_result(job_id, success, output, error=''):
    status, data = post_json(endpoint('/api/registry/deployment-result/'), auth_payload({
        'job_id': job_id,
        'success': bool(success),
        'output': output or '',
        'error': error or '',
    }), timeout=30)
    if 200 <= status < 300:
        log(f'Deployment job {job_id} result posted.')
        return True
    log(f'Deployment result post failed status={status} {data.get("error") or data}')
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
        output_parts.extend(['$ ' + display.replace(password, '********'), output.replace(password, '********')])
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
    status, data = post_json(endpoint('/api/registry/deployment-poll/'), auth_payload(), timeout=30)
    if status == 204:
        return False
    if not (200 <= status < 300):
        log(f'Deployment poll failed status={status} {data.get("error") or data}')
        return False
    job = data.get('job')
    if not job:
        return False
    log(f'Running deployment job {job.get("id")}: {job.get("image_reference")}')
    return run_deployment(job)


class AgentHandler(BaseHTTPRequestHandler):
    server_version = 'DockerControlAgent/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - - [%s] %s\n' % (self.address_string(), self.log_date_time_string(), fmt % args))

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
        self.send_json(200, {'success': True, 'agent': AGENT_ID})

    def do_POST(self):
        if self.path != '/run-command':
            self.send_json(404, {'success': False, 'error': 'Not found'})
            return
        payload = self.read_payload()
        if payload.get('password') != AGENT_TOKEN:
            self.send_json(403, {'success': False, 'error': 'Invalid agent token.'})
            return
        command = payload.get('command')
        try:
            timeout = max(1, min(int(payload.get('timeout') or 120), 900))
        except (TypeError, ValueError):
            timeout = 120
        popen_command, display_command = command_to_process(command)
        if not popen_command:
            self.send_json(400, {'success': False, 'error': 'Command is required.'})
            return
        success, return_code, _, output = run_process(popen_command, timeout=timeout)
        self.send_json(200 if success else 500, {
            'success': success,
            'return_code': return_code,
            'command': display_command,
            'output': output,
        })


def start_http_server():
    try:
        HTTPServer(('0.0.0.0', AGENT_PORT), AgentHandler).serve_forever()
    except OSError as exc:
        log(f'Agent command server failed on port {AGENT_PORT}: {exc}')


def main():
    if not AGENT_TOKEN or not CONTROL_SERVER_URL:
        raise SystemExit('AGENT_TOKEN and CONTROL_SERVER_URL are required.')
    threading.Thread(target=start_http_server, daemon=True).start()
    last_heartbeat = 0
    last_deployment_poll = 0
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
    main()
