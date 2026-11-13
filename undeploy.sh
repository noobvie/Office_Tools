#!/bin/bash
# =============================================================================
# Office Tools — Undeploy Script
# Removes everything that deploy.sh installed from this VPS.
#
# Usage:  sudo bash undeploy.sh
# =============================================================================

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
skip()    { echo -e "${DIM}[SKIP]${RESET}  $*"; }

# ─── Must run as root ─────────────────────────────────────────────────────────
[[ "$EUID" -ne 0 ]] && echo -e "${RED}[FATAL]${RESET} Run as root: sudo bash undeploy.sh" && exit 1

# ─── Known paths (must match deploy.sh exactly) ───────────────────────────────
DEPLOY_CONF="/opt/office-tools/deploy.conf"
OPT_DIR="/opt/office-tools"          # repo, backend, pocketbase, deploy.conf
WEB_ROOT="/var/www/office-tools"     # nginx-served frontend
LOG_DIR="/var/log/office-tools"      # deploy logs

SVC_API="/etc/systemd/system/office-tools-api.service"
SVC_COBALT="/etc/systemd/system/office-tools-cobalt.service"
SVC_POT="/etc/systemd/system/office-tools-pot.service"
# Hardening drop-in directories (lib/systemd.sh svc_write_hardening)
SVC_DROPIN_DIRS=("/etc/systemd/system/office-tools-api.service.d"
                 "/etc/systemd/system/office-tools-cobalt.service.d"
                 "/etc/systemd/system/office-tools-pot.service.d")
CRON_YTDLP="/etc/cron.daily/yt-dlp-update"                  # lib/youtube.sh install_ytdlp
# Where the same updater lives on a server last deployed before it moved to cron.daily.
CRON_YTDLP_WEEKLY="/etc/cron.weekly/yt-dlp-update"
CRON_YTCOOKIE="/etc/cron.d/office-tools-ytcookie"            # lib/youtube.sh setup_cookie_keepalive
LOGROTATE_YTCOOKIE="/etc/logrotate.d/office-tools-ytcookie"  # same

# nginx: Debian layout (sites-available + sites-enabled symlink) and RHEL layout
# (conf.d), main site and the ip4./ip6. echo vhost (lib/os.sh detect_os, lib/nginx.sh).
NGINX_AVAIL="/etc/nginx/sites-available/office-tools"
NGINX_ENABLED="/etc/nginx/sites-enabled/office-tools"
NGINX_RHEL="/etc/nginx/conf.d/office-tools.conf"
NGINX_IPECHO_AVAIL="/etc/nginx/sites-available/office-tools-ipecho"
NGINX_IPECHO_ENABLED="/etc/nginx/sites-enabled/office-tools-ipecho"
NGINX_IPECHO_RHEL="/etc/nginx/conf.d/office-tools-ipecho.conf"
NGINX_SNIPPET_DIR="/etc/nginx/office-tools"   # OT_NGINX_SNIPPET_DIR in lib/nginx.sh
# http-level zones, map and log_format the vhosts refer to (OT_NGINX_HTTP_CONF in lib/nginx.sh)
NGINX_HTTP_CONF="/etc/nginx/conf.d/00-office-tools-http.conf"

# coturn config paths written by lib/backend.sh setup_turn (Debian, then RHEL/EPEL)
TURN_CONFS=("/etc/turnserver.conf" "/etc/coturn/turnserver.conf")
TURN_MARKER="# Office Tools — File Drop TURN relay (managed by deploy.sh)"

