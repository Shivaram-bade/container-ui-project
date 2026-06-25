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


def registry_manifest_exists(repository_name, tag, registry_url=None):
    encoded_name = quote(repository_name, safe='/')
    encoded_tag = quote(tag, safe='')
    url = f'{(registry_url or get_default_registry_url()).rstrip("/")}/v2/{encoded_name}/manifests/{encoded_tag}'
    request = urllib_request.Request(
        url,
        headers={
            'Accept': ', '.join([
                'application/vnd.oci.image.index.v1+json',
                'application/vnd.oci.image.manifest.v1+json',
                'application/vnd.docker.distribution.manifest.list.v2+json',
                'application/vnd.docker.distribution.manifest.v2+json',
            ]),
        },
        method='HEAD',
    )
    try:
        with urllib_request.urlopen(request, timeout=20) as response:
            return 200 <= response.status < 300
    except urllib_error.HTTPError as exc:
        if exc.code == 404:
            return False
        detail = exc.read().decode('utf-8', errors='replace')
        raise RegistryClientError(detail or str(exc)) from exc
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise RegistryClientError(str(exc)) from exc


def get_registry_manifest_digest(repository_name, tag, registry_url=None):
    encoded_name = quote(repository_name, safe='/')
    encoded_tag = quote(tag, safe='')
    url = f'{(registry_url or get_default_registry_url()).rstrip("/")}/v2/{encoded_name}/manifests/{encoded_tag}'
    request = urllib_request.Request(
        url,
        headers={
            'Accept': ', '.join([
                'application/vnd.oci.image.index.v1+json',
                'application/vnd.oci.image.manifest.v1+json',
                'application/vnd.docker.distribution.manifest.list.v2+json',
                'application/vnd.docker.distribution.manifest.v2+json',
            ]),
        },
        method='HEAD',
    )
    try:
        with urllib_request.urlopen(request, timeout=20) as response:
            digest = response.headers.get('Docker-Content-Digest', '').strip()
            if not digest:
                raise RegistryClientError('Registry did not return a manifest digest for this tag.')
            return digest
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RegistryClientError(detail or str(exc)) from exc
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise RegistryClientError(str(exc)) from exc


def delete_registry_manifest(repository_name, tag, registry_url=None):
    digest = get_registry_manifest_digest(repository_name, tag, registry_url=registry_url)
    encoded_name = quote(repository_name, safe='/')
    encoded_digest = quote(digest, safe=':')
    url = f'{(registry_url or get_default_registry_url()).rstrip("/")}/v2/{encoded_name}/manifests/{encoded_digest}'
    request = urllib_request.Request(url, method='DELETE')
    try:
        with urllib_request.urlopen(request, timeout=20) as response:
            if response.status not in (200, 202):
                raise RegistryClientError(f'Registry delete returned HTTP {response.status}.')
    except urllib_error.HTTPError as exc:
        detail = exc.read().decode('utf-8', errors='replace')
        raise RegistryClientError(detail or str(exc)) from exc
    except (urllib_error.URLError, TimeoutError, OSError) as exc:
        raise RegistryClientError(str(exc)) from exc
    return digest


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
