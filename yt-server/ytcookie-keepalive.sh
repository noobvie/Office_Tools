#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
#  ytcookie-keepalive.sh — keep the YouTube cookie session alive and report its state
#
#  Installed to /opt/office-tools/yt-server/ by deploy.sh, run from
#  /etc/cron.d/office-tools-ytcookie as www-data (the user yt-server runs as, so the
#  cookie file keeps its owner when yt-dlp rewrites it).
#
#  Two jobs:
#    1. KEEP ALIVE — a periodic authenticated request makes yt-dlp write the rotated
#       cookies back to the file, which is what stops a parked session from going
#       stale between real downloads.
#    2. REPORT — writes <cookie-dir>/cookies.status, which server.js reads for the
#       /health "cookies" field ("file:ok" / "file:expired"). Without this file
#       /health can only ever say "file:unchecked".
#
#  Status file format (first line is all server.js reads):
#     ok       <iso-8601> <detail>
#     expired  <iso-8601> <detail>
#
#  An INCONCLUSIVE probe (network down, YouTube 5xx, yt-dlp missing) deliberately
#  leaves the previous status untouched — a transient failure must not be reported
#  to the operator as expired cookies.
#
#  Manual run:  runuser -u www-data -- /opt/office-tools/yt-server/ytcookie-keepalive.sh
#  Env overrides: YTCOOKIE_PROBE_URL, YTDLP (path to binary)
# ═══════════════════════════════════════════════════════════════════════════════

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"

# ── Resolve config from the same .env systemd feeds the server ────────────────
# Read it key-by-key rather than sourcing: .env is operator-edited and may hold
# values that would execute if sourced.
_env_get() {
    [[ -f "$ENV_FILE" ]] || return 0
    sed -n "s/^[[:space:]]*${1}=//p" "$ENV_FILE" | tail -n1 | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

COOKIES="${YTDLP_COOKIES:-$(_env_get YTDLP_COOKIES)}"
YTDLP_BIN="${YTDLP:-$(_env_get YTDLP)}"
YTDLP_BIN="${YTDLP_BIN:-yt-dlp}"

# The probe target. Any ordinary public video works — it is only ever fetched with
# --simulate (metadata, no download). Pick one that is unlikely to be deleted or made
# private, because a removed video fails in a way this script must NOT read as expired
# cookies (it reports "inconclusive" and leaves the status alone). Override per-run
# with YTCOOKIE_PROBE_URL if this one ever disappears.
PROBE_URL="${YTCOOKIE_PROBE_URL:-https://www.youtube.com/watch?v=J6VMJLSNAHk}"

# Nothing configured → nothing to keep alive. /health reports "none" on its own.
[[ -n "$COOKIES" ]] || exit 0

if [[ ! -f "$COOKIES" ]]; then
    # server.js checks the file itself and reports "file:missing" — no status to write.
    echo "ytcookie-keepalive: cookie file not found: $COOKIES" >&2
    exit 0
fi

STATUS_FILE="$(dirname "$COOKIES")/cookies.status"
LOCK_FILE="$(dirname "$COOKIES")/.cookies.lock"
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── Single instance ───────────────────────────────────────────────────────────
# yt-dlp rewrites the cookie file on exit; two overlapping runs can interleave those
# writes and corrupt the session that this script exists to protect.
exec 9>"$LOCK_FILE" || exit 0
flock -n 9 || { echo "ytcookie-keepalive: another run holds the lock — skipping" >&2; exit 0; }

command -v "$YTDLP_BIN" &>/dev/null || {
    echo "ytcookie-keepalive: $YTDLP_BIN not found — leaving previous status untouched" >&2
    exit 0
}

# ── Probe ─────────────────────────────────────────────────────────────────────
# --simulate: metadata only, no download. Uses the same cookie file the server does,
# so success here means the server's next real download authenticates the same way.
err_out="$(timeout 120 "$YTDLP_BIN" \
    --cookies "$COOKIES" \
    --simulate --no-warnings --no-playlist \
    --print '%(id)s' \
    "$PROBE_URL" 2>&1 >/dev/null)"
rc=$?

write_status() {
    printf '%s %s %s\n' "$1" "$NOW" "$2" > "$STATUS_FILE" || return 1
    chmod 644 "$STATUS_FILE" 2>/dev/null || true
}

if [[ $rc -eq 0 ]]; then
    write_status ok "probe succeeded (yt-dlp $("$YTDLP_BIN" --version 2>/dev/null || echo unknown))"
    echo "ytcookie-keepalive: ok"
    exit 0
fi

# Expired/invalidated cookies have a recognisable voice. Anything else — DNS failure,
# YouTube 5xx, a removed probe video, timeout — is inconclusive and must not be
# reported as expiry, so the previous status stays as it was.
if grep -qiE "sign in to confirm|confirm you.?re not a bot|not a bot|cookies are no longer valid|please sign in|login required|account cookies|this video is only available to|use --cookies" <<< "$err_out"; then
    reason="$(grep -iE 'sign in|cookie|bot' <<< "$err_out" | head -n1 | cut -c1-200)"
    write_status expired "${reason:-authentication rejected}"
    echo "ytcookie-keepalive: EXPIRED — $reason" >&2
    exit 0
fi

echo "ytcookie-keepalive: probe inconclusive (rc=$rc) — status left unchanged: $(head -c 200 <<< "$err_out")" >&2
exit 0
