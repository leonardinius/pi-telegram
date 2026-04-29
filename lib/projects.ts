import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";

export interface TelegramProjectInfo {
  name: string;
  path: string;
  port?: string;
  url?: string;
  status: string;
}

export interface TelegramProjectsRuntimeOptions {
  root?: string;
  projectBin?: string;
  publicBaseUrl?: string;
}

export interface TelegramProjectsActionResult {
  ok: boolean;
  text: string;
}

export type TelegramProjectsCallbackAction =
  | { kind: "ignore" }
  | { kind: "refresh" }
  | { kind: "up"; name: string }
  | { kind: "down"; name: string }
  | { kind: "health"; name: string }
  | { kind: "create-help" }
  | { kind: "delete"; name: string };

const DEFAULT_ROOT = "/home/agent/work/projects";
const DEFAULT_PROJECT_BIN = "/home/agent/work/agent/bin/project";
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function envValue(text: string, key: string): string | undefined {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(`${key}=`));
  if (!line) return undefined;
  return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
}

function shellOut(command: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = typeof (error as NodeJS.ErrnoException | null)?.code === "number"
        ? Number((error as NodeJS.ErrnoException).code)
        : error
          ? 1
          : 0;
      resolve({ code, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function trimOutput(value: string, max = 1200): string {
  const text = value.trim();
  return text.length <= max ? text : text.slice(text.length - max);
}

export function parseTelegramProjectsCallbackData(data?: string): TelegramProjectsCallbackAction {
  if (!data?.startsWith("proj:")) return { kind: "ignore" };
  // allow delete action via callback data
  const [, action, name = ""] = data.split(":");
  if (action === "refresh") return { kind: "refresh" };
  if (action === "create") return { kind: "create-help" };
  if (action === "delete") return { kind: "delete", name }; // Handle delete action
  if ((action === "up" || action === "down" || action === "health") && PROJECT_NAME_RE.test(name)) {
    return { kind: action, name };
  }
  return { kind: "ignore" };
}

export class TelegramProjectsRuntime {
  // Pending deletes: chatId → projectName
  private readonly pendingDeleteChats = new Map<number, string>();

  /**
   * Start delete flow: ask for user confirmation
   */
  requestDelete(chatId: number, name: string): void {
    this.pendingDeleteChats.set(chatId, name);
  }

  /**
   * Handle user reply for delete confirmation
   * returns project name when confirmed,
   * empty string when cancelled or mismatch,
   * undefined when no pending delete
   */
  consumePendingDelete(chatId: number, text: string): string | undefined {
    if (!this.pendingDeleteChats.has(chatId)) return undefined;
    const name = this.pendingDeleteChats.get(chatId)!;
    this.pendingDeleteChats.delete(chatId);
    const typed = text.trim().toLowerCase();
    if (typed === `delete ${name}`) return name;
    // any other reply aborts
    return "";
  }
  // store pending delete requests: chatId -> projectName
  private readonly pendingDeleteChats = new Map<number, string>();

  readonly root: string;
  readonly projectBin: string;
  readonly publicBaseUrl?: string;
  private readonly pendingCreateChats = new Set<number>();
  private readonly pendingDeleteChats = new Map<number, string>();

  constructor(options: TelegramProjectsRuntimeOptions = {}) {
    this.root = options.root || process.env.WORK_PROJECTS_ROOT || DEFAULT_ROOT;
    this.projectBin = options.projectBin || process.env.PI_PROJECT_BIN || DEFAULT_PROJECT_BIN;
    this.publicBaseUrl = options.publicBaseUrl || process.env.PI_PROJECTS_PUBLIC_BASE_URL;
  }

  requestCreate(chatId: number): void {
    this.pendingCreateChats.add(chatId);
  }

  hasPendingCreate(chatId: number): boolean {
    return this.pendingCreateChats.has(chatId);
  }

  cancelPendingCreate(chatId: number): void {
    this.pendingCreateChats.delete(chatId);
  }

  async consumePendingCreate(chatId: number, text: string): Promise<TelegramProjectsActionResult | undefined> {
    if (!this.pendingCreateChats.has(chatId)) return undefined;
    this.pendingCreateChats.delete(chatId);
    const args = text.trim().split(/\s+/).filter(Boolean);
    const [name, template = "node", port] = args;
    if (!name || !PROJECT_NAME_RE.test(name) || !["node", "static", "nginx"].includes(template)) {
      return { ok: false, text: "Expected: NAME node|static [PORT], e.g. my-app node 18082" };
    }
    return this.run(["new", name, template === "nginx" ? "static" : template, port || ""].filter(Boolean));
  }

  async list(): Promise<TelegramProjectInfo[]> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.root);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const projects: TelegramProjectInfo[] = [];
    for (const name of entries.sort((a, b) => a.localeCompare(b))) {
      if (!PROJECT_NAME_RE.test(name)) continue;
      const path = join(this.root, name);
      const composePath = join(path, "compose.yaml");
      try {
        await fs.stat(composePath);
      } catch {
        continue;
      }
      let port: string | undefined;
      try {
        port = envValue(await fs.readFile(join(path, ".env"), "utf8"), "APP_PORT");
      } catch {}
      const ps = await shellOut("docker", ["compose", "--env-file", ".env", "-f", "compose.yaml", "ps", "--format", "{{.Service}} {{.Status}}"], path);
      const status = ps.code === 0 && ps.stdout.trim() ? ps.stdout.trim().replace(/\n/g, "; ") : "stopped";
      const base = this.publicBaseUrl?.replace(/\/$/, "");
      const url = port ? (base ? `${base}:${port}/` : `http://127.0.0.1:${port}/`) : undefined;
      projects.push({ name, path, port, url, status });
    }
    return projects;
  }

  async run(args: string[]): Promise<TelegramProjectsActionResult> {
    const result = await shellOut(this.projectBin, args);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      ok: result.code === 0,
      text: trimOutput(output || `exit=${result.code}`),
    };
  }

  /**
   * Delete a project folder permanently.
   */
  async deleteProject(name: string): Promise<TelegramProjectsActionResult> {
    const projectPath = join(this.root, name);
    // First, stop and remove Docker containers
    const down = await shellOut(this.projectBin, ["down", name]);
    // Then, delete the project folder
    const rm = await shellOut("rm", ["-rf", projectPath]);
    // Aggregate output
    const parts: string[] = [];
    if (down.stdout) parts.push(down.stdout.trim());
    if (down.stderr) parts.push(down.stderr.trim());
    if (rm.stdout) parts.push(rm.stdout.trim());
    if (rm.stderr) parts.push(rm.stderr.trim());
    const text = parts.join("\n");
    return {
      ok: down.code === 0 && rm.code === 0,
      text: text || `Deleted ${name}`,
    };
  }

  async renderHtml(): Promise<string> {
    const projects = await this.list();
    const lines = ["<b>Projects</b>"];
    if (!projects.length) {
      lines.push("No projects found.");
    } else {
      for (const project of projects) {
        lines.push(
          `\n<b>${htmlEscape(project.name)}</b>`,
          `status: <code>${htmlEscape(project.status)}</code>`,
          project.url ? `url: <code>${htmlEscape(project.url)}</code>` : "url: n/a",
        );
      }
    }
    lines.push("\nCreate: <code>/projects new NAME node 18082</code>");
    return lines.join("\n");
  }

  async replyMarkup(): Promise<{ inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
    const projects = await this.list();
    const rows: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: "🔄 Refresh", callback_data: "proj:refresh" },
        { text: "➕ Create project", callback_data: "proj:create" },
      ],
    ];
    // For each project, add health row, controls row, and delete button row
    for (const project of projects.slice(0, 10)) {
      rows.push([{ text: `📦 ${project.name}`, callback_data: `proj:health:${project.name}` }]);
      rows.push([
        { text: "▶️ Start", callback_data: `proj:up:${project.name}` },
        { text: "⏹ Stop", callback_data: `proj:down:${project.name}` },
        { text: "🩺 Health", callback_data: `proj:health:${project.name}` },
      ]);
      rows.push([
        { text: "❌😵 DELETE APP", callback_data: `proj:delete:${project.name}` },
      ]);
    }
    return { inline_keyboard: rows };
  }

  async handleTextCommand(argsText: string): Promise<TelegramProjectsActionResult | undefined> {
    const args = argsText.trim().split(/\s+/).filter(Boolean);
    if (!args.length) return undefined;
    const [command, name, templateOrPath, portOrTemplate, maybePath] = args;
    if (command === "new") {
      if (!name || !PROJECT_NAME_RE.test(name)) return { ok: false, text: "Usage: /projects new NAME [node|static] [PORT]" };
      return this.run(["new", name, templateOrPath || "node", portOrTemplate || ""] .filter(Boolean));
    }
    if (command === "init") {
      if (!name || !PROJECT_NAME_RE.test(name)) return { ok: false, text: "Usage: /projects init NAME [node|static|auto] [PORT] [PATH]" };
      return this.run(["init", name, templateOrPath || "auto", portOrTemplate || "", maybePath || ""] .filter(Boolean));
    }
    if (["up", "down", "restart", "health", "logs", "ps", "status"].includes(command)) {
      return this.run(args);
    }
    return { ok: false, text: "Usage: /projects [new|init|up|down|restart|health|ps|status] ..." };
  }
}
