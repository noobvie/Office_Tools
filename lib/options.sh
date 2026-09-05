# =============================================================================
# Office Tools — Menu options 1 / 2 / 3 and DEL
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Option 1: Install / Update ───────────────────────────────────────────────
opt_1_install_update() {
    show_banner
    section "Option 1 — Install / Update"

    echo -e "  This will:"
    echo -e "    ${CYAN}·${RESET} Set system timezone  ${DIM}→ UTC (required for consistent timestamps)${RESET}"
    echo -e "    ${CYAN}·${RESET} Update OS packages   ${DIM}(${OS_FAMILY})${RESET}"
    echo -e "    ${CYAN}·${RESET} Install / update:    nginx · certbot · Node.js · git · curl"
    echo -e "    ${CYAN}·${RESET} Install / update:    ffmpeg · yt-dlp · PO-token provider · yt-server ${DIM}(YouTube downloader backend)${RESET}"
    echo -e "    ${CYAN}·${RESET} Pull latest code     ${DIM}(Office Tools GitHub)${RESET}"
    echo -e "    ${CYAN}·${RESET} Sync frontend files  ${DIM}→ $WEB_ROOT${RESET}"
    echo -e "    ${CYAN}·${RESET} Restart services     ${DIM}(if already configured)${RESET}"
    echo ""
    ask_proceed "Proceed" || return 0

    mkdir -p "$LOG_DIR"
    local logf="$LOG_DIR/install_$(date +%Y%m%d_%H%M%S).log"
    info "Logging to: $logf"

    (
        set -euo pipefail
        exec > >(tee "$logf") 2>&1
        enforce_utc_timezone
        pkg_update_os
        install_base_packages
        install_nodejs
        install_ffmpeg
        install_ytdlp
        setup_pot_provider
        pull_repo
        load_conf
        sync_frontend "${DOMAIN:-}"
        # Always call setup_yt_server — handles both fresh install and updates,
        # and always (re-)writes the systemd service file.
        setup_yt_server
        if [[ -n "$DOMAIN" ]]; then
            [[ -d "$BACKEND_DIR" ]] && sync_backend || true
            systemctl reload nginx 2>/dev/null || true
        fi
    ) || warn "Some steps had errors — check $logf"

    load_conf
    if [[ -n "$DOMAIN" ]]; then
        success "Update complete — https://${DOMAIN}"
    else
        success "Packages installed. Run Option 2 to configure a domain."
    fi

    press_enter
}

