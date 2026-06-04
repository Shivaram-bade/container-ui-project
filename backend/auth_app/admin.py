from django.contrib import admin
from .models import (
    Agent, DeploymentHistory, DeploymentJob, LoginHistory, RegistryImage,
    RegistryRepository, UserProfile
)


@admin.register(UserProfile)
class UserProfileAdmin(admin.ModelAdmin):
    list_display = ['user', 'created_at', 'updated_at']
    search_fields = ['user__username']
    readonly_fields = ['created_at', 'updated_at']


@admin.register(LoginHistory)
class LoginHistoryAdmin(admin.ModelAdmin):
    list_display = ['user', 'ip_address', 'timestamp']
    search_fields = ['user__username', 'ip_address']
    readonly_fields = ['timestamp']
    list_filter = ['timestamp']


@admin.register(Agent)
class AgentAdmin(admin.ModelAdmin):
    list_display = ['name', 'owner', 'server_ip', 'connected', 'last_seen']
    search_fields = ['name', 'server_ip', 'owner__username']
    list_filter = ['connected', 'ssh_auth_type']


@admin.register(RegistryRepository)
class RegistryRepositoryAdmin(admin.ModelAdmin):
    list_display = ['name', 'pull_host', 'username', 'updated_at']
    search_fields = ['name', 'pull_host']


@admin.register(RegistryImage)
class RegistryImageAdmin(admin.ModelAdmin):
    list_display = ['name', 'tag', 'repository', 'last_synced_at']
    search_fields = ['name', 'tag', 'repository__name']


@admin.register(DeploymentJob)
class DeploymentJobAdmin(admin.ModelAdmin):
    list_display = ['id', 'agent', 'image_reference', 'container_name', 'status', 'created_at']
    search_fields = ['image_reference', 'container_name', 'agent__name']
    list_filter = ['status', 'created_at']


@admin.register(DeploymentHistory)
class DeploymentHistoryAdmin(admin.ModelAdmin):
    list_display = ['job', 'agent', 'status', 'actor', 'created_at']
    search_fields = ['job__image_reference', 'agent__name', 'message']
    list_filter = ['status', 'created_at']
