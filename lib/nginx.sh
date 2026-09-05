# =============================================================================
# Office Tools — nginx vhost writers, SSL, ip-echo subdomains
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── nginx config writers ──────────────────────────────────────────────────────
_nginx_enable() {
    if [[ "$OS_FAMILY" == "debian" ]]; then
        ln -sf "$NGINX_CONF_PATH" "$NGINX_ENABLED_PATH"
        rm -f /etc/nginx/sites-enabled/default
    fi
    nginx -t 2>&1 || die "nginx config test failed — check $NGINX_CONF_PATH"
    systemctl reload nginx
}

write_nginx_http() {
    local domain="$1"
    cat > "$NGINX_CONF_PATH" << NGINXEOF
# Office Tools — managed by deploy.sh (HTTP — certbot will add SSL)
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    root  ${WEB_ROOT};
    index index.html;

    # SEO: strip explicit /index.html so canonical URL is always the directory
    location ~ ^(.*/)index\.html$ { return 301 \$1; }
    # SEO: strip trailing slash from .html file URLs (e.g. /pages/donate.html/)
    location ~ ^(.*\.html)/$ { return 301 \$1; }
    # SEO: enforce trailing slash on tool and page directory URLs (no file extension)
    location ~ ^(/tools/[^/.]+|/pages/[^/.]+)$ { return 301 \$uri/; }
    # Serve flat-file pages (pages/<x>.html) at their canonical directory URL /pages/<x>/
    # (donate/privacy live as pages/<x>.html but their canonical + sitemap use /pages/<x>/)
    location ~ ^/pages/([^/]+)/$ { try_files /pages/\$1.html /pages/\$1/index.html =404; }

    # Permanently removed pages — 410 Gone de-indexes faster/cleaner than a 404.
    # Add formerly-public URLs here when a tool/page is retired.
    location = /tools/wordle/ { return 410; }
    location ^~ /auth/        { return 410; }
    location ^~ /api/         { return 410; }   # old donate/wallet backend — live API is under /tools-api/
    location ~ ^/(playlist|shorts)(/|\$) { return 410; }   # retired YouTube routes

    location / { try_files \$uri/index.html \$uri \$uri.html =404; }

    # File Drop signaling — WebSocket upgrade (exact match wins over ^~ /tools-api/)
    location = /tools-api/drop-ws {
        proxy_pass            http://127.0.0.1:3001/drop-ws;
        proxy_http_version    1.1;
        proxy_set_header      Upgrade           \$http_upgrade;
        proxy_set_header      Connection        "upgrade";
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_read_timeout    1h;
        proxy_send_timeout    1h;
    }
    # Chat Room signaling — WebSocket upgrade (exact match wins over ^~ /tools-api/)
    location = /tools-api/chat-ws {
        proxy_pass            http://127.0.0.1:3001/chat-ws;
        proxy_http_version    1.1;
        proxy_set_header      Upgrade           \$http_upgrade;
        proxy_set_header      Connection        "upgrade";
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_read_timeout    1h;
        proxy_send_timeout    1h;
    }
    # Chat Room file uploads/downloads — up to 2 GB, long timeout for slow links
    # (longer prefix wins over ^~ /tools-api/; streamed, unbuffered)
    location ^~ /tools-api/api/chat/ {
        proxy_pass            http://127.0.0.1:3001/api/chat/;
        proxy_http_version    1.1;
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto \$scheme;
        client_max_body_size    2200M;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
        proxy_request_buffering off;
        proxy_buffering         off;
    }
    location ^~ /tools-api/ {
        proxy_pass            http://127.0.0.1:3001/;
        proxy_http_version    1.1;
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto \$scheme;
        proxy_read_timeout    600s;
        proxy_send_timeout    600s;
        proxy_request_buffering off;
        proxy_buffering         off;
    }
    location ^~ /yt-api/ {
        proxy_pass              http://127.0.0.1:9000/;
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        proxy_read_timeout      600s;
        proxy_send_timeout      600s;
        proxy_request_buffering off;
        proxy_buffering         off;
    }
    location ~ /\.                           { deny all; return 404; }
    location /backend/                       { deny all; return 404; }
    location ~ \.(env|sh|json|md|toml|log)$ { deny all; return 404; }
}
NGINXEOF
    _nginx_enable
    success "nginx HTTP config written for ${domain}"
}

