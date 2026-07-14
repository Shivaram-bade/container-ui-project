# base image python 3.12
FROM python:3.12-slim

WORKDIR /app

# Install system packages + OpenSSH client + Docker CLI dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    tar \
    openssh-client \
    git \
    bash && \
    rm -rf /var/lib/apt/lists/*

# Install latest Docker CLI
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH=x86_64; \
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then ARCH=aarch64; \
    else echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    DOCKER_VERSION=27.5.1 && \
    curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-${DOCKER_VERSION}.tgz" \
    -o docker.tgz && \
    tar -xzf docker.tgz && \
    mv docker/docker /usr/local/bin/docker && \
    chmod +x /usr/local/bin/docker && \
    rm -rf docker docker.tgz && \
    docker --version

# Install Docker Compose CLI plugin
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then ARCH=x86_64; \
    elif [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then ARCH=aarch64; \
    else echo "Unsupported architecture: $ARCH" && exit 1; \
    fi && \
    DOCKER_COMPOSE_VERSION=v2.32.4 && \
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${ARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    docker compose version

# Upgrade pip
RUN pip install --no-cache-dir --upgrade pip

# Install Python dependencies first for better layer caching
COPY requirements.txt ./

RUN pip install --no-cache-dir -r requirements.txt

# Copy project
COPY . .

# Start Django by default; start the Docker control agent when agent env is supplied.
CMD ["sh", "-c", "\
if [ -n \"$AGENT_ID\" ] && [ -n \"$AGENT_TOKEN\" ]; then \
  python -m auth_app.docker_agent; \
else \
  python manage.py migrate && \
  gunicorn vitel_project.wsgi:application \
    --bind 0.0.0.0:8000 \
    --workers 1 \
    --threads 4 \
    --worker-class gthread \
    --timeout 1800 \
    --access-logfile - \
    --error-logfile -; \
fi \
"]
