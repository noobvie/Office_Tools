# =============================================================================
# Office Tools — Menu option 6 — admin tasks
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Option 6: Admin Tasks ────────────────────────────────────────────────────
opt_6_admin_tasks() {
    while true; do
        show_banner
        load_conf
        section "Option 6 — Admin Tasks"

        echo -e "    ${BOLD}a)${RESET}  Service Status       ${DIM}detailed status for all services${RESET}"
        echo -e "    ${BOLD}b)${RESET}  Restart All Services ${DIM}nginx · api · pot-provider · yt-server${RESET}"
        echo -e "    ${BOLD}c)${RESET}  URLs & Ports         ${DIM}list all tool URLs, APIs, and listening ports${RESET}"
        echo -e "    ${BOLD}d)${RESET}  Backup Database      ${DIM}back up SQLite DB → /opt/office-tools/backups/${RESET}"
        echo -e "    ${BOLD}e)${RESET}  Restore Database     ${DIM}restore from a previous backup${RESET}"
        echo -e "    ${BOLD}f)${RESET}  Clean Old Logs       ${DIM}delete deploy logs older than 30 days${RESET}"
        echo -e "    ${BOLD}g)${RESET}  Purge Temp Files     ${DIM}file-share uploads${RESET}"
        echo -e "    ${BOLD}h)${RESET}  Update yt-server     ${DIM}sync from repo, update yt-dlp + PO-token provider, restart${RESET}"
        echo -e "    ${BOLD}i)${RESET}  Feedback emails      ${DIM}set / update notification email addresses${RESET}"
        echo -e "    ${BOLD}j)${RESET}  YouTube cookies      ${DIM}install / test / remove cookies.txt for yt-server${RESET}"
        echo -e "  ${DIM}  ──────────────────────────────────────────────${RESET}"
        echo -e "    ${BOLD}0)${RESET}  Back"
        echo ""
        echo -ne "  Choose [a-j / 0]: "; read -r _sub
        echo ""

        case "${_sub,,}" in
            a)  _admin_service_status   ;;
            b)  _admin_restart_all      ;;
            c)  _admin_list_urls        ;;
            d)  _admin_backup_db        ;;
            e)  _admin_restore_db       ;;
            f)  _admin_clean_logs       ;;
            g)  _admin_purge_temp       ;;
            h)  _admin_update_yt_server  ;;
            i)  _admin_feedback_email   ;;
            j)  _admin_configure_cookies ;;
            0)  return 0                ;;
            *)  warn "Invalid: $_sub"   ;;
        esac
    done
}

_admin_service_status() {
    section "Service Status"
    local svcs=("nginx" "office-tools-api" "office-tools-cobalt" "office-tools-pot")
    for svc in "${svcs[@]}"; do
        if ! systemctl list-unit-files "${svc}.service" &>/dev/null 2>&1 \
           || ! systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "^${svc}"; then
            echo -e "  ${DIM}○ %-22s not installed${RESET}" "$svc"
            continue
        fi
        if systemctl is-active --quiet "$svc" 2>/dev/null; then
            local uptime mem pid
            pid=$(systemctl show -p MainPID --value "$svc" 2>/dev/null || echo "")
            uptime=$(systemctl show -p ActiveEnterTimestamp --value "$svc" 2>/dev/null \
                     | sed 's/ [A-Z]*$//' || echo "")
            mem=""
            if [[ -n "$pid" ]] && [[ "$pid" != "0" ]]; then
                mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f MB", $1/1024}')
            fi
            printf "  ${GREEN}●${RESET} %-22s ${GREEN}running${RESET}" "$svc"
            [[ -n "$uptime" ]] && printf "  since %s" "$uptime"
            [[ -n "$mem"    ]] && printf "  |  mem: %s" "$mem"
            echo ""
        else
            local reason
            reason=$(systemctl show -p ActiveState --value "$svc" 2>/dev/null || echo "stopped")
            printf "  ${YELLOW}●${RESET} %-22s ${YELLOW}%s${RESET}\n" "$svc" "$reason"
            local last_err
            last_err=$(journalctl -u "$svc" -n 3 --no-pager --output=cat 2>/dev/null | tail -1)
            [[ -n "$last_err" ]] && echo -e "    ${DIM}Last log: ${last_err}${RESET}"
        fi
    done
    echo ""

    # Port listener table
    echo -e "  ${BOLD}Listening ports:${RESET}"
    echo -e "  ────────────────────────────────────────"
    for port_svc in "80:nginx (HTTP)" "443:nginx (HTTPS)" "3001:api-server" "9000:yt-server (YouTube downloads)" "${POT_PORT}:PO-token provider (bgutil)"; do
        local port="${port_svc%%:*}" label="${port_svc#*:}"
        if ss -tlnp 2>/dev/null | grep -q ":${port}\b"; then
            echo -e "  ${GREEN}●${RESET} :${port}  ${label}"
        else
            echo -e "  ${DIM}○ :${port}  ${label} (not listening)${RESET}"
        fi
    done
    echo ""
    press_enter
}