write_nginx_https() {
    local domain="$1"
    local ssl_cert="/etc/letsencrypt/live/${domain}/fullchain.pem"
    local ssl_key="/etc/letsencrypt/live/${domain}/privkey.pem"

    cat > "$NGINX_CONF_PATH" << NGINXEOF
# Office Tools — managed by deploy.sh

server {
    listen 80;
    listen [::]:80;
    server_name ${domain};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${domain};

    ssl_certificate     ${ssl_cert};
    ssl_certificate_key ${ssl_key};
    ssl_protocols             TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options           "SAMEORIGIN"             always;
    add_header X-Content-Type-Options    "nosniff"                always;
    add_header X-XSS-Protection          "1; mode=block"          always;
    add_header Referrer-Policy           "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy        "camera=(), microphone=(self), geolocation=()" always;

    gzip on; gzip_vary on;
    gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;
    gzip_min_length 1024;

    client_max_body_size 1100M;

    root  ${WEB_ROOT};
    index index.html;

    # SEO: strip explicit /index.html so canonical URL is always the directory
    location ~ ^(.*/)index\.html$ { return 301 \$1; }
    # SEO: strip trailing slash from .html file URLs (e.g. /pages/donate.html/)
    location ~ ^(.*\.html)/$ { return 301 \$1; }
    # SEO: enforce trailing slash on tool and page directory URLs (no file extension)
    location ~ ^(/tools/[^/.]+|/pages/[^/.]+)$ { return 301 \$uri/; }
    # Serve flat-file pages (pages/<x>.html) at their canonical directory URL /pages/<x>/
    # (donate/privacy live as pages/<x>.html but their canonical + sitemap use /pages/<x>/)
    location ~ ^/pages/([^/]+)/$ { try_files /pages/\$1.html /pages/\$1/index.html =404; }

    # Permanently removed pages — 410 Gone de-indexes faster/cleaner than a 404.
    # Add formerly-public URLs here when a tool/page is retired.
    location = /tools/wordle/ { return 410; }
    location ^~ /auth/        { return 410; }
    location ^~ /api/         { return 410; }   # old donate/wallet backend — live API is under /tools-api/
    location ~ ^/(playlist|shorts)(/|\$) { return 410; }   # retired YouTube routes

    location / { try_files \$uri/index.html \$uri \$uri.html =404; }

    location ~* \.(css|js|png|jpg|jpeg|gif|ico|svg|woff2|woff)$ {
        expires 7d;
        add_header Cache-Control "public, immutable";
    }

    # File Drop signaling — WebSocket upgrade (exact match wins over ^~ /tools-api/)
    location = /tools-api/drop-ws {
        proxy_pass            http://127.0.0.1:3001/drop-ws;
        proxy_http_version    1.1;
        proxy_set_header      Upgrade           \$http_upgrade;
        proxy_set_header      Connection        "upgrade";
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_read_timeout    1h;
        proxy_send_timeout    1h;
    }
    # Chat Room signaling — WebSocket upgrade (exact match wins over ^~ /tools-api/)
    location = /tools-api/chat-ws {
        proxy_pass            http://127.0.0.1:3001/chat-ws;
        proxy_http_version    1.1;
        proxy_set_header      Upgrade           \$http_upgrade;
        proxy_set_header      Connection        "upgrade";
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_read_timeout    1h;
        proxy_send_timeout    1h;
    }
    # Chat Room file uploads/downloads — up to 2 GB, long timeout for slow links
    # (longer prefix wins over ^~ /tools-api/; streamed, unbuffered)
    location ^~ /tools-api/api/chat/ {
        proxy_pass            http://127.0.0.1:3001/api/chat/;
        proxy_http_version    1.1;
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto \$scheme;
        client_max_body_size    2200M;
        proxy_read_timeout      3600s;
        proxy_send_timeout      3600s;
        proxy_request_buffering off;
        proxy_buffering         off;
    }
    location ^~ /tools-api/ {
        proxy_pass            http://127.0.0.1:3001/;
        proxy_http_version    1.1;
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto \$scheme;
        proxy_read_timeout    600s;
        proxy_send_timeout    600s;
        proxy_request_buffering off;
        proxy_buffering         off;
    }
    location ^~ /yt-api/ {
        proxy_pass              http://127.0.0.1:9000/;
        proxy_http_version      1.1;
        proxy_set_header        Host              \$host;
        proxy_set_header        X-Real-IP         \$remote_addr;
        proxy_set_header        X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header        X-Forwarded-Proto \$scheme;
        proxy_read_timeout      600s;
        proxy_send_timeout      600s;
        proxy_request_buffering off;
        proxy_buffering         off;
    }

    location ~ /\.                           { deny all; return 404; }
    location /backend/                       { deny all; return 404; }
    location ~ \.(env|sh|json|md|toml|log)$ { deny all; return 404; }
}
NGINXEOF
    _nginx_enable
    success "nginx HTTPS config hardened for ${domain}"
}

get_ssl() {
    local domain="$1" email="$2"
    section "Getting Let's Encrypt SSL for ${domain}"
    echo -e "  ${DIM}[i] Cloudflare users: if certificate generation fails, try setting your${RESET}"
    echo -e "  ${DIM}    DNS record to ${BOLD}DNS only${RESET}${DIM} (grey cloud) and re-run. You can re-enable${RESET}"
    echo -e "  ${DIM}    proxying after the certificate is issued.${RESET}"
    echo ""
    certbot --nginx -d "$domain" \
        --non-interactive --agree-tos \
        -m "$email" --redirect
    success "SSL certificate issued"
}

