#!/usr/bin/env bash
# ============================================================
#  Office Tools — Grin Wallet Setup & Service Manager
#  deploy_grinwallet.sh
#
#  Option 1: Integrate Grin Wallet
#    — Download latest grin-wallet binary (mainnet)
#    — Init new wallet  (grin-wallet init -h)
#    — Recover wallet   (grin-wallet init -hr)
#    — Patch grin-wallet.toml for mainnet
#    — Optionally encrypt & save passphrase/seed via OpenSSL
#    — Update server .env with wallet binary path
#
#  Option 2: Manage Wallet Service
#    — Start / Stop / Restart office-tools-grin-listener
#    — Enable / Disable auto-start on reboot
#
#  Paths
#    Binary:   /opt/office-tools/cmdgrinwallet/grin-wallet
#    Data:     /opt/office-tools/data/wallet/
#    Secrets:  /opt/office-tools/data/.wallet_pass.enc (OpenSSL-encrypted)
#              /opt/office-tools/data/.wallet_seed.enc (OpenSSL-encrypted)
#    Server:   /opt/office-tools/server/.env
# ============================================================
set -uo pipefail

# ── Paths ──────────────────────────────────────────────────────
INSTALL_DIR="/opt/office-tools"
WALLET_BIN_DIR="${INSTALL_DIR}/cmdgrinwallet"
WALLET_DATA_DIR="${INSTALL_DIR}/data/wallet"
WALLET_BIN="${WALLET_BIN_DIR}/grin-wallet"
WALLET_TOML="${WALLET_DATA_DIR}/grin-wallet.toml"
SERVER_ENV="${INSTALL_DIR}/server/.env"
ENCRYPTED_PASS="${INSTALL_DIR}/data/.wallet_pass.enc"
ENCRYPTED_SEED="${INSTALL_DIR}/data/.wallet_seed.enc"
LISTENER_WRAPPER="${WALLET_BIN_DIR}/start-listener.sh"
SERVICE_NAME="office-tools-grin-listener"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
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
  # Create group if missing
  if ! getent group "$GRIN_GROUP" &>/dev/null; then
    groupadd --system "$GRIN_GROUP"
    log "Created system group: ${GRIN_GROUP}"
  else
    log "Group already exists: ${GRIN_GROUP}"
  fi

  # Create system user if missing (no login shell, no home dir in /home)
  if ! id "$GRIN_USER" &>/dev/null; then
    useradd --system \
            --gid "$GRIN_GROUP" \
            --no-create-home \
            --home-dir "$WALLET_DATA_DIR" \
            --shell /usr/sbin/nologin \
            --comment "Grin wallet service account" \
            "$GRIN_USER"
    log "Created system user: ${GRIN_USER} (no login, no home in /home)"
  else
    log "User already exists: ${GRIN_USER}"
  fi

  # Create dirs and set ownership
  mkdir -p "$WALLET_BIN_DIR" "$WALLET_DATA_DIR"
  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_BIN_DIR" "$WALLET_DATA_DIR"
  chmod 750 "$WALLET_BIN_DIR"
  chmod 700 "$WALLET_DATA_DIR"
  log "Ownership set: ${WALLET_BIN_DIR} & ${WALLET_DATA_DIR} → ${GRIN_USER}:${GRIN_GROUP}"
}

