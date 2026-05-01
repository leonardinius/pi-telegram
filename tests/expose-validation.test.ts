/**
 * Regression tests for project publish expose validation
 * Guards fail-closed reason codes and the compose APP_PORT contract
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { validateProjectExpose } from "../scripts/expose-validation.ts";

async function withProject(
  name: string,
  files: Record<string, string>,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-expose-"));
  const project = join(root, name);
  await mkdir(project, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(project, file), content, "utf8");
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

const enabledExpose = "enabled: true\n";
const validEnv = "APP_PORT=18080\n";
const validCompose = [
  "services:",
  "  app:",
  "    ports:",
  "      - \"127.0.0.1:${APP_PORT}:3000\"",
  "",
].join("\n");

test("validates expose config with explicit loopback APP_PORT compose mapping", async () => {
  const fixture = await withProject("demo-app", {
    ".expose.yml": enabledExpose,
    ".env": validEnv,
    "compose.yaml": validCompose,
  });
  try {
    assert.deepEqual(await validateProjectExpose(fixture.root, "demo-app"), {
      name: "demo-app",
      ok: true,
      port: 18080,
    });
  } finally {
    await fixture.cleanup();
  }
});

test("rejects invalid project slugs with a stable reason code", async () => {
  const fixture = await withProject("Bad_Name", {
    ".expose.yml": enabledExpose,
    ".env": validEnv,
    "compose.yaml": validCompose,
  });
  try {
    assert.deepEqual(await validateProjectExpose(fixture.root, "Bad_Name"), {
      name: "Bad_Name",
      ok: false,
      reason: "INVALID_PROJECT_SLUG",
      detail: "expected lowercase letters, digits, and hyphen",
    });
  } finally {
    await fixture.cleanup();
  }
});

test("rejects compose mappings that do not bind APP_PORT on loopback", async () => {
  const fixture = await withProject("demo-app", {
    ".expose.yml": enabledExpose,
    ".env": validEnv,
    "compose.yaml": [
      "services:",
      "  app:",
      "    ports:",
      "      - \"0.0.0.0:${APP_PORT}:3000\"",
      "",
    ].join("\n"),
  });
  try {
    const result = await validateProjectExpose(fixture.root, "demo-app");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "PORT_MISMATCH");
      assert.equal(result.detail, "expected loopback host port APP_PORT=18080");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("accepts numeric APP_PORT compose mappings on loopback", async () => {
  const fixture = await withProject("demo-app", {
    ".expose.yml": enabledExpose,
    ".env": validEnv,
    "compose.yaml": [
      "services:",
      "  app:",
      "    ports:",
      "      - \"127.0.0.1:18080:3000\"",
      "",
    ].join("\n"),
  });
  try {
    const result = await validateProjectExpose(fixture.root, "demo-app");
    assert.equal(result.ok, true);
  } finally {
    await fixture.cleanup();
  }
});
