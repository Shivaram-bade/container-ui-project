from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('auth_app', '0007_userprofile_operations_configured'),
    ]

    operations = [
        migrations.AddField(
            model_name='agent',
            name='ssh_auth_type',
            field=models.CharField(default='password', max_length=20),
        ),
        migrations.AddField(
            model_name='agent',
            name='ssh_key_secret',
            field=models.TextField(blank=True),
        ),
        migrations.AddField(
            model_name='agent',
            name='ssh_key_passphrase_secret',
            field=models.TextField(blank=True),
        ),
    ]
