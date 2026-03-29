#!/usr/bin/env bash
# ============================================================
#  Office Tools — Grin Wallet Setup & Listener Manager
#  deploy_grinwallet.sh
#
#  Option 1: Integrate Grin Wallet
#    — Download latest grin-wallet binary (mainnet)
#    — Init new wallet  (grin-wallet init -h)
#    — Recover wallet   (grin-wallet init -hr)
#    — Configure grin-wallet.toml (node selection)
#    — Optionally save passphrase for auto-start (plain text)
#    — Update server .env with wallet binary path
#
#  Option 2: Manage Wallet Listener (tmux)
#    — Start / Stop / Restart grin-wallet listen in tmux
#    — Attach to session · View logs · Re-save passphrase
#    — Enable / disable auto-start on reboot (cron @reboot)
#
#  Wallet files live in:
#    /opt/office-tools/cmdgrinwallet/
#      grin-wallet          binary
#      grin-wallet.toml     config
#      wallet_data/         created by init
#      grin-wallet.log      runtime log
#
#  Auto-start helper (written by option 2):
#    /opt/office-tools/data/grin-listen.sh
#
#  Saved passphrase (plain text, root-only, chmod 640):
#    /opt/office-tools/data/.temp
#
#  ⚠  SECURITY NOTE
#    The saved passphrase is stored in PLAIN TEXT.
#    Your hosting provider and anyone with root access can read it.
#    Recommendation: transfer funds to a personal wallet regularly
#    rather than keeping a large balance on this server.
# ============================================================
set -uo pipefail

# ── Paths ──────────────────────────────────────────────────────
WALLET_DIR="/opt/office-tools/cmdgrinwallet"
WALLET_BIN="${WALLET_DIR}/grin-wallet"
WALLET_TOML="${WALLET_DIR}/grin-wallet.toml"
SERVER_ENV="/opt/office-tools/server/.env"
PASS_FILE="/opt/office-tools/data/.temp"
SEED_FILE="/opt/office-tools/data/.wallet_seed.enc"
LISTENER_SCRIPT="/opt/office-tools/data/grin-listen.sh"
OWNER_SCRIPT="/opt/office-tools/data/grin-owner.sh"
TMUX_SESSION="donate_grin_tor"
TMUX_SESSION_OWNER="donate_grin_slatepack"
GRIN_USER="grin"
GRIN_GROUP="grin"