_admin_restart_all() {
    section "Restarting All Services"
    local svcs=("nginx" "office-tools-api" "office-tools-pot" "office-tools-cobalt")
    local any=false
    for svc in "${svcs[@]}"; do
        if systemctl list-unit-files "${svc}.service" 2>/dev/null | grep -q "^${svc}"; then
            any=true
            echo -ne "  Restarting ${svc}… "
            if systemctl restart "$svc" 2>/dev/null; then
                echo -e "${GREEN}OK${RESET}"
            else
                echo -e "${YELLOW}FAILED${RESET}"
                warn "Check: journalctl -u $svc -n 20"
            fi
        fi
    done
    $any || warn "No managed services found — run Option 1 to install first."
    echo ""
    press_enter
}

_admin_list_urls() {
    load_conf
    section "URLs, APIs & Ports"

    if [[ -z "$DOMAIN" ]]; then
        warn "No domain configured yet — run Option 2 first."
        echo -e "  ${DIM}Services are running locally:${RESET}"
    fi

    local base="https://${DOMAIN:-<your-domain>}"

    echo -e "  ${BOLD}Frontend (nginx → $WEB_ROOT)${RESET}"
    echo -e "  ${CYAN}·${RESET} Main site      : ${base}/"
    echo -e "  ${CYAN}·${RESET} All tools      : ${base}/tools/"
    echo ""

    echo -e "  ${BOLD}Reverse-proxy routes (nginx)${RESET}"
    echo -e "  ${CYAN}·${RESET} API             : ${base}/tools-api/          → 127.0.0.1:3001"
    [[ -d "$YT_SERVER_DIR" ]] && \
    echo -e "  ${CYAN}·${RESET} YT Download API : ${base}/yt-api/             → 127.0.0.1:9000"
    echo ""

    echo -e "  ${BOLD}Internal services${RESET}"
    echo -e "  ${DIM}·${RESET} nginx           : :80 (HTTP) / :443 (HTTPS)"
    echo -e "  ${DIM}·${RESET} api server      : 127.0.0.1:3001"
    [[ -d "$YT_SERVER_DIR" ]] && \
    echo -e "  ${DIM}·${RESET} yt-server       : 127.0.0.1:9000"
    [[ -d "$POT_SERVER_DIR" ]] && \
    echo -e "  ${DIM}·${RESET} PO-token provider: 127.0.0.1:${POT_PORT}  ${DIM}(bgutil — YouTube bot-check bypass)${RESET}"
    echo ""

    echo -e "  ${BOLD}Pages${RESET}"
    echo -e "  ${DIM}·${RESET} ${base}/"
    echo -e "  ${DIM}·${RESET} ${base}/pages/donate.html"
    echo ""

    echo -e "  ${BOLD}Backend-dependent tools${RESET}"
    for t in "url-shortener" "pastebin" "file-share"; do
        echo -e "  ${DIM}·${RESET} ${base}/tools/${t}/"
    done
    echo ""

    echo -e "  ${BOLD}Sample tools (browser-local, no backend)${RESET}"
    for t in "currency" "password-generator" "qr-generator" "hash-generator" \
             "ip-location" "my-ip" "loan-calculator" "unit-converter" \
             "ai-token-counter" "yt-downloader"; do
        echo -e "  ${DIM}·${RESET} ${base}/tools/${t}/"
    done
    echo ""

    echo -e "  ${BOLD}API health checks${RESET}"
    echo -e "  ${DIM}·${RESET} api server      : ${base}/tools-api/health"
    [[ -d "$YT_SERVER_DIR" ]] && \
    echo -e "  ${DIM}·${RESET} yt-server       : ${base}/yt-api/health"
    echo ""

    press_enter
}