# ─── IP-echo subdomains (ip4. / ip6.) — Option-2 "both v4+v6" feature ───────────
# Two family-pinned hostnames let a browser learn BOTH its IPv4 and IPv6 by fetching
# each one: ip4.<apex> must be A-only DNS, ip6.<apex> AAAA-only. A single hostname
# can never return both (one connection = one family), so this is the only real way.
# Kept in an ISOLATED conf file with BEST-EFFORT certbot: any failure here warns and
# returns 0 — it can never break the main site or fail the deploy.

# Derive the apex (last two labels) so tools.grin.money → grin.money → ip4.grin.money.
# Good for single-label TLDs (.com/.money/.io); set the hosts by hand for .co.uk etc.
_ipecho_apex() { echo "$1" | awk -F. '{ if (NF>=2) print $(NF-1)"."$NF; else print $0 }'; }

_ipecho_conf_path() {
    if [[ "$OS_FAMILY" == "debian" ]]; then
        echo "/etc/nginx/sites-available/office-tools-ipecho"
    else
        echo "/etc/nginx/conf.d/office-tools-ipecho.conf"
    fi
}

setup_ip_echo() {
    local domain="$1" email="$2"
    local apex h4 h6 conf
    apex="$(_ipecho_apex "$domain")"
    h4="ip4.${apex}"; h6="ip6.${apex}"
    conf="$(_ipecho_conf_path)"

    section "IP-echo subdomains — ${h4} / ${h6} (best-effort)"

    # Two SEPARATE server blocks + two SEPARATE certs on purpose: if the server has no
    # public IPv6, ip6's cert can't validate — decoupling keeps ip4 working regardless.
    # HTTP-only first so certbot can validate + inject SSL (avoids the cert chicken-and-egg).
    cat > "$conf" << IPEOF
# Office Tools — IP-echo subdomains (managed by deploy.sh)
# ip4.<apex> = A-only DNS, ip6.<apex> = AAAA-only → each forces one family so a
# browser can read BOTH addresses. Every path returns the caller's IP via backend /ip
# (query strings like ?format=json pass through). Open CORS comes from the backend.
server {
    listen 80;
    listen [::]:80;
    server_name ${h4};
    location / {
        proxy_pass            http://127.0.0.1:3001/ip;
        proxy_http_version    1.1;
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto \$scheme;
    }
}
server {
    listen 80;
    listen [::]:80;
    server_name ${h6};
    location / {
        proxy_pass            http://127.0.0.1:3001/ip;
        proxy_http_version    1.1;
        proxy_set_header      Host              \$host;
        proxy_set_header      X-Real-IP         \$remote_addr;
        proxy_set_header      X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header      X-Forwarded-Proto \$scheme;
    }
}
IPEOF

    [[ "$OS_FAMILY" == "debian" ]] && ln -sf "$conf" "/etc/nginx/sites-enabled/office-tools-ipecho"

    if ! nginx -t 2>/dev/null; then
        warn "IP-echo nginx test failed — removing its conf, main site untouched. (check $conf)"
        rm -f "$conf"
        [[ "$OS_FAMILY" == "debian" ]] && rm -f "/etc/nginx/sites-enabled/office-tools-ipecho"
        return 0
    fi
    systemctl reload nginx

    # Independent certs — ip4 needs its A record live; ip6 needs a working public IPv6 (AAAA).
    if certbot --nginx -d "$h4" --non-interactive --agree-tos -m "$email" --redirect; then
        success "IPv4 host live: https://${h4}"
    else
        warn "certbot could not issue ${h4} — DNS for ip4. not propagated yet. Re-run Option 2 later."
    fi
    if certbot --nginx -d "$h6" --non-interactive --agree-tos -m "$email" --redirect; then
        success "IPv6 host live: https://${h6}"
    else
        warn "certbot could not issue ${h6} — no public IPv6 on this server, or ip6. AAAA not propagated."
        warn "ip4 still works; the 'Both at once' card will show ipv6:null until ip6. has a cert."
    fi
}

remove_ip_echo() {
    local conf; conf="$(_ipecho_conf_path)"
    [[ -e "$conf" ]] || return 0
    local apex h4 h6
    apex="$(_ipecho_apex "${1:-$DOMAIN}")"; h4="ip4.${apex}"; h6="ip6.${apex}"
    rm -f "$conf"
    [[ "$OS_FAMILY" == "debian" ]] && rm -f "/etc/nginx/sites-enabled/office-tools-ipecho"
    certbot delete --cert-name "$h4" --non-interactive 2>/dev/null || true
    nginx -t 2>/dev/null && systemctl reload nginx || true
    success "IP-echo subdomains removed (${h4} / ${h6})"
}


