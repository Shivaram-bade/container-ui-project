from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('auth_app', '0008_agent_ssh_key_auth'),
    ]

    operations = [
        migrations.AddField(
            model_name='userprofile',
            name='mobile_number',
            field=models.CharField(blank=True, default='', max_length=30),
        ),
        migrations.AddField(
            model_name='userprofile',
            name='gender',
            field=models.CharField(
                blank=True,
                choices=[
                    ('', 'Not specified'),
                    ('female', 'Female'),
                    ('male', 'Male'),
                    ('non_binary', 'Non-binary'),
                    ('prefer_not_to_say', 'Prefer not to say'),
                ],
                default='',
                max_length=20,
            ),
        ),
    ]