# ── Colours & logging ──────────────────────────────────────────
RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; CYN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GRN}[GrinWallet]${NC} $*"; }
warn() { echo -e "${YEL}[WARN]${NC} $*"; }
err()  { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()  { err "$1"; exit 1; }
sep()  { echo -e "${CYN}────────────────────────────────────────${NC}"; }

# ── Must run as root ───────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root or with sudo."

# ── Create grin system user/group & fix ownership ─────────────
setup_grin_user() {
  if ! getent group "$GRIN_GROUP" &>/dev/null; then
    groupadd --system "$GRIN_GROUP"
    log "Created system group: ${GRIN_GROUP}"
  else
    log "Group already exists: ${GRIN_GROUP}"
  fi

  if ! id "$GRIN_USER" &>/dev/null; then
    useradd --system \
            --gid "$GRIN_GROUP" \
            --no-create-home \
            --home-dir "$WALLET_DIR" \
            --shell /usr/sbin/nologin \
            --comment "Grin wallet service account" \
            "$GRIN_USER"
    log "Created system user: ${GRIN_USER} (no login)"
  else
    log "User already exists: ${GRIN_USER}"
  fi

  mkdir -p "$WALLET_DIR" "/opt/office-tools/data"
  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_DIR"
  chmod 750 "$WALLET_DIR"
  log "Ownership set: ${WALLET_DIR} → ${GRIN_USER}:${GRIN_GROUP}"
}

# ── Helper: read passphrase (hidden input, confirmed) ──────────
# Rules: minimum 3 characters, empty not accepted, 0 to cancel.
read_pass_confirmed() {
  local pass pass2
  while true; do
    read -r -s -p "Passphrase (min 3 chars, 0 to cancel): " pass; echo >&2
    [[ "$pass" == "0" ]] && return 1
    if [[ ${#pass} -lt 3 ]]; then
      warn "Passphrase must be at least 3 characters. Try again." >&2
      continue
    fi
    read -r -s -p "Confirm passphrase: " pass2; echo >&2
    if [[ "$pass" != "$pass2" ]]; then
      warn "Passphrases do not match. Try again." >&2
      unset pass pass2
      continue
    fi
    unset pass2
    break
  done
  printf '%s' "$pass"
}

# ── Helper: update or append a key in .env ────────────────────
upsert_env() {
  local key="$1" val="$2" file="$3"
  [[ ! -f "$file" ]] && touch "$file"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$file"
  else
    echo "${key}=${val}" >> "$file"
  fi
}

# ── Download latest grin-wallet binary from GitHub ────────────
download_grin_wallet() {
  log "Fetching latest grin-wallet release from GitHub…"
  local api_url="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"
  local api_json dl_url

  if ! api_json=$(curl -fsSL --connect-timeout 10 "$api_url" 2>&1); then
    err "Could not reach GitHub API: $api_json"
    return 1
  fi

  if echo "$api_json" | grep -q '"message"' && ! echo "$api_json" | grep -q '"browser_download_url"'; then
    local gh_msg; gh_msg=$(echo "$api_json" | grep '"message"' | head -1 | sed 's/.*"message": *"\([^"]*\)".*/\1/')
    err "GitHub API error: ${gh_msg}"
    return 1
  fi

  dl_url=$(printf '%s\n' "$api_json" \
    | grep 'linux-x86_64\.tar\.gz' \
    | grep -v 'sha256' \
    | grep -o 'https://[^"]*' \
    | head -1 \
    || true)

  if [[ -z "$dl_url" ]]; then
    err "Could not find a linux-x86_64 asset in the GitHub release."
    warn "Available assets:"
    printf '%s\n' "$api_json" | grep '"browser_download_url"' | sed 's/.*"\(https[^"]*\)".*/  \1/' >&2
    return 1
  fi

  log "Latest: $dl_url"
  local filename; filename=$(basename "$dl_url")
  local tmpdir;   tmpdir=$(mktemp -d)

  log "Downloading: $filename"
  if ! curl -fL --progress-bar "$dl_url" -o "${tmpdir}/${filename}"; then
    err "Download failed."
    rm -rf "$tmpdir"
    return 1
  fi

  log "Extracting to ${WALLET_DIR}…"
  mkdir -p "$WALLET_DIR"
  if ! tar -xzf "${tmpdir}/${filename}" -C "$WALLET_DIR"; then
    err "Extraction failed. Archive may be corrupt."
    rm -rf "$tmpdir"
    return 1
  fi
  chmod +x "$WALLET_BIN"
  rm -rf "$tmpdir"

  local version; version=$("$WALLET_BIN" --version 2>&1 | head -1 || echo "unknown")
  log "Installed: $version"
}

# ── Create mainnet grin-wallet.toml (always fresh) ────────────
create_wallet_toml() {
  mkdir -p "$WALLET_DIR"
  [[ -f "$WALLET_TOML" ]] && { log "Removing old grin-wallet.toml…"; rm -f "$WALLET_TOML"; }
  cat > "$WALLET_TOML" <<EOF
[wallet]
chain_type = "Mainnet"
api_listen_interface = "127.0.0.1"
api_listen_port = 3415
owner_api_listen_port = 3420
api_secret_path = "${WALLET_DIR}/.api_secret"
owner_api_secret_path = "${WALLET_DIR}/.owner_api_secret"
check_node_api_http_addr = "http://127.0.0.1:3413"
owner_api_include_foreign = false
data_file_dir = "${WALLET_DIR}/wallet_data/"
no_commit_cache = false
dark_background_color_scheme = true
keybase_notify_ttl = 1440

[logging]
log_to_stdout = true
stdout_log_level = "Info"
log_to_file = true
file_log_level = "Info"
log_file_path = "${WALLET_DIR}/grin-wallet.log"
log_file_append = true
log_max_size = 16777216
log_max_files = 3
EOF
  log "Created ${WALLET_TOML}"
}

# ── Check if a URL is reachable ────────────────────────────────
check_server_online() {
  local url="$1"
  local http_code
  http_code=$(curl -o /dev/null -s -w "%{http_code}" --max-time 5 "${url}/v2/foreign" 2>/dev/null || echo "000")
  if [[ "$http_code" =~ ^(2|3)[0-9]{2}$ ]] || [[ "$http_code" == "405" ]] || [[ "$http_code" == "404" ]]; then
    echo "online"
  else
    echo "offline"
  fi
}

# ── Select Grin node — returns URL via stdout ─────────────────
select_node_url() {
  local ext_servers=(
    "https://api.grin.money"
    "https://api.grinily.com"
    "https://api.grinnode.org"
  )

  echo "  Checking external node availability…" >&2
  echo >&2

  local ext_statuses=()
  for url in "${ext_servers[@]}"; do
    ext_statuses+=("$(check_server_online "$url")")
  done

  echo "  Select Grin node for grin-wallet.toml:" >&2
  echo >&2

  local i
  for i in "${!ext_servers[@]}"; do
    local host; host=$(echo "${ext_servers[$i]}" | sed 's|https\?://||')
    local flag
    if [[ "${ext_statuses[$i]}" == "online" ]]; then
      flag="${GRN}● online${NC}"
    else
      flag="${RED}○ offline${NC}"
    fi
    printf "  %d) %-36s %b\n" "$((i+1))" "$host" "$flag" >&2
  done

  local local_flag
  if ss -tlnp 2>/dev/null | grep -q ':3413' || netstat -tlnp 2>/dev/null | grep -q ':3413'; then
    local_flag="${GRN}● running${NC}"
  else
    local_flag="${YEL}○ install it by Grin Node Toolkit${NC}"
  fi
  printf "  4) %-36s %b\n" "Local node  127.0.0.1:3413" "$local_flag" >&2
  echo "  0) Back (keep current setting)" >&2
  echo >&2

  local choice
  read -r -p "Choice [0-4]: " choice >&2

  case "$choice" in
    1|2|3)
      local selected_url="${ext_servers[$((choice-1))]}"
      local selected_status="${ext_statuses[$((choice-1))]}"
      if [[ "$selected_status" == "offline" ]]; then
        warn "That server appears offline. Use it anyway? [y/N]" >&2
        local yn; read -r -p "" yn >&2
        if [[ "${yn,,}" != "y" ]]; then
          warn "No change — keeping current setting." >&2
          echo ""
          return
        fi
      fi
      echo "$selected_url"
      ;;
    4)
      warn "Remember to install a local Grin node before starting the wallet listener." >&2
      echo "http://127.0.0.1:3413"
      ;;
    0|*)
      echo ""
      ;;
  esac
}

# ── Patch check_node_api_http_addr in existing toml ───────────
patch_check_node() {
  echo
  local current_node
  current_node=$(grep 'check_node_api_http_addr' "$WALLET_TOML" | cut -d'"' -f2)
  log "Current node: ${current_node}"
  echo

  local chosen; chosen=$(select_node_url)
  if [[ -n "$chosen" ]]; then
    sed -i "s|check_node_api_http_addr = .*|check_node_api_http_addr = \"${chosen}\"|" "$WALLET_TOML"
    log "Updated check_node_api_http_addr → ${chosen}"
  else
    log "No changes made."
  fi
}

# ── Save passphrase to disk (plain text, root-only) ────────────
save_passphrase() {
  local pass="$1"
  [[ -z "$pass" ]] && { warn "No passphrase to save."; return; }
  mkdir -p "$(dirname "$PASS_FILE")"
  printf '%s' "$pass" > "$PASS_FILE"
  chown "root:${GRIN_GROUP}" "$PASS_FILE"
  chmod 640 "$PASS_FILE"
  log "Passphrase saved: ${PASS_FILE}"
}

# ── Save encrypted seed backup (OpenSSL AES-256-CBC) ──────────
save_seed_backup() {
  local wallet_pass="$1"
  log "Retrieving wallet seed phrase…"
  local seed_output
  if [[ -n "$wallet_pass" ]]; then
    seed_output=$(cd "$WALLET_DIR" && ./grin-wallet -p "$wallet_pass" recover 2>&1) || true
  else
    seed_output=$(cd "$WALLET_DIR" && ./grin-wallet recover 2>&1) || true
  fi

  echo
  warn "The seed phrase will be printed briefly. Make sure you are alone."
  read -r -s -p "Press Enter to view seed, then we will encrypt it immediately…"; echo
  echo "─── SEED PHRASE ───────────────────────────────"
  echo "$seed_output"
  echo "───────────────────────────────────────────────"
  echo
  warn "Write it down on paper NOW if you haven't already."
  read -r -s -p "Enter a password to encrypt this seed backup: " seed_enc_pass; echo
  read -r -s -p "Confirm seed backup password: " seed_enc_pass2; echo
  if [[ "$seed_enc_pass" != "$seed_enc_pass2" ]]; then
    warn "Passwords don't match. Seed will NOT be saved."; return
  fi

  mkdir -p "$(dirname "$SEED_FILE")"
  printf '%s\n' "$seed_output" | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass "pass:${seed_enc_pass}" -out "$SEED_FILE"
  chown root:root "$SEED_FILE"
  chmod 600 "$SEED_FILE"
  unset seed_enc_pass seed_enc_pass2
  log "Encrypted seed saved: ${SEED_FILE}"
  log "To recover: openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in ${SEED_FILE}"
}

# ── Update server .env with Grin API paths ───────────────────
update_server_env() {
  if [[ ! -f "$SERVER_ENV" ]]; then
    log "${SERVER_ENV} not found — skipping .env update (deploy Office Tools server to enable)."
    return
  fi
  upsert_env "GRIN_FOREIGN_API"           "http://127.0.0.1:3415/v2/foreign"    "$SERVER_ENV"
  upsert_env "GRIN_OWNER_API"             "http://127.0.0.1:3420/v3/owner"      "$SERVER_ENV"
  upsert_env "GRIN_API_SECRET_FILE"       "${WALLET_DIR}/wallet_data/.api_secret" "$SERVER_ENV"
  upsert_env "GRIN_OWNER_API_SECRET_FILE" "${WALLET_DIR}/.owner_api_secret"       "$SERVER_ENV"
  upsert_env "GRIN_LISTEN_PORT"           "3415"                                 "$SERVER_ENV"
  upsert_env "GRIN_LISTEN_HOST"           "127.0.0.1"                            "$SERVER_ENV"
  log "Updated ${SERVER_ENV}"
}

# ── Write the persistent listener wrapper script ───────────────
write_listener_script() {
  mkdir -p "$(dirname "$LISTENER_SCRIPT")"
  if [[ -f "$PASS_FILE" ]]; then
    cat > "$LISTENER_SCRIPT" <<SCRIPT
#!/bin/bash
PASS=\$(tr -d '\r\n' < "${PASS_FILE}")
cd "${WALLET_DIR}"
exec ./grin-wallet -p "\$PASS" listen
SCRIPT
  else
    cat > "$LISTENER_SCRIPT" <<SCRIPT
#!/bin/bash
cd "${WALLET_DIR}"
exec ./grin-wallet listen
SCRIPT
  fi
  chmod 750 "$LISTENER_SCRIPT"
  chown "root:${GRIN_GROUP}" "$LISTENER_SCRIPT"
  log "Listener script written: ${LISTENER_SCRIPT}"
}

# ── tmux helpers ──────────────────────────────────────────────
wallet_is_running() {
  tmux has-session -t "$TMUX_SESSION" 2>/dev/null
}

wallet_start() {
  if [[ ! -x "$WALLET_BIN" ]]; then
    err "grin-wallet binary not found. Run option 1 first."
    return 1
  fi
  if wallet_is_running; then
    warn "Wallet listener is already running (tmux: ${TMUX_SESSION})."
    return
  fi

  # Kill any orphaned grin-wallet process not in tmux
  if pgrep -f "grin-wallet.*listen" &>/dev/null; then
    warn "Killing orphaned grin-wallet process before starting…"
    pkill -f "grin-wallet.*listen" 2>/dev/null || true
    sleep 1
  fi

  # Write wrapper then run it in tmux.
  # The passphrase is read from PASS_FILE inside the wrapper — never appears in ps args.
  write_listener_script

  # Build a one-shot tmux wrapper that shows output and waits on exit for debugging
  local wrapper; wrapper=$(mktemp /tmp/grin-listen-XXXXXX.sh)
  cat > "$wrapper" <<WRAPPER
#!/bin/bash
bash "${LISTENER_SCRIPT}"
echo ""
echo "=== grin-wallet exited (see error above) ==="
read -r -p "Press Enter to close..."
WRAPPER
  chmod 700 "$wrapper"
  chown "${GRIN_USER}:${GRIN_GROUP}" "$wrapper"

  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_DIR"
  chmod 750 "$WALLET_DIR"

  tmux new-session -d -s "$TMUX_SESSION" -x 220 -y 50 \
    "su -s /bin/bash ${GRIN_USER} -c 'bash ${wrapper}'"
  sleep 1
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "Wallet listener started in tmux session: ${TMUX_SESSION}"
    log "Attach with: tmux attach -t ${TMUX_SESSION}"
  else
    err "tmux session exited immediately — check: tmux attach -t ${TMUX_SESSION}"
  fi
}

wallet_stop() {
  if wallet_is_running; then
    pkill -f "grin-wallet.*listen" 2>/dev/null || true
    sleep 1
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    log "Wallet listener stopped."
  else
    warn "Wallet listener is not running."
  fi
}

# ── Owner API session (donate_grin_slatepack) ─────────────────

write_owner_script() {
  mkdir -p "$(dirname "$OWNER_SCRIPT")"
  if [[ -f "$PASS_FILE" ]]; then
    cat > "$OWNER_SCRIPT" <<SCRIPT
#!/bin/bash
PASS=\$(tr -d '\r\n' < "${PASS_FILE}")
cd "${WALLET_DIR}"
exec ./grin-wallet -p "\$PASS" owner_api
SCRIPT
  else
    cat > "$OWNER_SCRIPT" <<SCRIPT
#!/bin/bash
cd "${WALLET_DIR}"
exec ./grin-wallet owner_api
SCRIPT
  fi
  chmod 750 "$OWNER_SCRIPT"
  chown "root:${GRIN_GROUP}" "$OWNER_SCRIPT"
  log "Owner API script written: ${OWNER_SCRIPT}"
}

owner_is_running() {
  tmux has-session -t "$TMUX_SESSION_OWNER" 2>/dev/null
}

owner_start() {
  if [[ ! -x "$WALLET_BIN" ]]; then
    err "grin-wallet binary not found. Run option 1 first."
    return 1
  fi
  if owner_is_running; then
    warn "Owner API is already running (tmux: ${TMUX_SESSION_OWNER})."
    return
  fi

  # Kill any orphaned grin-wallet owner_api process
  if pgrep -f "grin-wallet.*owner_api" &>/dev/null; then
    warn "Killing orphaned grin-wallet owner_api process before starting…"
    pkill -f "grin-wallet.*owner_api" 2>/dev/null || true
    sleep 1
  fi

  write_owner_script

  local wrapper; wrapper=$(mktemp /tmp/grin-owner-XXXXXX.sh)
  cat > "$wrapper" <<WRAPPER
#!/bin/bash
bash "${OWNER_SCRIPT}"
echo ""
echo "=== grin-wallet owner_api exited (see error above) ==="
read -r -p "Press Enter to close..."
WRAPPER
  chmod 700 "$wrapper"
  chown "${GRIN_USER}:${GRIN_GROUP}" "$wrapper"

  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_DIR"

  tmux new-session -d -s "$TMUX_SESSION_OWNER" -x 220 -y 50 \
    "su -s /bin/bash ${GRIN_USER} -c 'bash ${wrapper}'"
  sleep 1
  if tmux has-session -t "$TMUX_SESSION_OWNER" 2>/dev/null; then
    log "Owner API started in tmux session: ${TMUX_SESSION_OWNER}"
    log "Attach with: tmux attach -t ${TMUX_SESSION_OWNER}"
  else
    err "tmux session exited immediately — check: tmux attach -t ${TMUX_SESSION_OWNER}"
  fi
}

owner_stop() {
  if owner_is_running; then
    pkill -f "grin-wallet.*owner_api" 2>/dev/null || true
    sleep 1
    tmux kill-session -t "$TMUX_SESSION_OWNER" 2>/dev/null || true
    log "Owner API stopped."
  else
    warn "Owner API is not running."
  fi
}

# ── Auto-start on reboot (cron @reboot) ───────────────────────
reboot_autostart_enabled() {
  crontab -l 2>/dev/null | grep -qE "grin-listen\.sh|grin-owner\.sh"
}

# ── Watchdog cron (every 30 min — checks port 3415) ───────────
WATCHDOG_SCRIPT="/opt/office-tools/data/grin-watchdog.sh"
WATCHDOG_CRON_TAG="grin-watchdog"

watchdog_enabled() {
  crontab -l 2>/dev/null | grep -q "$WATCHDOG_CRON_TAG"
}

write_watchdog_script() {
  mkdir -p "$(dirname "$WATCHDOG_SCRIPT")"
  cat > "$WATCHDOG_SCRIPT" <<WDOG
#!/bin/bash
# Grin wallet watchdog — started by cron every 30 min
# Checks port 3415; if not listening, starts the tmux listener session.
TMUX_SESSION="${TMUX_SESSION}"
LISTENER_SCRIPT="${LISTENER_SCRIPT}"
GRIN_USER="${GRIN_USER}"
GRIN_GROUP="${GRIN_GROUP}"
LOG="/opt/office-tools/data/grin-watchdog.log"

log() { echo "\$(date '+%Y-%m-%d %H:%M:%S') \$*" >> "\$LOG"; }

# Check if port 3415 is accepting connections
# How long a tmux session must exist (seconds) before we consider it stale.
# grin-wallet can take 2-3 min to sync and open the listener port.
STALE_AFTER=300   # 5 minutes

# ── Step 1: port check ────────────────────────────────────────
if timeout 5 bash -c 'echo >/dev/tcp/127.0.0.1/3415' 2>/dev/null; then
  log "Port 3415 OK — wallet listener is running."
  exit 0
fi

log "Port 3415 not reachable."

# ── Step 2: is a tmux session present? ───────────────────────
if ! tmux has-session -t "\$TMUX_SESSION" 2>/dev/null; then
  log "No tmux session found — starting wallet listener."
  tmux new-session -d -s "\$TMUX_SESSION" -x 220 -y 50 \
    "su -s /bin/bash \${GRIN_USER} -c 'bash \${LISTENER_SCRIPT}'" 2>/dev/null
  sleep 3
  if tmux has-session -t "\$TMUX_SESSION" 2>/dev/null; then
    log "Wallet listener started successfully."
  else
    log "ERROR: tmux session exited immediately — check listener script."
  fi
  exit 0
fi

# ── Step 3: session exists but port is down — is it still young? ─
# Use the PID of the tmux server to find when the session was created.
SESSION_START=\$(tmux display-message -t "\$TMUX_SESSION" -p '#{session_created}' 2>/dev/null)
NOW=\$(date +%s)
AGE=\$(( NOW - SESSION_START ))

if [[ "\$AGE" -lt "\$STALE_AFTER" ]]; then
  log "tmux session is only \${AGE}s old (threshold: \${STALE_AFTER}s) — still initializing, leaving it alone."
  exit 0
fi

# ── Step 4: session is old and port still down → stale, restart ─
log "tmux session has been running \${AGE}s with no port 3415 — considered stale. Restarting."
# Kill grin-wallet FIRST before killing tmux — prevents orphan processes
# (tmux kill-session reparents children to PID 1 instantly; pkill must run before that)
pkill -f "grin-wallet.*listen" 2>/dev/null || true
sleep 1
tmux kill-session -t "\$TMUX_SESSION" 2>/dev/null || true
sleep 2
tmux new-session -d -s "\$TMUX_SESSION" -x 220 -y 50 \
  "su -s /bin/bash \${GRIN_USER} -c 'bash \${LISTENER_SCRIPT}'" 2>/dev/null
sleep 3
if tmux has-session -t "\$TMUX_SESSION" 2>/dev/null; then
  log "Wallet listener restarted successfully."
else
  log "ERROR: tmux session exited immediately after restart — check listener script."
fi
WDOG
  chmod 750 "$WATCHDOG_SCRIPT"
  chown "root:${GRIN_GROUP}" "$WATCHDOG_SCRIPT"
  log "Watchdog script written: ${WATCHDOG_SCRIPT}"
}

enable_watchdog() {
  write_listener_script
  write_watchdog_script
  if watchdog_enabled; then
    warn "Watchdog cron already enabled."
    return
  fi
  local cron_line="*/30 * * * * bash ${WATCHDOG_SCRIPT} # ${WATCHDOG_CRON_TAG}"
  ( crontab -l 2>/dev/null; echo "$cron_line" ) | crontab -
  log "Watchdog cron enabled (every 30 min)."
  log "Cron entry: ${cron_line}"
  log "Log: /opt/office-tools/data/grin-watchdog.log"
}

disable_watchdog() {
  if ! watchdog_enabled; then
    warn "Watchdog cron not found."
    return
  fi
  crontab -l 2>/dev/null | grep -v "$WATCHDOG_CRON_TAG" | crontab -
  log "Watchdog cron disabled."
}

enable_reboot_autostart() {
  write_listener_script
  write_owner_script

  if reboot_autostart_enabled; then
    warn "Auto-start cron already set."
    return
  fi

  # Two @reboot entries — TOR listener (port 3415) and Owner API (port 3420)
  local cron_tor="@reboot sleep 30 && tmux new-session -d -s ${TMUX_SESSION} -x 220 -y 50 \"su -s /bin/bash ${GRIN_USER} -c 'bash ${LISTENER_SCRIPT}'\" 2>/dev/null # grin-listen.sh"
  local cron_owner="@reboot sleep 35 && tmux new-session -d -s ${TMUX_SESSION_OWNER} -x 220 -y 50 \"su -s /bin/bash ${GRIN_USER} -c 'bash ${OWNER_SCRIPT}'\" 2>/dev/null # grin-owner.sh"

  ( crontab -l 2>/dev/null; echo "$cron_tor"; echo "$cron_owner" ) | crontab -
  log "Auto-start on reboot enabled (root crontab @reboot)."
  log "TOR listener  cron: ${cron_tor}"
  log "Owner API     cron: ${cron_owner}"
}

disable_reboot_autostart() {
  if ! reboot_autostart_enabled; then
    warn "Auto-start cron not found."
    return
  fi
  crontab -l 2>/dev/null | grep -v "grin-listen.sh" | grep -v "grin-owner.sh" | crontab -
  log "Auto-start on reboot disabled."
}

# ── Option 1: Integrate Grin Wallet ───────────────────────────
option_integrate() {
  trap 'echo; err "Failed at line ${LINENO}: ${BASH_COMMAND}"; echo; read -r -p "Press Enter to return to menu…"; trap - ERR; return 1' ERR

  sep
  log "=== Option 1: Integrate Grin Wallet ==="
  sep

  # Step 0: System user
  echo
  log "Step 0/5 — System User (grin:grin)"
  setup_grin_user

  # Step 1: Binary
  echo
  log "Step 1/5 — Grin Wallet Binary"
  if [[ -x "$WALLET_BIN" ]]; then
    local cur_ver; cur_ver=$("$WALLET_BIN" --version 2>&1 | head -1)
    log "Already installed: $cur_ver"
    read -r -p "Re-download latest version? [y/N] " yn
    [[ "${yn,,}" == "y" ]] && download_grin_wallet
  else
    download_grin_wallet
  fi

  # Step 2: Select node (toml is written AFTER init so grin-wallet init doesn't overwrite it)
  echo
  log "Step 2/5 — Select Grin Node"
  local chosen_node=""
  chosen_node=$(select_node_url)

  # Step 3: Init or Recover
  echo
  log "Step 3/5 — Wallet Initialization"
  echo
  echo "  1) Create NEW wallet    (grin-wallet init -h)"
  echo "  2) RECOVER wallet       (grin-wallet init -hr)"
  echo "  0) Skip — wallet already initialized"
  echo
  read -r -p "Choice [0-2]: " wallet_choice

  local wallet_pass=""
  case "$wallet_choice" in
    1)
      log "Creating new wallet…"
      rm -f "$WALLET_TOML" "${WALLET_DIR}/wallet_data/wallet.seed"
      echo
      echo "  Enter a passphrase to protect your wallet."
      echo "  Leave blank for no passphrase."
      echo
      if wallet_pass=$(read_pass_confirmed); then
        (cd "$WALLET_DIR" && ./grin-wallet -p "$wallet_pass" init -h)
      else
        (cd "$WALLET_DIR" && ./grin-wallet init -h)
      fi
      echo
      warn "IMPORTANT: Write down the seed phrase shown above on paper."
      echo
      if [[ -n "$wallet_pass" ]]; then
        echo
        echo -e "  ${YEL}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "  ${YEL}║  /!\  SECURITY WARNING — READ BEFORE SAVING              ║${NC}"
        echo -e "  ${YEL}║                                                          ║${NC}"
        echo -e "  ${YEL}║  Saving the passphrase allows auto-start on reboot       ║${NC}"
        echo -e "  ${YEL}║  and auto-start if the grin-wallet crashes.              ║${NC}"
        echo -e "  ${YEL}║                                                          ║${NC}"
        echo -e "  ${YEL}║  /!\  It will be stored in PLAIN TEXT on this server     ║${NC}"
        echo -e "  ${YEL}║     Your hosting provider can read it.                   ║${NC}"
        echo -e "  ${YEL}║     Anyone with root access can read it.                 ║${NC}"
        echo -e "  ${YEL}║                                                          ║${NC}"
        echo -e "  ${YEL}║  Recommendation: transfer funds to a personal wallet     ║${NC}"
        echo -e "  ${YEL}║  regularly — do not keep a large balance here.           ║${NC}"
        echo -e "  ${YEL}╚══════════════════════════════════════════════════════════╝${NC}"
        echo
        read -r -p "  Save passphrase for auto-start? [y/N] " save_pass
        [[ "${save_pass,,}" == "y" ]] && save_passphrase "$wallet_pass"
        read -r -p "  Also save encrypted seed backup? [y/N] " save_seed
        [[ "${save_seed,,}" == "y" ]] && save_seed_backup "$wallet_pass"
      fi
      ;;
    2)
      log "Recovering wallet from seed…"
      rm -f "$WALLET_TOML" "${WALLET_DIR}/wallet_data/wallet.seed"
      echo
      echo "  Enter the passphrase that protects this wallet."
      echo "  Leave blank if the wallet has no passphrase."
      echo
      if wallet_pass=$(read_pass_confirmed); then
        (cd "$WALLET_DIR" && ./grin-wallet -p "$wallet_pass" init -hr)
      else
        (cd "$WALLET_DIR" && ./grin-wallet init -hr)
      fi
      echo
      if [[ -n "$wallet_pass" ]]; then
        echo
        echo -e "  ${YEL}╔══════════════════════════════════════════════════════════╗${NC}"
        echo -e "  ${YEL}║  ⚠  SECURITY WARNING — READ BEFORE SAVING               ║${NC}"
        echo -e "  ${YEL}║                                                          ║${NC}"
        echo -e "  ${YEL}║  Saving the passphrase allows auto-start on reboot       ║${NC}"
        echo -e "  ${YEL}║  and remote start via the web interface.                 ║${NC}"
        echo -e "  ${YEL}║                                                          ║${NC}"
        echo -e "  ${YEL}║  ⚠  It will be stored in PLAIN TEXT on this server.     ║${NC}"
        echo -e "  ${YEL}║     Your hosting provider can read it.                  ║${NC}"
        echo -e "  ${YEL}║     Anyone with root access can read it.                ║${NC}"
        echo -e "  ${YEL}║                                                          ║${NC}"
        echo -e "  ${YEL}║  Recommendation: transfer funds to a personal wallet     ║${NC}"
        echo -e "  ${YEL}║  regularly — do not keep a large balance here.           ║${NC}"
        echo -e "  ${YEL}╚══════════════════════════════════════════════════════════╝${NC}"
        echo
        read -r -p "  Save passphrase for auto-start? [y/N] " save_pass
        [[ "${save_pass,,}" == "y" ]] && save_passphrase "$wallet_pass"
      fi
      ;;
    0|*)
      log "Skipping wallet initialization."
      ;;
  esac

  # Write toml now (after init so it isn't overwritten) and apply node choice
  echo
  log "Step 2b/5 — Write grin-wallet.toml"
  create_wallet_toml
  if [[ -n "$chosen_node" ]]; then
    sed -i "s|check_node_api_http_addr = .*|check_node_api_http_addr = \"${chosen_node}\"|" "$WALLET_TOML"
    log "Node set → ${chosen_node}"
  fi

  # Step 4: Fix ownership (grin-wallet writes files as root during init)
  echo
  log "Step 4/5 — Fix Ownership"
  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_DIR"
  chmod 750 "$WALLET_DIR"
  log "Ownership confirmed: ${WALLET_DIR} → ${GRIN_USER}:${GRIN_GROUP}"

  # Step 5: Server .env
  echo
  log "Step 5/5 — Update Server Configuration"
  update_server_env

  echo
  sep
  log "Grin Wallet integration complete!"
  echo
  echo "  Wallet dir : ${WALLET_DIR}/"
  echo "  Binary     : ${WALLET_BIN}"
  echo "  Config     : ${WALLET_TOML}"
  [[ -f "$PASS_FILE" ]] && echo "  Passphrase : ${PASS_FILE}  (plain text)"
  [[ -f "$SEED_FILE" ]] && echo "  Seed backup: ${SEED_FILE}  (AES-256 encrypted)"
  sep
  trap - ERR
  echo
  read -r -p "Press Enter to return to menu…"
}

