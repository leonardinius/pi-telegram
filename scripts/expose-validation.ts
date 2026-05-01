/**
 * Shared project publish validation for ingress scripts
 * Owns fail-closed reason codes, slug checks, APP_PORT parsing, and compose port contract checks
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

export const EXPOSE_VALIDATION_REASONS = [
  "EXPOSE_DISABLED",
  "APP_PORT_MISSING",
  "APP_PORT_INVALID",
  "COMPOSE_INVALID",
  "PORT_MISMATCH",
  "INVALID_PROJECT_SLUG",
] as const;

export type ExposeValidationReason = typeof EXPOSE_VALIDATION_REASONS[number];

export type ExposeValidationResult =
  | { name: string; ok: true; port: number }
  | { name: string; ok: false; reason: ExposeValidationReason; detail?: string };

export const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const INVALID_PROJECT_SLUG_DETAIL = "expected lowercase letters, digits, and hyphen";
export const COMPOSE_PORT_CONTRACT =
  'expected a compose ports entry binding host loopback APP_PORT, e.g. "127.0.0.1:${APP_PORT}:<container-port>"';

export function isValidProjectSlug(name: string): boolean {
  return PROJECT_SLUG_PATTERN.test(name);
}

export function parsePort(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

export function envValue(text: string, key: string): string | undefined {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!key || key.startsWith("#")) continue;
    env[key] = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

export async function readProjectEnv(root: string, name: string): Promise<Record<string, string>> {
  return parseEnv(await fs.readFile(join(root, name, ".env"), "utf8"));
}

export function isExposeEnabled(text: string): boolean {
  return /^\s*enabled\s*:\s*true\s*(?:#.*)?$/im.test(text);
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function parseComposePortListItem(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("-")) return undefined;
  return unquoteYamlScalar(trimmed.slice(1).trim());
}

function isValidContainerPort(value: string): boolean {
  const [port] = value.split("/");
  return parsePort(port) !== undefined;
}

export function composeMatchesPortContract(compose: string, appPort: number): boolean {
  const appPortText = String(appPort);
  for (const line of compose.split(/\r?\n/)) {
    const item = parseComposePortListItem(line);
    if (!item) continue;
    const parts = item.split(":");
    if (parts.length !== 3) continue;
    const [hostIp, hostPort, containerPort] = parts;
    if (hostIp !== "127.0.0.1") continue;
    if (hostPort !== "${APP_PORT}" && hostPort !== appPortText) continue;
    if (!isValidContainerPort(containerPort ?? "")) continue;
    return true;
  }
  return false;
}

type ComposePortContractError = {
  reason: Extract<ExposeValidationReason, "COMPOSE_INVALID" | "PORT_MISMATCH">;
  detail: string;
};

export function validateComposePortContract(compose: string, appPort: number): ComposePortContractError | undefined {
  if (!/^\s*services\s*:/m.test(compose)) {
    return { reason: "COMPOSE_INVALID", detail: "missing services" };
  }
  if (!composeMatchesPortContract(compose, appPort)) {
    return { reason: "PORT_MISMATCH", detail: `expected loopback host port APP_PORT=${appPort}` };
  }
  return undefined;
}

export async function validateProjectExpose(root: string, name: string): Promise<ExposeValidationResult> {
  const path = join(root, name);

  if (!isValidProjectSlug(name)) {
    return { name, ok: false, reason: "INVALID_PROJECT_SLUG", detail: INVALID_PROJECT_SLUG_DETAIL };
  }

  try {
    const expose = await fs.readFile(join(path, ".expose.yml"), "utf8");
    if (!isExposeEnabled(expose)) return { name, ok: false, reason: "EXPOSE_DISABLED" };
  } catch {
    return { name, ok: false, reason: "EXPOSE_DISABLED" };
  }

  let appPort: number;
  try {
    const env = await fs.readFile(join(path, ".env"), "utf8");
    const rawPort = envValue(env, "APP_PORT");
    if (!rawPort) return { name, ok: false, reason: "APP_PORT_MISSING" };
    const parsed = parsePort(rawPort);
    if (!parsed) return { name, ok: false, reason: "APP_PORT_INVALID", detail: `APP_PORT=${rawPort}` };
    appPort = parsed;
  } catch {
    return { name, ok: false, reason: "APP_PORT_MISSING" };
  }

  try {
    const compose = await fs.readFile(join(path, "compose.yaml"), "utf8");
    const composeError = validateComposePortContract(compose, appPort);
    if (composeError) return { name, ok: false, ...composeError };
  } catch {
    return { name, ok: false, reason: "COMPOSE_INVALID", detail: "compose.yaml unreadable" };
  }

  return { name, ok: true, port: appPort };
}

export async function validateProjectsExpose(root: string): Promise<ExposeValidationResult[]> {
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const results: ExposeValidationResult[] = [];
  for (const name of names) {
    results.push(await validateProjectExpose(root, name));
  }
  return results;
}
