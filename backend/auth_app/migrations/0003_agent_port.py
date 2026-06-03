from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('auth_app', '0002_agent'),
    ]

    operations = [
        migrations.AddField(
            model_name='agent',
            name='port',
            field=models.PositiveIntegerField(default=19541),
        ),
    ]
