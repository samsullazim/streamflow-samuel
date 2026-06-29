#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/samsullazim/streamflow-samuel.git}"
APP_DIR="${APP_DIR:-/root/streamflow-github}"
DOMAIN_OR_IP="${1:-${DOMAIN_OR_IP:-}}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-Aremania87}"

if [ -z "$DOMAIN_OR_IP" ]; then
  IP=$(curl -4 -sS ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
  DOMAIN_OR_IP="${IP}.nip.io"
fi

if [[ "$DOMAIN_OR_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  DOMAIN="${DOMAIN_OR_IP}.nip.io"
else
  DOMAIN="$DOMAIN_OR_IP"
fi
BASE_URL="https://${DOMAIN}"

echo "==> Installing dependencies"
apt-get update
apt-get install -y git curl ca-certificates ffmpeg caddy build-essential python3 make g++

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=18?0:1)' ; then
  echo "==> Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

CLONE_URL="$REPO_URL"
if [ -n "${GITHUB_TOKEN:-}" ] && [[ "$REPO_URL" == https://github.com/* ]]; then
  CLONE_URL="https://samsullazim:${GITHUB_TOKEN}@${REPO_URL#https://}"
fi

if [ -d "$APP_DIR/.git" ]; then
  echo "==> Updating existing app at $APP_DIR"
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" checkout main
  git -C "$APP_DIR" pull --ff-only || true
else
  echo "==> Cloning app to $APP_DIR"
  rm -rf "$APP_DIR"
  git clone "$CLONE_URL" "$APP_DIR"
fi

cd "$APP_DIR"

echo "==> Installing npm deps"
npm install

SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
if [ -f .env ]; then
  grep -q '^SESSION_SECRET=' .env && SECRET=$(grep '^SESSION_SECRET=' .env | head -1 | cut -d= -f2-) || true
fi
cat > .env <<EOF
PORT=7575
SESSION_SECRET=${SECRET}
NODE_ENV=production
BASE_URL=${BASE_URL}
EOF

cat > /etc/systemd/system/streamflow.service <<EOF
[Unit]
Description=StreamFlow Samuel Custom
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=$(command -v node) ${APP_DIR}/app.js
Restart=always
RestartSec=5
StandardOutput=append:${APP_DIR}/streamflow.log
StandardError=append:${APP_DIR}/streamflow.log

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
    reverse_proxy 127.0.0.1:7575
    encode gzip
}

http://${DOMAIN} {
    redir https://${DOMAIN}{uri} permanent
}
EOF

echo "==> Initializing database and admin"
node - <<NODE
const {initializeDatabase}=require('./db/database');
const User=require('./models/User');
(async()=>{
 await initializeDatabase();
 let user=await User.findByUsername('${ADMIN_USER}');
 if(!user){
   await User.create({username:'${ADMIN_USER}', password:'${ADMIN_PASS}', user_role:'admin', status:'active', disk_limit:0});
   console.log('admin created');
 } else {
   console.log('admin exists');
 }
 setTimeout(()=>process.exit(0),500);
})().catch(e=>{console.error(e);process.exit(1)});
NODE

systemctl daemon-reload
systemctl enable streamflow.service caddy
systemctl restart streamflow.service
systemctl restart caddy
sleep 5

echo "==> Status"
systemctl is-active streamflow.service
systemctl is-active caddy
curl -k -sSI "$BASE_URL/login" | head -5 || true

echo ""
echo "DONE: ${BASE_URL}"
echo "Login: ${ADMIN_USER} / ${ADMIN_PASS}"
