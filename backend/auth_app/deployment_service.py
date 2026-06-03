from django.utils import timezone

from .models import DeploymentHistory, DeploymentJob


def record_deployment_history(job, status_value, message='', output='', actor=None):
    return DeploymentHistory.objects.create(
        job=job,
        agent=job.agent,
        status=status_value,
        message=message or '',
        output=output or '',
        actor=actor,
    )


def mark_deployment_job_running(job):
    job.status = DeploymentJob.STATUS_RUNNING
    job.started_at = job.started_at or timezone.now()
    job.save(update_fields=['status', 'started_at', 'updated_at'])
    record_deployment_history(job, DeploymentJob.STATUS_RUNNING, 'Agent started deployment job.')
    return job


def mark_deployment_job_complete(job, success, output='', error=''):
    job.status = DeploymentJob.STATUS_SUCCEEDED if success else DeploymentJob.STATUS_FAILED
    job.output = output or ''
    job.error = error or ''
    job.completed_at = timezone.now()
    job.save(update_fields=['status', 'output', 'error', 'completed_at', 'updated_at'])
    record_deployment_history(
        job,
        job.status,
        'Deployment completed successfully.' if success else 'Deployment failed.',
        output or error,
    )
    return job
