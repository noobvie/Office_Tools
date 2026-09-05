# =============================================================================
# Office Tools — Repo pull, frontend sync, update-from-repo
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Repo & frontend ──────────────────────────────────────────────────────────
pull_repo() {
    section "Pulling Office Tools from GitHub"
    if [[ -d "$REPO_DIR/.git" ]]; then
        info "Repo found — fetching latest…"
        git -C "$REPO_DIR" fetch origin
        local branch
        branch=$(git -C "$REPO_DIR" branch --show-current 2>/dev/null || echo "master")
        git -C "$REPO_DIR" reset --hard "origin/$branch"
    else
        info "Cloning $REPO_URL…"
        mkdir -p "$(dirname "$REPO_DIR")"
        git clone "$REPO_URL" "$REPO_DIR"
    fi
    success "Repo: $(git -C "$REPO_DIR" log -1 --format='%h %s')"
}

sync_frontend() {
    local domain="${1:-}"
    section "Syncing frontend → $WEB_ROOT"
    mkdir -p "$WEB_ROOT"
    rsync -a --delete \
        --exclude='.git' \
        --exclude='.gitignore' \
        --exclude='backend' \
        --exclude='deploy.sh' \
        --exclude='undeploy.sh' \
        --exclude='lib' \
        --exclude='*.sh' \
        --exclude='*.md' \
        "$REPO_DIR/" "$WEB_ROOT/"
    chown -R www-data:www-data "$WEB_ROOT"
    chmod -R 755 "$WEB_ROOT"
    find "$WEB_ROOT" -type f -exec chmod 644 {} \;

    if [[ "$OS_FAMILY" == "rhel" ]]; then
        chcon -R -t httpd_sys_content_t "$WEB_ROOT" 2>/dev/null || true
    fi

    [[ -n "$domain" ]] && _patch_domain "$REPO_DIR" "$domain"
    [[ -n "$domain" ]] && _patch_domain "$WEB_ROOT"  "$domain"

    success "Frontend deployed to $WEB_ROOT"
}

_patch_domain() {
    local dir="$1" domain="$2"
    local cfg="$dir/js/config.js"
    if [[ -f "$cfg" ]]; then
        local apex; apex="$(_ipecho_apex "$domain")"
        sed -i "s|https://api\.yourdomain\.com|https://${domain}/tools-api|g" "$cfg"
        sed -i "s|https://ip4\.yourdomain\.com|https://ip4.${apex}|g"         "$cfg"
        sed -i "s|https://ip6\.yourdomain\.com|https://ip6.${apex}|g"         "$cfg"
        sed -i "s|https://yourdomain\.com|https://${domain}|g"              "$cfg"
    fi
    find "$dir" -name "*.html" -not -path "*/.git/*" \
        -exec sed -i "s|https://yourdomain\.com|https://${domain}|g" {} \;
    # Patch domain in sitemap.xml so Google sees the real URLs
    local sitemap="$dir/sitemap.xml"
    [[ -f "$sitemap" ]] && \
        sed -i "s|https://yourdomain\.com|https://${domain}|g" "$sitemap"
}


