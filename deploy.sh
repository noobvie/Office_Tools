#!/bin/bash
# =============================================================================
# Office Tools — One-Shot Deployment Script
# https://github.com/noobvie/Office_Tools
#
# Run once on a fresh Debian/Ubuntu server as root.
# Installs: nginx, certbot, Node.js, PocketBase, Office Tools frontend.
# Sets up: SSL, secure nginx config, systemd services.
# =============================================================================

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; }
die()     { echo -e "${RED}${BOLD}[FATAL]${RESET} $*"; exit 1; }
section() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  $*${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
}

# ─── Must run as root ─────────────────────────────────────────────────────────
[[ "$EUID" -ne 0 ]] && die "Run this script as root: sudo bash deploy.sh"

# ─── Paths ────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/noobvie/Office_Tools.git"
REPO_DIR="/opt/office-tools/repo"
WEB_ROOT="/var/www/office-tools"
BACKEND_DIR="/opt/office-tools/backend"
PB_DIR="/opt/office-tools/pocketbase"
NGINX_SYMLINK="office-tools"
NGINX_CONF_PATH="/etc/nginx/sites-available/${NGINX_SYMLINK}"
DEPLOY_CONF="/opt/office-tools/deploy.conf"   # saved config — skips prompts on redeploy
LOG_DIR="/var/log/office-tools"
LOG_FILE="$LOG_DIR/deploy_$(date +%Y%m%d_%H%M%S).log"

mkdir -p "$LOG_DIR"
exec > >(tee "$LOG_FILE") 2>&1
info "Log file: $LOG_FILE"

echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║     Office Tools — Deployment Script             ║${RESET}"
echo -e "${BOLD}${CYAN}║     github.com/noobvie/Office_Tools              ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════╝${RESET}"
echo ""

# ─── Parse flags ──────────────────────────────────────────────────────────────
RECONFIGURE=false
for arg in "$@"; do
    [[ "$arg" == "--reconfigure" ]] && RECONFIGURE=true
done

# ─── Load saved config or prompt ──────────────────────────────────────────────
DOMAIN=""; EMAIL=""; SETUP_BACKEND="n"
GRIN_WALLET_PASS=""; PB_ADMIN_EMAIL=""; PB_ADMIN_PASSWORD=""

if [[ -f "$DEPLOY_CONF" && "$RECONFIGURE" == false ]]; then
    # ── Redeploy: load saved config, skip all prompts ──────────────────────
    # shellcheck source=/dev/null
    source "$DEPLOY_CONF"
    section "Redeploy — using saved config"
    info "Domain        : $DOMAIN"
    info "Backend       : $SETUP_BACKEND"
    info "Config file   : $DEPLOY_CONF"
    info "Pass --reconfigure to change any setting"
    echo ""
