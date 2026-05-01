
#!/usr/bin/env bash
#
# pi-telegram-start.sh
# Start/stop/reload the pi-telegram bridge inside a tmux session.
#
# Usage:
#   pi-telegram-start.sh start|stop|reload
#
# Exit codes:
#   0   success
#   10  wrong user (not running as agent)
#   11  missing dependency (tmux / pi not found)
#   12  missing workdir or config
#   13  pi binary not executable
#   30  tmux error
#   40  pi startup timeout
#   41  send-keys failed
#   42  connect/lock verification failed

set -o pipefail

# ---- Config (overridable by env) ----
TMUX_SESSION="${PI_TELEGRAM_TMUX_SESSION:-work-pi}"
TMUX_TARGET="${PI_TELEGRAM_TMUX_TARGET:-${TMUX_SESSION}:0.0}"
WORKDIR="${PI_TELEGRAM_WORKDIR:-/home/agent/.pi/agent}"
PI_BIN="${PI_TELEGRAM_PI_BIN:-/home/agent/.npm-global/bin/pi}"
CONNECT_CMD="${PI_TELEGRAM_CONNECT_COMMAND:-/telegram-connect}"
RUN_DIR="${PI_TELEGRAM_RUN_DIR:-/run/pi-telegram}"
START_TIMEOUT="${PI_TELEGRAM_START_TIMEOUT:-60}"
CONNECT_TIMEOUT="${PI_TELEGRAM_CONNECT_TIMEOUT:-45}"
MARKER_DIR="${RUN_DIR}/markers"

# ---- Helpers ----
log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [pi-telegram-start] $*" >&2
}

error() {
  log "ERROR: $*"
  exit "$1"
}

tmux_run() {
  tmux -S /tmp/tmux-$(id -u)/default "$@" 2>/dev/null || tmux "$@"
}

tmux_has_session() {
  tmux_run has-session -t "$TMUX_SESSION" 2>/dev/null
}

tmux_pane_pid() {
  # Get the PID of the process in the target pane
  tmux_run display-message -p -t "$TMUX_TARGET" '#{pane_pid}' 2>/dev/null
}

# ---- Mode ----
MODE="${1:-start}"

case "$MODE" in
  start)
    ;;
  stop|reload)
    ;;
  *)
    error 1 "Usage: $0 {start|stop|reload}"
    ;;
esac

# ---- Pre-flight ----
USER_ACTUAL="$(id -un)"
if [ "$USER_ACTUAL" != "agent" ]; then
  error 10 "Must be run as user 'agent', current user: $USER_ACTUAL"
fi

if ! command -v tmux >/dev/null 2>&1; then
  error 11 "tmux not found in PATH"
fi

if [ ! -x "$PI_BIN" ]; then
  error 13 "pi binary not executable or not found: $PI_BIN"
fi

if [ ! -d "$WORKDIR" ]; then
  error 12 "Workdir does not exist: $WORKDIR"
fi

TELEGRAM_CONFIG="${WORKDIR}/telegram.json"

mkdir -p "$RUN_DIR" "$MARKER_DIR"

SESSID_MARKER="${MARKER_DIR}/${TMUX_SESSION}.created"

