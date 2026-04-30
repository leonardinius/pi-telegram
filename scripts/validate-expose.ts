#!/usr/bin/env node
import { promises as fs } from "node:fs";
import { join } from "node:path";

type Reason =
  | "EXPOSE_DISABLED"
  | "APP_PORT_MISSING"
  | "APP_PORT_INVALID"
  | "COMPOSE_INVALID"
  | "PORT_MISMATCH";

type Result = { name: string; ok: true; port: number } | { name: string; ok: false; reason: Reason; detail?: string };

const root = process.argv[2] || process.env.WORK_PROJECTS_ROOT || "/home/agent/work/projects";

function parsePort(v?: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

function envValue(text: string, key: string): string | undefined {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

async function validateProject(name: string): Promise<Result> {
  const path = join(root, name);
  try {
    const expose = await fs.readFile(join(path, ".expose.yml"), "utf8");
    if (!/enabled:\s*true\b/i.test(expose)) return { name, ok: false, reason: "EXPOSE_DISABLED" };
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
    if (!compose.includes("services:")) return { name, ok: false, reason: "COMPOSE_INVALID", detail: "missing services" };
    const direct = compose.includes(`${appPort}:`);
    const envMapped = compose.includes("${APP_PORT}");
    if (!direct && !envMapped) return { name, ok: false, reason: "PORT_MISMATCH", detail: `APP_PORT=${appPort}` };
  } catch {
    return { name, ok: false, reason: "COMPOSE_INVALID", detail: "compose.yaml unreadable" };
  }

  return { name, ok: true, port: appPort };
}

async function main() {
  const names = await fs.readdir(root).catch(() => [] as string[]);
  const results: Result[] = [];
  for (const name of names) {
    results.push(await validateProject(name));
  }
  for (const r of results) {
    if (r.ok) console.log(JSON.stringify({ project: r.name, ok: true, port: r.port }));
    else console.log(JSON.stringify({ project: r.name, ok: false, reason: r.reason, detail: r.detail || "" }));
  }
  const failures = results.filter((r) => !r.ok).length;
  process.exit(failures ? 2 : 0);
}

main();