# ── Helper: read passphrase (hidden, confirmed) ────────────────
read_pass_confirmed() {
  local pass pass2
  while true; do
    read -r -s -p "Enter wallet passphrase (min 3 chars, or 0 to go back): " pass; echo
    [[ "$pass" == "0" ]] && return 1
    if [[ -z "$pass" || ${#pass} -lt 3 ]]; then
      warn "Passphrase required and must be at least 3 characters. Try again."
      continue
    fi
    read -r -s -p "Confirm passphrase: " pass2; echo
    if [[ "$pass" != "$pass2" ]]; then
      warn "Passphrases don't match, try again."
      continue
    fi
    break
  done
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

# ── Download latest grin-wallet binary ────────────────────────
download_grin_wallet() {
  log "Fetching latest grin-wallet release from GitHub…"
  local api_url="https://api.github.com/repos/mimblewimble/grin-wallet/releases/latest"
  local dl_url
  local api_json
  api_json=$(curl -fsSL "$api_url") || die "Could not reach GitHub API. Check internet connection."
  dl_url=$(printf '%s\n' "$api_json" \
    | grep '"browser_download_url"' \
    | grep 'linux-amd64' \
    | grep -v 'sha256' \
    | head -1 \
    | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/' \
    || true)

  [[ -z "$dl_url" ]] && die "Could not fetch grin-wallet download URL. Check internet connection."

  local filename; filename=$(basename "$dl_url")
  local tmpdir;   tmpdir=$(mktemp -d)

  log "Downloading: $filename"
  curl -fL "$dl_url" -o "${tmpdir}/${filename}"

  log "Extracting to ${WALLET_BIN_DIR}…"
  mkdir -p "$WALLET_BIN_DIR"
  tar -xzf "${tmpdir}/${filename}" -C "$WALLET_BIN_DIR" --strip-components=1
  chmod +x "$WALLET_BIN"
  rm -rf "$tmpdir"

  local version; version=$("$WALLET_BIN" --version 2>&1 | head -1 || echo "unknown")
  log "Installed: $version"
}

# ── Create default mainnet grin-wallet.toml ───────────────────
create_wallet_toml() {
  mkdir -p "$WALLET_DATA_DIR"
  if [[ -f "$WALLET_TOML" ]]; then
    log "grin-wallet.toml already exists — skipping creation."
    return
  fi
  cat > "$WALLET_TOML" <<EOF
[wallet]
chain_type = "Mainnet"
api_listen_interface = "127.0.0.1"
api_listen_port = 3415
owner_api_listen_port = 3420
api_secret_path = "${WALLET_DATA_DIR}/.api_secret"
owner_api_secret_path = "${WALLET_DATA_DIR}/.owner_api_secret"
check_node_api_http_addr = "http://127.0.0.1:3413"
owner_api_include_foreign = false
data_file_dir = "${WALLET_DATA_DIR}/"
no_commit_cache = false
dark_background_color_scheme = true
keybase_notify_ttl = 1440

[logging]
log_to_stdout = false
stdout_log_level = "Info"
log_to_file = true
file_log_level = "Debug"
log_file_path = "${WALLET_DATA_DIR}/grin-wallet.log"
log_max_size = 16777216
log_max_files = 3
EOF
  log "Created ${WALLET_TOML} (mainnet, node: 127.0.0.1:3413)"
}

# ── Check if a URL is reachable (HTTP 2xx/3xx) ────────────────
check_server_online() {
  local url="$1"
  local http_code
  http_code=$(curl -o /dev/null -s -w "%{http_code}" --max-time 5 "${url}/v2/foreign" 2>/dev/null || echo "000")
  # Accept 2xx, 3xx, and 405 (Method Not Allowed = endpoint exists but GET not allowed)
  if [[ "$http_code" =~ ^(2|3)[0-9]{2}$ ]] || [[ "$http_code" == "405" ]] || [[ "$http_code" == "404" ]]; then
    echo "online"
  else
    echo "offline"
  fi
}

# ── Patch check_node URL in toml ──────────────────────────────
patch_check_node() {
  echo
  local current_node
  current_node=$(grep 'check_node_api_http_addr' "$WALLET_TOML" | cut -d'"' -f2)
  log "Current node: ${current_node}"
  echo

  # ── External servers (live status check) ────────────────────
  local ext_servers=(
    "https://api.grin.money"
    "https://api.grinily.com"
    "https://api.grinnode.org"
  )

  echo "  Checking external node availability…"
  echo

  local ext_statuses=()
  for url in "${ext_servers[@]}"; do
    ext_statuses+=("$(check_server_online "$url")")
  done

  # ── Menu ────────────────────────────────────────────────────
  echo "  Select Grin node for grin-wallet.toml:"
  echo

  local i
  for i in "${!ext_servers[@]}"; do
    local host; host=$(echo "${ext_servers[$i]}" | sed 's|https\?://||')
    local flag
    if [[ "${ext_statuses[$i]}" == "online" ]]; then
      flag="${GRN}● online${NC}"
    else
      flag="${RED}○ offline${NC}"
    fi
    printf "  %d) %-36s %b\n" "$((i+1))" "$host" "$flag"
  done

  printf "  4) %-36s %b\n" "Local node  127.0.0.1:3413" "${YEL}(install later)${NC}"
  echo "  0) Back"
  echo

  local choice
  read -r -p "Choice [0-4]: " choice

  case "$choice" in
    1|2|3)
      local selected_url="${ext_servers[$((choice-1))]}"
      local selected_status="${ext_statuses[$((choice-1))]}"
      if [[ "$selected_status" == "offline" ]]; then
        warn "That server appears offline. Use it anyway? [y/N]"
        read -r -p "" yn
        [[ "${yn,,}" != "y" ]] && { log "No changes made."; return; }
      fi
      sed -i "s|check_node_api_http_addr = .*|check_node_api_http_addr = \"${selected_url}\"|" "$WALLET_TOML"
      log "Updated check_node_api_http_addr → ${selected_url}"
      ;;
    4)
      sed -i "s|check_node_api_http_addr = .*|check_node_api_http_addr = \"http://127.0.0.1:3413\"|" "$WALLET_TOML"
      log "Updated check_node_api_http_addr → http://127.0.0.1:3413"
      warn "Remember to install a local Grin node before starting the wallet listener."
      ;;
    0|*)
      log "No changes made."
      ;;
  esac
}

# ── Encrypt passphrase to disk (OpenSSL AES-256-CBC) ──────────
encrypt_passphrase() {
  local pass="$1"
  [[ -z "$pass" ]] && { warn "No passphrase to encrypt."; return; }
  log "Encrypting passphrase with OpenSSL AES-256-CBC + PBKDF2 (100,000 iterations)…"
  printf '%s' "$pass" | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -out "$ENCRYPTED_PASS"
  chmod 600 "$ENCRYPTED_PASS"
  log "Saved: ${ENCRYPTED_PASS}"
  log "To decrypt: openssl enc -d -aes-256-cbc -pbkdf2 -in ${ENCRYPTED_PASS}"
}

# ── Encrypt seed phrase to disk (OpenSSL AES-256-CBC) ─────────
encrypt_seed() {
  local wallet_pass="$1"
  log "Retrieving wallet seed phrase…"
  # Run recover in a subshell; capture stdout
  local seed_output
  if [[ -n "$wallet_pass" ]]; then
    seed_output=$("$WALLET_BIN" -r "$WALLET_DATA_DIR" -p "$wallet_pass" recover 2>&1) || true
  else
    seed_output=$("$WALLET_BIN" -r "$WALLET_DATA_DIR" recover 2>&1) || true
  fi

  echo
  warn "The seed phrase will be printed briefly. Make sure you are alone."
  read -r -s -p "Press Enter to view seed, then we will encrypt it immediately…"
  echo
  echo "─── SEED PHRASE ───────────────────────────────"
  echo "$seed_output"
  echo "───────────────────────────────────────────────"
  echo
  warn "Write it down on paper NOW if you haven't already."
  read -r -p "Enter a password to encrypt this seed backup: " -s seed_enc_pass; echo
  read -r -p "Confirm seed backup password: " -s seed_enc_pass2; echo
  if [[ "$seed_enc_pass" != "$seed_enc_pass2" ]]; then
    warn "Passwords don't match. Seed will NOT be saved."; return
  fi

  printf '%s\n' "$seed_output" | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 \
    -pass "pass:${seed_enc_pass}" -out "$ENCRYPTED_SEED"
  chmod 600 "$ENCRYPTED_SEED"
  unset seed_enc_pass seed_enc_pass2
  log "Encrypted seed saved: ${ENCRYPTED_SEED}"
  log "To decrypt: openssl enc -d -aes-256-cbc -pbkdf2 -in ${ENCRYPTED_SEED}"
}

# ── Update server .env with wallet binary path ────────────────
update_server_env() {
  if [[ ! -f "$SERVER_ENV" ]]; then
    warn "${SERVER_ENV} not found — skipping .env update."
    warn "Manually set: GRIN_WALLET_BIN=${WALLET_BIN}"
    return
  fi
  upsert_env "GRIN_WALLET_BIN"      "$WALLET_BIN"                           "$SERVER_ENV"
  upsert_env "GRIN_WALLET_FALLBACK" "${WALLET_BIN_DIR}/grin-wallet"         "$SERVER_ENV"
  # Remove plaintext passphrase if it was set — user should use prompt or keyring
  if grep -q "^GRIN_WALLET_PASS=" "$SERVER_ENV" 2>/dev/null; then
    sed -i "s|^GRIN_WALLET_PASS=.*|# GRIN_WALLET_PASS= (use startup prompt or GRIN_WALLET_PASS_KEYRING=1)|" "$SERVER_ENV"
    warn "Cleared GRIN_WALLET_PASS from .env — use interactive prompt or OS keyring."
  fi
  log "Updated ${SERVER_ENV}"
}

# ── Install systemd listener service ──────────────────────────
install_listener_service() {
  [[ ! -x "$WALLET_BIN" ]] && die "grin-wallet binary not found. Run option 1 first."

  log "Creating wrapper script: ${LISTENER_WRAPPER}"
  if [[ -f "$ENCRYPTED_PASS" ]]; then
    cat > "$LISTENER_WRAPPER" <<EOF
#!/usr/bin/env bash
# Decrypts the OpenSSL-encrypted passphrase at runtime — never stored in plaintext.
# Run: openssl enc -d -aes-256-cbc -pbkdf2 -in ${ENCRYPTED_PASS}  to view manually.
PASS=\$(openssl enc -d -aes-256-cbc -pbkdf2 -in "${ENCRYPTED_PASS}" 2>/dev/null || echo "")
exec "${WALLET_BIN}" -r "${WALLET_DATA_DIR}" \${PASS:+-p "\$PASS"} listen
EOF
  else
    cat > "$LISTENER_WRAPPER" <<EOF
#!/usr/bin/env bash
exec "${WALLET_BIN}" -r "${WALLET_DATA_DIR}" listen
EOF
  fi
  chmod 700 "$LISTENER_WRAPPER"

  log "Creating service: ${SERVICE_FILE}"
  cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Office Tools — Grin Wallet TOR Listener
Documentation=https://docs.grin.mw
After=network.target

[Service]
Type=simple
User=${GRIN_USER}
Group=${GRIN_GROUP}
ExecStart=${LISTENER_WRAPPER}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
# Restrict filesystem access
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  log "Service installed: ${SERVICE_NAME}"
  echo
  read -r -p "Enable auto-start on reboot? [Y/n] " yn
  [[ "${yn,,}" != "n" ]] && systemctl enable "$SERVICE_NAME" && log "Auto-start enabled."
}

# ── Option 1: Integrate Grin Wallet ───────────────────────────
option_integrate() {
  sep
  log "=== Option 1: Integrate Grin Wallet ==="
  sep

  # ── Step 0: System user ─────────────────────────────────────
  echo
  log "Step 0/4 — System User (grin:grin)"
  setup_grin_user

  # ── Step 1: Binary ──────────────────────────────────────────
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

  # ── Step 2: Config ──────────────────────────────────────────
  echo
  log "Step 2/5 — Wallet Configuration (grin-wallet.toml)"
  create_wallet_toml
  patch_check_node

  # ── Step 3: Init or Recover ─────────────────────────────────
  echo
  log "Step 3/5 — Wallet Initialization"
  echo
  echo "  1) Create NEW wallet    [grin-wallet init -h]"
  echo "     Generates a fresh seed phrase. Back it up securely!"
  echo
  echo "  2) RECOVER wallet       [grin-wallet init -hr]"
  echo "     Restores a wallet from an existing 24-word seed phrase."
  echo
  echo "  0) Skip (wallet already initialized)"
  echo
  read -r -p "Choice [0-2]: " wallet_choice

  local wallet_pass=""
  case "$wallet_choice" in
    1)
      log "Creating new wallet…"
      log "You will be prompted for a passphrase (press Enter to use none)."
      echo
      "$WALLET_BIN" -r "$WALLET_DATA_DIR" init -h
      echo
      warn "IMPORTANT: Write down the seed phrase shown above on paper. It cannot be recovered."
      echo
      read -r -p "Save OpenSSL-encrypted passphrase to disk? [y/N] " save_pass
      if [[ "${save_pass,,}" == "y" ]]; then
        if wallet_pass=$(read_pass_confirmed); then
          encrypt_passphrase "$wallet_pass"
          echo
          read -r -p "Also save OpenSSL-encrypted seed backup? [y/N] " save_seed
          [[ "${save_seed,,}" == "y" ]] && encrypt_seed "$wallet_pass"
        else
          warn "Passphrase entry cancelled — skipping encrypt."
        fi
      fi
      ;;
    2)
      log "Recovering wallet from seed…"
      log "You will be prompted for your 24-word seed phrase and a new passphrase."
      echo
      "$WALLET_BIN" -r "$WALLET_DATA_DIR" init -hr
      echo
      read -r -p "Save OpenSSL-encrypted passphrase to disk? [y/N] " save_pass
      if [[ "${save_pass,,}" == "y" ]]; then
        if wallet_pass=$(read_pass_confirmed); then
          encrypt_passphrase "$wallet_pass"
        else
          warn "Passphrase entry cancelled — skipping encrypt."
        fi
      fi
      ;;
    0|*)
      log "Skipping wallet initialization."
      ;;
  esac

  # ── Step 4: Re-apply ownership after wallet init ────────────
  echo
  log "Step 4/5 — Fix Ownership After Wallet Init"
  chown -R "${GRIN_USER}:${GRIN_GROUP}" "$WALLET_DATA_DIR"
  chmod 700 "$WALLET_DATA_DIR"
  # Encrypted pass: root owns it, grin group can read (needed by service wrapper)
  [[ -f "$ENCRYPTED_PASS" ]] && chown "root:${GRIN_GROUP}" "$ENCRYPTED_PASS" && chmod 640 "$ENCRYPTED_PASS"
  # Encrypted seed: root-only, no need for the service to read it
  [[ -f "$ENCRYPTED_SEED" ]] && chown root:root "$ENCRYPTED_SEED" && chmod 600 "$ENCRYPTED_SEED"
  log "Ownership confirmed: ${WALLET_DATA_DIR} → ${GRIN_USER}:${GRIN_GROUP}"

  # ── Step 5: Server .env ─────────────────────────────────────
  echo
  log "Step 5/5 — Update Server Configuration"
  update_server_env

  echo
  sep
  log "Grin Wallet integration complete!"
  echo
  echo "  Binary:        ${WALLET_BIN}"
  echo "  Wallet data:   ${WALLET_DATA_DIR}/"
  [[ -f "$ENCRYPTED_PASS" ]] && echo "  Enc passphrase: ${ENCRYPTED_PASS}"
  [[ -f "$ENCRYPTED_SEED" ]] && echo "  Enc seed:       ${ENCRYPTED_SEED}"
  echo
  log "Passphrase note: The server reads the passphrase via interactive prompt at startup."
  log "  For auto-restart without prompt: set GRIN_WALLET_PASS_KEYRING=1 in .env"
  log "  and store once: secret-tool store --label='Grin wallet' service grin-wallet account mainnet"
  sep
}

