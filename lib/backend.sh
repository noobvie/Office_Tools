# =============================================================================
# Office Tools — Backend service and TURN relay (coturn)
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Backend ──────────────────────────────────────────────────────────────────
# Write/update NOTIFY_EMAIL and NOTIFY_EMAIL_2 in existing .env
_update_notify_env() {
    local e1="${1:-}" e2="${2:-}"
    [[ ! -f "$BACKEND_DIR/.env" ]] && return 0
    for key_val in "NOTIFY_EMAIL=${e1}" "NOTIFY_EMAIL_2=${e2}"; do
        local key="${key_val%%=*}"
        local val="${key_val#*=}"
        if grep -q "^${key}=" "$BACKEND_DIR/.env" 2>/dev/null; then
            sed -i "s|^${key}=.*|${key}=${val}|" "$BACKEND_DIR/.env"
        else
            echo "${key}=${val}" >> "$BACKEND_DIR/.env"
        fi
    done
}

# ─── TURN relay (coturn) — File Drop WebRTC fallback ───────────────────────────
# Installs+configures coturn with the REST/`use-auth-secret` scheme so the API
# server can mint short-lived TURN credentials (see /api/tools/turn). Idempotent
# and non-fatal: on any failure it warns and returns 0 so the deploy continues —
# File Drop still works over direct P2P, just without the relay fallback.
setup_turn() {
    local domain="$1" secret="$2" ext_ip="${3:-}"
    section "TURN relay setup — coturn (File Drop fallback)"

    # On a cloud VPS with 1:1 NAT (public IP not on the interface), coturn must be
    # told the public↔private mapping or it advertises the private IP as the relay
    # candidate. Passed as <PUBLIC>/<PRIVATE> from _provision_turn only when they differ.
    local ext_line=""
    [[ -n "$ext_ip" ]] && ext_line="external-ip=${ext_ip}"

    # coturn reads a different config path per distro: Debian → /etc/turnserver.conf
    # (plus the /etc/default/coturn enable gate); EPEL on Rocky/Alma → /etc/coturn/
    # turnserver.conf. Writing to the wrong one would leave coturn running on
    # package defaults (no auth secret) — broken. Pick the path the package uses.
    local turn_conf="/etc/turnserver.conf"
    if [[ "$OS_FAMILY" == "debian" ]]; then
        DEBIAN_FRONTEND=noninteractive apt-get install -y coturn >/dev/null 2>&1 \
            || { warn "coturn install failed — File Drop will use direct P2P only"; return 0; }
        # Debian gates the daemon behind /etc/default/coturn
        if grep -q '^#*TURNSERVER_ENABLED=' /etc/default/coturn 2>/dev/null; then
            sed -i 's/^#*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
        else
            echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn
        fi
    else
        # coturn on Rocky/Alma comes from EPEL — install fails (non-fatal) if EPEL absent
        dnf install -y coturn >/dev/null 2>&1 || yum install -y coturn >/dev/null 2>&1 \
            || { warn "coturn install failed (EPEL enabled?) — File Drop will use direct P2P only"; return 0; }
        mkdir -p /etc/coturn
        turn_conf="/etc/coturn/turnserver.conf"
    fi

    # Plain turn: on 3478 (udp+tcp) only. We deliberately do NOT configure turns:
    # (TLS 5349): the frontend advertises only turn: URLs, the relayed media is
    # already end-to-end DTLS-encrypted, and pointing coturn at the root-only LE
    # privkey would make a non-root coturn (EL) fail to start for zero client gain.
    # turns: can be added later (needs a cert the coturn user can read).
    cat > "$turn_conf" << TURNEOF
# Office Tools — File Drop TURN relay (managed by deploy.sh)
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=${secret}
realm=${domain}
${ext_line}
no-cli
no-tcp-relay
no-multicast-peers
min-port=49152
max-port=65535
# SSRF hardening — never relay to loopback/private/link-local ranges
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
TURNEOF
    # The config holds the auth secret, so keep it non-world-readable — but coturn
    # runs as a non-root user on EL (coturn) and may on Debian (turnserver), so a
    # 600 root:root file would be UNREADABLE to the daemon and it wouldn't start.
    # 640 root:<service-group> lets the daemon read it; falls back to root:root
    # (fine — Debian's unit runs as root) when no such group exists.
    chmod 640 "$turn_conf"
    for _grp in coturn turnserver; do
        if getent group "$_grp" >/dev/null 2>&1; then chown "root:$_grp" "$turn_conf"; break; fi
    done

    # Firewall: TURN signaling (3478 udp+tcp) + relay media range
    if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
        firewall-cmd --permanent --add-port=3478/udp --add-port=3478/tcp &>/dev/null
        firewall-cmd --permanent --add-port=49152-65535/udp &>/dev/null
        firewall-cmd --reload &>/dev/null
    fi
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
        ufw allow 3478/udp >/dev/null 2>&1 || true
        ufw allow 3478/tcp >/dev/null 2>&1 || true
        ufw allow 49152:65535/udp >/dev/null 2>&1 || true
    fi

    systemctl enable coturn >/dev/null 2>&1 || true
    if systemctl restart coturn >/dev/null 2>&1; then
        success "coturn TURN relay running on :3478 (realm ${domain})"
    else
        warn "coturn failed to start — check: journalctl -u coturn (File Drop still works P2P)"
    fi
}

# Set KEY=VALUE in the backend .env — update in place or append. Value must not
# contain the sed delimiter (|); TURN URLs/secret/domain never do.
_set_env_kv() {
    local key="$1" val="$2" envf="$BACKEND_DIR/.env"
    if grep -q "^${key}=" "$envf" 2>/dev/null; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$envf"
    else
        echo "${key}=${val}" >> "$envf"
    fi
}

