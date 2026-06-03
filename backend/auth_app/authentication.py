import jwt
from django.conf import settings
from django.contrib.auth.models import User
from rest_framework import authentication, exceptions


class JWTAuthentication(authentication.BaseAuthentication):
    """Authenticate API requests using the app's Bearer JWT access token."""

    keyword = 'Bearer'

    def authenticate(self, request):
        auth_header = authentication.get_authorization_header(request).decode('utf-8')
        if not auth_header:
            return None

        parts = auth_header.split()
        if len(parts) != 2 or parts[0] != self.keyword:
            raise exceptions.AuthenticationFailed('Invalid authorization header.')

        try:
            payload = jwt.decode(parts[1], settings.SECRET_KEY, algorithms=['HS256'])
        except jwt.ExpiredSignatureError as exc:
            raise exceptions.AuthenticationFailed('Access token has expired.') from exc
        except jwt.InvalidTokenError as exc:
            raise exceptions.AuthenticationFailed('Invalid access token.') from exc

        try:
            user = User.objects.get(id=payload.get('user_id'))
        except User.DoesNotExist as exc:
            raise exceptions.AuthenticationFailed('User not found.') from exc

        if not user.is_active:
            raise exceptions.AuthenticationFailed('User account is disabled.')

        return user, parts[1]