# ── Option 2: Manage Wallet Listener Service ──────────────────
option_manage_service() {
  sep
  log "=== Option 2: Grin Wallet Listener Service ==="
  log "Service: ${SERVICE_NAME}  (enables TOR direct-send on donate page)"
  sep

  while true; do
    echo
    # Status
    local running enabled
    systemctl is-active  --quiet "$SERVICE_NAME" 2>/dev/null && running="RUNNING ✓" || running="STOPPED ✗"
    systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null && enabled="ENABLED"   || enabled="DISABLED"
    echo "  Status:     ${running}"
    echo "  Auto-start: ${enabled}"
    echo
    echo "  1) Start"
    echo "  2) Stop"
    echo "  3) Restart"
    echo "  4) Enable auto-start on reboot"
    echo "  5) Disable auto-start on reboot"
    echo "  6) Install / reinstall service unit"
    echo "  7) View logs (last 60 lines)"
    echo "  0) Back"
    echo
    read -r -p "Choice [0-7]: " svc_choice

    case "$svc_choice" in
      1) systemctl start   "$SERVICE_NAME" && log "Started." ;;
      2) systemctl stop    "$SERVICE_NAME" && log "Stopped." ;;
      3) systemctl restart "$SERVICE_NAME" && log "Restarted." ;;
      4) systemctl enable  "$SERVICE_NAME" && log "Auto-start enabled (starts on next reboot)." ;;
      5) systemctl disable "$SERVICE_NAME" && log "Auto-start disabled." ;;
      6) install_listener_service ;;
      7) journalctl -u "$SERVICE_NAME" -n 60 --no-pager ;;
      0) break ;;
      *) warn "Invalid choice." ;;
    esac
  done
}