_admin_backup_db() {
    local backup_dir="/opt/office-tools/backups"
    local db_file="/opt/office-tools/data/tools.db"
    mkdir -p "$backup_dir"
    section "Backup Database"

    if [[ ! -f "$db_file" ]]; then
        warn "SQLite database not found at $db_file — backend not installed or not yet started."
        press_enter; return 0
    fi

    local ts; ts=$(date +%Y%m%d_%H%M%S)
    local backup_file="${backup_dir}/tools_backup_${ts}.db"

    info "Copying SQLite database (tools.db)…"
    cp "$db_file" "$backup_file" \
        && success "Backup saved: $backup_file" \
        || warn "Backup failed — check disk space and permissions"

    # Show last 5 backups
    echo ""
    echo -e "  ${BOLD}Recent backups:${RESET}"
    ls -lh "${backup_dir}"/tools_backup_*.db 2>/dev/null \
        | tail -5 \
        | awk '{printf "  · %s  (%s)\n", $NF, $5}' \
        || echo -e "  ${DIM}(none)${RESET}"
    echo ""
    press_enter
}

_admin_restore_db() {
    local backup_dir="/opt/office-tools/backups"
    local db_file="/opt/office-tools/data/tools.db"
    section "Restore Database"

    # List backups
    local backups=()
    while IFS= read -r f; do
        [[ -f "$f" ]] && backups+=("$f")
    done < <(ls -t "${backup_dir}"/tools_backup_*.db 2>/dev/null)

    if [[ "${#backups[@]}" -eq 0 ]]; then
        warn "No backups found in ${backup_dir}."
        press_enter; return 0
    fi

    echo -e "  ${BOLD}Available backups:${RESET}"
    local i=1
    for f in "${backups[@]}"; do
        local sz; sz=$(du -sh "$f" 2>/dev/null | cut -f1)
        printf "    ${CYAN}%d)${RESET}  %-50s %s\n" "$i" "$(basename "$f")" "$sz"
        ((i++))
    done
    echo ""
    echo -ne "  Select backup number (0 to cancel): "
    read -r _sel
    [[ "$_sel" == "0" ]] || [[ -z "$_sel" ]] && return 0

    if ! [[ "$_sel" =~ ^[0-9]+$ ]] || (( _sel < 1 || _sel > ${#backups[@]} )); then
        warn "Invalid selection."; press_enter; return 0
    fi

    local chosen="${backups[$(( _sel - 1 ))]}"
    echo ""
    echo -e "  ${YELLOW}${BOLD}WARNING: This will overwrite the current database with:${RESET}"
    echo -e "  ${YELLOW}$(basename "$chosen")${RESET}"
    echo ""
    ask_proceed "Proceed" || return 0

    info "Stopping API server…"
    systemctl stop office-tools-api 2>/dev/null || true
    sleep 1

    info "Restoring backup…"
    cp "$chosen" "$db_file" \
        && success "Restore complete" \
        || warn "Restore failed — check the backup file integrity"

    chown root:root "$db_file" 2>/dev/null || true

    info "Restarting API server…"
    systemctl start office-tools-api 2>/dev/null \
        && success "API server running" \
        || warn "API server failed to restart — check: journalctl -u office-tools-api -n 20"
    press_enter
}

_admin_clean_logs() {
    section "Clean Old Logs"
    mkdir -p "$LOG_DIR"

    local count
    count=$(find "$LOG_DIR" -type f -name "*.log" -mtime +30 2>/dev/null | wc -l)
    echo -e "  Log directory : ${LOG_DIR}"
    echo -e "  Total size    : $(du -sh "$LOG_DIR" 2>/dev/null | cut -f1)"
    echo -e "  Logs > 30 days: ${count} file(s)"
    echo ""

    if [[ "$count" -eq 0 ]]; then
        info "No logs older than 30 days — nothing to clean."
        press_enter; return 0
    fi

    ask_proceed "Delete ${count} log file(s) older than 30 days" || return 0
    find "$LOG_DIR" -type f -name "*.log" -mtime +30 -delete
    success "Deleted ${count} old log file(s)."

    # Also rotate nginx logs if present
    if [[ -d /var/log/nginx ]]; then
        local nginx_old
        nginx_old=$(find /var/log/nginx -type f -name "*.log.*" -mtime +30 2>/dev/null | wc -l)
        if [[ "$nginx_old" -gt 0 ]]; then
            find /var/log/nginx -type f -name "*.log.*" -mtime +30 -delete
            success "Deleted ${nginx_old} old nginx rotated log(s)."
        fi
    fi

    press_enter
}

_admin_purge_temp() {
    section "Purge Temp Files"
    local purged=false

    # ── File-share uploads ─────────────────────────────────────────────────
    local uploads_dir="/opt/office-tools/data/uploads"
    if [[ -d "$uploads_dir" ]]; then
        local fs_count fs_size
        fs_count=$(find "$uploads_dir" -type f 2>/dev/null | wc -l)
        fs_size=$(du -sh "$uploads_dir" 2>/dev/null | cut -f1 || echo "0")

        echo -e "  ${BOLD}File-share uploaded files${RESET}  (${uploads_dir})"
        echo -e "  Files : ${fs_count}   Size : ${fs_size}"
        echo -e "  ${DIM}Note: these are files shared via the File Share tool.${RESET}"
        echo -e "  ${YELLOW}Warning: deleting removes files from active shares.${RESET}"

        if [[ "$fs_count" -gt 0 ]]; then
            echo -ne "  Delete ALL uploaded files? [y/N]: "; read -r _r; _r="${_r:-N}"
            if [[ "${_r,,}" == "y" ]]; then
                find "$uploads_dir" -type f -delete 2>/dev/null
                success "Deleted ${fs_count} uploaded file(s)."
                purged=true
            fi
        fi
    else
        echo -e "  ${DIM}File-share uploads dir not found — backend not installed.${RESET}"
    fi
    echo ""

    $purged || info "Nothing was deleted."
    press_enter
}

_admin_feedback_email() {
    section "Feedback Notification Emails"
    if [[ ! -f "$BACKEND_DIR/.env" ]]; then
        warn "Backend not installed — run Option 2 first."
        press_enter; return 0
    fi

    local cur1 cur2
    cur1=$(grep '^NOTIFY_EMAIL=' "$BACKEND_DIR/.env" 2>/dev/null \
        | cut -d= -f2- | tr -d '"' | tr -d "'")
    cur2=$(grep '^NOTIFY_EMAIL_2=' "$BACKEND_DIR/.env" 2>/dev/null \
        | cut -d= -f2- | tr -d '"' | tr -d "'")

    echo -e "  ${DIM}Current primary  : ${cur1:-(not set)}${RESET}"
    echo -e "  ${DIM}Current secondary: ${cur2:-(not set)}${RESET}"
    echo ""
    echo -e "  ${DIM}Leave blank to keep current value. Enter '-' to clear.${RESET}"
    echo ""

    echo -ne "  Primary email: "; read -r _e1
    echo -ne "  Secondary email (optional): "; read -r _e2

    [[ "$_e1" == "-" ]] && _e1=""
    [[ "$_e2" == "-" ]] && _e2=""
    [[ -z "$_e1" ]] && _e1="$cur1"
    [[ -z "$_e2" ]] && _e2="$cur2"

    _update_notify_env "$_e1" "$_e2"
    systemctl restart office-tools-api 2>/dev/null \
        && success "Feedback emails updated and API server restarted." \
        || warn "Could not restart API server — check: journalctl -u office-tools-api -n 10"
    press_enter
}

_admin_update_yt_server() {
    section "Update yt-server"
    if [[ ! -d "$YT_SERVER_DIR" ]]; then
        warn "yt-server not installed — run Option 1 first."
        press_enter; return 0
    fi

    ask_proceed "Sync yt-server from repo, update yt-dlp + PO-token provider, and restart services" || return 0

    install_ytdlp
    setup_pot_provider
    sync_yt_server

    systemctl is-active --quiet office-tools-cobalt \
        && success "yt-server updated and running" \
        || warn "yt-server restart failed — check: journalctl -u office-tools-cobalt -n 20"
    press_enter
}


