from django.contrib import admin
from .models import UserProfile, LoginHistory


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
