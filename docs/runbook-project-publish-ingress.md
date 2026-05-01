# Runbook: Project Publish Ingress (Ubuntu + systemd + Cloudflare Access)

## Scope

Интеграция publish-потока проектов с `pi-telegram` и `scripts/external/project` через единый `scripts/sync-ingress.ts` и fail-closed валидацию `scripts/expose-validation.ts`.

## Реализованный контракт

- Публичный URL только `https://<project>-<base>/`.
- `<project>` берётся из slug проекта, `<base>` из `PI_PROJECTS_PUBLIC_BASE_URL`.
- `APP_PUBLIC_URL` не участвует в derivation публичного хоста.
- Валидация publish fail-closed с reason code:
  - `EXPOSE_DISABLED`
  - `APP_PORT_MISSING`
  - `APP_PORT_INVALID`
  - `COMPOSE_INVALID`
  - `PORT_MISMATCH`
  - `INVALID_PROJECT_SLUG`

## Требования к проекту

Проект публикуется только если:

1. `.expose.yml` содержит `enabled: true`.
2. `.env` содержит валидный `APP_PORT` (`1..65535`).
3. `compose.yaml` валиден по контракту порта: loopback bind и согласование с `APP_PORT`.

Иначе маршрут не генерируется.

## Команды

- Проверка матрицы publish:
  - `node --experimental-strip-types scripts/validate-expose.ts`
- Синхронизация ingress:
  - `node --experimental-strip-types scripts/sync-ingress.ts`

Переменные:

- `WORK_PROJECTS_ROOT` (по умолчанию `/home/agent/work/projects`)
- `PI_PROJECTS_PUBLIC_BASE_URL` (по умолчанию `apps.it101.org`)
- `PI_CADDY_DYNAMIC_CONFIG_PATH` (по умолчанию `/etc/caddy/Caddyfile.projects`)
- `PI_CADDY_VALIDATE_CMD` (по умолчанию `caddy`)
- `PI_CADDY_RELOAD_CMD` (по умолчанию `systemctl`)

## Интеграция с lifecycle project

`scripts/external/project` вызывает `sync_ingress` после успешных:

- `new`
- `init`
- `up`
- `down`
- `restart`
- `delete`

Поведение:

- при `sync_ingress` ошибке команда возвращает non-zero;
- логи операции и ingress синка разделены префиксом `[ingress]`.

## Caddy/systemd (операторские шаги)

- Проверка конфига: `caddy validate --config <path>`
- Reload: `systemctl reload caddy`
- Статус: `systemctl status caddy`
- Логи: `journalctl -u caddy -f`

## Безопасность origin bypass

Обязательные меры:

- upstream только `127.0.0.1:<APP_PORT>`;
- Caddy слушает loopback-only (`127.0.0.1`, `::1`);
- хостовый firewall блокирует прямой доступ к app портам извне.

## Canary rollout

- Сначала включить только проект `aaa` (`.expose.yml: enabled: true`).
- Окно наблюдения: 24h.
- Стоп-критерии: повторяющиеся 5xx, недоступность, деградация latency.

## Текущие ограничения

- Нет custom domains.
- Нет per-project override публичного хоста.
- Нет DNS-операций вне шаблона `<project>-<base>`.
