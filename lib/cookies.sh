# =============================================================================
# Office Tools — Admin — YouTube cookie management
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Admin: YouTube cookies ───────────────────────────────────────────────────
# The one step that cannot be automated away: Google gates the login behind a human
# (CAPTCHA/2FA, worse from a datacenter IP). Everything AFTER the export is done here
# so the operator never has to hand-run install/grep/echo/systemctl.
#
# Option 1 is a guided walkthrough that ends in the paste prompt — a first-time operator
# should never have to find a reference guide, read it, then come back. Option 6 is a
# short reference for someone who has done this before; the step-by-step lives in the
# wizard only, so the two cannot drift apart.
_admin_configure_cookies() {
    section "YouTube cookies"

    if [[ ! -d "$YT_SERVER_DIR" ]]; then
        warn "yt-server not installed — run Option 1 first."
        press_enter; return 0
    fi

    local cookie_file="${YT_SERVER_DIR}/cookies.txt"
    local status_file="${YT_SERVER_DIR}/cookies.status"

    echo -e "  Current state:"
    if [[ -f "$cookie_file" ]]; then
        echo -e "    ${BOLD}file:${RESET}   $cookie_file  ${DIM}($(wc -l < "$cookie_file") lines, $(stat -c '%U:%G %a' "$cookie_file"))${RESET}"
        if [[ -f "$status_file" ]]; then
            echo -e "    ${BOLD}status:${RESET} $(head -n1 "$status_file")"
        else
            echo -e "    ${BOLD}status:${RESET} ${DIM}not probed yet (keep-alive cron has not run)${RESET}"
        fi
    else
        echo -e "    ${DIM}no cookie file installed${RESET}"
    fi
    echo ""
    echo -e "  ${BOLD}1)${RESET} Set up cookies  ${DIM}— guided, start here${RESET}"
    echo -e "  ${BOLD}2)${RESET} Paste a cookies.txt I already exported"
    echo -e "  ${BOLD}3)${RESET} Import from a path on this server"
    echo -e "  ${BOLD}4)${RESET} Test now ${DIM}(run the probe and show the result)${RESET}"
    echo -e "  ${BOLD}5)${RESET} Remove cookies ${DIM}(back to PO-token only)${RESET}"
    echo -e "  ${BOLD}6)${RESET} Quick reference ${DIM}(renewing + troubleshooting)${RESET}"
    echo -e "  ${BOLD}0)${RESET} Back"
    echo ""
    echo -ne "  Choose [1-6 / 0]: "; read -r _ck
    echo ""

    case "$_ck" in
        1) _cookie_wizard ;;
        2) _cookie_install_from_paste ;;
        3) _cookie_install_from_path ;;
        4) _cookie_probe; press_enter ;;
        5)
            ask_proceed "Remove the cookie file and unset YTDLP_COOKIES" || return 0
            rm -f "$cookie_file" "$status_file"
            sed -i '/^[[:space:]]*YTDLP_COOKIES=/d' "${YT_SERVER_DIR}/.env" 2>/dev/null || true
            systemctl restart office-tools-cobalt 2>/dev/null || true
            success "Cookies removed — yt-server restarted (PO-token only)"
            press_enter
            ;;
        6) _cookie_howto; press_enter ;;
        *) return 0 ;;
    esac
}

# "Press Enter" between wizard screens. press_enter says "return to menu", which is the
# wrong promise in the middle of a walkthrough.
_cookie_step_pause() {
    echo ""
    echo -ne "${DIM}  Press Enter for $1…${RESET}"; read -r
}

