# =============================================================================
# Office Tools — OS detection, timezone, package management
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── OS detection ─────────────────────────────────────────────────────────────
OS_FAMILY=""   # "debian" or "rhel"
OS_NAME="unknown"

detect_os() {
    if [[ ! -f /etc/os-release ]]; then
        die "Cannot detect OS (/etc/os-release not found)."
    fi
    # shellcheck source=/dev/null
    source /etc/os-release
    OS_NAME="${PRETTY_NAME:-${NAME:-unknown}}"

    case "${ID:-}" in
        ubuntu|debian|linuxmint|pop)
            OS_FAMILY="debian" ;;
        almalinux|rocky|centos|rhel|fedora|ol)
            OS_FAMILY="rhel" ;;
        *)
            case "${ID_LIKE:-}" in
                *debian*) OS_FAMILY="debian" ;;
                *rhel*|*centos*|*fedora*) OS_FAMILY="rhel" ;;
                *) die "Unsupported OS: ${OS_NAME}. Use Debian/Ubuntu or AlmaLinux/Rocky Linux." ;;
            esac ;;
    esac

    if [[ "$OS_FAMILY" == "debian" ]]; then
        NGINX_CONF_PATH="/etc/nginx/sites-available/office-tools"
        NGINX_ENABLED_PATH="/etc/nginx/sites-enabled/office-tools"
    else
        NGINX_CONF_PATH="/etc/nginx/conf.d/office-tools.conf"
        NGINX_ENABLED_PATH=""
    fi
}


# ─── System timezone ──────────────────────────────────────────────────────────
# Forces the server to UTC so logs and service timestamps are all consistent.
# Browser-based tools are unaffected by server timezone —
# they already use UTC JS methods internally.
enforce_utc_timezone() {
    section "Enforcing UTC system timezone"
    local current
    current=$(timedatectl show --property=Timezone --value 2>/dev/null \
              || cat /etc/timezone 2>/dev/null \
              || readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' \
              || echo "unknown")

    if [[ "$current" == "UTC" ]]; then
        info "System timezone is already UTC — nothing to change."
        return 0
    fi

    warn "Current timezone: '${current}' — changing to UTC"
    if command -v timedatectl &>/dev/null; then
        timedatectl set-timezone UTC
    elif [[ -f /usr/share/zoneinfo/UTC ]]; then
        ln -sf /usr/share/zoneinfo/UTC /etc/localtime
        echo "UTC" > /etc/timezone
    else
        warn "Cannot set timezone automatically — set it manually: timedatectl set-timezone UTC"
        return 0
    fi

    success "Timezone set to UTC (was: ${current})"
    info "All server processes and logs will now use UTC timestamps."
}

# ─── Package management ────────────────────────────────────────────────────────
pkg_update_os() {
    section "Updating OS packages — ${OS_NAME}"
    if [[ "$OS_FAMILY" == "debian" ]]; then
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
    else
        dnf upgrade -y --nobest 2>/dev/null || dnf upgrade -y
    fi
    success "OS packages updated"
}

pkg_install() {
    if [[ "$OS_FAMILY" == "debian" ]]; then
        apt-get install -y --no-install-recommends "$@"
    else
        dnf install -y "$@"
    fi
}

install_base_packages() {
    section "Installing base packages"
    if [[ "$OS_FAMILY" == "debian" ]]; then
        apt-get update -qq
        pkg_install nginx certbot python3-certbot-nginx \
            git curl unzip rsync ca-certificates gnupg python3-pip \
            iputils-ping traceroute
        # postfix — provides sendmail for feedback email notifications
        if ! command -v sendmail &>/dev/null; then
            echo "postfix postfix/mailname string $(hostname -f)"    | debconf-set-selections
            echo "postfix postfix/main_mailer_type string 'Internet Site'" | debconf-set-selections
            DEBIAN_FRONTEND=noninteractive pkg_install postfix
            systemctl enable postfix
            systemctl start  postfix
            success "postfix installed (sendmail provider)"
        else
            info "sendmail already available — skipping postfix install"
        fi
    else
        # EPEL provides certbot on RHEL-family
        dnf install -y epel-release
        dnf install -y nginx certbot python3-certbot-nginx \
            git curl unzip rsync ca-certificates python3-pip \
            iputils traceroute postfix
        systemctl enable postfix
        systemctl start  postfix
        # Allow nginx to proxy to localhost (SELinux)
        setsebool -P httpd_can_network_connect 1 2>/dev/null || \
            warn "SELinux: could not set httpd_can_network_connect — set manually if proxying fails"
    fi

    # Open firewall ports if firewalld is active
    if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld 2>/dev/null; then
        firewall-cmd --permanent --add-service=http --add-service=https &>/dev/null
        firewall-cmd --reload &>/dev/null
        success "Firewall: HTTP and HTTPS opened"
    fi

    systemctl enable nginx
    systemctl start  nginx
    success "Base packages installed — nginx $(nginx -v 2>&1 | grep -oP '[\d.]+')"
}

install_nodejs() {
    # Node 26+ by choice. The hard requirement is only 24+ (the backend uses the
    # built-in node:sqlite module, unflagged from Node 24), but Office Tools is a
    # single-user deploy so we run the newer line for a more mature node:sqlite.
    # MIN = accept-as-is floor, VER = version installed when Node is missing/too old.
    # Note: 26 >= 24, so a box also running the mining pool (needs >=24) stays happy.
    local MIN=26 VER=26
    if command -v node &>/dev/null; then
        local cur
        cur=$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])' 2>/dev/null || echo 0)
        if [[ "$cur" -ge "$MIN" ]]; then
            info "Node.js $(node -v) already installed — skipping"
            return 0
        fi
        info "Node.js $cur < $MIN — upgrading to $VER…"
    fi

    local setup_url
    if [[ "$OS_FAMILY" == "debian" ]]; then
        setup_url="https://deb.nodesource.com/setup_${VER}.x"
    else
        setup_url="https://rpm.nodesource.com/setup_${VER}.x"
    fi

    curl -fsSL "$setup_url" | bash - || die "NodeSource setup failed"

    if [[ "$OS_FAMILY" == "debian" ]]; then
        apt-get install -y nodejs
    else
        dnf install -y nodejs
    fi
    success "Node.js $(node -v) installed"
}