# ─── Option 2: Add / Configure Domain ─────────────────────────────────────────
opt_2_add_domain() {
    show_banner
    section "Option 2 — Add / Configure Domain"

    load_conf

    # Prerequisites check
    if ! command -v nginx &>/dev/null; then
        warn "nginx not installed. Run Option 1 first."
        press_enter; return 0
    fi
    if ! command -v certbot &>/dev/null; then
        warn "certbot not installed. Run Option 1 first."
        press_enter; return 0
    fi
    if [[ ! -d "$REPO_DIR/.git" ]]; then
        warn "Repository not cloned. Run Option 1 first."
        press_enter; return 0
    fi

    # Domain prompt
    echo ""
    [[ -n "$DOMAIN" ]] && echo -e "  ${DIM}Current domain: ${DOMAIN}${RESET}"
    echo -e "  ${DIM}(enter 0 at any prompt to cancel and return to menu)${RESET}"
    while true; do
        local _prompt="  ${BOLD}Domain name${RESET}"
        [[ -n "$DOMAIN" ]] && _prompt+=" (Enter = keep ${DIM}[$DOMAIN]${RESET})"
        _prompt+=": "
        echo -ne "$_prompt"
        read -r _new
        [[ "$_new" == "0" ]] && return 0
        if [[ -n "$_new" ]]; then DOMAIN="$_new"; break
        elif [[ -n "$DOMAIN" ]]; then break
        else warn "Domain cannot be empty."; fi
    done

    # Email prompt
    while true; do
        local _eprompt="  ${BOLD}Email for SSL${RESET}"
        [[ -n "$EMAIL" ]] && _eprompt+=" (Enter = keep ${DIM}[$EMAIL]${RESET})"
        _eprompt+=": "
        echo -ne "$_eprompt"
        read -r _new
        [[ "$_new" == "0" ]] && return 0
        if [[ -n "$_new" ]]; then EMAIL="$_new"; break
        elif [[ -n "$EMAIL" ]]; then break
        else warn "Email cannot be empty."; fi
    done

    # Backend — only prompt on first install
    local _do_backend=false
    if [[ ! -d "$BACKEND_DIR" ]] || [[ ! -f "$BACKEND_DIR/.env" ]]; then
        echo ""
        echo -e "  ${DIM}Backend service (API server) is optional.${RESET}"
        echo -ne "  Set up backend? [Y/n]: "
        read -r _b; _b="${_b:-Y}"
        [[ "${_b,,}" == "y" ]] && _do_backend=true && SETUP_BACKEND="y"
    else
        info "Backend already installed — will sync files only"
    fi

    # Notify emails for feedback submissions
    local _notify_email="" _notify_email2=""
    _notify_email=$(grep '^NOTIFY_EMAIL=' "$BACKEND_DIR/.env" 2>/dev/null \
        | cut -d= -f2- | tr -d '"' | tr -d "'")
    _notify_email2=$(grep '^NOTIFY_EMAIL_2=' "$BACKEND_DIR/.env" 2>/dev/null \
        | cut -d= -f2- | tr -d '"' | tr -d "'")
    echo ""
    echo -e "  ${BOLD}Feedback notification emails${RESET} ${DIM}(where to send user reports — leave blank to skip)${RESET}"
    local _p1="  Primary email"
    [[ -n "$_notify_email" ]] && _p1+=" ${DIM}[${_notify_email}]${RESET}"
    echo -ne "${_p1}: "
    read -r _new_ne; [[ "$_new_ne" == "0" ]] && return 0
    [[ -n "$_new_ne" ]] && _notify_email="$_new_ne"
    local _p2="  Secondary email ${DIM}(optional)"
    [[ -n "$_notify_email2" ]] && _p2+=" [${_notify_email2}]"
    _p2+="${RESET}"
    echo -ne "${_p2}: "
    read -r _new_ne2; [[ "$_new_ne2" == "0" ]] && return 0
    [[ -n "$_new_ne2" ]] && _notify_email2="$_new_ne2"

    echo ""
    echo -e "  Domain        : ${BOLD}${DOMAIN}${RESET}"
    echo -e "  SSL email     : ${EMAIL}"
    if [[ -n "$_notify_email" ]]; then
        echo -e "  Notify        : ${DIM}(configured)${RESET}"
    else
        echo -e "  Notify        : ${DIM}(disabled)${RESET}"
    fi
    echo -e "  Web root      : $WEB_ROOT"
    echo ""
    ask_proceed "Proceed" || return 0

    mkdir -p "$LOG_DIR"
    local logf="$LOG_DIR/domain_$(date +%Y%m%d_%H%M%S).log"
    info "Logging to: $logf"

    (
        set -euo pipefail
        exec > >(tee "$logf") 2>&1

        sync_frontend "$DOMAIN"
        write_nginx_http "$DOMAIN"
        get_ssl "$DOMAIN" "$EMAIL"
        write_nginx_https "$DOMAIN"

        if [[ "$_do_backend" == true ]]; then
            setup_backend_first "$DOMAIN" "$_notify_email" "$_notify_email2"
        elif [[ -d "$BACKEND_DIR" ]]; then
            sync_backend
            _update_notify_env "$_notify_email" "$_notify_email2"
            systemctl restart office-tools-api 2>/dev/null || true
        fi

        # Optional ip4./ip6. subdomains (best-effort; never fails the deploy)
        setup_ip_echo "$DOMAIN" "$EMAIL" || true
    ) || { warn "Errors during setup — check $logf"; press_enter; return 0; }

    save_conf
    print_summary "$DOMAIN"
    press_enter
}

