#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p data/local_storage/excel data/local_storage/access data/exports certbot/www certbot/conf
chmod -R 775 data certbot

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine before deploying LogiFlow." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose is required. Install Docker Compose v2 or docker-compose." >&2
  exit 1
fi

if [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock || true
fi

mkdir -p /etc/docker
cat > /tmp/logiflow-daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
JSON
if [ "$(id -u)" -eq 0 ]; then
  cp /tmp/logiflow-daemon.json /etc/docker/daemon.json
else
  sudo cp /tmp/logiflow-daemon.json /etc/docker/daemon.json || true
fi

"${COMPOSE[@]}" up --build -d
sleep 30
"${COMPOSE[@]}" ps
curl -fsS http://127.0.0.1:3000/health || curl -fsS http://127.0.0.1/health
