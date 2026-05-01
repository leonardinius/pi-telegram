/**
 * Regression tests for dynamic project ingress sync rendering
 * Guards validation-matrix routing and predictable reason summaries
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildIngressConfig,
  formatValidationMatrixLines,
  summarizeValidationMatrix,
} from "../scripts/sync-ingress.ts";
import type { ExposeValidationResult } from "../scripts/expose-validation.ts";

async function withProjects(filesByProject: Record<string, Record<string, string>>): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "pi-telegram-sync-ingress-"));
  for (const [name, files] of Object.entries(filesByProject)) {
    const project = join(root, name);
    await mkdir(project, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      await writeFile(join(project, file), content, "utf8");
    }
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("renders ingress routes from valid validation-matrix entries only", async () => {
  const fixture = await withProjects({
    "valid-app": {
      ".env": [
        "APP_BASIC_AUTH_USER=alice",
        "APP_BASIC_AUTH_PASS=secret",
        "APP_PUBLIC_URL=https://evil.example.test/",
        "",
      ].join("\n"),
    },
    "invalid-app": {
      ".env": "APP_BASIC_AUTH_PASS=do-not-read\n",
    },
  });
  const matrix: ExposeValidationResult[] = [
    { name: "valid-app", ok: true, port: 18080 },
    { name: "invalid-app", ok: false, reason: "APP_PORT_INVALID", detail: "APP_PORT=oops" },
  ];

  try {
    const result = await buildIngressConfig({
      root: fixture.root,
      baseDomain: "apps.example.test",
      matrix,
      hashPassword: async (plain) => `hashed:${plain}`,
    });

    assert.equal(result.routeCount, 1);
    assert.match(result.content, /http:\/\/valid-app-apps\.example\.test \{/);
    assert.match(result.content, /alice hashed:secret/);
    assert.match(result.content, /reverse_proxy 127\.0\.0\.1:18080/);
    assert.doesNotMatch(result.content, /invalid-app/);
    assert.doesNotMatch(result.content, /evil\.example\.test/);
  } finally {
    await fixture.cleanup();
  }
});

test("formats validation-matrix lines with stable reason-code summary", () => {
  const matrix: ExposeValidationResult[] = [
    { name: "valid-app", ok: true, port: 18080 },
    { name: "bad-port", ok: false, reason: "APP_PORT_INVALID", detail: "APP_PORT=oops" },
    { name: "disabled", ok: false, reason: "EXPOSE_DISABLED" },
  ];

  assert.deepEqual(formatValidationMatrixLines(matrix), [
    '{"event":"ingress_validation","project":"valid-app","ok":true,"port":18080}',
    '{"event":"ingress_validation","project":"bad-port","ok":false,"reason":"APP_PORT_INVALID","detail":"APP_PORT=oops"}',
    '{"event":"ingress_validation","project":"disabled","ok":false,"reason":"EXPOSE_DISABLED","detail":""}',
    '{"event":"ingress_validation_summary","total":3,"valid":1,"skipped":2,"reasons":{"EXPOSE_DISABLED":1,"APP_PORT_MISSING":0,"APP_PORT_INVALID":1,"COMPOSE_INVALID":0,"PORT_MISMATCH":0,"INVALID_PROJECT_SLUG":0}}',
  ]);

  assert.deepEqual(summarizeValidationMatrix(matrix), {
    total: 3,
    valid: 1,
    skipped: 2,
    reasons: {
      EXPOSE_DISABLED: 1,
      APP_PORT_MISSING: 0,
      APP_PORT_INVALID: 1,
      COMPOSE_INVALID: 0,
      PORT_MISMATCH: 0,
      INVALID_PROJECT_SLUG: 0,
    },
  });
});
