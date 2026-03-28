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
#    — Optionally encrypt & save passphrase/seed via OpenSSL
#    — Update server .env with wallet binary path
#
#  Option 2: Manage Wallet Listener (tmux)
#    — Start / Stop / Restart grin-wallet listen in tmux session
#    — Attach to session to watch live output
#
#  All wallet files live in one directory (grin-wallet uses CWD):
#    /opt/office-tools/cmdgrinwallet/
#      grin-wallet          binary
#      grin-wallet.toml     config
#      wallet.seed          created by init
#      grin-wallet.log      runtime log
#
#  Secrets (root-only):
#    /opt/office-tools/data/.temp
#    /opt/office-tools/data/.wallet_seed.enc
# ============================================================
set -uo pipefail

# ── Paths ──────────────────────────────────────────────────────
WALLET_DIR="/opt/office-tools/cmdgrinwallet"
WALLET_BIN="${WALLET_DIR}/grin-wallet"
WALLET_TOML="${WALLET_DIR}/grin-wallet.toml"
SERVER_ENV="/opt/office-tools/server/.env"
ENCRYPTED_PASS="/opt/office-tools/data/.temp"
ENCRYPTED_SEED="/opt/office-tools/data/.wallet_seed.enc"
TMUX_SESSION="donate_grin_wallet"
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