# ── Option 2: Manage Wallet Listener (tmux) ───────────────────
option_manage_service() {
  sep
  log "=== Option 2: Grin Wallet Listener (tmux) ==="
  sep

  while true; do
    echo
    if wallet_is_running; then
      echo -e "  TOR listener   : ${GRN}RUNNING ✓${NC}  (tmux: ${TMUX_SESSION})"
    else
      echo -e "  TOR listener   : ${RED}STOPPED ✗${NC}  (port 3415 / grin-wallet listen)"
    fi

    if owner_is_running; then
      echo -e "  Owner API      : ${GRN}RUNNING ✓${NC}  (tmux: ${TMUX_SESSION_OWNER})"
    else
      echo -e "  Owner API      : ${RED}STOPPED ✗${NC}  (port 3420 / grin-wallet owner_api)"
    fi

    if [[ -f "$PASS_FILE" ]]; then
      echo -e "  Passphrase     : ${GRN}saved${NC}  (${PASS_FILE})"
    else
      echo -e "  Passphrase     : ${YEL}not saved${NC}  (listeners will fail if wallet has a passphrase)"
    fi

    if reboot_autostart_enabled; then
      echo -e "  Auto-start     : ${GRN}enabled${NC}  (cron @reboot)"
    else
      echo -e "  Auto-start     : ${YEL}disabled${NC}"
    fi

    if watchdog_enabled; then
      echo -e "  Watchdog       : ${GRN}enabled${NC}  (cron every 30 min — port 3415)"
    else
      echo -e "  Watchdog       : ${YEL}disabled${NC}"
    fi

    echo
    echo "  ── TOR listener (donate_grin_tor) ─────────────────────────"
    echo "  1) Start TOR listener"
    echo "  2) Stop TOR listener"
    echo "  3) Restart TOR listener"
    echo "  4) View wallet log (last 60 lines)"
    echo
    echo "  ── Owner API (donate_grin_slatepack) ──────────────────────"
    echo "  5) Start Owner API"
    echo "  6) Stop Owner API"
    echo "  7) Restart Owner API"
    echo
    echo "  ── Settings ───────────────────────────────────────────────"
    echo "  8) Re-save passphrase"
    echo "  9) Enable auto-start on reboot  (cron @reboot)"
    echo " 10) Disable auto-start on reboot"
    echo " 11) Enable watchdog  (cron every 30 min — auto-restart if port 3415 down)"
    echo " 12) Disable watchdog"
    echo " 13) View watchdog log"
    echo "  0) Back"
    echo
    read -r -p "Choice [0-13]: " svc_choice

    case "$svc_choice" in
      1) wallet_start
         echo
         warn "To view output run outside this script:  tmux attach -t ${TMUX_SESSION}"
         ;;
      2) wallet_stop ;;
      3) wallet_stop; sleep 1; wallet_start
         echo
         warn "To view output run outside this script:  tmux attach -t ${TMUX_SESSION}"
         ;;
      4)
        local logfile="${WALLET_DIR}/grin-wallet.log"
        if [[ -f "$logfile" ]]; then
          tail -n 60 "$logfile"
        else
          warn "Log file not found: ${logfile}"
        fi
        ;;
      5) owner_start
         echo
         warn "To view output run outside this script:  tmux attach -t ${TMUX_SESSION_OWNER}"
         ;;
      6) owner_stop ;;
      7) owner_stop; sleep 1; owner_start
         echo
         warn "To view output run outside this script:  tmux attach -t ${TMUX_SESSION_OWNER}"
         ;;
      8)
        rm -f "$PASS_FILE"
        local new_pass
        if new_pass=$(read_pass_confirmed); then
          save_passphrase "$new_pass"
          unset new_pass
        else
          warn "Cancelled."
        fi
        ;;
      9) enable_reboot_autostart ;;
      10) disable_reboot_autostart ;;
      11) enable_watchdog ;;
      12) disable_watchdog ;;
      13)
        local wlog="/opt/office-tools/data/grin-watchdog.log"
        if [[ -f "$wlog" ]]; then
          tail -n 60 "$wlog"
        else
          warn "Watchdog log not found: ${wlog}  (watchdog may not have run yet)"
        fi
        ;;
      0) break ;;
      *) warn "Invalid choice." ;;
    esac
    echo
    read -r -p "Press Enter to continue…"
  done
}

