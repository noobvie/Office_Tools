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

SVC_PB="/etc/systemd/system/office-tools-pb.service"
SVC_PAY="/etc/systemd/system/office-tools-pay.service"

NGINX_AVAIL="/etc/nginx/sites-available/office-tools"
NGINX_ENABLED="/etc/nginx/sites-enabled/office-tools"

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

while true; do
    echo -ne "${BOLD}Domain name${RESET} used during deployment (e.g. tools.example.com): "
    read -r DOMAIN
    [[ -n "$DOMAIN" ]] && break
    warn "Domain cannot be empty."
done

LETSENCRYPT_DIR="/etc/letsencrypt/live/${DOMAIN}"
LETSENCRYPT_RENEWAL="/etc/letsencrypt/renewal/${DOMAIN}.conf"

# ─── Build removal checklist ──────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}${YELLOW}  Everything below will be PERMANENTLY deleted:${RESET}"
echo -e "${BOLD}${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Systemd services
echo -e "${BOLD}  Systemd services${RESET}"
for svc in office-tools-pb office-tools-pay; do
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
for f in "$SVC_PB" "$SVC_PAY"; do
    [[ -f "$f" ]] && echo -e "    ${RED}✗${RESET}  $f" || echo -e "    ${DIM}–  $f  (not found)${RESET}"
done

# Nginx
echo ""
echo -e "${BOLD}  Nginx config${RESET}"
for f in "$NGINX_AVAIL" "$NGINX_ENABLED"; do
    [[ -e "$f" ]] && echo -e "    ${RED}✗${RESET}  $f" || echo -e "    ${DIM}–  $f  (not found)${RESET}"
done

# SSL certificate
echo ""
echo -e "${BOLD}  SSL certificate (Let's Encrypt)${RESET}"
if [[ -d "$LETSENCRYPT_DIR" ]]; then
    echo -e "    ${RED}✗${RESET}  $LETSENCRYPT_DIR"
    echo -e "    ${RED}✗${RESET}  $LETSENCRYPT_RENEWAL  ${DIM}(renewal config)${RESET}"
else
    echo -e "    ${DIM}–  No certificate found for ${DOMAIN} — will skip${RESET}"
fi

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
echo -e "    ${GREEN}•${RESET}  nginx, certbot, Node.js system packages  ${DIM}(installed system-wide)${RESET}"
echo -e "    ${GREEN}•${RESET}  Other nginx virtual hosts / sites        ${DIM}(unrelated to Office Tools)${RESET}"
echo -e "    ${GREEN}•${RESET}  Grin node / wallet                       ${DIM}(managed separately)${RESET}"
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
for svc in office-tools-pay office-tools-pb; do
    if systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "${svc}"; then
        info "Stopping and disabling ${svc}…"
        systemctl stop    "${svc}" 2>/dev/null || true
        systemctl disable "${svc}" 2>/dev/null || true
        success "${svc} stopped and disabled"
    else
        skip "${svc} not found"
    fi
done

# ─── 2. Remove systemd unit files ────────────────────────────────────────────
for f in "$SVC_PB" "$SVC_PAY"; do
    if [[ -f "$f" ]]; then
        rm -f "$f"
        success "Removed $f"
    else
        skip "$f not found"
    fi
done

systemctl daemon-reload
success "systemd daemon reloaded"

# ─── 3. Remove nginx config ───────────────────────────────────────────────────
for f in "$NGINX_ENABLED" "$NGINX_AVAIL"; do
    if [[ -e "$f" ]]; then
        rm -f "$f"
        success "Removed $f"
    else
        skip "$f not found"
    fi
done

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
    certbot delete --cert-name "${DOMAIN}" --non-interactive 2>/dev/null || {
        warn "certbot delete failed — removing manually…"
        rm -rf "$LETSENCRYPT_DIR"
        rm -f  "$LETSENCRYPT_RENEWAL"
    }
    success "SSL certificate removed"
else
    skip "No Let's Encrypt certificate found for ${DOMAIN}"
fi

# ─── 5. Remove directories ───────────────────────────────────────────────────
for d in "$OPT_DIR" "$WEB_ROOT" "$LOG_DIR"; do
    if [[ -d "$d" ]]; then
        rm -rf "$d"
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