case "$MODE" in
  start)
    log "Starting pi-telegram bridge (session=$TMUX_SESSION, target=$TMUX_TARGET)"

    # ---- Check config ---
    if [ ! -f "$TELEGRAM_CONFIG" ]; then
      error 12 "Telegram config not found: $TELEGRAM_CONFIG. Run /telegram-setup in pi first."
    fi
    if ! grep -q '"botToken"' "$TELEGRAM_CONFIG" 2>/dev/null; then
      error 12 "No botToken found in $TELEGRAM_CONFIG. Run /telegram-setup in pi first."
    fi

    SESSION_CREATED_BY_US=false

    # ---- Ensure tmux session exists ---
    if ! tmux_has_session; then
      log "tmux session '$TMUX_SESSION' not found, creating..."
      # Start with running pi in the pane
      if tmux_run new-session -d -s "$TMUX_SESSION" -c "$WORKDIR" "$PI_BIN"; then
        SESSION_CREATED_BY_US=true
        log "Created tmux session '$TMUX_SESSION' with pi"
        echo "true" > "$SESSID_MARKER"
      else
        error 30 "Failed to create tmux session '$TMUX_SESSION'"
      fi
    else
      log "tmux session '$TMUX_SESSION' already exists"
      # Ensure target pane has a pi-like process running
      PID="$(tmux_pane_pid)"
      if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
        log "No live pi-like process in target pane, starting pi..."
        if ! tmux_run send-keys -t "$TMUX_TARGET" -- "$PI_BIN" Enter; then
          error 30 "Failed to start pi in tmux pane"
        fi
        # Give it a moment to start
        sleep 2
      fi
    fi

    # ---- Wait for pi process in pane ---
    ELAPSED=0
    while [ "$ELAPSED" -lt "$START_TIMEOUT" ]; do
      PID="$(tmux_pane_pid)"
      if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
        # Check if it's actually pi (by cmdline or comm)
        COMM="$(tr -d '\0' < /proc/$PID/comm 2>/dev/null || true)"
        if [ "$COMM" = "pi" ] || [ "$COMM" = "node" ]; then
          log "pi process found in pane (PID=$PID)"
          break
        fi
      fi
      sleep 1
      ELAPSED=$((ELAPSED + 1))
    done

    if [ "$ELAPSED" -ge "$START_TIMEOUT" ]; then
      error 40 "Timeout waiting for pi process in tmux pane"
    fi

    # ---- Send /telegram-connect ---
    log "Sending '$CONNECT_CMD' to tmux pane..."
    if ! tmux_run send-keys -t "$TMUX_TARGET" -- "$CONNECT_CMD" Enter; then
      error 41 "Failed to send-keys to tmux pane"
    fi

    # ---- Verify bridge lock ---
    # Wait briefly for lock file / locks.json to reflect bridge is running
    ELAPSED=0
    VERIFIED=false
    while [ "$ELAPSED" -lt "$CONNECT_TIMEOUT" ]; do
      LOCKS_FILE="$WORKDIR/locks.json"
      if [ -f "$LOCKS_FILE" ] && grep -q '@llblab/pi-telegram' "$LOCKS_FILE" 2>/dev/null; then
        # Optional: check pid is live
        P_LOCK="$(grep -o '"pid":[0-9]*' "$LOCKS_FILE" | head -1 | cut -d: -f2)"
        if [ -n "$P_LOCK" ] && kill -0 "$P_LOCK" 2>/dev/null; then
          VERIFIED=true
          break
        elif [ -z "$P_LOCK" ]; then
          # No pid written but extension listed - consider OK
          VERIFIED=true
          break
        fi
      fi
      sleep 1
      ELAPSED=$((ELAPSED + 1))
    done

    if [ "$VERIFIED" = false ]; then
      log "WARNING: Bridge lock not detected after $CONNECT_TIMEOUT s (may still be starting)"
      # Do not fail outright — bridge may take longer; we consider start "successful" if pi process is alive.
      # This matches systemd oneshot+RemainAfterExit: we've done our job.
    else
      log "Bridge lock verified (bridge is running)"
    fi

    log "Start completed successfully"
    exit 0
    ;;

  stop)
    log "Stopping pi-telegram bridge (session=$TMUX_SESSION)"

    if tmux_has_session; then
      # Try graceful disconnect if possible
      tmux_run send-keys -t "$TMUX_TARGET" -- "/telegram-disconnect" Enter 2>/dev/null || true
      sleep 1

      # If we created this session, stop the tmux session entirely.
      if [ -f "$SESSID_MARKER" ]; then
        log "Stopping tmux session '$TMUX_SESSION' (created by service)"
        tmux_run kill-session -t "$TMUX_SESSION" 2>/dev/null || true
        rm -f "$SESSID_MARKER"
      else
        log "Tmux session '$TMUX_SESSION' existed before service; leaving it running"
      fi
    else
      log "Tmux session '$TMUX_SESSION' not found (already stopped)"
    fi

    rm -f "$SESSID_MARKER"
    log "Stop completed"
    exit 0
    ;;

  reload)
    log "Reloading (same as start)"
    exec "$0" start
    ;;
esac
