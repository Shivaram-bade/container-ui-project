from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('auth_app', '0003_agent_port'),
    ]

    operations = [
        migrations.AddField(
            model_name='agent',
            name='ssh_username',
            field=models.CharField(default='root', max_length=150),
        ),
        migrations.AddField(
            model_name='agent',
            name='ssh_port',
            field=models.PositiveIntegerField(default=22),
        ),
        migrations.AddField(
            model_name='agent',
            name='password_secret',
            field=models.TextField(blank=True),
        ),
    ]