# ── Helper: read passphrase (hidden, confirmed, min 3 chars) ───
read_pass_confirmed() {
  local pass
  read -r -s -p "Passphrase (Enter for none, 0 to cancel): " pass; echo
  [[ "$pass" == "0" ]] && return 1
  echo "$pass"
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
log_to_stdout = false
stdout_log_level = "Info"
log_to_file = true
file_log_level = "Debug"
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

# ── Select Grin node — returns URL via stdout, empty = local default ──
# Used during option 1 (before init) to pick a node without writing toml yet.
# After init, the caller applies the returned URL to the freshly written toml.
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
    local_flag="${YEL}○ install later${NC}"
  fi
  printf "  4) %-36s %b\n" "Local node  127.0.0.1:3413" "$local_flag" >&2
  echo "  0) Keep default (127.0.0.1:3413)" >&2
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
          warn "No change — will use default 127.0.0.1:3413." >&2
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

# ── Patch check_node_api_http_addr in existing toml (standalone use) ──
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

# ── Machine-specific key (no interactive prompt needed) ────────
# Derived from /etc/machine-id — ties the encrypted file to this server.
machine_key() {
  local mid
  mid=$(cat /etc/machine-id 2>/dev/null || hostname)
  printf '%s' "grin-wallet-${mid}" | sha256sum | cut -d' ' -f1
}

# ── Encrypt passphrase to disk (OpenSSL AES-256-CBC) ──────────
encrypt_passphrase() {
  local pass="$1"
  [[ -z "$pass" ]] && { warn "No passphrase to encrypt."; return; }
  mkdir -p "$(dirname "$ENCRYPTED_PASS")"
  log "Saving passphrase (plain text, root-only)…"
  printf '%s' "$pass" > "$ENCRYPTED_PASS"
  chown "root:${GRIN_GROUP}" "$ENCRYPTED_PASS"
  chmod 640 "$ENCRYPTED_PASS"
  log "Saved: ${ENCRYPTED_PASS}"
}

# ── Encrypt seed phrase to disk (OpenSSL AES-256-CBC) ─────────
encrypt_seed() {
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

  mkdir -p "$(dirname "$ENCRYPTED_SEED")"
  printf '%s\n' "$seed_output" | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass "pass:${seed_enc_pass}" -out "$ENCRYPTED_SEED"
  chown root:root "$ENCRYPTED_SEED"
  chmod 600 "$ENCRYPTED_SEED"
  unset seed_enc_pass seed_enc_pass2
  log "Encrypted seed saved: ${ENCRYPTED_SEED}"
}

# ── Update server .env with wallet binary path ────────────────
update_server_env() {
  if [[ ! -f "$SERVER_ENV" ]]; then
    log "${SERVER_ENV} not found — skipping .env update (deploy Office Tools server to enable)."
    return
  fi
  upsert_env "GRIN_WALLET_BIN" "$WALLET_BIN" "$SERVER_ENV"
  if grep -q "^GRIN_WALLET_PASS=" "$SERVER_ENV" 2>/dev/null; then
    sed -i "s|^GRIN_WALLET_PASS=.*|# GRIN_WALLET_PASS= (use startup prompt or GRIN_WALLET_PASS_KEYRING=1)|" "$SERVER_ENV"
    warn "Cleared GRIN_WALLET_PASS from .env — use interactive prompt or OS keyring."
  fi
  log "Updated ${SERVER_ENV}"
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

  # Kill any orphaned grin-wallet process not in tmux (e.g. from a previous failed start)
  if pgrep -f "grin-wallet.*listen" &>/dev/null; then
    warn "Killing orphaned grin-wallet process before starting..."
    pkill -f "grin-wallet.*listen" 2>/dev/null || true
    sleep 1
  fi

  # Build a wrapper script that the grin user executes inside tmux.
  # The passphrase is written to a root-only temp file, read once by the
  # wrapper, then immediately deleted — never appears in ps or shell args.
  local wrapper; wrapper=$(mktemp /tmp/grin-listen-XXXXXX.sh)
  chmod 700 "$wrapper"

  if [[ -f "$ENCRYPTED_PASS" ]]; then
    local pass
    pass=$(cat "$ENCRYPTED_PASS" 2>/dev/null || true)
    if [[ -n "$pass" ]]; then
      # Write passphrase as a literal into wrapper; wrapper deletes itself then execs
      local quoted_pass; quoted_pass=$(printf '%q' "$pass")
      cat > "$wrapper" <<WRAPPER
#!/bin/bash
PASS=${quoted_pass}
rm -f "${wrapper}"
cd "${WALLET_DIR}"
./grin-wallet -p "\$PASS" listen
echo ""
echo "=== grin-wallet exited (see error above) ==="
read -r -p "Press Enter to close..."
WRAPPER
      unset pass quoted_pass
    else
      warn "Could not decrypt passphrase — starting without it."
      cat > "$wrapper" <<WRAPPER
#!/bin/bash
rm -f "$wrapper"
cd "${WALLET_DIR}"
./grin-wallet listen
echo ""
echo "=== grin-wallet exited (see error above) ==="
read -r -p "Press Enter to close..."
WRAPPER
    fi
  else
    warn "No saved passphrase found — if the wallet has a passphrase, listener will fail."
    warn "Re-run option 1 and save the passphrase so the web service can auto-start it."
    cat > "$wrapper" <<WRAPPER
#!/bin/bash
rm -f "$wrapper"
cd "${WALLET_DIR}"
./grin-wallet listen
echo ""
echo "=== grin-wallet exited (see error above) ==="
read -r -p "Press Enter to close..."
WRAPPER
  fi

  # Ensure grin user owns all wallet files (init may have created them as root)
  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_DIR"
  chmod 750 "$WALLET_DIR"

  chown "${GRIN_USER}:${GRIN_GROUP}" "$wrapper"
  tmux new-session -d -s "$TMUX_SESSION" -x 220 -y 50 \
    "su -s /bin/bash ${GRIN_USER} -c 'bash ${wrapper}'"
  sleep 1
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    log "Wallet listener started in tmux session: ${TMUX_SESSION}"
    log "Attach with: tmux attach -t ${TMUX_SESSION}"
  else
    err "tmux session exited immediately — attach to check: tmux attach -t ${TMUX_SESSION}"
  fi
}

wallet_stop() {
  if wallet_is_running; then
    tmux kill-session -t "$TMUX_SESSION"
    log "Wallet listener stopped."
  else
    warn "Wallet listener is not running."
  fi
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

  # Step 2: Select node (save choice — toml is written AFTER init so grin-wallet init doesn't complain)
  echo
  log "Step 2/5 — Select Grin Node"
  # Ask node selection and remember the URL; toml is not written yet
  local chosen_node=""
  chosen_node=$(select_node_url)   # returns the URL or empty for local default

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
      warn "Enter a passphrase to protect your wallet (you will type it ONCE — it is saved automatically)."
      warn "Leave blank and press Enter for no passphrase."
      echo
      if wallet_pass=$(read_pass_confirmed); then
        (cd "$WALLET_DIR" && ./grin-wallet -p "$wallet_pass" init -h)
      else
        # No passphrase — run without -p
        (cd "$WALLET_DIR" && ./grin-wallet init -h)
      fi
      echo
      warn "IMPORTANT: Write down the seed phrase shown above on paper."
      echo
      if [[ -n "$wallet_pass" ]]; then
        encrypt_passphrase "$wallet_pass"
        read -r -p "Also save seed backup? [y/N] " save_seed
        [[ "${save_seed,,}" == "y" ]] && encrypt_seed "$wallet_pass"
      fi
      ;;
    2)
      log "Recovering wallet from seed…"
      rm -f "$WALLET_TOML" "${WALLET_DIR}/wallet_data/wallet.seed"
      echo
      warn "Enter the passphrase that protects this wallet (you will type it ONCE — it is saved automatically)."
      warn "Leave blank and press Enter if the wallet has no passphrase."
      echo
      if wallet_pass=$(read_pass_confirmed); then
        (cd "$WALLET_DIR" && ./grin-wallet -p "$wallet_pass" init -hr)
      else
        (cd "$WALLET_DIR" && ./grin-wallet init -hr)
      fi
      echo
      if [[ -n "$wallet_pass" ]]; then
        encrypt_passphrase "$wallet_pass"
      fi
      ;;
    0|*)
      log "Skipping wallet initialization."
      ;;
  esac

  # Write our toml now (after init) and apply the node choice from step 2
  echo
  log "Step 2b/5 — Write grin-wallet.toml (replacing init-generated config)"
  create_wallet_toml
  if [[ -n "$chosen_node" ]]; then
    sed -i "s|check_node_api_http_addr = .*|check_node_api_http_addr = \"${chosen_node}\"|" "$WALLET_TOML"
    log "Node set → ${chosen_node}"
  fi

  # Step 4: Fix ownership after init (grin-wallet writes files as root during init)
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
  [[ -f "$ENCRYPTED_PASS" ]] && echo "  Enc pass   : ${ENCRYPTED_PASS}"
  [[ -f "$ENCRYPTED_SEED" ]] && echo "  Enc seed   : ${ENCRYPTED_SEED}"
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
      echo -e "  Status : ${GRN}RUNNING ✓${NC}  (tmux: ${TMUX_SESSION})"
    else
      echo -e "  Status : ${RED}STOPPED ✗${NC}"
    fi
    echo
    if [[ -f "$ENCRYPTED_PASS" ]]; then
      echo -e "  Passphrase : ${GRN}saved${NC}  (${ENCRYPTED_PASS})"
    else
      echo -e "  Passphrase : ${YEL}not saved${NC}  (wallet will fail to auto-start if it has a passphrase)"
    fi
    echo
    echo "  1) Start listener"
    echo "  2) Stop listener"
    echo "  3) Restart listener"
    echo "  4) Attach to tmux session  (Ctrl-b d to detach)"
    echo "  5) View wallet log (last 60 lines)"
    echo "  6) Re-save passphrase"
    echo "  0) Back"
    echo
    read -r -p "Choice [0-6]: " svc_choice

    case "$svc_choice" in
      1)
        wallet_start
        ;;
      2)
        wallet_stop
        ;;
      3)
        wallet_stop
        sleep 1
        wallet_start
        ;;
      4)
        if wallet_is_running; then
          log "Attaching to tmux session '${TMUX_SESSION}' — press Ctrl-b d to detach."
          tmux attach -t "$TMUX_SESSION"
        else
          warn "Wallet listener is not running. Start it first (option 1)."
        fi
        ;;
      5)
        local logfile="${WALLET_DIR}/grin-wallet.log"
        if [[ -f "$logfile" ]]; then
          tail -n 60 "$logfile"
        else
          warn "Log file not found: ${logfile}"
        fi
        ;;
      6)
        rm -f "$ENCRYPTED_PASS"
        local new_pass
        if new_pass=$(read_pass_confirmed); then
          encrypt_passphrase "$new_pass"
          unset new_pass
        else
          warn "Cancelled."
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
    echo -e "  Binary      : ${GRN}installed${NC}  ${ver}"
  else
    echo -e "  Binary      : ${RED}not installed${NC}"
  fi

  # wallet.seed lives in wallet_data/ subdir (grin-wallet default)
  local seed_file="${WALLET_DIR}/wallet_data/wallet.seed"
  if [[ -f "$seed_file" ]]; then
    echo -e "  Wallet      : ${GRN}initialized${NC}"
  elif [[ -x "$WALLET_BIN" ]]; then
    echo -e "  Wallet      : ${YEL}not initialized${NC}  (run option 1)"
  else
    echo -e "  Wallet      : ${RED}not initialized${NC}"
  fi

  if [[ -f "$WALLET_TOML" ]]; then
    local node; node=$(grep 'check_node_api_http_addr' "$WALLET_TOML" | cut -d'"' -f2)
    echo -e "  Node        : ${node}"
  fi

  if wallet_is_running; then
    echo -e "  Listener    : ${GRN}running${NC}  (tmux: ${TMUX_SESSION})"
  else
    echo -e "  Listener    : ${YEL}stopped${NC}"
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
    echo "  2) Manage Wallet Service   (start · stop · restart · logs)"
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
