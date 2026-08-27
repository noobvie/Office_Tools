# =============================================================================
# Office Tools — UI helpers — colors, logging, prompts
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Colors & helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
die()     { echo -e "${RED}${BOLD}[FATAL]${RESET} $*" >&2; exit 1; }

section() {
    echo ""
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${BOLD}${CYAN}  $*${RESET}"
    echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
}

press_enter() {
    echo ""
    echo -ne "${DIM}  Press Enter to return to menu…${RESET}"
    read -r
}

# Returns 0 (true=proceed) or 1 (abort — n or 0 pressed)
ask_proceed() {
    local prompt="${1:-Proceed}"
    echo -ne "  ${BOLD}${prompt}? [Y/n/0]: ${RESET}"; read -r _ap
    [[ "${_ap,,}" == "n" || "$_ap" == "0" ]] && return 1
    return 0
}