# ─── Option 5: Update from Repo ───────────────────────────────────────────────
opt_5_update_repo() {
    show_banner
    section "Option 5 — Update from Repository"

    # Determine which git repo to use as the reference for branch listing.
    # Priority: SCRIPT_DIR (where deploy.sh lives) if it's a git repo; else REPO_DIR.
    local src_dir="$REPO_DIR"
    if [[ -d "$SCRIPT_DIR/.git" ]] && [[ "$SCRIPT_DIR" != "$REPO_DIR" ]]; then
        src_dir="$SCRIPT_DIR"
    elif [[ ! -d "$REPO_DIR/.git" ]]; then
        warn "Repository not cloned yet. Run Option 1 to install first."
        press_enter; return 0
    fi

    local current_branch
    current_branch=$(git -C "$src_dir" branch --show-current 2>/dev/null || echo "unknown")

    echo -e "  Script dir:     ${DIM}${SCRIPT_DIR}${RESET}"
    echo -e "  Server repo:    ${DIM}${REPO_DIR}${RESET}"
    echo -e "  Remote:         ${DIM}${REPO_URL}${RESET}"
    echo -e "  Current branch: ${BOLD}${current_branch}${RESET}"
    echo -e "  Last commit:    ${DIM}$(git -C "$src_dir" log -1 --format='%h %s' 2>/dev/null)${RESET}"
    echo ""

    info "Fetching remote branch list…"
    git -C "$src_dir" fetch --quiet origin 2>/dev/null \
        || warn "Could not reach remote — using cached branch list"

    local branches=()
    while IFS= read -r b; do
        [[ -z "$b" ]] && continue
        branches+=("$b")
    done < <(git -C "$src_dir" branch -r 2>/dev/null \
        | grep -v '\->' | sed 's|[[:space:]]*origin/||')

    if [[ "${#branches[@]}" -gt 0 ]]; then
        echo -e "  ${BOLD}Available branches:${RESET}"
        local i=1
        for b in "${branches[@]}"; do
            local marker=""
            [[ "$b" == "$current_branch" ]] && marker=" ${DIM}← current${RESET}"
            printf "    %s%d)%s  %s%s\n" "${CYAN}" "$i" "${RESET}" "$b" "$marker"
            ((i++))
        done
        echo ""
    fi

    echo -ne "  Branch number or name (Enter = keep ${DIM}[${current_branch}]${RESET}, 0 to cancel): "
    read -r _input
    [[ "$_input" == "0" ]] && return 0

    local target_branch="$current_branch"
    if [[ -n "$_input" ]]; then
        if [[ "$_input" =~ ^[0-9]+$ ]] && (( _input >= 1 && _input <= ${#branches[@]} )); then
            target_branch="${branches[$(( _input - 1 ))]}"
        else
            target_branch="$_input"
        fi
    fi

    echo ""
    echo -e "  Target:  ${BOLD}${target_branch}${RESET}"
    ask_proceed "Proceed" || return 0

    mkdir -p "$LOG_DIR"
    local logf="$LOG_DIR/update_$(date +%Y%m%d_%H%M%S).log"
    info "Logging to: $logf"

    # ── Self-update FIRST, OUTSIDE the subshell so we can exit the whole program ──
    # bash runs the in-memory copy of deploy.sh AND of every lib/*.sh sourced at
    # launch; freshly pulled files do NOT hot-reload. If we kept going in this same
    # process, the apply steps below (write_nginx_https, sync_*) would still call the
    # OLD functions, so a just-pulled fix to any config writer would silently not take
    # effect this run. So: pull the dir the running script lives in, and if the commit
    # changed at all, stop and make the operator re-launch; the new code then applies
    # on the next run. Keyed on the COMMIT, not on deploy.sh's mtime, so a change to
    # any sourced library trips the guard too.
    # Watch SCRIPT_DIR unconditionally (even when == REPO_DIR) — it's where $0 lives.
    if [[ -d "$SCRIPT_DIR/.git" ]]; then
        local _self_before _self_after
        _self_before=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo none)
        info "Pulling script directory: $SCRIPT_DIR"
        if git -C "$SCRIPT_DIR" fetch origin \
           && git -C "$SCRIPT_DIR" checkout "$target_branch" \
           && git -C "$SCRIPT_DIR" reset --hard "origin/$target_branch"; then
            success "Script dir updated: $(git -C "$SCRIPT_DIR" log -1 --format='%h %s')"
        else
            warn "Could not update script dir — check connectivity / branch name."
            press_enter; return 0
        fi
        _self_after=$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || echo none)
        if [[ "$_self_before" != "$_self_after" ]]; then
            echo ""
            warn "Deploy code changed: ${_self_before:0:7} → ${_self_after:0:7} (deploy.sh and/or lib/*.sh)"
            echo -e "  ${BOLD}Bash is still running the old in-memory copy.${RESET} Re-launch deploy.sh and run"
            echo -e "  Option 5 again to apply the new code (sync frontend/backend/nginx)."
            echo -e "  ${DIM}Continuing now would apply with the old code instead of what was just pulled.${RESET}"
            press_enter
            exit 0
        fi
        info "Deploy code unchanged — applying with the current code."
    fi

    (
        set -euo pipefail
        exec > >(tee "$logf") 2>&1

        # ── Pull server repo: /opt/office-tools/repo ───────────────────────────
        if [[ -d "$REPO_DIR/.git" ]]; then
            info "Pulling server repo: $REPO_DIR"
            git -C "$REPO_DIR" fetch origin
            git -C "$REPO_DIR" checkout "$target_branch"
            git -C "$REPO_DIR" reset --hard "origin/$target_branch"
            success "Server repo updated: $(git -C "$REPO_DIR" log -1 --format='%h %s')"
        elif [[ -d "$SCRIPT_DIR/.git" ]]; then
            # Server repo doesn't exist yet — seed it from SCRIPT_DIR or clone fresh
            info "Server repo not found — cloning from remote…"
            mkdir -p "$(dirname "$REPO_DIR")"
            git clone --branch "$target_branch" "$REPO_URL" "$REPO_DIR"
            success "Server repo cloned: $(git -C "$REPO_DIR" log -1 --format='%h %s')"
        fi

        load_conf
        sync_frontend "${DOMAIN:-}"

        # Sync backend if installed
        [[ -d "$BACKEND_DIR" ]] && sync_backend || true

        # Sync yt-server if installed
        [[ -d "$YT_SERVER_DIR" ]] && sync_yt_server || true

        # Refresh nginx config so new location blocks (e.g. /yt-api/) are always picked up.
        # Re-write the full config from the current deploy.sh template — safe because the
        # config is generated from a template with no manual customisations.
        if systemctl is-active --quiet nginx 2>/dev/null && [[ -n "${DOMAIN:-}" ]]; then
            local ssl_cert="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
            if [[ -f "$ssl_cert" ]]; then
                info "Refreshing nginx HTTPS config for ${DOMAIN}…"
                write_nginx_https "$DOMAIN"
            elif [[ -f "$NGINX_CONF_PATH" ]]; then
                info "Refreshing nginx HTTP config for ${DOMAIN}…"
                write_nginx_http "$DOMAIN"
            fi
            success "nginx config refreshed and reloaded"
        elif systemctl is-active --quiet nginx 2>/dev/null; then
            systemctl reload nginx
            success "nginx reloaded"
        fi
    ) || { warn "Update failed — check $logf"; press_enter; return 0; }

    load_conf
    if [[ -n "$DOMAIN" ]]; then
        success "Updated to branch '${target_branch}' — https://${DOMAIN}"
    else
        success "Updated to branch '${target_branch}'"
    fi
    press_enter
}


