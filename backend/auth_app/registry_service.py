import json
import os
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import quote

from django.utils import timezone

from .models import RegistryImage, RegistryRepository


DEFAULT_REGISTRY_INTERNAL_URL = os.getenv('VITEL_REGISTRY_INTERNAL_URL', 'http://localhost:5000').rstrip('/')
DEFAULT_REGISTRY_PUSH_HOST = os.getenv('VITEL_REGISTRY_PUSH_HOST', 'localhost:5000').strip()


class RegistryClientError(RuntimeError):
    pass


def get_default_registry_url():
    return DEFAULT_REGISTRY_INTERNAL_URL


def get_default_registry_push_host():
    return DEFAULT_REGISTRY_PUSH_HOST


def get_or_create_repository(name, owner=None, registry_url=None, pull_host=None):
    repository, _ = RegistryRepository.objects.get_or_create(
        name=name,
        defaults={
            'owner': owner,
            'registry_url': registry_url or get_default_registry_url(),
            'pull_host': pull_host or get_default_registry_push_host(),
        },
    )
    changed = []
    if registry_url and repository.registry_url != registry_url:
        repository.registry_url = registry_url
        changed.append('registry_url')
    if pull_host and repository.pull_host != pull_host:
        repository.pull_host = pull_host
        changed.append('pull_host')
    if owner and not repository.owner_id:
        repository.owner = owner
        changed.append('owner')
    if changed:
        repository.save(update_fields=[*changed, 'updated_at'])
    return repository


def registry_request(path, registry_url=None):
    url = f'{(registry_url or get_default_registry_url()).rstrip("/")}{path}'
    request = urllib_request.Request(url, headers={'Accept': 'application/json'}, method='GET')
    try:
        with urllib_request.urlopen(request, timeout=20) as response:
            body = response.read().decode('utf-8')
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RegistryClientError(detail or str(exc)) from exc
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise RegistryClientError(str(exc)) from exc

    try:
        return json.loads(body) if body else {}
    except json.JSONDecodeError as exc:
        raise RegistryClientError('Registry returned invalid JSON.') from exc


def list_registry_catalog(registry_url=None):
    data = registry_request('/v2/_catalog', registry_url=registry_url)
    return data.get('repositories') or []


def list_registry_tags(repository_name, registry_url=None):
    encoded_name = quote(repository_name, safe='/')
    data = registry_request(f'/v2/{encoded_name}/tags/list', registry_url=registry_url)
    return data.get('tags') or []


def sync_registry_images(owner=None, registry_url=None, pull_host=None):
    registry_url = registry_url or get_default_registry_url()
    pull_host = pull_host or get_default_registry_push_host()
    synced = []
    for repository_name in list_registry_catalog(registry_url=registry_url):
        repository = get_or_create_repository(repository_name, owner=owner, registry_url=registry_url, pull_host=pull_host)
        for tag in list_registry_tags(repository_name, registry_url=registry_url):
            image, _ = RegistryImage.objects.update_or_create(
                repository=repository,
                tag=tag,
                defaults={
                    'name': repository_name,
                    'last_synced_at': timezone.now(),
                },
            )
            synced.append(image)
    return synced


def build_registry_reference(repository_name, tag, pull_host=None):
    host = (pull_host or get_default_registry_push_host()).strip().rstrip('/')
    return f'{host}/{repository_name}:{tag}'