else
    # ── First run (or --reconfigure): prompt for everything ────────────────
    [[ "$RECONFIGURE" == true ]] && warn "--reconfigure flag set — re-entering all settings."
    section "Configuration"

    while true; do
        echo -ne "${BOLD}Domain name${RESET} (e.g. tools.example.com): "
        read -r DOMAIN
        [[ -n "$DOMAIN" ]] && break
        warn "Domain cannot be empty."
    done

    while true; do
        echo -ne "${BOLD}Email${RESET} for Let's Encrypt SSL certificate: "
        read -r EMAIL
        [[ -n "$EMAIL" ]] && break
        warn "Email cannot be empty."
    done

    echo ""
    echo -e "${DIM}Backend services (PocketBase + Grin payment server) are optional."
    echo -e "You can skip them and set up later.${RESET}"
    echo ""
    echo -ne "Set up backend (PocketBase + Grin payment server)? [Y/n]: "
    read -r SETUP_BACKEND
    SETUP_BACKEND="${SETUP_BACKEND:-Y}"

    if [[ "${SETUP_BACKEND,,}" == "y" ]]; then
        section "Backend Configuration"
        echo -e "  ${DIM}These values go into ${BACKEND_DIR}/.env${RESET}"
        echo ""

        echo -ne "  Grin wallet password (GRIN_WALLET_PASS): "
        read -rs GRIN_WALLET_PASS; echo ""

        echo -ne "  PocketBase admin email (PB_ADMIN_EMAIL): "
        read -r PB_ADMIN_EMAIL

        echo -ne "  PocketBase admin password (PB_ADMIN_PASSWORD): "
        read -rs PB_ADMIN_PASSWORD; echo ""
    fi

    echo ""
    info "Deploying to  : $DOMAIN"
    info "Web root      : $WEB_ROOT"
    info "Backend dir   : $BACKEND_DIR"
    info "PocketBase dir: $PB_DIR"
    info "Log file      : $LOG_FILE"
    echo ""
    echo -ne "${BOLD}Proceed? [Y/n]: ${RESET}"
    read -r CONFIRM
    [[ "${CONFIRM,,}" == "n" ]] && echo "Aborted." && exit 0

    # Save config for future redeploys (passwords excluded — stored in .env)
    mkdir -p "$(dirname "$DEPLOY_CONF")"
    cat > "$DEPLOY_CONF" << CONFEOF
# Office Tools deploy config — auto-generated by deploy.sh
# Re-run with --reconfigure to change these values.
DOMAIN="${DOMAIN}"
EMAIL="${EMAIL}"
SETUP_BACKEND="${SETUP_BACKEND}"
PB_ADMIN_EMAIL="${PB_ADMIN_EMAIL}"
CONFEOF
    chmod 600 "$DEPLOY_CONF"
    success "Config saved to $DEPLOY_CONF"
fi

# ─── Step 1: System packages ──────────────────────────────────────────────────
section "Step 1 — Installing packages"

apt-get update -qq
apt-get install -y --no-install-recommends \
    nginx certbot python3-certbot-nginx \
    git curl unzip rsync ca-certificates gnupg

# Node.js 20 (via NodeSource) if not already installed
if ! command -v node &>/dev/null || [[ "$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')" -lt 18 ]]; then
    info "Installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi

success "Packages ready. Node $(node -v), nginx $(nginx -v 2>&1 | grep -oP '[\d.]+')"

# ─── Step 2: Clone / update repo ─────────────────────────────────────────────
section "Step 2 — Pulling Office Tools from GitHub"

if [[ -d "$REPO_DIR/.git" ]]; then
    info "Repo exists — pulling latest..."
    git -C "$REPO_DIR" pull --ff-only
else
    info "Cloning $REPO_URL..."
    mkdir -p "$(dirname "$REPO_DIR")"
    git clone "$REPO_URL" "$REPO_DIR"
fi

success "Repo up to date: $(git -C "$REPO_DIR" log -1 --format='%h %s')"

# ─── Step 3: Patch js/config.js with real domain ─────────────────────────────
section "Step 3 — Patching frontend config"

CONFIG_FILE="$REPO_DIR/js/config.js"
# Replace placeholder domain with real domain in PB_URL and GRIN_SERVER_URL
sed -i "s|https://pb\.yourdomain\.com|https://${DOMAIN}/pb-api|g"  "$CONFIG_FILE"
sed -i "s|https://pay\.yourdomain\.com|https://${DOMAIN}/pay-api|g" "$CONFIG_FILE"
sed -i "s|https://yourdomain\.com|https://${DOMAIN}|g"              "$CONFIG_FILE"

success "config.js updated for $DOMAIN"

# ─── Step 4: Deploy frontend to web root ─────────────────────────────────────
section "Step 4 — Deploying frontend to $WEB_ROOT"

mkdir -p "$WEB_ROOT"

rsync -av --delete \
    --exclude='.git' \
    --exclude='.gitignore' \
    --exclude='backend' \
    --exclude='deploy.sh' \
    --exclude='*.md' \
    "$REPO_DIR/" "$WEB_ROOT/"

