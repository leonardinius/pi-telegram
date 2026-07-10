/**
 * Codex usage limit reporting helpers
 * Owns narrow OpenAI Codex usage fetching and Telegram-friendly quota rendering
 */

export interface TelegramUsageAuthCredential {
  type: string;
  accessToken?: string;
  accountId?: string;
  email?: string;
  expiresAt?: number;
}

export interface TelegramUsageAuthStorage {
  getApiKey(provider: string): Promise<string | undefined>;
  get(provider: string): TelegramUsageAuthCredential | undefined;
}

export interface TelegramUsageContext {
  modelRegistry?: {
    authStorage?: TelegramUsageAuthStorage;
  };
}

interface CodexUsageWindowPayload {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number;
}

interface CodexUsageRateLimitPayload {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: CodexUsageWindowPayload | null;
  secondary_window?: CodexUsageWindowPayload | null;
}

interface CodexUsageAdditionalRateLimitPayload {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: CodexUsageRateLimitPayload | null;
}

interface CodexUsagePayload {
  plan_type?: string;
  rate_limit?: CodexUsageRateLimitPayload | null;
  additional_rate_limits?: CodexUsageAdditionalRateLimitPayload[] | null;
  rate_limit_reset_credits?: { available_count?: number } | null;
}

interface RenderedUsageLimit {
  label: string;
  usedPercent?: number;
  resetAt?: number;
  limitReached?: boolean;
}

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_USAGE_DASHBOARD_URL = "https://chatgpt.com/codex/settings/usage";
const BAR_WIDTH = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getWindowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds === undefined) return fallback;
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

function getResetAt(window: CodexUsageWindowPayload, nowMs: number): number | undefined {
  const resetAt = toNumber(window.reset_at);
  if (resetAt !== undefined) return resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000;
  const after = toNumber(window.reset_after_seconds);
  return after === undefined ? undefined : nowMs + after * 1000;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

function formatBar(percent: number | undefined): string {
  if (percent === undefined) return `[${"░".repeat(BAR_WIDTH)}]`;
  const filled = Math.round(Math.min(Math.max(percent, 0), 100) / 100 * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`;
}

function windowToLimit(
  label: string,
  window: CodexUsageWindowPayload | null | undefined,
  limitReached: boolean | undefined,
  nowMs: number,
): RenderedUsageLimit | undefined {
  if (!isRecord(window)) return undefined;
  return {
    label: getWindowLabel(toNumber(window.limit_window_seconds), label),
    usedPercent: toNumber(window.used_percent),
    resetAt: getResetAt(window, nowMs),
    limitReached,
  };
}

function collectLimits(payload: CodexUsagePayload, nowMs: number): RenderedUsageLimit[] {
  const limits: RenderedUsageLimit[] = [];
  const root = payload.rate_limit;
  const add = (limit: RenderedUsageLimit | undefined) => {
    if (limit) limits.push(limit);
  };
  add(windowToLimit("primary", root?.primary_window, root?.limit_reached, nowMs));
  add(windowToLimit("secondary", root?.secondary_window, root?.limit_reached, nowMs));
  for (const extra of payload.additional_rate_limits ?? []) {
    const suffix = extra.limit_name ?? extra.metered_feature ?? "extra";
    add(windowToLimit(`${suffix} primary`, extra.rate_limit?.primary_window, extra.rate_limit?.limit_reached, nowMs));
    add(windowToLimit(`${suffix} secondary`, extra.rate_limit?.secondary_window, extra.rate_limit?.limit_reached, nowMs));
  }
  return limits;
}

function formatLimit(limit: RenderedUsageLimit, nowMs: number): string {
  const percent = limit.usedPercent;
  const pct = percent === undefined ? "?" : `${percent.toFixed(1)}%`;
  const reset = limit.resetAt && limit.resetAt > nowMs ? ` reset ${formatDuration(limit.resetAt - nowMs)}` : "";
  const status = limit.limitReached ? " exhausted" : "";
  return `${limit.label.padEnd(8)} ${pct.padStart(6)} ${formatBar(percent)}${reset}${status}`;
}

export async function buildCodexUsageHtml(ctx: TelegramUsageContext): Promise<string> {
  const authStorage = ctx.modelRegistry?.authStorage;
  if (!authStorage) return "Codex usage unavailable: auth storage is not exposed by this Pi runtime.";

  const accessToken = await authStorage.getApiKey("openai-codex");
  const credential = authStorage.get("openai-codex");
  if (!accessToken || credential?.type !== "oauth") {
    return "Codex usage unavailable: no openai-codex OAuth credential. Run Pi /login for openai-codex first.";
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "pi-telegram/usage",
  };
  if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;

  const response = await fetch(CODEX_USAGE_URL, { headers });
  if (response.status === 403) {
    return [
      "Codex usage API rejected Pi OAuth token: HTTP 403.",
      `Open the Codex usage dashboard: ${CODEX_USAGE_DASHBOARD_URL}`,
    ].join("\n");
  }
  if (!response.ok) return `Codex usage request failed: HTTP ${response.status}`;
  const raw = await response.json() as unknown;
  if (!isRecord(raw)) return "Codex usage response was not an object.";
  const payload = raw as CodexUsagePayload;
  const nowMs = Date.now();
  const limits = collectLimits(payload, nowMs);
  const title = ["Codex usage", payload.plan_type ? `plan ${payload.plan_type}` : undefined].filter(Boolean).join(" · ");
  const lines = [`<b>${escapeHtml(title)}</b>`];
  if (limits.length === 0) lines.push("<code>no limits reported</code>");
  else lines.push(`<pre>${escapeHtml(limits.map((limit) => formatLimit(limit, nowMs)).join("\n"))}</pre>`);
  const credits = toNumber(payload.rate_limit_reset_credits?.available_count);
  if (credits && credits > 0) lines.push(escapeHtml(`${credits} saved reset${credits === 1 ? "" : "s"} available`));
  return lines.join("\n");
}
