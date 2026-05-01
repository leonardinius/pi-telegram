
# Systemd Deployment — pi-telegram

This directory contains production systemd deployment files for the pi-telegram bridge.

## Files

- `pi-telegram@.service` — systemd service template (instance name = tmux session name, e.g. `pi-telegram@work-pi.service`)
- `pi-telegram-start.sh` — start/stop/reload helper script
- `pi-telegram-health.sh` — liveness/readiness health check script

## Quick Start

```bash
# 1) Install systemd unit (as root)
sudo cp pi-telegram@.service /etc/systemd/system/
sudo chmod 644 /etc/systemd/system/pi-telegram@.service

# 2) Install helper scripts (as root)
sudo cp pi-telegram-start.sh /usr/local/bin/
sudo cp pi-telegram-health.sh /usr/local/bin/
sudo chmod 0755 /usr/local/bin/pi-telegram-start.sh
sudo chmod 0755 /usr/local/bin/pi-telegram-health.sh

# 3) Create an env file (as root or agent user)
sudo mkdir -p /etc/default
sudo touch /etc/default/pi-telegram
sudo chmod 0600 /etc/default/pi-telegram

# Example /etc/default/pi-telegram (optional overrides):
# PI_TELEGRAM_TMUX_SESSION=work-pi
# PI_TELEGRAM_TMUX_TARGET=work-pi:0.0
# PI_TELEGRAM_WORKDIR=/home/agent/.pi/agent
# PI_TELEGRAM_PI_BIN=/home/agent/.npm-global/bin/pi

# 4) Create a config file for agent (recommended)
sudo mkdir -p /home/agent/.config
touch /home/agent/.config/pi-telegram.env
sudo chown agent:agent /home/agent/.config/pi-telegram.env
sudo chmod 0600 /home/agent/.config/pi-telegram.env
# (this file overrides/extends the env above)

# 5) Reload systemd and enable service
sudo systemctl daemon-reload
sudo systemctl enable --now pi-telegram@work-pi.service

# 6) Check status
sudo systemctl status pi-telegram@work-pi.service
journalctl -u pi-telegram@work-pi.service -f
```

## Service behavior

- **User**: runs as `agent:agent`
- **WorkingDirectory**: `/home/agent/.pi/agent`
- **RemainAfterExit**: `yes` — the service is considered "active" while the tmux session and bridge are running
- **RestartPolicy**: `on-failure` with exponential backoff (5s → up to 5m) and a burst window (30min/10 bursts)
- **Start sequence**:
  1. Validates `tmux` and `pi` binary exist
  2. Ensures `$WORKDIR/telegram.json` exists and has a `botToken`
  3. Creates the tmux session (if missing) and starts `pi` in it
  4. Waits for a pi-like process inside the tmux pane
  5. Sends `/telegram-connect` inside the pane
  6. Optionally verifies the bridge appeared in `locks.json`
- **Stop sequence**:
  1. Sends `/telegram-disconnect` (best-effort)
  2. If the tmux session was created by this service, kills it
  3. If the session existed beforehand, it is left running (safe for manual use)

## Health check

```bash
# Run standalone
/usr/local/bin/pi-telegram-health.sh

echo $?  # 0 = healthy, 1 = unhealthy
```

The health check verifies:

1. tmux session `$PI_TELEGRAM_TMUX_SESSION` exists
2. target pane `$PI_TELEGRAM_TMUX_TARGET` exists
3. a live process exists in the pane
4. (optional) bridge entry in `$WORKDIR/locks.json` and its PID liveness
5. (optional) presence of `telegram.json` and botToken

You can use this as a systemd `ExecStartPre`/`ExecStartPost`, in a cron, or as a liveness probe from an external monitor.

Example systemd liveness wrapper (create `/etc/systemd/system/pi-telegram@.service.d/health.conf`):

```ini
[Service]
ExecStartPost=/usr/local/bin/pi-telegram-health.sh || (systemctl stop pi-telegram@%i && exit 1)
```

Or a simple cron line (as root or agent):

```cron
*/2 * * * * /usr/local/bin/pi-telegram-health.sh || logger -t pi-telegram-health "health check failed"
```

## Logs

```bash
# Service logs
journalctl -u pi-telegram@work-pi.service -f

# Tmux pane output (what pi is printing)
tmux capture-pane -pt work-pi:0.0 -S -500
```

## Updating / Restart

```bash
# Stop bridge (graceful)
sudo systemctl stop pi-telegram@work-pi.service

# Update code
cd /home/agent/work/pi-telegram && git pull

# Reinstall pi extension if needed (from project directory)
pi install /home/agent/work/pi-telegram

# Restart
sudo systemctl start pi-telegram@work-pi.service
sudo systemctl status pi-telegram@work-pi.service

# Or use reload (same as start in this implementation)
sudo systemctl reload pi-telegram@work-pi.service
```

## Troubleshooting

### Permission denied (systemd)
- Ensure `User=agent` and files are readable by agent.
- Check `ReadWritePaths` in unit — make sure `/home/agent/.pi` is included.
- Run: `systemctl cat pi-telegram@work-pi.service` to confirm env/files.

### Tmux errors ("no server" / "can't find session")
- Confirm `tmux` is installed and in the `PATH` used by systemd (`/usr/bin/tmux`).
- The service sets `PrivateTmp=no` to allow access to tmux sockets.
- Manual test (as agent): `tmux has-session -t work-pi`.

### Token invalid / bridge won't connect
- Run `/telegram-setup` inside a manual pi session to create/update `~/.pi/agent/telegram.json`.
- Re-check content: `cat ~/.pi/agent/telegram.json`.
- In the tmux session run `/telegram-status` to see current bridge state.

### Service starts but bridge never becomes active
- Check locks.json: `cat /home/agent/.pi/agent/locks.json` for `@llblab/pi-telegram`.
- Confirm `/telegram-connect` was sent — look at captured pane output.
- If the bridge is already running in another session, `/telegram-connect` may prompt for takeover; the non-interactive service startup can't answer. Stop other sessions first.

### Port conflicts / singleton conflict
- pi-telegram is session-local. Only one pi session should be connected to the bot token.
- If you want multiple bots, you would need multiple bot tokens and separate services with different env/sessions.

## Security notes

- `ProtectSystem=strict` and `ProtectHome=read-only` are enabled; `ReadWritePaths` explicitly allows the pi state and tmp directories.
- `botToken` must not be committed to git — use the env file or `telegram.json` (file mode `0600`).
- `PrivateTmp=no` is required for the service to interact with user tmux sockets. This is acceptable here since the service runs as the same user and only manages that user's tmux.
- If running on a shared host, consider adding stronger sandboxing (network namespacing, seccomp).

## Env variables reference

| Variable | Default | Meaning |
|----------|---------|---------|
| `PI_TELEGRAM_TMUX_SESSION` | `work-pi` | tmux session name |
| `PI_TELEGRAM_TMUX_TARGET` | `<session>:0.0` | tmux target pane |
| `PI_TELEGRAM_WORKDIR` | `/home/agent/.pi/agent` | pi working dir |
| `PI_TELEGRAM_PI_BIN` | `/home/agent/.npm-global/bin/pi` | pi binary path |
| `PI_TELEGRAM_CONNECT_COMMAND` | `/telegram-connect` | command to start bridge |
| `PI_TELEGRAM_RUN_DIR` | `/run/pi-telegram` | marker/run directory |
| `PI_TELEGRAM_START_TIMEOUT` | `60` | seconds to wait for pi process |
| `PI_TELEGRAM_CONNECT_TIMEOUT` | `45` | seconds to wait for lock verification |

## License

Same as project: MIT