# The IP a remote client actually sees (asks an external echo; falls back to the
# default-route source IP). TURN clients must reach this IP directly.
_detect_public_ip() {
    local ip="" url
    for url in "https://api.ipify.org" "https://ipv4.icanhazip.com" "https://ifconfig.me/ip"; do
        # || true: under `set -e`+pipefail a failed curl would otherwise abort the
        # loop before the fallback URLs are tried.
        ip=$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || true
        [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && { echo "$ip"; return 0; }
    done
    ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true
}
# The IP actually bound on the interface (private on a NAT box, public otherwise).
_detect_local_ip() {
    ip -4 route get 1.1.1.1 2>/dev/null | grep -oP 'src \K[0-9.]+' | head -1 || true
}

# Idempotently ensure TURN settings exist in .env and coturn is provisioned.
# Safe on first-time setup AND every update (sync_backend): reuses an existing
# TURN_SECRET (never rotates a working one), then (re)configures coturn.
# No-op without a domain or an existing .env.
#
# TURN is advertised on the server's PUBLIC IP, not the site domain: a CDN/proxy
# in front of the domain (e.g. Cloudflare's orange cloud) only forwards 80/443, so
# UDP/TCP 3478 sent to the proxied hostname dies at the edge and never reaches
# coturn. The raw IP goes straight to the box. (Trade-off: the /api/tools/turn
# response then exposes the origin IP — unavoidable for TURN to function.)
_provision_turn() {
    local domain="$1" envf="$BACKEND_DIR/.env"
    if [[ -z "$domain" || ! -f "$envf" ]]; then return 0; fi

    local pub_ip local_ip host ext_ip=""
    pub_ip="$(_detect_public_ip)"  || true
    local_ip="$(_detect_local_ip)" || true
    if [[ -n "$pub_ip" ]]; then
        host="$pub_ip"
        # 1:1 NAT (cloud): interface holds a private IP ≠ the public IP → tell coturn.
        [[ -n "$local_ip" && "$local_ip" != "$pub_ip" ]] && ext_ip="${pub_ip}/${local_ip}"
    else
        warn "Could not detect public IP — TURN will use ${domain} (fails if behind a proxy/CDN)"
        host="$domain"
    fi

    local secret
    # || true: grep exits 1 (→ pipefail) when TURN_SECRET isn't in .env yet (fresh
    # box); without the guard `set -e` would abort the deploy on first-time setup.
    secret=$(grep -E '^TURN_SECRET=' "$envf" 2>/dev/null | head -1 | cut -d= -f2-) || true
    [[ -z "$secret" ]] && secret="$(openssl rand -hex 32)"
    _set_env_kv TURN_URLS   "turn:${host}:3478?transport=udp,turn:${host}:3478?transport=tcp"
    _set_env_kv TURN_SECRET "$secret"
    grep -q '^TURN_TTL=' "$envf" 2>/dev/null || echo 'TURN_TTL=3600' >> "$envf"
    chmod 600 "$envf"
    setup_turn "$domain" "$secret" "$ext_ip"
}

setup_backend_first() {
    local domain="$1"
    local notify_email="${2:-}"
    local notify_email2="${3:-}"

    section "Backend setup — API server"

    mkdir -p "$BACKEND_DIR"
    mkdir -p /opt/office-tools/data/uploads
    chown -R www-data:www-data /opt/office-tools/data
    rsync -a "$REPO_DIR/backend/" "$BACKEND_DIR/"

    cat > "$BACKEND_DIR/.env" << ENVEOF
# Office Tools backend config
PORT=3001
CORS_ORIGINS=https://${domain}
NOTIFY_EMAIL=${notify_email}
NOTIFY_EMAIL_2=${notify_email2}
# Per-IP/min cap for the public port-check probe endpoints (default 600, clamp 10–2000).
# Raise for many miners behind one shared NAT/VPN (e.g. 1000); restart the service after.
PROBE_RATE_PER_MIN=600
ENVEOF
    chmod 600 "$BACKEND_DIR/.env"

    # TURN relay for File Drop — idempotent; the same helper runs on every
    # sync_backend so existing deployments get it on update, not just here.
    _provision_turn "$domain"

    cd "$BACKEND_DIR" && npm install --omit=dev && cd /
    success "Backend files ready at $BACKEND_DIR"

    # Systemd service
    section "Creating systemd service"
    cat > /etc/systemd/system/office-tools-api.service << PAYEOF
[Unit]
Description=Office Tools — API Server
After=network.target
[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=${BACKEND_DIR}
ExecStart=/usr/bin/node office-tools-server.js
Environment=TZ=UTC
EnvironmentFile=${BACKEND_DIR}/.env
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
[Install]
WantedBy=multi-user.target
PAYEOF

    systemctl daemon-reload
    systemctl enable office-tools-api
    systemctl start office-tools-api || \
        warn "API server failed to start — check: journalctl -u office-tools-api"

    success "Backend service enabled and started"
}

sync_backend() {
    section "Syncing backend files"
    rsync -a --exclude='.env' "$REPO_DIR/backend/" "$BACKEND_DIR/"
    cd "$BACKEND_DIR" && npm install --omit=dev && cd /
    # Ensure SQLite data directory exists and is owned by the service user
    mkdir -p /opt/office-tools/data/uploads
    chown -R www-data:www-data /opt/office-tools/data
    # Ensure the File Drop TURN relay is provisioned (idempotent). Runs here so
    # existing deployments pick up TURN on a normal update, before the restart
    # below so the API loads the freshly-seeded TURN_SECRET/TURN_URLS.
    _provision_turn "${DOMAIN:-}"
    systemctl restart office-tools-api 2>/dev/null || true
    success "Backend synced and service restarted"
}


