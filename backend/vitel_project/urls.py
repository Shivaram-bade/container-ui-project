"""
URL configuration for vitel_project project.
"""
from django.contrib import admin
from django.urls import path, include
from django.conf import settings
from django.conf.urls.static import static
from auth_app import views as auth_views

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/auth/', include('auth_app.urls')),
    path('api/registry/images/', auth_views.registry_images, name='registry_images'),
    path('api/registry/tags/', auth_views.registry_tags, name='registry_tags'),
    path('api/registry/deploy/', auth_views.registry_deploy, name='registry_deploy'),
    path('api/registry/deployment-poll/', auth_views.registry_deployment_poll, name='registry_deployment_poll'),
    path('api/registry/deployment-result/', auth_views.registry_deployment_result, name='registry_deployment_result'),
]

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)
