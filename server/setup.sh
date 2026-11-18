#!/usr/bin/env bash
# Game server box setup (card 08). Re-runnable: running it again on a set-up box changes nothing, and on a
# fresh Ubuntu LTS box it builds the whole server (then `npm run deploy:server` puts the game on it).
# Don't type one-off commands into the box: if it isn't in this script, it didn't happen.
#
#   npm run deploy:server -- --setup        (runs this over SSH, then deploys)
#   ssh -i ~/.ssh/race-server ubuntu@race.justinoxford.com 'sudo bash -s' < server/setup.sh
#
# What it does: system updates + automatic security updates, a 1 GB swapfile (the $5 box has 0.5 GB),
# Node LTS, Caddy (HTTPS with automatic certificates, proxying to the game on 127.0.0.1), a `racing`
# system user, /etc/racing.env, and the racing systemd service (restarts on crash and on reboot).
set -euo pipefail

DOMAIN="${DOMAIN:-race.justinoxford.com}"
NODE_MAJOR="${NODE_MAJOR:-26}"
GAME_PORT="${GAME_PORT:-2567}"
PAGES_ORIGIN="${PAGES_ORIGIN:-https://justin-oxford.github.io}"
APP_USER=racing
APP_DIR=/opt/racing

[ "$(id -u)" = 0 ] || { echo "run as root (sudo bash -s < server/setup.sh)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive
say() { echo "[setup] $*"; }

say "packages: update + upgrade"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https unattended-upgrades sqlite3

say "automatic security updates"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

say "swapfile (1 GB)"
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap /swapfile >/dev/null; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/90-racing-swap.conf
sysctl -q -p /etc/sysctl.d/90-racing-swap.conf

say "Node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" != "$NODE_MAJOR" ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get -y -q install nodejs
fi
say "node $(node --version)"

say "Caddy"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get -y -q install caddy
fi
# HTTPS for the domain (Caddy gets and renews the certificate; needs ports 80 + 443 open), proxied to the
# game server, which only listens on 127.0.0.1. WebSockets pass straight through.
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:${GAME_PORT}
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
EOF
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable --now caddy >/dev/null
systemctl reload caddy

say "app user and folders"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_DIR" "$APP_DIR/releases" "$APP_DIR/data"

say "/etc/racing.env (kept if it exists: secrets go here, never in git)"
if [ ! -f /etc/racing.env ]; then
  cat > /etc/racing.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=${GAME_PORT}
ALLOWED_ORIGINS=${PAGES_ORIGIN}
EOF
fi
chown root:"$APP_USER" /etc/racing.env
chmod 0640 /etc/racing.env

say "racing.service"
cat > /etc/systemd/system/racing.service <<EOF
[Unit]
Description=JavaScript Racing multiplayer server
After=network-online.target
Wants=network-online.target

[Service]
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}/current
EnvironmentFile=/etc/racing.env
ExecStart=/usr/bin/node --max-old-space-size=256 --enable-source-maps dist-server/server.mjs
Restart=always
RestartSec=2
# Locked down: it can only write its own data folder.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=${APP_DIR}/data

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable racing >/dev/null
if [ -e "$APP_DIR/current" ]; then systemctl restart racing; say "racing restarted"; else say "no release yet: npm run deploy:server puts one on"; fi

# Card 09 adds the nightly SQLite backup cron here.

say "done. memory:"
free -m | head -2