# Same rule as valid_domain in lib/config.sh (this script runs standalone, without lib/).
valid_domain() {
    local d="${1:-}"
    if [[ -z "$d" || ${#d} -gt 253 || "$d" == *..* || "$d" != *.* ]]; then
        return 1
    fi
    if [[ ! "$d" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
        return 1
    fi
    return 0
}

# True when coturn is running on a config this repo wrote: only then is stopping it ours
# to do. The marker is the first line of the turnserver.conf heredoc in lib/backend.sh.
turn_is_ours() {
    local f first
    for f in "${TURN_CONFS[@]}"; do
        [[ -f "$f" ]] || continue
        first=$(head -n1 "$f" 2>/dev/null) || true
        if [[ "$first" == "$TURN_MARKER" ]]; then
            return 0
        fi
    done
    return 1
}

echo ""
echo -e "${BOLD}${RED}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${RED}║     Office Tools — Undeploy Script               ║${RESET}"
echo -e "${BOLD}${RED}║     This will PERMANENTLY remove Office Tools.   ║${RESET}"
echo -e "${BOLD}${RED}╚══════════════════════════════════════════════════╝${RESET}"
echo ""

# ─── Prompt 1: Domain name ────────────────────────────────────────────────────
# Pre-fill from saved config if it exists
DOMAIN=""
if [[ -f "$DEPLOY_CONF" ]]; then
    # shellcheck source=/dev/null
    SAVED_DOMAIN=$(grep -E '^DOMAIN=' "$DEPLOY_CONF" 2>/dev/null | cut -d'"' -f2 || true)
    if [[ -n "$SAVED_DOMAIN" ]]; then
        echo -e "${DIM}Detected domain from previous deploy: ${SAVED_DOMAIN}${RESET}"
    fi
fi

# The domain names a /etc/letsencrypt path that is deleted below, so only a strictly
# valid hostname is accepted (an empty value or ".." would point at a parent directory).
while true; do
    echo -ne "${BOLD}Domain name${RESET} used during deployment (e.g. tools.example.com): "
    read -r DOMAIN
    DOMAIN="${DOMAIN,,}"
    if valid_domain "$DOMAIN"; then break; fi
    warn "Not a valid hostname: '${DOMAIN}' (e.g. tools.example.com)"
done

LETSENCRYPT_DIR="/etc/letsencrypt/live/${DOMAIN:?}"
LETSENCRYPT_RENEWAL="/etc/letsencrypt/renewal/${DOMAIN:?}.conf"
# ip4./ip6. echo hosts use the last two labels of the domain (_ipecho_apex in lib/nginx.sh)
IPECHO_APEX="$(echo "$DOMAIN" | awk -F. '{ if (NF>=2) print $(NF-1)"."$NF; else print $0 }')"
IPECHO_CERTS=("ip4.${IPECHO_APEX}" "ip6.${IPECHO_APEX}")

NGINX_FILES=("$NGINX_AVAIL" "$NGINX_ENABLED" "$NGINX_RHEL"
             "$NGINX_IPECHO_AVAIL" "$NGINX_IPECHO_ENABLED" "$NGINX_IPECHO_RHEL")
EXTRA_FILES=("$CRON_YTDLP_WEEKLY" "$CRON_YTCOOKIE" "$LOGROTATE_YTCOOKIE")

# ─── Build removal checklist ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${YELLOW}  Everything below will be PERMANENTLY deleted:${RESET}"
echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Systemd services
echo -e "${BOLD}  Systemd services${RESET}"
for svc in office-tools-api office-tools-cobalt office-tools-pot; do
    if systemctl list-unit-files "${svc}.service" &>/dev/null 2>&1 && \
       systemctl list-unit-files "${svc}.service" | grep -q "${svc}"; then
        STATUS=$(systemctl is-active "${svc}" 2>/dev/null || echo "inactive")
        echo -e "    ${RED}✗${RESET}  ${svc}  ${DIM}(${STATUS})${RESET}"
    else
        echo -e "    ${DIM}–  ${svc}  (not found — will skip)${RESET}"
    fi
done

# Systemd unit files
echo ""
echo -e "${BOLD}  Systemd unit files${RESET}"
for f in "$SVC_API" "$SVC_COBALT" "$SVC_POT" "$CRON_YTDLP" "${EXTRA_FILES[@]}"; do
    [[ -f "$f" ]] && echo -e "    ${RED}✗${RESET}  $f" || echo -e "    ${DIM}–  $f  (not found)${RESET}"
done
for d in "${SVC_DROPIN_DIRS[@]}"; do
    [[ -d "$d" ]] && echo -e "    ${RED}✗${RESET}  $d/" || echo -e "    ${DIM}–  $d/  (not found)${RESET}"
done

# Nginx
echo ""
echo -e "${BOLD}  Nginx config${RESET}"
for f in "${NGINX_FILES[@]}" "$NGINX_SNIPPET_DIR" "$NGINX_HTTP_CONF"; do
    [[ -e "$f" ]] && echo -e "    ${RED}✗${RESET}  $f" || echo -e "    ${DIM}–  $f  (not found)${RESET}"
done

# TURN relay
echo ""
echo -e "${BOLD}  TURN relay (coturn)${RESET}"
if turn_is_ours; then
    echo -e "    ${RED}✗${RESET}  coturn service stopped + disabled  ${DIM}(its config was written by deploy.sh; package kept)${RESET}"
else
    echo -e "    ${DIM}–  coturn not configured by deploy.sh — left alone${RESET}"
fi

# SSL certificate
echo ""
echo -e "${BOLD}  SSL certificate (Let's Encrypt)${RESET}"
if [[ -d "$LETSENCRYPT_DIR" ]]; then
    echo -e "    ${RED}✗${RESET}  $LETSENCRYPT_DIR"
    echo -e "    ${RED}✗${RESET}  $LETSENCRYPT_RENEWAL  ${DIM}(renewal config)${RESET}"
else
    echo -e "    ${DIM}–  No certificate found for ${DOMAIN} — will skip${RESET}"
fi
for c in "${IPECHO_CERTS[@]}"; do
    if [[ -d "/etc/letsencrypt/live/${c}" ]]; then
        echo -e "    ${RED}✗${RESET}  /etc/letsencrypt/live/${c}  ${DIM}(ip-echo host)${RESET}"
    fi
done

# Directories
echo ""
echo -e "${BOLD}  Directories${RESET}"
for d in "$OPT_DIR" "$WEB_ROOT" "$LOG_DIR"; do
    if [[ -d "$d" ]]; then
        SIZE=$(du -sh "$d" 2>/dev/null | cut -f1 || echo "?")
        echo -e "    ${RED}✗${RESET}  $d  ${DIM}(${SIZE})${RESET}"
    else
        echo -e "    ${DIM}–  $d  (not found — will skip)${RESET}"
    fi
done

echo ""
echo -e "${BOLD}  What is ${GREEN}NOT${RESET}${BOLD} removed by this script:${RESET}"
echo -e "    ${GREEN}•${RESET}  nginx, certbot, Node.js, coturn packages ${DIM}(installed system-wide)${RESET}"
echo -e "    ${GREEN}•${RESET}  Firewall rules (80/443, 3478, 49152-65535) ${DIM}(remove by hand if unused)${RESET}"
echo -e "    ${GREEN}•${RESET}  Other nginx virtual hosts / sites        ${DIM}(unrelated to Office Tools)${RESET}"
echo -e "    ${GREEN}•${RESET}  /var/log/nginx/office-tools.access.log*  ${DIM}(nginx's own log directory; delete by hand)${RESET}"
echo ""

# ─── Prompt 2: Confirm ────────────────────────────────────────────────────────
echo -e "${BOLD}${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -ne "${BOLD}Type  yes  to confirm permanent removal: ${RESET}"
read -r CONFIRM

if [[ "$CONFIRM" != "yes" ]]; then
    echo ""
    echo -e "${GREEN}Aborted. Nothing was changed.${RESET}"
    exit 0
fi

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${CYAN}  Removing Office Tools…${RESET}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# ─── 1. Stop & disable systemd services ──────────────────────────────────────
for svc in office-tools-api office-tools-cobalt office-tools-pot; do
    if systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "${svc}"; then
        info "Stopping and disabling ${svc}…"
        systemctl stop    "${svc}" 2>/dev/null || true
        systemctl disable "${svc}" 2>/dev/null || true
        success "${svc} stopped and disabled"
    else
        skip "${svc} not found"
    fi
done

# coturn: only when it runs on the config deploy.sh wrote — its secret was shared with the
# API server being removed, so nothing else can be using it.
if turn_is_ours; then
    info "Stopping and disabling coturn (configured by deploy.sh)…"
    systemctl stop    coturn 2>/dev/null || true
    systemctl disable coturn 2>/dev/null || true
    success "coturn stopped and disabled (package and its config file kept)"
else
    skip "coturn not configured by deploy.sh"
fi

# ─── 2. Remove systemd unit files, cron and logrotate entries ─────────────────
for f in "$SVC_API" "$SVC_COBALT" "$SVC_POT" "$CRON_YTDLP" "${EXTRA_FILES[@]}"; do
    if [[ -f "$f" ]]; then
        rm -f "$f"
        success "Removed $f"
    else
        skip "$f not found"
    fi
done
for d in "${SVC_DROPIN_DIRS[@]}"; do
    if [[ -d "$d" ]]; then
        rm -rf "${d:?}"
        success "Removed $d"
    else
        skip "$d not found"
    fi
done

systemctl daemon-reload
success "systemd daemon reloaded"

# ─── 3. Remove nginx config ───────────────────────────────────────────────────
# Vhosts first, then the snippet directory they include and the http-level file whose
# zones and log_format they name, so no remaining conf can reference a missing one.
for f in "${NGINX_FILES[@]}"; do
    if [[ -e "$f" || -L "$f" ]]; then
        rm -f "$f"
        success "Removed $f"
    else
        skip "$f not found"
    fi
done
if [[ -d "$NGINX_SNIPPET_DIR" ]]; then
    rm -rf "${NGINX_SNIPPET_DIR:?}"
    success "Removed $NGINX_SNIPPET_DIR"
else
    skip "$NGINX_SNIPPET_DIR not found"
fi
if [[ -f "$NGINX_HTTP_CONF" ]]; then
    rm -f "$NGINX_HTTP_CONF"
    success "Removed $NGINX_HTTP_CONF"
else
    skip "$NGINX_HTTP_CONF not found"
fi

# Test nginx config before reloading (other sites may still be running)
if nginx -t 2>/dev/null; then
    systemctl reload nginx
    success "nginx reloaded (other sites unaffected)"
else
    warn "nginx config test failed after removal — nginx NOT reloaded."
    warn "Check /etc/nginx/ manually and run: nginx -t && systemctl reload nginx"
fi

# ─── 4. Delete SSL certificate ───────────────────────────────────────────────
if [[ -d "$LETSENCRYPT_DIR" ]]; then
    info "Deleting Let's Encrypt certificate for ${DOMAIN}…"
    if ! certbot delete --cert-name "${DOMAIN}" --non-interactive 2>/dev/null; then
        warn "certbot delete failed — removing manually…"
        # DOMAIN passed valid_domain at the prompt; :? refuses to run on an empty value.
        rm -rf "/etc/letsencrypt/live/${DOMAIN:?}"
        rm -f  "/etc/letsencrypt/renewal/${DOMAIN:?}.conf"
    fi
    success "SSL certificate removed"
else
    skip "No Let's Encrypt certificate found for ${DOMAIN}"
fi
# ip4./ip6. echo-host certificates (best-effort; certbot only, no manual deletion)
for c in "${IPECHO_CERTS[@]}"; do
    if [[ -d "/etc/letsencrypt/live/${c}" ]]; then
        if certbot delete --cert-name "$c" --non-interactive 2>/dev/null; then
            success "SSL certificate removed for $c"
        else
            warn "certbot delete failed for $c — remove it with: certbot delete --cert-name $c"
        fi
    fi
done

# ─── 5. Remove directories ───────────────────────────────────────────────────
for d in "$OPT_DIR" "$WEB_ROOT" "$LOG_DIR"; do
    if [[ -d "$d" ]]; then
        rm -rf "${d:?}"
        success "Removed $d"
    else
        skip "$d not found"
    fi
done

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${GREEN}  Office Tools fully removed from this server.${RESET}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
echo -e "  ${DIM}Removed:${RESET}  services · nginx config · SSL cert · all directories"
echo -e "  ${DIM}Kept:${RESET}     nginx · certbot · Node.js · other vhosts"
echo ""
echo -e "  To redeploy at any time:  ${BOLD}sudo bash deploy.sh${RESET}"
echo ""
