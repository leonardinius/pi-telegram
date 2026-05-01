/**
 * Telegram bridge runtime-state helpers
 * Owns small session-local runtime primitives that are shared by orchestration but are not specific to queueing, rendering, polling, or Telegram transport
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TELEGRAM_TYPING_ACTION_INTERVAL_MS = 4000;
const AUTO_RELOAD_SMOKE_TIMEOUT_MS = 60_000;
const TELEGRAM_TMUX_RELOAD_TIMEOUT_MS = 10_000;

export interface TelegramPiSmokeTestResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface TelegramTmuxReloadResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface TelegramTmuxSendTextResult {
  ok: boolean;
  target: string;
  stdout: string;
  stderr: string;
  error?: string;
}

function resolveTmuxTargetFromList(stdout: string): string {
  if (/^work-pi:/m.test(stdout)) return "work-pi:0.0";
  if (/^pi:/m.test(stdout)) return "pi:0.0";
  const first = stdout.split(/\r?\n/).find((line) => line.trim());
  if (first) return `${first.split(":")[0]}:0.0`;
  return "work-pi:0.0";
}

export function resolveTmuxTarget(): Promise<string> {
  const explicit = process.env.PI_TMUX_TARGET || process.env.PI_TELEGRAM_TMUX_TARGET;
  if (explicit) return Promise.resolve(explicit);
  return new Promise((resolve) => {
    execFile("tmux", ["ls"], (error, stdout) => {
      if (error) {
        resolve("work-pi:0.0");
        return;
      }
      resolve(resolveTmuxTargetFromList(stdout));
    });
  });
}

export async function sendTextToTmuxPane(
  text: string,
): Promise<TelegramTmuxSendTextResult> {
  const target = await resolveTmuxTarget();
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["send-keys", "-t", target, "--", text, "Enter"],
      { timeout: TELEGRAM_TMUX_RELOAD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, target, stdout, stderr, error: (error as Error).message });
          return;
        }
        resolve({ ok: true, target, stdout, stderr });
      },
    );
  });
}

export function triggerTmuxTelegramReload(): Promise<TelegramTmuxReloadResult> {
  return new Promise((resolve) => {
    const target = process.env.PI_TELEGRAM_TMUX_TARGET || "work-pi:0.0";
    const command = process.env.PI_TELEGRAM_TMUX_RELOAD_CMD || "/telegram-tgreload-now";
    execFile(
      "tmux",
      ["send-keys", "-t", target, command, "Enter"],
      { timeout: TELEGRAM_TMUX_RELOAD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, stdout, stderr, error: (error as Error).message });
          return;
        }
        resolve({ ok: true, stdout, stderr });
      },
    );
  });
}

export function tailTelegramRuntimeText(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return text.slice(text.length - max);
}

export function runPiPingSmokeTest(
  cwd: string,
): Promise<TelegramPiSmokeTestResult> {
  return new Promise((resolve) => {
    const home = process.env.HOME || ".";
    const defaultPiPath = join(home, ".npm-global", "bin", "pi");
    const piCmd = existsSync(defaultPiPath) ? defaultPiPath : "pi";
    const args = ["--no-session", "--offline", "-p", "ping"];
    const baseEnv = {
      HOME: home,
      USER: process.env.USER || "agent",
      PATH: `${home}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`,
      PI_TELEGRAM_AUTOSTART: "0",
      PI_OFFLINE: "1",
      RTK_DISABLE: "1",
      PI_TUI: "0",
      PI_MEMORY_RECALL: "0",
    } as NodeJS.ProcessEnv;
    const cwdPrimary = existsSync(cwd) ? cwd : process.cwd();
    const cwdFallback = home;

    const runOnce = (useCwd: string): Promise<TelegramPiSmokeTestResult> =>
      new Promise((res) => {
        const child = spawn(piCmd, args, {
          cwd: useCwd,
          env: baseEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        let sawPong = false;
        const timer = setTimeout(() => {
          try { child.kill("SIGTERM"); } catch {}
        }, AUTO_RELOAD_SMOKE_TIMEOUT_MS);
        child.stdout?.on("data", (chunk) => {
          const text = String(chunk);
          out += text;
          if (!sawPong && /pong/i.test(text)) sawPong = true;
        });
        child.stderr?.on("data", (chunk) => {
          err += String(chunk);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          const hasExtensionError = err.includes("Extension error");
          if (sawPong || (code === 0 && /pong/i.test(out))) {
            res({ ok: true, stdout: out, stderr: err });
            return;
          }
          const parts = [
            code !== null && code !== undefined ? `code=${code}` : "",
            signal ? `signal=${signal}` : "",
            `cwd=${useCwd}`,
            `piCmd=${piCmd}`,
          ].filter(Boolean);
          res({
            ok: false,
            stdout: out,
            stderr: err,
            error: hasExtensionError
              ? "pi smoke test reported extension errors"
              : parts.join(" "),
          });
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          res({ ok: false, stdout: out, stderr: err, error: (error as Error).message });
        });
      });

    (async () => {
      const first = await runOnce(cwdPrimary);
      if (first.ok) {
        resolve(first);
        return;
      }
      const needRetry = first.stderr.trim().length === 0 && cwdPrimary !== cwdFallback;
      if (!needRetry) {
        resolve(first);
        return;
      }
      const second = await runOnce(cwdFallback);
      if (second.ok) {
        resolve(second);
        return;
      }
      resolve({
        ok: false,
        stdout: second.stdout || first.stdout,
        stderr: second.stderr || first.stderr,
        error: second.error || first.error,
      });
    })().catch((err) => {
      resolve({ ok: false, stdout: "", stderr: "", error: String(err) });
    });
  });
}

export interface TelegramRuntimeQueueCounters {
  nextQueuedTelegramItemOrder: number;
  nextQueuedTelegramControlOrder: number;
  nextPriorityReactionOrder: number;
}

export interface TelegramRuntimeLifecycleFlags {
  activeTelegramToolExecutions: number;
  telegramTurnDispatchPending: boolean;
  compactionInProgress: boolean;
  preserveQueuedTurnsAsHistory: boolean;
  setupInProgress: boolean;
}

export interface TelegramBridgeRuntimeState
  extends TelegramRuntimeQueueCounters, TelegramRuntimeLifecycleFlags {
  abortHandler?: () => void;
  typingInterval?: ReturnType<typeof setInterval>;
}

export interface TelegramRuntimeQueuePort {
  syncCounters: (counters: Partial<TelegramRuntimeQueueCounters>) => void;
  allocateItemOrder: () => number;
  allocateControlOrder: () => number;
  getNextPriorityReactionOrder: () => number;
  incrementNextPriorityReactionOrder: () => void;
}

export interface TelegramRuntimeLifecyclePort {
  syncFlags: (flags: Partial<TelegramRuntimeLifecycleFlags>) => void;
  getActiveToolExecutions: () => number;
  setActiveToolExecutions: (count: number) => void;
  resetActiveToolExecutions: () => void;
  hasDispatchPending: () => boolean;
  setDispatchPending: (pending: boolean) => void;
  clearDispatchPending: () => void;
  isCompactionInProgress: () => boolean;
  setCompactionInProgress: (inProgress: boolean) => void;
  shouldPreserveQueuedTurnsAsHistory: () => boolean;
  setPreserveQueuedTurnsAsHistory: (preserve: boolean) => void;
}

export interface TelegramRuntimeSetupPort {
  isInProgress: () => boolean;
  start: () => boolean;
  finish: () => void;
}

export interface TelegramRuntimeAbortPort {
  hasHandler: () => boolean;
  setHandler: (abortHandler: () => void) => void;
  clearHandler: () => void;
  getHandler: () => (() => void) | undefined;
  abortTurn: () => boolean;
}

export interface TelegramRuntimeTypingPort {
  start: (deps: TelegramTypingLoopDeps) => boolean;
  stop: () => boolean;
}

export interface TelegramBridgeRuntime {
  state: TelegramBridgeRuntimeState;
  queue: TelegramRuntimeQueuePort;
  lifecycle: TelegramRuntimeLifecyclePort;
  setup: TelegramRuntimeSetupPort;
  abort: TelegramRuntimeAbortPort;
  typing: TelegramRuntimeTypingPort;
}

export function createTelegramBridgeRuntimeState(): TelegramBridgeRuntimeState {
  return {
    nextQueuedTelegramItemOrder: 0,
    nextQueuedTelegramControlOrder: 0,
    nextPriorityReactionOrder: 0,
    activeTelegramToolExecutions: 0,
    telegramTurnDispatchPending: false,
    compactionInProgress: false,
    preserveQueuedTurnsAsHistory: false,
    setupInProgress: false,
  };
}

export function createTelegramBridgeRuntime(
  state = createTelegramBridgeRuntimeState(),
): TelegramBridgeRuntime {
  return {
    state,
    queue: {
      syncCounters: (counters) =>
        syncTelegramQueueRuntimeCounters(state, counters),
      allocateItemOrder: () => allocateTelegramQueueItemOrder(state),
      allocateControlOrder: () => allocateTelegramQueueControlOrder(state),
      getNextPriorityReactionOrder: () =>
        getNextTelegramPriorityReactionOrder(state),
      incrementNextPriorityReactionOrder: () =>
        incrementNextTelegramPriorityReactionOrder(state),
    },
    lifecycle: {
      syncFlags: (flags) => syncTelegramLifecycleRuntimeFlags(state, flags),
      getActiveToolExecutions: () => getActiveTelegramToolExecutions(state),
      setActiveToolExecutions: (count) =>
        setActiveTelegramToolExecutions(state, count),
      resetActiveToolExecutions: () => resetActiveTelegramToolExecutions(state),
      hasDispatchPending: () => hasTelegramDispatchPending(state),
      setDispatchPending: (pending) =>
        setTelegramDispatchPending(state, pending),
      clearDispatchPending: () => clearTelegramDispatchPending(state),
      isCompactionInProgress: () => isTelegramCompactionInProgress(state),
      setCompactionInProgress: (inProgress) =>
        setTelegramCompactionInProgress(state, inProgress),
      shouldPreserveQueuedTurnsAsHistory: () =>
        shouldPreserveQueuedTurnsAsHistory(state),
      setPreserveQueuedTurnsAsHistory: (preserve) =>
        setPreserveQueuedTurnsAsHistory(state, preserve),
    },
    setup: {
      isInProgress: () => isTelegramSetupInProgress(state),
      start: () => startTelegramSetup(state),
      finish: () => finishTelegramSetup(state),
    },
    abort: {
      hasHandler: () => hasTelegramAbortHandler(state),
      setHandler: (abortHandler) =>
        setTelegramAbortHandler(state, abortHandler),
      clearHandler: () => clearTelegramAbortHandler(state),
      getHandler: () => getTelegramAbortHandler(state),
      abortTurn: () => abortTelegramTurn(state),
    },
    typing: {
      start: (deps) => startTelegramTypingLoop(state, deps),
      stop: () => stopTelegramTypingLoop(state),
    },
  };
}

export function syncTelegramQueueRuntimeCounters(
  state: TelegramBridgeRuntimeState,
  counters: Partial<TelegramRuntimeQueueCounters>,
): void {
  if (counters.nextQueuedTelegramItemOrder !== undefined) {
    state.nextQueuedTelegramItemOrder = counters.nextQueuedTelegramItemOrder;
  }
  if (counters.nextQueuedTelegramControlOrder !== undefined) {
    state.nextQueuedTelegramControlOrder =
      counters.nextQueuedTelegramControlOrder;
  }
  if (counters.nextPriorityReactionOrder !== undefined) {
    state.nextPriorityReactionOrder = counters.nextPriorityReactionOrder;
  }
}

export function allocateTelegramQueueItemOrder(
  state: TelegramBridgeRuntimeState,
): number {
  return state.nextQueuedTelegramItemOrder++;
}

export function allocateTelegramQueueControlOrder(
  state: TelegramBridgeRuntimeState,
): number {
  return state.nextQueuedTelegramControlOrder++;
}

export function getNextTelegramPriorityReactionOrder(
  state: TelegramBridgeRuntimeState,
): number {
  return state.nextPriorityReactionOrder;
}

export function incrementNextTelegramPriorityReactionOrder(
  state: TelegramBridgeRuntimeState,
): void {
  state.nextPriorityReactionOrder += 1;
}

export function syncTelegramLifecycleRuntimeFlags(
  state: TelegramBridgeRuntimeState,
  flags: Partial<TelegramRuntimeLifecycleFlags>,
): void {
  if (flags.activeTelegramToolExecutions !== undefined) {
    state.activeTelegramToolExecutions = flags.activeTelegramToolExecutions;
  }
  if (flags.telegramTurnDispatchPending !== undefined) {
    state.telegramTurnDispatchPending = flags.telegramTurnDispatchPending;
  }
  if (flags.compactionInProgress !== undefined) {
    state.compactionInProgress = flags.compactionInProgress;
  }
  if (flags.preserveQueuedTurnsAsHistory !== undefined) {
    state.preserveQueuedTurnsAsHistory = flags.preserveQueuedTurnsAsHistory;
  }
  if (flags.setupInProgress !== undefined) {
    state.setupInProgress = flags.setupInProgress;
  }
}

export function getActiveTelegramToolExecutions(
  state: TelegramBridgeRuntimeState,
): number {
  return state.activeTelegramToolExecutions;
}

export function setActiveTelegramToolExecutions(
  state: TelegramBridgeRuntimeState,
  count: number,
): void {
  state.activeTelegramToolExecutions = count;
}

export function resetActiveTelegramToolExecutions(
  state: TelegramBridgeRuntimeState,
): void {
  state.activeTelegramToolExecutions = 0;
}

export function hasTelegramDispatchPending(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.telegramTurnDispatchPending;
}

function setTelegramDispatchPending(
  state: TelegramBridgeRuntimeState,
  pending: boolean,
): void {
  state.telegramTurnDispatchPending = pending;
}

export function clearTelegramDispatchPending(
  state: TelegramBridgeRuntimeState,
): void {
  state.telegramTurnDispatchPending = false;
}

export function isTelegramCompactionInProgress(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.compactionInProgress;
}

export function setTelegramCompactionInProgress(
  state: TelegramBridgeRuntimeState,
  inProgress: boolean,
): void {
  state.compactionInProgress = inProgress;
}

export function shouldPreserveQueuedTurnsAsHistory(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.preserveQueuedTurnsAsHistory;
}

export function setPreserveQueuedTurnsAsHistory(
  state: TelegramBridgeRuntimeState,
  preserve: boolean,
): void {
  state.preserveQueuedTurnsAsHistory = preserve;
}

export function isTelegramSetupInProgress(
  state: TelegramBridgeRuntimeState,
): boolean {
  return state.setupInProgress;
}

export function startTelegramSetup(state: TelegramBridgeRuntimeState): boolean {
  if (state.setupInProgress) return false;
  state.setupInProgress = true;
  return true;
}

export function finishTelegramSetup(state: TelegramBridgeRuntimeState): void {
  state.setupInProgress = false;
}

export function hasTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
): boolean {
  return !!state.abortHandler;
}

export function setTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
  abortHandler: () => void,
): void {
  state.abortHandler = abortHandler;
}

export function clearTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
): void {
  state.abortHandler = undefined;
}

export function getTelegramAbortHandler(
  state: TelegramBridgeRuntimeState,
): (() => void) | undefined {
  return state.abortHandler;
}

export function abortTelegramTurn(state: TelegramBridgeRuntimeState): boolean {
  if (!state.abortHandler) return false;
  state.abortHandler();
  return true;
}

export interface TelegramTypingLoopDeps {
  chatId: number | undefined;
  intervalMs: number;
  sendTypingAction: (chatId: number) => Promise<unknown>;
}

export interface TelegramRuntimeEventRecorderPort {
  recordRuntimeEvent?: (
    category: string,
    error: unknown,
    details?: Record<string, unknown>,
  ) => void;
}

export interface TelegramTypingLoopStarterDeps<TContext>
  extends TelegramRuntimeEventRecorderPort {
  typing: TelegramRuntimeTypingPort;
  getDefaultChatId: () => number | undefined;
  sendTypingAction: (chatId: number) => Promise<unknown>;
  updateStatus: (ctx: TContext, error?: string) => void;
  intervalMs?: number;
}

export function createTelegramTypingLoopStarter<TContext>(
  deps: TelegramTypingLoopStarterDeps<TContext>,
): (ctx: TContext, chatId?: number) => void {
  return (ctx, chatId) => {
    deps.typing.start({
      chatId: chatId ?? deps.getDefaultChatId(),
      intervalMs: deps.intervalMs ?? TELEGRAM_TYPING_ACTION_INTERVAL_MS,
      sendTypingAction: async (targetChatId) => {
        try {
          await deps.sendTypingAction(targetChatId);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          deps.recordRuntimeEvent?.("typing", error, {
            chatId: targetChatId,
          });
          deps.updateStatus(ctx, `typing failed: ${message}`);
        }
      },
    });
  };
}

export function startTelegramTypingLoop(
  state: TelegramBridgeRuntimeState,
  deps: TelegramTypingLoopDeps,
): boolean {
  if (state.typingInterval || deps.chatId === undefined) return false;
  const sendTyping = (): void => {
    void deps.sendTypingAction(deps.chatId as number);
  };
  sendTyping();
  state.typingInterval = setInterval(sendTyping, deps.intervalMs);
  return true;
}

export function stopTelegramTypingLoop(
  state: TelegramBridgeRuntimeState,
): boolean {
  if (!state.typingInterval) return false;
  clearInterval(state.typingInterval);
  state.typingInterval = undefined;
  return true;
}

export function createTelegramContextAbortHandlerSetter<
  TContext extends { abort: () => void },
>(
  abort: Pick<TelegramRuntimeAbortPort, "setHandler">,
): (ctx: TContext) => void {
  return (ctx) => {
    abort.setHandler(() => ctx.abort());
  };
}

export interface TelegramAgentEndResetDeps {
  abort: Pick<TelegramRuntimeAbortPort, "clearHandler">;
  typing: Pick<TelegramRuntimeTypingPort, "stop">;
  clearActiveTurn: () => void;
  resetToolExecutions: () => void;
  clearPendingModelSwitch: () => void;
  clearDispatchPending: () => void;
}

export function createTelegramAgentEndResetter(
  deps: TelegramAgentEndResetDeps,
): () => void {
  return () => {
    deps.abort.clearHandler();
    deps.typing.stop();
    deps.clearActiveTurn();
    deps.resetToolExecutions();
    deps.clearPendingModelSwitch();
    deps.clearDispatchPending();
  };
}

export interface TelegramPromptDispatchLifecycleDeps<TContext>
  extends TelegramRuntimeEventRecorderPort {
  lifecycle: Pick<
    TelegramRuntimeLifecyclePort,
    "setDispatchPending" | "clearDispatchPending"
  >;
  typing: Pick<TelegramRuntimeTypingPort, "stop">;
  startTypingLoop: (ctx: TContext, chatId?: number) => void;
  updateStatus: (ctx: TContext, error?: string) => void;
}

export interface TelegramPromptDispatchRuntimeDeps<TContext>
  extends TelegramRuntimeEventRecorderPort {
  lifecycle: TelegramPromptDispatchLifecycleDeps<TContext>["lifecycle"];
  typing: TelegramRuntimeTypingPort;
  getDefaultChatId: () => number | undefined;
  sendTypingAction: (chatId: number) => Promise<unknown>;
  updateStatus: (ctx: TContext, error?: string) => void;
  intervalMs?: number;
}

export interface TelegramPromptDispatchRuntime<TContext> {
  startTypingLoop: (ctx: TContext, chatId?: number) => void;
  onPromptDispatchStart: (ctx: TContext, chatId?: number) => void;
  onPromptDispatchFailure: (ctx: TContext, message: string) => void;
}

export function createTelegramPromptDispatchRuntime<TContext>(
  deps: TelegramPromptDispatchRuntimeDeps<TContext>,
): TelegramPromptDispatchRuntime<TContext> {
  const startTypingLoop = createTelegramTypingLoopStarter(deps);
  return {
    startTypingLoop,
    ...createTelegramPromptDispatchLifecycle({
      lifecycle: deps.lifecycle,
      typing: deps.typing,
      startTypingLoop,
      updateStatus: deps.updateStatus,
      recordRuntimeEvent: deps.recordRuntimeEvent,
    }),
  };
}

export function createTelegramPromptDispatchLifecycle<TContext>(
  deps: TelegramPromptDispatchLifecycleDeps<TContext>,
) {
  return {
    onPromptDispatchStart: (ctx: TContext, chatId?: number): void => {
      deps.lifecycle.setDispatchPending(true);
      deps.startTypingLoop(ctx, chatId);
      deps.updateStatus(ctx);
    },
    onPromptDispatchFailure: (ctx: TContext, message: string): void => {
      deps.lifecycle.clearDispatchPending();
      deps.typing.stop();
      deps.recordRuntimeEvent?.("dispatch", new Error(message));
      deps.updateStatus(ctx, `dispatch failed: ${message}`);
    },
  };
}