# The guided path: three short screens that end in the paste prompt.
# It teaches exactly ONE export route (private window + extension). Offering two routes
# inside a wizard is how someone half-follows each and exports nothing usable — the
# yt-dlp alternative is a footnote in the reference instead.
_cookie_wizard() {
    section "Set up YouTube cookies — 1 of 3: the account"
    cat << 'W1EOF'
  YouTube answers VPS IPs with "Sign in to confirm you're not a bot". The
  PO-token provider handles most of that; on a flagged IP YouTube also wants a
  logged-in session, and cookies.txt is that session. Google's login is
  deliberately human-gated, so it cannot be done on this server — you export on
  your own computer and paste the result here. About 5 minutes, once.

  FIRST: make a "burner" Google account

    A burner (= throwaway, disposable) account is a NEW Google account made
    only for this job. Any name, no recovery details you care about, nothing
    else signed in to it, and losing it tomorrow costs you nothing.

    Never use your own Gmail. Two reasons:
      - YouTube flags, and sometimes bans, accounts whose session is used for
        server-side downloading.
      - cookies.txt IS a working login. It lives on this server; anyone who
        can read that file is signed in as that account.

    Create it at accounts.google.com, then visit youtube.com once with it so
    the account has a normal YouTube session.
W1EOF
    _cookie_step_pause "step 2 of 3 — the export"

    section "Set up YouTube cookies — 2 of 3: export in your browser"
    cat << 'W2EOF'
  Do this on your own computer, not on this server:

    1. Install the browser extension "Get cookies.txt LOCALLY", and allow it
       to run in private windows.
    2. Open a PRIVATE / INCOGNITO window.
    3. Log into youtube.com with the BURNER account.
    4. Open any ordinary video, for example:
W2EOF
    echo "         ${YTCOOKIE_PROBE_URL:-https://www.youtube.com/watch?v=J6VMJLSNAHk}"
    cat << 'W2EOF'
    5. Click the extension -> Export -> save cookies.txt (Netscape format).
    6. CLOSE the private window WITHOUT logging out.

  Step 6 is the one that decides whether any of this works. Logging out
  invalidates the session on Google's side and kills the exported file with
  it — that is the #1 reason server cookies "work for an hour and then die".
  A private window is what keeps anything from touching the session after.
W2EOF
    _cookie_step_pause "step 3 of 3 — installing it"

    section "Set up YouTube cookies — 3 of 3: paste it here"
    _cookie_install_from_paste
}

_cookie_install_from_paste() {
    local tmp_file _line
    echo -e "  Open ${BOLD}cookies.txt${RESET} in a text editor, copy ${BOLD}all${RESET} of it and paste"
    echo -e "  it below. Then press Enter and type a line containing only ${BOLD}EOF${RESET}."
    echo ""
    echo -e "  ${DIM}(The first line is usually: # Netscape HTTP Cookie File)${RESET}"
    echo ""
    tmp_file="$(mktemp)"
    while IFS= read -r _line; do
        [[ "$_line" == "EOF" ]] && break
        printf '%s\n' "$_line" >> "$tmp_file"
    done
    _cookie_install_file "$tmp_file"
}

_cookie_install_from_path() {
    local _src tmp_file
    echo -ne "  Path to cookies.txt on this server: "; read -r _src
    [[ -f "${_src:-}" ]] || { warn "No such file: ${_src:-}"; press_enter; return 0; }
    tmp_file="$(mktemp)"
    cp "$_src" "$tmp_file" || { warn "Could not read $_src"; rm -f "$tmp_file"; press_enter; return 0; }
    _cookie_install_file "$tmp_file"
}

# Validate, install, wire up .env + cron, restart, probe. Shared by every route in.
_cookie_install_file() {
    local tmp_file="$1"
    local cookie_file="${YT_SERVER_DIR}/cookies.txt"
    local status_file="${YT_SERVER_DIR}/cookies.status"

    # Sanity-check before installing: a truncated paste or an HTML error page saved as
    # cookies.txt fails silently at download time, which is the hardest kind to debug.
    if ! grep -qi 'youtube[.]com' "$tmp_file"; then
        warn "No youtube.com entries found — that does not look like a YouTube cookies.txt."
        rm -f "$tmp_file"; press_enter; return 0
    fi
    # Netscape format is TAB-separated, 7 fields. Some terminals and SSH clients turn
    # pasted TABs into spaces; that file installs fine and then fails inside yt-dlp with
    # an error that says nothing about tabs. Catch it here instead.
    if ! awk -F'\t' '$0 !~ /^#/ && NF >= 7 { found = 1 } END { exit !found }' "$tmp_file"; then
        warn "No tab-separated cookie lines found."
        echo -e "  ${DIM}Netscape cookies.txt uses TAB separators, and a terminal paste can${RESET}"
        echo -e "  ${DIM}turn them into spaces. Copy the file to this server (scp) and use${RESET}"
        echo -e "  ${DIM}option 3 — Import from a path — instead.${RESET}"
        rm -f "$tmp_file"; press_enter; return 0
    fi

    # 600 www-data: yt-dlp REWRITES this file as it rotates the session, so the service
    # user must own it — a root-owned file makes every rotation fail silently.
    install -o www-data -g www-data -m 600 "$tmp_file" "$cookie_file" \
        || { warn "Could not install $cookie_file"; rm -f "$tmp_file"; press_enter; return 0; }
    rm -f "$tmp_file" "$status_file"

    env_ensure "${YT_SERVER_DIR}/.env" YTDLP_COOKIES "$cookie_file"
    chown www-data:www-data "${YT_SERVER_DIR}/.env" 2>/dev/null || true
    setup_cookie_keepalive

    systemctl restart office-tools-cobalt 2>/dev/null || true
    sleep 2
    success "Cookies installed ($(wc -l < "$cookie_file") lines) and yt-server restarted"
    echo ""
    _cookie_probe
    press_enter
}