chown -R www-data:www-data "$WEB_ROOT"
chmod -R 755 "$WEB_ROOT"
find "$WEB_ROOT" -type f -exec chmod 644 {} \;

success "Frontend deployed to $WEB_ROOT"

# ─── Step 5: nginx config (HTTP only first — certbot adds SSL block itself) ───
section "Step 5 — Writing nginx config"

# IMPORTANT: write HTTP-only block first.
# Writing "listen 443 ssl" before the certificate exists fails nginx -t.
# Certbot --nginx will append the SSL server block and fill in cert paths.
cat > "$NGINX_CONF_PATH" << NGINXEOF
# Office Tools — managed by deploy.sh
# SSL block will be added below by certbot automatically.
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    root  ${WEB_ROOT};
    index index.html;

    # ── Static frontend ──────────────────────────────────────────────────────
    location / {
        try_files \$uri \$uri/ \$uri.html =404;
    }

    # ── PocketBase API ───────────────────────────────────────────────────────
    location ^~ /pb-api/ {
        proxy_pass         http://127.0.0.1:8090/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_buffering    off;
    }

    # ── Grin payment server ──────────────────────────────────────────────────
    location ^~ /pay-api/ {
        proxy_pass         http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # ── Block sensitive paths ────────────────────────────────────────────────
    location ~ /\.                           { deny all; return 404; }
    location /backend/                       { deny all; return 404; }
    location ~ \.(env|sh|json|md|toml|log)$ { deny all; return 404; }
}
NGINXEOF

ln -sf "$NGINX_CONF_PATH" "/etc/nginx/sites-enabled/${NGINX_SYMLINK}"
rm -f /etc/nginx/sites-enabled/default

if ! nginx -t 2>&1; then
    error "nginx config test failed. Config file: $NGINX_CONF_PATH"
    cat "$NGINX_CONF_PATH"
    die "Fix the config above and re-run deploy.sh"
fi
systemctl reload nginx
success "nginx HTTP config written and reloaded"

# ─── Step 6: SSL certificate — certbot rewrites config with SSL block ─────────
section "Step 6 — Getting Let's Encrypt SSL certificate"

certbot --nginx -d "$DOMAIN" \
    --non-interactive --agree-tos \
    -m "$EMAIL" \
    --redirect

# certbot has issued the cert — cert paths are now known.
# Rewrite the full config with SSL hardening (avoids fragile sed patching).
SSL_CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
SSL_KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"

cat > "$NGINX_CONF_PATH" << NGINXEOF
# Office Tools — managed by deploy.sh
# Certbot will update the ssl_certificate lines on renewal.

# ── HTTP → HTTPS redirect ────────────────────────────────────────────────────
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

