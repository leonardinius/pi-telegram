# Runbook: Project Publish Ingress (Ubuntu + systemd + Cloudflare Access)

## Scope

Spec for integrating project publish flow with `pi-telegram` project management and existing `project` scripts.

## Canonical slug proposal

- Auto slug: `projpub-v1-cf-caddy-localbind`

## Hard requirements

1. Publish allowed only when `<project>/.expose.yml` has `enabled: true`.
2. Publish source of truth for port is `<project>/.env` key `APP_PORT`.
3. `compose.yaml` must be valid and must agree with `APP_PORT` (exact exposed upstream port expected by app runtime contract).
4. Any missing/invalid/mismatch state is **fail closed**: do not publish, log explicit error.
5. Single shared Caddy instance, dynamic config generation.
6. Caddy upstreams only to `http://127.0.0.1:<APP_PORT>`.
7. Origin bypass protection is mandatory:
   - Caddy listens only on `127.0.0.1` and `::1`.
   - Host firewall hardening is mandatory step.
8. Cloudflare Access policy:
   - allow only owner email,
   - MFA always,
   - no break-glass account.
9. Hook integration into `project` commands: `new/init/up/down/restart/delete` -> unified `sync-ingress` call after successful operation.
10. Canary: first app `aaa`, observation window 24h, stop criteria: repeated 5xx, unavailability, latency regression.

## Target artifacts

- `docs/runbook-project-publish-ingress.md` (this file)
- `scripts/sync-ingress` (or existing project-script integration point)
- `scripts/validate-expose` (or inlined in `sync-ingress`)
- systemd unit for shared Caddy ingress render/reload flow
- Caddy template + generated runtime config
- firewall baseline script/runbook section

## Implementation plan (concrete)

### Phase 1 — Validation core (fail-closed)

1. Add validator flow per project:
   - Read `.expose.yml` -> require `enabled: true`.
   - Read `.env` -> parse `APP_PORT` integer range `1..65535`.
   - Validate `compose.yaml` is parseable and references the same app port contract.
2. On any check failure:
   - mark project as not publishable,
   - emit structured log line with reason code (`EXPOSE_DISABLED`, `APP_PORT_MISSING`, `APP_PORT_INVALID`, `COMPOSE_INVALID`, `PORT_MISMATCH`),
   - skip ingress entry generation.

### Phase 2 — Dynamic ingress generation

1. Build `sync-ingress` command:
   - enumerate projects under root,
   - run validation core for each,
   - generate a single Caddy config from valid projects only,
   - atomically write config (`tmp` + rename),
   - run `caddy validate` then `systemctl reload caddy` only on valid config.
2. Routing model:
   - host `https://<project>.<publicBaseDomain>` -> reverse proxy `127.0.0.1:<APP_PORT>`.

### Phase 3 — Caddy and systemd

1. Install Caddy natively on Ubuntu.
2. Configure Caddy systemd service.
3. Bind only loopback in Caddy global/server config:
   - `127.0.0.1`
   - `::1`
4. Add operational commands in runbook:
   - `systemctl status caddy`
   - `journalctl -u caddy -f`
   - `caddy validate --config <generated>`

### Phase 4 — Firewall hardening (mandatory)

1. Enforce host firewall rules (ufw/nftables):
   - deny direct inbound to app ports,
   - only required public ingress ports exposed for CF tunnel/access path,
   - local loopback unrestricted.
2. Add verification checklist:
   - external probe to app port fails,
   - localhost probe succeeds,
   - published host reachable only via Cloudflare auth flow.

### Phase 5 — Hook integration into project lifecycle

After successful `project` operations, call unified `sync-ingress`:
- `new`
- `init`
- `up`
- `down`
- `restart`
- `delete`

Rules:
- invoke only on successful primary operation,
- if `sync-ingress` fails, return non-zero and explicit stderr,
- keep operation/result logs separate (`project-op` vs `ingress-sync`).

### Phase 6 — Cloudflare Access policy

1. Create Access app for publish domain pattern.
2. Policy:
   - include: exact owner email only,
   - require: MFA always.
3. Explicitly do not configure break-glass bypass.

### Phase 7 — Canary rollout (`aaa`)

1. Enable publish for `aaa` only.
2. Observe for 24h.
3. Stop rollout if any:
   - repeated 5xx,
   - downtime/unreachable periods,
   - latency regression vs baseline.
4. If clean, proceed to wider enablement by `.expose.yml` toggles.

## Acceptance criteria

- Disabled/malformed project configs never produce public routes.
- Port mismatch always blocks publish.
- `sync-ingress` is idempotent and safe to run repeatedly.
- Caddy reload happens only after successful validation.
- Direct origin bypass is blocked (bind + firewall).
- Project lifecycle commands consistently trigger ingress sync.
- Canary decision documented after 24h window.
