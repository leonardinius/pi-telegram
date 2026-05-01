
#!/usr/bin/env bash
#
# pi-telegram-health.sh
# Health check for pi-telegram bridge.
#
# Returns:
#   0  - healthy (all checks passed)
#   1  - unhealthy (any check failed)
#
# Can be used in systemd ExecStartPre/ExecStartPost or cron/liveness probes.
#
# Environment variables (see pi-telegram-start.sh for defaults):
#   PI_TELEGRAM_TMUX_SESSION=work-pi
#   PI_TELEGRAM_TMUX_TARGET=work-pi:0.0
#   PI_TELEGRAM_WORKDIR=/home/agent/.pi/agent
#   PI_TELEGRAM_PI_BIN=/home/agent/.npm-global/bin/pi
#   PI_TELEGRAM_RUN_DIR=/run/pi-telegram

set -o pipefail

TMUX_SESSION="${PI_TELEGRAM_TMUX_SESSION:-work-pi}"
TMUX_TARGET="${PI_TELEGRAM_TMUX_TARGET:-${TMUX_SESSION}:0.0}"
WORKDIR="${PI_TELEGRAM_WORKDIR:-/home/agent/.pi/agent}"
RUN_DIR="${PI_TELEGRAM_RUN_DIR:-/run/pi-telegram}"

LOG_PREFIX="[health-check]"

log_info()  { echo "${LOG_PREFIX} INFO: $*"; }
log_error() { echo "${LOG_PREFIX} ERROR: $*" >&2; }

fail() {
  log_error "$*"
  exit 1
}

# ---- Check 1: systemd unit status ---
# Note: only run this check when invoked under the same slice, otherwise skip.
# If systemctl is available, check whether the service is active.
if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet pi-telegram@${TMUX_SESSION}.service 2>/dev/null; then
    log_info "systemd unit pi-telegram@${TMUX_SESSION}.service is active"
  else
    log_info "systemd unit pi-telegram@${TMUX_SESSION}.service not active (or unit not found) — continuing with other checks"
  fi
fi

# ---- Check 2: tmux has session ---
tmux_run() {
  tmux -S /tmp/tmux-$(id -u)/default "$@" 2>/dev/null || tmux "$@"
}

if ! tmux_run has-session -t "$TMUX_SESSION" 2>/dev/null; then
  fail "tmux session '$TMUX_SESSION' not found"
fi
log_info "tmux session '$TMUX_SESSION' exists"

# ---- Check 3: tmux target pane exists ---
if ! tmux_run list-panes -t "$TMUX_TARGET >/dev/null 2>&1"; then
  # try alternative test
  if ! tmux_run display-message -p -t "$TMUX_TARGET" '#{pane_id}' >/dev/null 2>&1; then
    fail "tmux target '$TMUX_TARGET' not found"
  fi
fi
log_info "tmux target '$TMUX_TARGET' exists"

# ---- Check 4: target pane has live pi-like process ---
PID="$(tmux_run display-message -p -t "$TMUX_TARGET" '#{pane_pid}' 2>/dev/null)"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  fail "no live process found in tmux target pane (expected pi-like process)"
fi

COMM="$(tr -d '\0' < /proc/$PID/comm 2>/dev/null || true)"
if [ "$COMM" != "pi" ] && [ "$COMM" != "node" ]; then
  # Not strictly a failure — could be a shell waiting for commands — but warn
  log_info "pane PID=$COMM (comm='$COMM') — not a known pi/node process; being lenient"
else
  log_info "pane process OK (comm='$COMM', PID=$PID)"
fi

# ---- Check 5 (optional/strong): bridge lock in locks.json ---
LOCKS_FILE="$WORKDIR/locks.json"
if [ -f "$LOCKS_FILE" ]; then
  if grep -q '@llblab/pi-telegram' "$LOCKS_FILE" 2>/dev/null; then
    P_LOCK="$(grep -o '"pid":[0-9]*' "$LOCKS_FILE" | head -1 | cut -d: -f2)"
    if [ -n "$P_LOCK" ]; then
      if kill -0 "$P_LOCK" 2>/dev/null; then
        log_info "bridge lock present and pid=$P_LOCK is alive"
      else
        log_info "bridge lock present but pid=$P_LOCK is not alive (stale?)"
        # Not failing on this — useful but not fatal for system checks.
      fi
    else
      log_info "bridge extension listed in locks.json (no pid field found)"
    fi
  else
    log_info "bridge extension not listed in locks.json (bridge may not be active yet)"
  fi
else
  log_info "locks.json not found at $LOCKS_FILE (bridge may not be active yet)"
fi

# ---- Check 6: telegram.json present (optional config sanity) ---
TELEGRAM_CONFIG="$WORKDIR/telegram.json"
if [ -f "$TELEGRAM_CONFIG" ]; then
  if grep -q '"botToken"' "$TELEGRAM_CONFIG" 2>/dev/null; then
    log_info "telegram.json exists and contains botToken"
  else
    log_info "telegram.json exists but no botToken field (run /telegram-setup)"
  fi
else
  log_info "telegram.json not found (bridge may not be paired yet)"
fi

log_info "all checks passed"
exit 0
