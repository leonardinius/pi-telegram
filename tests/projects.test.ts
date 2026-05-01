/**
 * Regression tests for Telegram project management UI helpers
 * Guards public publish URL display against per-project host override drift
 */

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TelegramProjectsRuntime } from "../lib/projects.ts";

async function withFakeDocker(): Promise<{ bin: string; restore: () => void }> {
  const bin = await mkdtemp(join(tmpdir(), "pi-telegram-projects-bin-"));
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "if [[ \"${1:-}\" == \"compose\" ]]; then",
      "  if printf '%s\\n' \"$@\" | grep -qx -- '-q'; then echo fake-container; exit 0; fi",
      "  if printf '%s\\n' \"$@\" | grep -qx -- '--format'; then echo 'app running'; exit 0; fi",
      "fi",
      "if [[ \"${1:-}\" == \"inspect\" ]]; then echo 'https://evil.example.test/'; exit 0; fi",
      "exit 0",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(docker, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath || ""}`;
  return {
    bin,
    restore: () => {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    },
  };
}

test("project list renders public host only from project name and managed base", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-projects-"));
  const fakeDocker = await withFakeDocker();
  try {
    const project = join(root, "valid-app");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "compose.yaml"), "services:\n  app:\n    image: nginx\n", "utf8");
    await writeFile(
      join(project, ".env"),
      [
        "APP_PORT=18080",
        "APP_PUBLIC_URL=https://evil.example.test/",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(join(project, ".expose.yml"), "enabled: true\n", "utf8");

    const runtime = new TelegramProjectsRuntime({
      root,
      publicBaseUrl: "https://apps.example.test/",
    });

    const [info] = await runtime.list();

    assert.equal(info?.publicUrl, "https://valid-app-apps.example.test/");
  } finally {
    fakeDocker.restore();
    await rm(fakeDocker.bin, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
