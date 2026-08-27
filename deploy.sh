#!/bin/bash
# =============================================================================
# Office Tools — Deploy Manager
# Interactive menu for installation, domain management, and removal.
#
# Supports:  Debian · Ubuntu · AlmaLinux · Rocky Linux · CentOS Stream
# Usage:     sudo bash deploy.sh
# =============================================================================


# ─── Paths ────────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/noobvie/Office_Tools.git"
REPO_DIR="/opt/office-tools/repo"
WEB_ROOT="/var/www/office-tools"
BACKEND_DIR="/opt/office-tools/backend"
YT_SERVER_DIR="/opt/office-tools/yt-server"
POT_SERVER_DIR="/opt/office-tools/pot-server"   # bgutil PO-token provider (YouTube bot-check bypass)
POT_PORT=4416
DEPLOY_CONF="/opt/office-tools/deploy.conf"
LOG_DIR="/var/log/office-tools"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# nginx config paths — set by detect_os()
NGINX_CONF_PATH=""
NGINX_ENABLED_PATH=""   # empty = not used (RHEL writes directly to conf.d)


# ─── Load libraries ───────────────────────────────────────────────────────────
# Every function lives in lib/. All modules are sourced up-front, before any of
# them runs, so definition order never matters (bash resolves globals at call
# time). Add a new module by appending its basename to this list.
for _lib in ui config os repo nginx backend youtube cookies options admin; do
    _libf="$SCRIPT_DIR/lib/${_lib}.sh"
    [[ -r "$_libf" ]] || { echo "[FATAL] missing library: $_libf" >&2; exit 1; }
    # shellcheck source=/dev/null
    source "$_libf"
done
unset _lib _libf

# ─── Summary printer ──────────────────────────────────────────────────────────
print_summary() {
    local domain="$1"
    echo ""
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${GREEN}  ✔  https://${domain}  is live${RESET}"
    echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "  ${BOLD}Site:${RESET}           https://${domain}/"
    echo -e "  ${BOLD}YT Downloader:${RESET}  https://${domain}/tools/yt-downloader/"
    echo -e "  ${BOLD}YT API:${RESET}         https://${domain}/yt-api/   ${DIM}(yt-server, port 9000)${RESET}"
    echo -e "  ${BOLD}Web root:${RESET}       ${WEB_ROOT}"
    echo -e "  ${BOLD}nginx config:${RESET}   ${NGINX_CONF_PATH}"
    echo -e "  ${BOLD}Repo:${RESET}           ${REPO_DIR}"
    echo -e "  ${BOLD}Logs:${RESET}           ${LOG_DIR}/"
    echo ""
}

# ─── Banner & status ──────────────────────────────────────────────────────────
show_banner() {
    clear
    echo ""
    echo -e "${BOLD}${CYAN}╔═══════════════════════════════════════════════════════╗${RESET}"
    echo -e "${BOLD}${CYAN}║       Office Tools — Deploy Manager  v2026.08.28      ║${RESET}"
    echo -e "${BOLD}${CYAN}║       github.com/noobvie/Office_Tools                 ║${RESET}"
    echo -e "${BOLD}${CYAN}╚═══════════════════════════════════════════════════════╝${RESET}"
    echo ""
    echo -e "  ${DIM}OS: ${OS_NAME}${RESET}"
}

show_status() {
    load_conf
    echo -e "  ${BOLD}Current status${RESET}"
    echo -e "  ──────────────────────────────────────────────────"

    if [[ -n "$DOMAIN" ]]; then
        echo -e "  ${GREEN}●${RESET} Domain       : ${BOLD}${DOMAIN}${RESET}"
    else
        echo -e "  ${DIM}○ Domain       : not configured${RESET}"
    fi

    if [[ -d "$REPO_DIR/.git" ]]; then
        local commit; commit=$(git -C "$REPO_DIR" log -1 --format='%h %s' 2>/dev/null || echo "unknown")
        echo -e "  ${GREEN}●${RESET} Repo         : ${DIM}${commit}${RESET}"
    else
        echo -e "  ${DIM}○ Repo         : not cloned${RESET}"
    fi

    # Core services (yt-server excluded — managed separately via Option 6)
    local svcs=("nginx" "office-tools-api")
    for svc in "${svcs[@]}"; do
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            echo -e "  ${GREEN}●${RESET} ${svc}  ${DIM}running${RESET}"
        elif systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "${svc}"; then
            echo -e "  ${YELLOW}●${RESET} ${svc}  ${DIM}stopped${RESET}"
        fi
    done

    echo ""
}


# ─── Main loop ────────────────────────────────────────────────────────────────
[[ "$EUID" -ne 0 ]] && die "Run as root: sudo bash deploy.sh"
detect_os

while true; do
    show_banner
    show_status

    echo -e "  ${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "    ${BOLD}1)${RESET}   Install / Update    ${DIM}packages · OS · pull latest code${RESET}"
    echo -e "    ${BOLD}2)${RESET}   Add Domain          ${DIM}configure domain · SSL · backend${RESET}"
    echo -e "    ${BOLD}3)${RESET}   Remove / Switch     ${DIM}remove or change active domain${RESET}"
    echo -e "    ${BOLD}5)${RESET}   Update from Repo    ${DIM}pull specific branch · restart services${RESET}"
    echo -e "    ${BOLD}6)${RESET}   Admin Tasks         ${DIM}status · restart · URLs · backup · cleanup${RESET}"
    echo -e "  ${DIM}  ──────────────────────────────────────────────${RESET}"
    echo -e "  ${RED}  DEL)${RESET} Delete              ${DIM}permanently remove Office Tools${RESET}"
    echo -e "    ${BOLD}0)${RESET}   Exit"
    echo -e "  ${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -ne "  Choose [0-3 / 5-6 / del]: "; read -r _choice
    echo ""

    case "${_choice,,}" in
        1)   opt_1_install_update ;;
        2)   opt_2_add_domain     ;;
        3)   opt_3_remove_switch  ;;
        5)   opt_5_update_repo    ;;
        6)   opt_6_admin_tasks    ;;
        del) opt_del_delete; break ;;
        0)   echo -e "${DIM}Goodbye.${RESET}"; exit 0 ;;
        *)   warn "Invalid choice: $_choice" ;;
    esac
done