# ─── Option 3: Remove / Switch Domain ─────────────────────────────────────────
opt_3_remove_switch() {
    show_banner
    section "Option 3 — Remove / Switch Domain"

    load_conf

    if [[ -z "$DOMAIN" ]]; then
        warn "No domain configured. Nothing to remove or switch."
        press_enter; return 0
    fi

    echo -e "  Configured domain: ${BOLD}${DOMAIN}${RESET}"
    echo ""
    echo -e "    ${YELLOW}a)${RESET}  Remove domain         ${DIM}nginx config + SSL cert only — files kept${RESET}"
    echo -e "    ${YELLOW}b)${RESET}  Switch to new domain  ${DIM}remove old config, set up new domain + SSL${RESET}"
    echo -e "    ${YELLOW}0)${RESET}  Back"
    echo ""
    echo -ne "  Choose [a/b/0]: "; read -r _sub

    case "${_sub,,}" in
      a)
        echo ""
        echo -ne "  ${BOLD}${YELLOW}Type 'yes' to confirm removing config for ${DOMAIN}: ${RESET}"
        read -r _c
        [[ "$_c" != "yes" ]] && info "Aborted."; [[ "$_c" != "yes" ]] && press_enter && return 0

        # Remove nginx config
        if [[ -e "$NGINX_CONF_PATH" ]]; then
            rm -f "$NGINX_CONF_PATH"
            success "Removed: $NGINX_CONF_PATH"
        fi
        if [[ -n "$NGINX_ENABLED_PATH" && -L "$NGINX_ENABLED_PATH" ]]; then
            rm -f "$NGINX_ENABLED_PATH"
            success "Removed symlink: $NGINX_ENABLED_PATH"
        fi

        # Remove the optional ip4./ip6. echo subdomains too
        remove_ip_echo "$DOMAIN" || true

        if nginx -t 2>/dev/null; then
            systemctl reload nginx
            success "nginx reloaded"
        else
            warn "nginx config test failed — check /etc/nginx/ manually"
        fi

        # Remove SSL cert
        if [[ -d "/etc/letsencrypt/live/${DOMAIN}" ]]; then
            certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || {
                rm -rf "/etc/letsencrypt/live/${DOMAIN}"
                rm -f  "/etc/letsencrypt/renewal/${DOMAIN}.conf"
            }
            success "SSL certificate removed for $DOMAIN"
        fi

        local _old="$DOMAIN"
        DOMAIN=""
        save_conf
        success "Domain '$_old' removed. Use Option 2 to configure a new domain."
        ;;

      b)
        echo ""
        while true; do
            echo -ne "  ${BOLD}New domain name${RESET}: "
            read -r _new
            [[ -n "$_new" ]] && break
            warn "Domain cannot be empty."
        done
        echo -ne "  ${BOLD}Email for SSL${RESET} (Enter = keep [$EMAIL]): "
        read -r _em; [[ -n "$_em" ]] && EMAIL="$_em"

        echo ""
        echo -e "  Will remove: ${BOLD}${DOMAIN}${RESET}"
        echo -e "  Will set up: ${BOLD}${_new}${RESET}"
        echo ""
        ask_proceed "Proceed" || return 0

        mkdir -p "$LOG_DIR"
        local logf="$LOG_DIR/switch_$(date +%Y%m%d_%H%M%S).log"

        (
            set -euo pipefail
            exec > >(tee "$logf") 2>&1

            section "Removing old domain: $DOMAIN"
            rm -f "$NGINX_CONF_PATH" 2>/dev/null || true
            [[ -n "$NGINX_ENABLED_PATH" ]] && rm -f "$NGINX_ENABLED_PATH" 2>/dev/null || true
            certbot delete --cert-name "$DOMAIN" --non-interactive 2>/dev/null || true
            remove_ip_echo "$DOMAIN" || true
            nginx -t 2>/dev/null && systemctl reload nginx || true
            success "Old domain removed"

            DOMAIN="$_new"

            section "Setting up new domain: $DOMAIN"
            sync_frontend "$DOMAIN"
            write_nginx_http "$DOMAIN"
            get_ssl "$DOMAIN" "$EMAIL"
            write_nginx_https "$DOMAIN"
            [[ -d "$BACKEND_DIR" ]] && sync_backend || true
            setup_ip_echo "$DOMAIN" "$EMAIL" || true
        ) || { warn "Errors during switch — check $logf"; press_enter; return 0; }

        DOMAIN="$_new"
        save_conf
        print_summary "$DOMAIN"
        ;;

      *) info "Back to main menu." ;;
    esac

    press_enter
}


# ─── DEL: Delete ──────────────────────────────────────────────────────────────
opt_del_delete() {
    show_banner
    section "Delete — Remove Office Tools"

    echo -e "  ${RED}${BOLD}This will PERMANENTLY remove Office Tools from this server.${RESET}"
    echo ""

    # Locate undeploy.sh
    local _undeploy=""
    for _p in \
        "$SCRIPT_DIR/undeploy.sh" \
        "$REPO_DIR/undeploy.sh" \
        "/opt/office-tools/repo/undeploy.sh"; do
        [[ -f "$_p" ]] && _undeploy="$_p" && break
    done

    if [[ -z "$_undeploy" ]]; then
        die "undeploy.sh not found. Copy it next to deploy.sh and retry."
    fi

    info "Will run: $_undeploy"
    echo ""
    bash "$_undeploy"
}