# ── Current status snapshot ────────────────────────────────────
print_status() {
  echo
  echo -e "  ${CYN}Current Status${NC}"
  echo "  ─────────────────────────────────────────"

  # Binary
  if [[ -x "$WALLET_BIN" ]]; then
    local ver; ver=$("$WALLET_BIN" --version 2>&1 | head -1)
    echo -e "  Binary      : ${GRN}installed${NC}  ${ver}"
  else
    echo -e "  Binary      : ${RED}not installed${NC}"
  fi

  # Wallet initialised (wallet.seed written by grin-wallet init)
  if [[ -f "${WALLET_DATA_DIR}/wallet.seed" ]]; then
    echo -e "  Wallet      : ${GRN}initialized${NC}"
  elif [[ -x "$WALLET_BIN" ]]; then
    echo -e "  Wallet      : ${YEL}not initialized${NC}  (run option 1)"
  else
    echo -e "  Wallet      : ${RED}not initialized${NC}"
  fi

  # Node configured in toml
  if [[ -f "$WALLET_TOML" ]]; then
    local node; node=$(grep 'check_node_api_http_addr' "$WALLET_TOML" | cut -d'"' -f2)
    echo -e "  Node        : ${node}"
  fi

  # Systemd service
  if systemctl list-unit-files "${SERVICE_NAME}.service" 2>/dev/null | grep -q "$SERVICE_NAME"; then
    if systemctl is-active --quiet "$SERVICE_NAME" 2>/dev/null; then
      echo -e "  Listener    : ${GRN}running${NC}"
    else
      echo -e "  Listener    : ${YEL}stopped${NC}"
    fi
    if systemctl is-enabled --quiet "$SERVICE_NAME" 2>/dev/null; then
      echo -e "  Auto-start  : enabled"
    else
      echo -e "  Auto-start  : disabled"
    fi
  else
    echo -e "  Listener    : ${RED}service not installed${NC}"
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
    echo "  2) Manage Wallet Service   (start · stop · restart · schedule)"
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
