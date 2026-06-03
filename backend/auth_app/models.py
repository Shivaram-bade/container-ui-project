from django.db import models
from django.contrib.auth.models import User
from django.core.files.base import ContentFile
import os


class UserProfile(models.Model):
    """Extended user profile with image support"""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    profile_image = models.ImageField(upload_to='profile_images/', null=True, blank=True)
    mobile_number = models.CharField(max_length=30, blank=True, default='')
    gender = models.CharField(
        max_length=20,
        blank=True,
        default='',
        choices=[
            ('', 'Not specified'),
            ('female', 'Female'),
            ('male', 'Male'),
            ('non_binary', 'Non-binary'),
            ('prefer_not_to_say', 'Prefer not to say'),
        ],
    )
    operations = models.TextField(blank=True, default='')
    operations_configured = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.user.username}'s profile"

    class Meta:
        verbose_name = 'User Profile'
        verbose_name_plural = 'User Profiles'


class LoginHistory(models.Model):
    """Track user login history"""
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='login_history')
    ip_address = models.GenericIPAddressField(null=True, blank=True)
    timestamp = models.DateTimeField(auto_now_add=True)
    user_agent = models.TextField(blank=True)

    def __str__(self):
        return f"{self.user.username} - {self.timestamp}"

    class Meta:
        verbose_name = 'Login History'
        verbose_name_plural = 'Login Histories'
        ordering = ['-timestamp']


class RBACGroup(models.Model):
    """Application operation group for UI and API access control."""
    name = models.CharField(max_length=150, unique=True)
    operations = models.TextField(blank=True, default='')
    users = models.ManyToManyField(User, related_name='rbac_groups', blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

    class Meta:
        ordering = ['name']


class Agent(models.Model):
    """Remote server agent registered to this controller."""
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name='agents')
    name = models.CharField(max_length=150)
    server_ip = models.GenericIPAddressField()
    ssh_username = models.CharField(max_length=150, default='root')
    ssh_port = models.PositiveIntegerField(default=22)
    ssh_auth_type = models.CharField(max_length=20, default='password')
    ssh_key_secret = models.TextField(blank=True)
    ssh_key_passphrase_secret = models.TextField(blank=True)
    port = models.PositiveIntegerField(default=19541)
    password_hash = models.CharField(max_length=256)
    password_secret = models.TextField(blank=True)
    connected = models.BooleanField(default=False)
    last_seen = models.DateTimeField(null=True, blank=True)
    hostname = models.CharField(max_length=255, blank=True)
    containers_count = models.PositiveIntegerField(default=0)
    images_count = models.PositiveIntegerField(default=0)
    networks_count = models.PositiveIntegerField(default=0)
    volumes_count = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f"{self.name} ({self.server_ip})"

    class Meta:
        unique_together = ('owner', 'name')
        ordering = ['name']



class AgentCommand(models.Model):
    """Command queued by the controller and pulled by a remote agent."""
    STATUS_PENDING = 'pending'
    STATUS_RUNNING = 'running'
    STATUS_COMPLETED = 'completed'
    STATUS_FAILED = 'failed'
    STATUS_CHOICES = [
        (STATUS_PENDING, 'Pending'),
        (STATUS_RUNNING, 'Running'),
        (STATUS_COMPLETED, 'Completed'),
        (STATUS_FAILED, 'Failed'),
    ]

    agent = models.ForeignKey(Agent, on_delete=models.CASCADE, related_name='commands')
    command = models.TextField()
    command_display = models.TextField(blank=True)
    timeout = models.PositiveIntegerField(default=120)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_PENDING)
    success = models.BooleanField(default=False)
    return_code = models.IntegerField(null=True, blank=True)
    output = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return f'{self.agent.name} command {self.id} ({self.status})'

    class Meta:
        ordering = ['created_at']


class Deployment(models.Model):
    """Docker Compose deployment tracked by this controller."""
    owner = models.ForeignKey(User, on_delete=models.CASCADE, related_name='deployments')
    name = models.CharField(max_length=150)
    project_name = models.CharField(max_length=180)
    compose_file = models.TextField()
    target_agent = models.ForeignKey(Agent, null=True, blank=True, on_delete=models.SET_NULL, related_name='deployments')
    status = models.CharField(max_length=40, default='created')
    last_output = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    def __str__(self):
        return self.name

    class Meta:
        unique_together = ('owner', 'name')
        ordering = ['name']
