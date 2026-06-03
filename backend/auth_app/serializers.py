from rest_framework import serializers
from django.contrib.auth.models import User
from .models import Agent, RBACGroup, UserProfile, LoginHistory


class UserProfileSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserProfile
        fields = ['id', 'profile_image', 'mobile_number', 'gender']


class UserSerializer(serializers.ModelSerializer):
    profile = UserProfileSerializer(read_only=True)
    profile_image = serializers.ImageField(write_only=True, required=False)
    name = serializers.SerializerMethodField()
    mobile_number = serializers.SerializerMethodField()
    gender = serializers.SerializerMethodField()
    operations = serializers.SerializerMethodField()
    groups = serializers.SerializerMethodField()
    is_admin = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'email', 'name', 'mobile_number', 'gender', 'profile',
            'profile_image', 'operations', 'groups', 'is_admin'
        ]

    def get_name(self, instance):
        full_name = instance.get_full_name().strip()
        return full_name or instance.first_name or instance.username

    def get_mobile_number(self, instance):
        profile = getattr(instance, 'profile', None)
        return profile.mobile_number if profile else ''

    def get_gender(self, instance):
        profile = getattr(instance, 'profile', None)
        return profile.gender if profile else ''

    def get_operations(self, instance):
        from .views import get_user_operation_codes
        return sorted(get_user_operation_codes(instance))

    def get_groups(self, instance):
        return [{'id': group.id, 'name': group.name} for group in instance.rbac_groups.all()]

    def get_is_admin(self, instance):
        return bool(instance.is_staff or instance.is_superuser)

    def to_representation(self, instance):
        """Convert to representation with profile image URL"""
        ret = super().to_representation(instance)
        if hasattr(instance, 'profile') and instance.profile.profile_image:
            ret['profile_image'] = instance.profile.profile_image.url
        return ret


class RegisterSerializer(serializers.Serializer):
    username = serializers.CharField(max_length=150, required=True)
    email = serializers.EmailField(required=True)
    password = serializers.CharField(write_only=True, required=True, min_length=8)

    def validate_username(self, value):
        if User.objects.filter(username=value).exists():
            raise serializers.ValidationError("Username already exists")
        return value

    def validate_email(self, value):
        if User.objects.filter(email=value).exists():
            raise serializers.ValidationError("Email already exists")
        return value

    def create(self, validated_data):
        user = User.objects.create_user(**validated_data)
        UserProfile.objects.get_or_create(user=user)
        return user


class LoginSerializer(serializers.Serializer):
    username = serializers.CharField(required=True)
    password = serializers.CharField(write_only=True, required=True)
    profile_image = serializers.ImageField(required=False)


class LoginHistorySerializer(serializers.ModelSerializer):
    class Meta:
        model = LoginHistory
        fields = ['id', 'ip_address', 'timestamp', 'user_agent']


class AgentSerializer(serializers.ModelSerializer):
    class Meta:
        model = Agent
        fields = [
            'id', 'name', 'server_ip', 'ssh_username', 'ssh_port', 'ssh_auth_type', 'port',
            'connected', 'last_seen', 'hostname', 'containers_count', 'images_count',
            'networks_count', 'volumes_count', 'created_at', 'updated_at',
        ]


class RBACGroupSerializer(serializers.ModelSerializer):
    class Meta:
        model = RBACGroup
        fields = ['id', 'name', 'operations', 'created_at', 'updated_at']