# Short reference for someone who has done this before. The full step-by-step is the
# wizard (option 1) and is deliberately NOT repeated here.
_cookie_howto() {
    section "YouTube cookies — quick reference"
    cat << 'HOWTOEOF'
  EXPORT  (option 1 walks you through this)
    Burner Google account -> PRIVATE window -> log into youtube.com -> open a
    video -> "Get cookies.txt LOCALLY" -> Export -> close the window WITHOUT
    logging out. Logging out kills the exported file too.
    Never your own Gmail: cookies.txt is a working login for that account.

  RENEWING
    Cookies last weeks, not forever — but you do not have to watch for it.
    A cron probe runs every 6 hours (ytcookie-keepalive.sh): it keeps the
    session rotating, and writes "expired" into cookies.status when Google
    finally rejects it. /health then reports "cookies":"file:expired" and the
    downloader page shows an orange warning next to the backend line.
    To renew: export again with the same burner account, then option 2.

  TROUBLESHOOTING
    "file:missing"      YTDLP_COOKIES in .env points at a file that is gone.
    "file:unchecked"    installed, cron has not probed yet — use option 4.
    inconclusive probe  network/YouTube hiccup, or the probe video was removed.
                        The old status is kept on purpose. Override the video
                        with YTCOOKIE_PROBE_URL.
    paste rejected      a terminal turned the TABs into spaces — scp the file
                        to this server and use option 3 instead.
    still bot-checked   check office-tools-pot is running and yt-dlp is current
                        (Option 6 -> h), then export fresh cookies.

  WITHOUT THE EXTENSION  (advanced)
    yt-dlp can export from a NORMAL Firefox profile logged in as the burner —
    never a private one, whose cookies are memory-only and invisible to it —
    with Firefox closed:
HOWTOEOF
    echo "      yt-dlp --cookies-from-browser firefox --cookies cookies.txt \\"
    echo "             --skip-download \"${YTCOOKIE_PROBE_URL:-https://www.youtube.com/watch?v=J6VMJLSNAHk}\""
    cat << 'HOWTOEOF'
    Firefox, not Chrome: app-bound cookie encryption commonly breaks the
    --cookies-from-browser chrome path.
HOWTOEOF
    echo ""
}

# Runs the keep-alive probe once (as www-data, exactly as cron will) and prints both
# its verdict and what /health now reports.
_cookie_probe() {
    local ka="${YT_SERVER_DIR}/ytcookie-keepalive.sh"
    if [[ -x "$ka" ]]; then
        info "Probing cookies with yt-dlp…"
        # Run as the service user so a rotated cookies.txt keeps www-data ownership.
        if command -v runuser &>/dev/null; then
            runuser -u www-data -- "$ka" 2>&1 | sed 's/^/    /' || true
        else
            su -s /bin/bash www-data -c "$ka" 2>&1 | sed 's/^/    /' || true
        fi
    else
        warn "Keep-alive script not found at $ka — run Option 6 → h to sync yt-server."
    fi
    # PORT is operator-editable in .env — do not assume 9000, or this reports a healthy
    # server as down on any box where it was changed.
    local port health
    port="$(sed -n 's/^[[:space:]]*PORT=//p' "${YT_SERVER_DIR}/.env" 2>/dev/null | tail -n1 | tr -d "\"' ")"
    port="${port:-9000}"
    health="$(curl -s --max-time 5 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
    if [[ -n "$health" ]]; then
        echo -e "  ${BOLD}/health:${RESET} ${health}"
    else
        warn "yt-server not answering on 127.0.0.1:${port} — check: journalctl -u office-tools-cobalt -n 30"
    fi
}


