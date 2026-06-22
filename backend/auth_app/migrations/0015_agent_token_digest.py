from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('auth_app', '0014_agent_soft_delete'),
    ]

    operations = [
        migrations.AddField(
            model_name='agent',
            name='token_digest',
            field=models.CharField(blank=True, default='', max_length=64),
        ),
    ]
