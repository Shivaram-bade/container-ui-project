import base64
import json
import os
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urljoin

from django.conf import settings
from django.utils import timezone

from .models import RegistryImage, RegistryRepository


def get_registry_internal_url():
    return os.getenv('VITEL_REGISTRY_INTERNAL_URL', 'http://vitel-registry:5000').rstrip('/')


def get_registry_push_host():
    return os.getenv('VITEL_REGISTRY_PUSH_HOST', '127.0.0.1:5000').strip()


def get_default_repository(user, pull_host='localhost:5000'):
    repository, _ = RegistryRepository.objects.get_or_create(
        owner=user,
        name='Vitel Registry',
        defaults={
            'registry_url': get_registry_internal_url(),
            'pull_host': pull_host,
        },
    )
    updates = []
    internal_url = get_registry_internal_url()
    if repository.registry_url != internal_url:
        repository.registry_url = internal_url
        updates.append('registry_url')
    if pull_host and repository.pull_host != pull_host:
        repository.pull_host = pull_host
        updates.append('pull_host')
    if updates:
        repository.save(update_fields=[*updates, 'updated_at'])
    return repository


def build_basic_auth_header(username, password):
    if not username or not password:
        return {}
    token = base64.b64encode(f'{username}:{password}'.encode('utf-8')).decode('ascii')
    return {'Authorization': f'Basic {token}'}


def registry_get_json(registry_url, path, username='', password='', timeout=20):
    url = urljoin(registry_url.rstrip('/') + '/', path.lstrip('/'))
    req = urllib_request.Request(url, headers=build_basic_auth_header(username, password), method='GET')
    try:
        with urllib_request.urlopen(req, timeout=timeout) as response:
            text = response.read().decode('utf-8')
            return True, json.loads(text) if text else {}, ''
    except urllib_error.HTTPError as exc:
        text = exc.read().decode('utf-8', errors='replace')
        return False, {}, text or str(exc)
    except (urllib_error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return False, {}, str(exc)


def list_registry_repositories(repository):
    ok, data, error = registry_get_json(repository.registry_url, '/v2/_catalog')
    if not ok:
        return False, [], error
    return True, sorted(data.get('repositories') or []), ''


def list_registry_tags(repository, image_name):
    image_name = str(image_name or '').strip().strip('/')
    if not image_name:
        return False, [], 'Image name is required.'
    ok, data, error = registry_get_json(repository.registry_url, f'/v2/{image_name}/tags/list')
    if not ok:
        return False, [], error
    tags = sorted(data.get('tags') or [])
    now = timezone.now()
    for tag in tags:
        RegistryImage.objects.update_or_create(
            repository=repository,
            name=image_name,
            tag=tag,
            defaults={'last_synced_at': now},
        )
    return True, tags, ''


def sync_registry_images(repository):
    ok, repositories, error = list_registry_repositories(repository)
    if not ok:
        return False, [], error
    images = []
    for image_name in repositories:
        tags_ok, tags, tags_error = list_registry_tags(repository, image_name)
        if not tags_ok:
            images.append({'name': image_name, 'tags': [], 'error': tags_error})
            continue
        images.append({'name': image_name, 'tags': tags})
    return True, images, ''


def build_registry_image_reference(repository, image_name, tag):
    image_name = str(image_name or '').strip().strip('/')
    tag = str(tag or '').strip()
    return f'{repository.pull_host.rstrip("/")}/{image_name}:{tag}'