# ── HTTPS server ─────────────────────────────────────────────────────────────
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${DOMAIN};

    ssl_certificate     ${SSL_CERT};
    ssl_certificate_key ${SSL_KEY};

    # Strong SSL
    ssl_protocols             TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers               ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_session_cache         shared:SSL:10m;
    ssl_session_timeout       1d;
    ssl_session_tickets       off;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options           "SAMEORIGIN"             always;
    add_header X-Content-Type-Options    "nosniff"                always;
    add_header X-XSS-Protection          "1; mode=block"          always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy        "camera=(), microphone=(), geolocation=()" always;

    # Gzip
    gzip            on;
    gzip_vary       on;
    gzip_types      text/plain text/css text/javascript application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    root  ${WEB_ROOT};
    index index.html;

    # ── Static frontend ──────────────────────────────────────────────────────
    location / {
        try_files \$uri \$uri/ \$uri.html =404;
    }

    # Cache static assets
    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff2|woff)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # ── PocketBase API ───────────────────────────────────────────────────────
    location ^~ /pb-api/ {
        proxy_pass         http://127.0.0.1:8090/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 300s;
        proxy_buffering    off;
    }

    # ── PocketBase admin UI — HTML shell ─────────────────────────────────────
    # The admin SPA is served from /_/ on PocketBase.
    location ^~ /_/ {
        proxy_pass         http://127.0.0.1:8090/_/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # ── PocketBase admin UI — API calls ──────────────────────────────────────
    # The admin SPA makes API calls to /api/ using absolute paths.
    # /pb-api/ is for the frontend app; /api/ is for the admin UI itself.
    location ^~ /api/ {
        proxy_pass         http://127.0.0.1:8090/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # ── Grin payment server ──────────────────────────────────────────────────
    location ^~ /pay-api/ {
        proxy_pass         http://127.0.0.1:3001/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # ── Block sensitive paths ────────────────────────────────────────────────
    location ~ /\.                           { deny all; return 404; }
    location /backend/                       { deny all; return 404; }
    location ~ \.(env|sh|json|md|toml|log)$ { deny all; return 404; }
}
NGINXEOF

if ! nginx -t 2>&1; then
    error "nginx config test failed. Config file: $NGINX_CONF_PATH"
    error "Current config written:"
    cat "$NGINX_CONF_PATH"
    die "Fix the config above and re-run deploy.sh"
fi
systemctl reload nginx
success "SSL certificate issued and nginx hardened for $DOMAIN"

# ─── Step 7: Backend setup (optional) ────────────────────────────────────────
if [[ "${SETUP_BACKEND,,}" == "y" ]]; then

    BACKEND_ALREADY_SET_UP=false
    [[ -f "$BACKEND_DIR/.env" && -x "$PB_DIR/pocketbase" ]] && BACKEND_ALREADY_SET_UP=true

    if [[ "$BACKEND_ALREADY_SET_UP" == true && "$RECONFIGURE" == false ]]; then
        section "Step 7 — Backend already set up — syncing files only"
        # Only sync updated backend source files; keep existing .env intact
        rsync -av --exclude='.env' "$REPO_DIR/backend/" "$BACKEND_DIR/"
        cd "$BACKEND_DIR" && npm install --omit=dev && cd /
        cp "$BACKEND_DIR/pb_hooks/main.pb.js" "$PB_DIR/pb_hooks/"
        systemctl restart office-tools-pb office-tools-pay 2>/dev/null || true
        success "Backend files synced and services restarted"
    else
    section "Step 7 — Setting up backend"

    # 7a. Copy backend files
    mkdir -p "$BACKEND_DIR"
    rsync -av "$REPO_DIR/backend/" "$BACKEND_DIR/"

    # 7b. Write .env
    cat > "$BACKEND_DIR/.env" << ENVEOF
# ── Grin Wallet ──────────────────────────────────────────────────────────────
GRIN_OWNER_URL=http://127.0.0.1:3420/v3/owner
GRIN_WALLET_PASS=${GRIN_WALLET_PASS}
GRIN_FOREIGN_URL=http://127.0.0.1:3415/v2/foreign

# ── PocketBase ───────────────────────────────────────────────────────────────
PB_URL=http://127.0.0.1:8090
PB_ADMIN_EMAIL=${PB_ADMIN_EMAIL}
PB_ADMIN_PASSWORD=${PB_ADMIN_PASSWORD}

# ── Server ───────────────────────────────────────────────────────────────────
PORT=3001
CORS_ORIGINS=https://${DOMAIN}
PAYMENT_EXPIRY_MINUTES=30

# ── Plan amounts in nanogrin (1 GRIN = 1,000,000,000 nanogrin) ───────────────
PLAN_PRO_MONTHLY_NANOGRIN=10000000000
PLAN_PRO_YEARLY_NANOGRIN=100000000000
PLAN_LIFETIME_NANOGRIN=500000000000
ENVEOF

    chmod 600 "$BACKEND_DIR/.env"
    chown root:root "$BACKEND_DIR/.env"

    # 7c. npm install
    cd "$BACKEND_DIR"
    npm install --omit=dev
    cd /

    success "Backend files ready at $BACKEND_DIR"

    # 7d. Download latest PocketBase
    section "Step 7b — Downloading PocketBase"

    mkdir -p "$PB_DIR"
    PB_VERSION=$(curl -s https://api.github.com/repos/pocketbase/pocketbase/releases/latest \
        | grep '"tag_name"' | cut -d'"' -f4 | sed 's/v//')
    PB_ZIP="pocketbase_${PB_VERSION}_linux_amd64.zip"
    PB_URL_DL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/${PB_ZIP}"

    curl -L "$PB_URL_DL" -o "/tmp/${PB_ZIP}"
    unzip -o "/tmp/${PB_ZIP}" -d "$PB_DIR"
    chmod +x "$PB_DIR/pocketbase"
    rm -f "/tmp/${PB_ZIP}"

    # Copy pb_hooks and pb_schema
    mkdir -p "$PB_DIR/pb_hooks"
    cp "$BACKEND_DIR/pb_hooks/main.pb.js" "$PB_DIR/pb_hooks/"

    chown -R www-data:www-data "$PB_DIR"
    success "PocketBase $PB_VERSION installed at $PB_DIR"

    # 7e. Create systemd services
    section "Step 7c — Creating systemd services"

    # PocketBase service
    cat > /etc/systemd/system/office-tools-pb.service << PBEOF
[Unit]
Description=Office Tools — PocketBase
After=network.target
Wants=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${PB_DIR}
ExecStart=${PB_DIR}/pocketbase serve --http=127.0.0.1:8090
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
PBEOF

    # Grin payment server service
    cat > /etc/systemd/system/office-tools-pay.service << PAYEOF
[Unit]
Description=Office Tools — Grin Payment Server
After=network.target office-tools-pb.service
Wants=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${BACKEND_DIR}
ExecStart=/usr/bin/node grin-payment-server.js
EnvironmentFile=${BACKEND_DIR}/.env
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
PAYEOF

    systemctl daemon-reload
    systemctl enable office-tools-pb office-tools-pay
    systemctl start  office-tools-pb

    # Give PocketBase time to initialize before creating superuser
    info "Waiting for PocketBase to initialize..."
    sleep 3

    # Create superuser using credentials entered during setup
    if [[ -n "$PB_ADMIN_EMAIL" && -n "$PB_ADMIN_PASSWORD" ]]; then
        info "Creating PocketBase superuser: $PB_ADMIN_EMAIL"
        "$PB_DIR/pocketbase" superuser upsert "$PB_ADMIN_EMAIL" "$PB_ADMIN_PASSWORD" \
            && success "PocketBase superuser created: $PB_ADMIN_EMAIL" \
            || warn "Superuser creation failed — run manually: $PB_DIR/pocketbase superuser upsert EMAIL PASS"
    else
        warn "PB_ADMIN_EMAIL or PB_ADMIN_PASSWORD not set — skipping superuser creation."
        warn "Run manually: $PB_DIR/pocketbase superuser upsert EMAIL PASS"
    fi

    systemctl start office-tools-pay || \
        warn "Grin payment server failed to start — check 'journalctl -u office-tools-pay'. Is your Grin wallet running?"

    success "systemd services created and started"
    fi  # end else (first-time backend setup)
fi    # end SETUP_BACKEND

# ─── Done ─────────────────────────────────────────────────────────────────────
section "Deployment Complete"

echo -e "${BOLD}${GREEN}  ✔  https://${DOMAIN}  is live${RESET}"
echo ""

echo -e "${BOLD}── Locations ───────────────────────────────────────────────────${RESET}"
echo -e "  Web root       : ${WEB_ROOT}"
echo -e "  nginx config   : ${NGINX_CONF_PATH}"
echo -e "  Git repo       : ${REPO_DIR}"
echo -e "  Deploy logs    : ${LOG_DIR}/"
echo -e "  This run log   : ${LOG_FILE}"
echo -e "  SSL cert       : /etc/letsencrypt/live/${DOMAIN}/"
echo ""

if [[ "${SETUP_BACKEND,,}" == "y" ]]; then
    echo -e "${BOLD}── Backend ─────────────────────────────────────────────────────${RESET}"
    echo -e "  PocketBase dir : ${PB_DIR}"
    echo -e "  PocketBase bin : ${PB_DIR}/pocketbase"
    echo -e "  Backend dir    : ${BACKEND_DIR}"
    echo -e "  Backend .env   : ${BACKEND_DIR}/.env  ${DIM}(chmod 600, secrets here)${RESET}"
    echo -e "  PB schema      : ${BACKEND_DIR}/pb_schema.json"
    echo -e "  PB hooks       : ${PB_DIR}/pb_hooks/main.pb.js"
    echo ""

    echo -e "${BOLD}── Service commands ────────────────────────────────────────────${RESET}"
    echo -e "  systemctl status  office-tools-pb     ${DIM}# PocketBase status${RESET}"
    echo -e "  systemctl status  office-tools-pay    ${DIM}# Grin payment server status${RESET}"
    echo -e "  systemctl restart office-tools-pb"
    echo -e "  systemctl restart office-tools-pay"
    echo -e "  journalctl -fu    office-tools-pb     ${DIM}# live PocketBase logs${RESET}"
    echo -e "  journalctl -fu    office-tools-pay    ${DIM}# live payment server logs${RESET}"
    echo ""

    echo -e "${BOLD}── URLs ────────────────────────────────────────────────────────${RESET}"
    echo -e "  Site           : ${GREEN}https://${DOMAIN}/${RESET}"
    echo -e "  Admin panel    : ${GREEN}https://${DOMAIN}/admin/${RESET}        ${DIM}(PocketBase admin credentials)${RESET}"
    echo -e "  PocketBase UI  : ${GREEN}https://${DOMAIN}/pb-api/_/${RESET}     ${DIM}(first-time: create admin account)${RESET}"
    echo -e "  PB API root    : ${GREEN}https://${DOMAIN}/pb-api/${RESET}"
    echo -e "  Payment API    : ${GREEN}https://${DOMAIN}/pay-api/${RESET}"
    echo ""

    echo -e "${BOLD}${YELLOW}── PocketBase first-time setup (do this now) ───────────────────${RESET}"
    echo -e "  1. Open  ${BOLD}https://${DOMAIN}/pb-api/_/${RESET}"
    echo -e "  2. Create admin account — use the email/password you entered"
    echo -e "  3. Go to  Settings → Import Collections"
    echo -e "     Paste contents of:  ${BOLD}${BACKEND_DIR}/pb_schema.json${RESET}"
    echo -e "  4. Configure mail  Settings → Mail  (for welcome/verification emails)"
    echo -e "  5. Restart PocketBase:  ${BOLD}systemctl restart office-tools-pb${RESET}"
    echo ""
fi

echo -e "${BOLD}── nginx commands ──────────────────────────────────────────────${RESET}"
echo -e "  nginx -t                              ${DIM}# test config${RESET}"
echo -e "  systemctl reload nginx                ${DIM}# apply config changes${RESET}"
echo -e "  systemctl status nginx"
echo -e "  tail -f /var/log/nginx/error.log      ${DIM}# nginx errors${RESET}"
echo -e "  tail -f /var/log/nginx/access.log     ${DIM}# nginx access${RESET}"
echo ""

echo -e "${BOLD}── Redeploy after git push ─────────────────────────────────────${RESET}"
echo -e "  ${BOLD}sudo bash ${REPO_DIR}/deploy.sh${RESET}"
echo -e "  ${DIM}(re-pulls repo, re-syncs frontend, reloads nginx — SSL not re-requested)${RESET}"
echo ""

success "All done!"