# ── Current status snapshot ────────────────────────────────────
print_status() {
  echo
  echo -e "  ${CYN}Current Status${NC}"
  echo "  ─────────────────────────────────────────"

  if [[ -x "$WALLET_BIN" ]]; then
    local ver; ver=$("$WALLET_BIN" --version 2>&1 | head -1)
    echo -e "  Binary     : ${GRN}installed${NC}  ${ver}"
  else
    echo -e "  Binary     : ${RED}not installed${NC}"
  fi

  local seed_file="${WALLET_DIR}/wallet_data/wallet.seed"
  if [[ -f "$seed_file" ]]; then
    echo -e "  Wallet     : ${GRN}initialized${NC}"
  elif [[ -x "$WALLET_BIN" ]]; then
    echo -e "  Wallet     : ${YEL}not initialized${NC}  (run option 1)"
  else
    echo -e "  Wallet     : ${RED}not initialized${NC}"
  fi

  if [[ -f "$WALLET_TOML" ]]; then
    local node; node=$(grep 'check_node_api_http_addr' "$WALLET_TOML" | cut -d'"' -f2)
    echo -e "  Node       : ${node}"
  fi

  if wallet_is_running; then
    echo -e "  TOR listener : ${GRN}running${NC}  (tmux: ${TMUX_SESSION})"
  else
    echo -e "  TOR listener : ${YEL}stopped${NC}"
  fi

  if owner_is_running; then
    echo -e "  Owner API    : ${GRN}running${NC}  (tmux: ${TMUX_SESSION_OWNER})"
  else
    echo -e "  Owner API    : ${YEL}stopped${NC}"
  fi

  if reboot_autostart_enabled; then
    echo -e "  Auto-start   : ${GRN}enabled${NC}  (cron @reboot)"
  else
    echo -e "  Auto-start   : ${YEL}disabled${NC}"
  fi

  echo "  ─────────────────────────────────────────"
}

# ── Main menu ──────────────────────────────────────────────────
main() {
  echo
  echo "╔══════════════════════════════════════════════╗"
  echo "║  Office Tools — Grin Wallet Manager          ║"
  echo "╚══════════════════════════════════════════════╝"

  while true; do
    print_status
    echo
    echo "  1) Integrate Grin Wallet   (download · init · recover · configure)"
    echo "  2) Manage Wallet Listener  (start · stop · logs · auto-start on reboot)"
    echo "  0) Exit"
    echo
    read -r -p "Choice [0-2]: " choice

    case "$choice" in
      1) option_integrate ;;
      2) option_manage_service ;;
      0) log "Goodbye."; exit 0 ;;
      *) warn "Invalid choice." ;;
    esac
  done
}

main
