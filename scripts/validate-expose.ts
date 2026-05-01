#!/usr/bin/env node
/**
 * CLI reporter for project publish expose validation
 * Emits stable JSONL reason codes from the shared fail-closed validator
 */

import { validateProjectsExpose } from "./expose-validation.ts";

const root = process.argv[2] || process.env.WORK_PROJECTS_ROOT || "/home/agent/work/projects";

async function main() {
  const results = await validateProjectsExpose(root);
  for (const r of results) {
    if (r.ok) console.log(JSON.stringify({ project: r.name, ok: true, port: r.port }));
    else console.log(JSON.stringify({ project: r.name, ok: false, reason: r.reason, detail: r.detail || "" }));
  }
  const failures = results.filter((r) => !r.ok).length;
  process.exit(failures ? 2 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
