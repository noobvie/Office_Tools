# =============================================================================
# Office Tools — systemd sandboxing drop-ins for the three services
# Sourced by deploy.sh — not executable on its own.
# shellcheck shell=bash
# =============================================================================

# ─── Hardening drop-ins ───────────────────────────────────────────────────────
# /etc/systemd/system/<unit>.service.d/10-hardening.conf, rewritten on every install and
# update run so existing servers get it too. A drop-in that cannot be written, or a
# sandbox the kernel/container cannot set up, leaves the service running unhardened:
# these helpers warn and always return 0, so a deploy never stops half-way over them.
#
# Every unit runs as www-data (User=), and for such a unit the seccomp-based settings
# (ProtectKernelTunables, ProtectKernelModules, RestrictSUIDSGID, LockPersonality,
# RestrictRealtime) make systemd also apply NoNewPrivileges=yes. The API server runs
# sendmail (postfix's setgid postdrop) and ping (setuid or file capabilities), which do
# not work under NoNewPrivileges, so office-tools-api gets only the namespace-based
# settings below. yt-server (node, yt-dlp, ffmpeg) and the PO-token provider (node) run
# no setuid/setgid program.
#
# ProtectSystem=full makes /usr, /boot, /efi and /etc read-only. None of the services
# writes there: data lives under /opt/office-tools, uploads in its data dir, yt-server's
# downloads in its temp dir, and yt-dlp's cache under the service user's home. The daily
# yt-dlp update and the cookie keep-alive run from cron, outside these units.
# PrivateTmp=yes gives a unit its own /tmp and /var/tmp. yt-server writes downloads to
# os.tmpdir() and serves them itself; nothing outside the unit reads them. The API server
# writes no temp files that another process reads. The PO-token provider is third-party
# code, so it is left on the shared /tmp.
OT_HARDEN_DROPIN="10-hardening.conf"

_svc_dropin_dir() { printf '/etc/systemd/system/%s.service.d' "$1"; }

_svc_hardening_body() {
    case "$1" in
        office-tools-api)
            # yt-dlp is not run here; ping/traceroute/sendmail are a few tasks each.
            cat << 'APIHARDEOF'
# Office Tools — sandboxing for the API server (managed by deploy.sh)
# Namespace-based settings only: seccomp-based ones would imply NoNewPrivileges for this
# User= service, which breaks sendmail (setgid postdrop) and ping.
[Service]
ProtectSystem=full
PrivateTmp=yes
TasksMax=512
APIHARDEOF
            ;;
        office-tools-cobalt)
            # Each download is a yt-dlp process plus ffmpeg, both multi-threaded, and
            # MAX_CONCURRENT can be raised or set to 0 (no limit): 1024 leaves room.
            cat << 'YTHARDEOF'
# Office Tools — sandboxing for yt-server (managed by deploy.sh)
[Service]
ProtectSystem=full
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
TasksMax=1024
YTHARDEOF
            ;;
        office-tools-pot)
            cat << 'POTHARDEOF'
# Office Tools — sandboxing for the bgutil PO-token provider (managed by deploy.sh)
# Third-party code: no PrivateTmp and no task limit.
[Service]
ProtectSystem=full
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictRealtime=yes
POTHARDEOF
            ;;
        *)
            return 1
            ;;
    esac
}

# Writes the drop-in for one unit and reloads systemd, so the restart the caller does next
# runs with it. Skips a unit whose unit file does not exist. Always returns 0.
svc_write_hardening() {
    local unit="$1" dir tmp
    if [[ ! -f "/etc/systemd/system/${unit}.service" ]]; then
        return 0
    fi
    dir="$(_svc_dropin_dir "$unit")"
    tmp="$dir/${OT_HARDEN_DROPIN}.new"
    if ! mkdir -p "$dir"; then
        warn "Could not create $dir — ${unit} runs without the hardening drop-in"
        return 0
    fi
    # systemd reads only *.conf here, so the half-written .new file is never loaded.
    if ! _svc_hardening_body "$unit" > "$tmp"; then
        rm -f "$tmp"
        warn "Could not write the hardening drop-in for ${unit} — it keeps its previous settings"
        return 0
    fi
    if ! mv -f "$tmp" "$dir/$OT_HARDEN_DROPIN"; then
        rm -f "$tmp"
        warn "Could not install $dir/$OT_HARDEN_DROPIN — ${unit} keeps its previous settings"
        return 0
    fi
    if ! systemctl daemon-reload; then
        warn "systemctl daemon-reload failed — the hardening drop-in for ${unit} applies on the next reload"
    fi
    return 0
}

# Called after the caller (re)started the unit. If it is down because systemd could not
# set up the sandbox (exit 226 NAMESPACE, 227 NO_NEW_PRIVILEGES, 228 SECCOMP — e.g. a
# container without mount namespaces), removes the drop-in and starts it unhardened.
# Any other failure is the service's own and is left for the caller's checks to report.
svc_verify_hardening() {
    local unit="$1" dropin st=""
    dropin="$(_svc_dropin_dir "$unit")/$OT_HARDEN_DROPIN"
    if [[ ! -f "$dropin" ]]; then
        return 0
    fi
    sleep 3
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
        return 0
    fi
    st=$(systemctl show -p ExecMainStatus --value "$unit" 2>/dev/null) || st=""
    case "$st" in
        226|227|228) ;;
        *) return 0 ;;
    esac
    warn "${unit} could not start with its sandbox (exit ${st}) — removing $dropin and starting it without"
    if ! rm -f "$dropin"; then
        warn "Could not remove $dropin — ${unit} stays down; remove it by hand and restart the unit"
        return 0
    fi
    systemctl daemon-reload || warn "systemctl daemon-reload failed"
    systemctl restart "$unit" || warn "${unit} failed to restart — check: journalctl -u ${unit} -n 30"
    return 0
}
