from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('auth_app', '0015_agent_token_digest'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='KubernetesAuthUser',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('username', models.CharField(max_length=150)),
                ('namespace', models.CharField(default='default', max_length=150)),
                ('role_name', models.CharField(max_length=150)),
                ('role_binding_name', models.CharField(blank=True, max_length=180)),
                ('certificate_name', models.CharField(max_length=150)),
                ('csr_name', models.CharField(blank=True, max_length=180)),
                ('expiration_days', models.PositiveIntegerField(default=90)),
                ('certificate_expiry', models.DateTimeField(blank=True, null=True)),
                ('certificate_status', models.CharField(choices=[('active', 'Active'), ('failed', 'Failed'), ('expired', 'Expired'), ('revoked', 'Revoked')], default='active', max_length=20)),
                ('permissions', models.JSONField(blank=True, default=list)),
                ('resources', models.JSONField(blank=True, default=list)),
                ('can_i_results', models.JSONField(blank=True, default=list)),
                ('current_context', models.CharField(blank=True, max_length=255)),
                ('authentication_status', models.CharField(blank=True, max_length=120)),
                ('certificate_pem', models.TextField(blank=True)),
                ('private_key_pem', models.TextField(blank=True)),
                ('kubeconfig', models.TextField(blank=True)),
                ('error_message', models.TextField(blank=True)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('created_by', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='created_kubernetes_auth_users', to=settings.AUTH_USER_MODEL)),
                ('owner', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='kubernetes_auth_users', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['username'],
                'unique_together': {('owner', 'username'), ('owner', 'namespace', 'role_name')},
            },
        ),
        migrations.CreateModel(
            name='KubernetesAuthAuditLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(max_length=80)),
                ('message', models.TextField(blank=True)),
                ('details', models.JSONField(blank=True, default=dict)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('actor', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='kubernetes_auth_audit_events', to=settings.AUTH_USER_MODEL)),
                ('auth_user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='audit_logs', to='auth_app.kubernetesauthuser')),
                ('owner', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='kubernetes_auth_audit_logs', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'ordering': ['-created_at'],
            },
        ),
    ]
