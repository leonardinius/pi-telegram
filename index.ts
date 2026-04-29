/**
 * Telegram bridge extension entrypoint and orchestration layer
 * Keeps the runtime wiring in one place while delegating reusable domain logic to /lib modules
 */

import * as Api from "./lib/api.ts";
import * as Attachments from "./lib/attachments.ts";
import * as Commands from "./lib/commands.ts";
import * as Config from "./lib/config.ts";
import * as Media from "./lib/media.ts";
import * as Menu from "./lib/menu.ts";
import * as Model from "./lib/model.ts";
import * as Pi from "./lib/pi.ts";
import * as Polling from "./lib/polling.ts";
import * as Preview from "./lib/preview.ts";
import * as Projects from "./lib/projects.ts";
import * as Queue from "./lib/queue.ts";
import * as Registration from "./lib/registration.ts";
import * as Replies from "./lib/replies.ts";
import * as Runtime from "./lib/runtime.ts";
import * as Setup from "./lib/setup.ts";
import * as Status from "./lib/status.ts";
import * as Turns from "./lib/turns.ts";
import * as Updates from "./lib/updates.ts";

type ActivePiModel = NonNullable<Pi.ExtensionContext["model"]>;
type RuntimeTelegramQueueItem = Queue.TelegramQueueItem<Pi.ExtensionContext>;

// --- Extension Runtime ---

export default function (pi: Pi.ExtensionAPI) {
  const TELEGRAM_AUTOSTART_ENV = process.env.PI_TELEGRAM_AUTOSTART?.toLowerCase();
  const telegramAutostartEnabled = !(
    TELEGRAM_AUTOSTART_ENV === "0" ||
    TELEGRAM_AUTOSTART_ENV === "false" ||
    TELEGRAM_AUTOSTART_ENV === "no"
  );
  const piRuntime = Pi.createExtensionApiRuntimePorts(pi);
  const bridgeRuntime = Runtime.createTelegramBridgeRuntime();
  const configStore = Config.createTelegramConfigStore();
  const activeTurnRuntime = Queue.createTelegramActiveTurnStore();
  const pendingModelSwitchStore =
    Model.createPendingModelSwitchStore<
      Model.ScopedTelegramModel<ActivePiModel>
    >();
  const modelMenuRuntime = Menu.createTelegramModelMenuRuntime<ActivePiModel>();
  const runtimeEvents = Status.createTelegramRuntimeEventRecorder({
    getBotToken: configStore.getBotToken,
  });
  const mediaGroupRuntime =
    Media.createTelegramMediaGroupController<Api.TelegramMessage>();
  const telegramQueueStore =
    Queue.createTelegramQueueStore<Pi.ExtensionContext>();
  const projectsRuntime = new Projects.TelegramProjectsRuntime();
  const pollingControllerState = Polling.createTelegramPollingControllerState();
  const { getStatusLines, updateStatus } =
    Status.createTelegramBridgeStatusRuntime<
      Pi.ExtensionContext,
      RuntimeTelegramQueueItem
    >({
      getConfig: configStore.get,
      isPollingActive: Polling.createTelegramPollingActivityReader(
        pollingControllerState,
      ),
      getActiveSourceMessageIds: activeTurnRuntime.getSourceMessageIds,
      hasActiveTurn: activeTurnRuntime.has,
      hasDispatchPending: bridgeRuntime.lifecycle.hasDispatchPending,
      isCompactionInProgress: bridgeRuntime.lifecycle.isCompactionInProgress,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      hasPendingModelSwitch: pendingModelSwitchStore.has,
      getQueuedItems: telegramQueueStore.getQueuedItems,
      formatQueuedStatus: Queue.formatQueuedTelegramItemsStatus,
      getRecentRuntimeEvents: runtimeEvents.getEvents,
    });
  const currentModelRuntime = Model.createCurrentModelRuntime<
    Pi.ExtensionContext,
    ActivePiModel
  >({
    getContextModel: Pi.getExtensionContextModel,
    updateStatus,
  });
  const queueMutationRuntime =
    Queue.createTelegramQueueMutationController<Pi.ExtensionContext>({
      ...telegramQueueStore,
      getNextPriorityReactionOrder:
        bridgeRuntime.queue.getNextPriorityReactionOrder,
      incrementNextPriorityReactionOrder:
        bridgeRuntime.queue.incrementNextPriorityReactionOrder,
      updateStatus,
    });

  // --- Telegram API ---

  const {
    callMultipart,
    deleteWebhook,
    getUpdates,
    setMyCommands,
    sendTypingAction,
    sendMessageDraft,
    sendMessage,
    downloadFile: downloadTelegramBridgeFile,
    editMessageText: editTelegramMessageText,
    addMessageReaction,
    answerCallbackQuery,
    prepareTempDir,
  } = Api.createDefaultTelegramBridgeApiRuntime({
    getBotToken: configStore.getBotToken,
    recordRuntimeEvent: runtimeEvents.record,
  });

  // --- Message Delivery & Preview ---

  const promptDispatchRuntime =
    Runtime.createTelegramPromptDispatchRuntime<Pi.ExtensionContext>({
      lifecycle: bridgeRuntime.lifecycle,
      typing: bridgeRuntime.typing,
      getDefaultChatId: activeTurnRuntime.getChatId,
      sendTypingAction,
      updateStatus,
      recordRuntimeEvent: runtimeEvents.record,
    });

  // --- Reply Runtime Wiring ---

  const {
    replyTransport,
    sendTextReply,
    sendMarkdownReply,
    editInteractiveMessage,
    sendInteractiveMessage,
  } =
    Replies.createTelegramRenderedMessageDeliveryRuntime<Menu.TelegramReplyMarkup>(
      {
        sendMessage,
        editMessage: editTelegramMessageText,
      },
    );
  const dispatchNextQueuedTelegramTurn =
    Queue.createTelegramQueueDispatchRuntime<Pi.ExtensionContext>({
      ...telegramQueueStore,
      isCompactionInProgress: bridgeRuntime.lifecycle.isCompactionInProgress,
      hasActiveTurn: activeTurnRuntime.has,
      hasDispatchPending: bridgeRuntime.lifecycle.hasDispatchPending,
      isIdle: Pi.isExtensionContextIdle,
      hasPendingMessages: Pi.hasExtensionContextPendingMessages,
      updateStatus,
      sendTextReply,
      recordRuntimeEvent: runtimeEvents.record,
      ...promptDispatchRuntime,
      sendUserMessage: piRuntime.sendUserMessage,
    }).dispatchNext;
  const previewRuntime = Preview.createTelegramAssistantPreviewRuntime({
    getActiveTurn: activeTurnRuntime.get,
    isAssistantMessage: Replies.isAssistantAgentMessage,
    getMessageText: Replies.getAgentMessageText,
    getDefaultReplyToMessageId: activeTurnRuntime.getReplyToMessageId,
    sendDraft: sendMessageDraft,
    sendMessage,
    editMessageText: editTelegramMessageText,
    ...replyTransport,
  });

  // --- Bridge Setup ---

  const modelSwitchController =
    Model.createTelegramModelSwitchControllerRuntime<
      Pi.ExtensionContext,
      Model.ScopedTelegramModel<ActivePiModel>
    >({
      isIdle: Pi.isExtensionContextIdle,
      getPendingModelSwitch: pendingModelSwitchStore.get,
      setPendingModelSwitch: pendingModelSwitchStore.set,
      getActiveTurn: activeTurnRuntime.get,
      getAbortHandler: bridgeRuntime.abort.getHandler,
      hasAbortHandler: bridgeRuntime.abort.hasHandler,
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
      allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
      appendQueuedItem: queueMutationRuntime.append,
      updateStatus,
    });
  const menuActions = Menu.createTelegramMenuActionRuntimeWithStateBuilder<
    ActivePiModel,
    Pi.ExtensionContext
  >({
    runtime: modelMenuRuntime,
    createSettingsManager: Pi.createSettingsManager,
    getActiveModel: currentModelRuntime.get,
    getThinkingLevel: piRuntime.getThinkingLevel,
    buildStatusHtml: Status.createTelegramStatusHtmlBuilder({
      getActiveModel: currentModelRuntime.get,
    }),
    storeModelMenuState: modelMenuRuntime.storeState,
    isIdle: Pi.isExtensionContextIdle,
    canOfferInFlightModelSwitch: modelSwitchController.canOfferInFlightSwitch,
    sendTextReply,
    editInteractiveMessage,
    sendInteractiveMessage,
  });

  const handleAutoReloadCommand =
    Commands.createTelegramAutoReloadCommandHandler<
      Api.TelegramMessage,
      Pi.ExtensionContext
    >({
      runSmokeTest: Runtime.runPiPingSmokeTest,
      tailText: Runtime.tailTelegramRuntimeText,
      getCwd: Pi.getExtensionContextCwd,
      isIdle: Pi.isExtensionContextIdle,
      sendReloadCommand: piRuntime.sendUserMessage,
      sendTextReply: async (message, text) => {
        await sendTextReply(message.chat.id, message.message_id, text);
      },
    });

  const sendProjectsMenu = async (chatId: number): Promise<void> => {
    await sendInteractiveMessage(
      chatId,
      await projectsRuntime.renderHtml(),
      "html",
      await projectsRuntime.replyMarkup(),
    );
  };

  const handleProjectsCommand = async (
    message: Api.TelegramMessage,
  ): Promise<void> => {
    const rawText = message.text || message.caption || "";
    const argsText = rawText.replace(/^\/projects(?:@\w+)?\s*/i, "").trim();
    const result = await projectsRuntime.handleTextCommand(argsText);
    if (result) {
      await sendTextReply(
        message.chat.id,
        message.message_id,
        `${result.ok ? "OK" : "Failed"}: ${result.text}`,
      );
    }
    await sendProjectsMenu(message.chat.id);
  };

  const handleProjectsCallback = async (
    query: Api.TelegramCallbackQuery,
  ): Promise<boolean> => {
    const action = Projects.parseTelegramProjectsCallbackData(query.data);
    if (action.kind === "ignore") return false;
    const message = query.message;
    if (!message?.chat?.id || !message.message_id) {
      await answerCallbackQuery(query.id, "Missing Telegram message context.");
      return true;
    }
    let notice = "";
    if (action.kind === "create-help") {
      projectsRuntime.requestCreate(message.chat.id);
      notice = "Create: reply with <code>NAME node|static [PORT]</code>, e.g. <code>my-app node 18082</code>";
      await answerCallbackQuery(query.id, "Reply with: NAME node|static [PORT]");
      await sendTextReply(
        message.chat.id,
        message.message_id,
        "Project create: reply with `NAME node|static [PORT]`, e.g. `my-app node 18082`",
      );
    } else if (action.kind === "delete") {
      // Begin delete flow: ask for irreversible confirmation
      projectsRuntime.requestDelete(message.chat.id, action.name);
      notice = `☠️❌ IRREVERSIBLE: delete app '${action.name}'?`;
      await answerCallbackQuery(query.id, `Confirm delete ${action.name}`);
      await sendTextReply(
        message.chat.id,
        message.message_id,
        `☠️❌ IRREVERSIBLE\nDelete app '${action.name}'?\nReply: delete ${action.name} or cancel`,
      );
    } else if (action.kind === "up" || action.kind === "down" || action.kind === "health") {
      const result = await projectsRuntime.run([action.kind, action.name]);
      notice = `<b>${result.ok ? "OK" : "Failed"} / ${action.kind} ${action.name}</b>\n<code>${result.text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code>`;
      const plainNotice = `${result.ok ? "OK" : "Failed"}: project ${action.kind} ${action.name}\n${result.text}`;
      await answerCallbackQuery(query.id, `${result.ok ? "OK" : "Failed"}: ${result.text}`.slice(0, 180));
      await sendTextReply(message.chat.id, message.message_id, plainNotice);
    } else {
      await answerCallbackQuery(query.id);
    }
    const menuHtml = await projectsRuntime.renderHtml();
    await editInteractiveMessage(
      message.chat.id,
      message.message_id,
      notice ? `${menuHtml}\n\n${notice}` : menuHtml,
      "html",
      await projectsRuntime.replyMarkup(),
    );
    return true;
  };

  // --- Polling ---

  const pollingRuntime = Polling.createTelegramPollingControllerRuntime<
    Api.TelegramUpdate,
    Pi.ExtensionContext
  >({
    state: pollingControllerState,
    getConfig: configStore.get,
    hasBotToken: configStore.hasBotToken,
    deleteWebhook,
    getUpdates,
    persistConfig: configStore.persist,
    handleUpdate: Updates.createTelegramPairedUpdateRuntime<
      Pi.ExtensionContext,
      Api.TelegramUpdate
    >({
      getAllowedUserId: configStore.getAllowedUserId,
      setAllowedUserId: configStore.setAllowedUserId,
      persistConfig: configStore.persist,
      updateStatus,
      removePendingMediaGroupMessages: mediaGroupRuntime.removeMessages,
      removeQueuedTelegramTurnsByMessageIds:
        queueMutationRuntime.removeByMessageIds,
      clearQueuedTelegramTurnPriorityByMessageId:
        queueMutationRuntime.clearPriorityByMessageId,
      prioritizeQueuedTelegramTurnByMessageId:
        queueMutationRuntime.prioritizeByMessageId,
      answerCallbackQuery,
      handleAuthorizedTelegramCallbackQuery: async (query, ctx) => {
        if (await handleProjectsCallback(query)) return;
        await Menu.createTelegramMenuCallbackHandlerForContext<
          Api.TelegramCallbackQuery,
          Pi.ExtensionContext,
          ActivePiModel
        >({
          getStoredModelMenuState: modelMenuRuntime.getState,
          getActiveModel: currentModelRuntime.get,
          getThinkingLevel: piRuntime.getThinkingLevel,
          setThinkingLevel: piRuntime.setThinkingLevel,
          updateStatus,
          updateModelMenuMessage: menuActions.updateModelMenuMessage,
          updateThinkingMenuMessage: menuActions.updateThinkingMenuMessage,
          updateStatusMessage: menuActions.updateStatusMessage,
          answerCallbackQuery,
          isIdle: Pi.isExtensionContextIdle,
          hasActiveTelegramTurn: activeTurnRuntime.has,
          hasAbortHandler: bridgeRuntime.abort.hasHandler,
          getActiveToolExecutions:
            bridgeRuntime.lifecycle.getActiveToolExecutions,
          setModel: piRuntime.setModel,
          setCurrentModel: currentModelRuntime.setCurrentModel,
          stagePendingModelSwitch: modelSwitchController.stagePendingSwitch,
          restartInterruptedTelegramTurn:
            modelSwitchController.restartInterruptedTurn,
        })(query, ctx);
      },
      sendTextReply,
      handleAuthorizedTelegramMessage:
        Media.createTelegramMediaGroupDispatchRuntime<
          Api.TelegramMessage,
          Pi.ExtensionContext
        >({
          mediaGroups: mediaGroupRuntime,
          dispatchMessages: Commands.createTelegramCommandOrPromptRuntime<
            Api.TelegramMessage,
            Pi.ExtensionContext
          >({
            extractRawText: Media.extractFirstTelegramMessageText,
            handleCommand: Commands.createTelegramCommandHandlerTargetRuntime<
              Api.TelegramMessage,
              Pi.ExtensionContext
            >({
              hasAbortHandler: bridgeRuntime.abort.hasHandler,
              clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
              hasQueuedTelegramItems: telegramQueueStore.hasQueuedItems,
              setPreserveQueuedTurnsAsHistory:
                bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory,
              abortCurrentTurn: bridgeRuntime.abort.abortTurn,
              handleAutoReload: handleAutoReloadCommand,
              isIdle: Pi.isExtensionContextIdle,
              hasPendingMessages: Pi.hasExtensionContextPendingMessages,
              hasActiveTelegramTurn: activeTurnRuntime.has,
              hasDispatchPending: bridgeRuntime.lifecycle.hasDispatchPending,
              isCompactionInProgress:
                bridgeRuntime.lifecycle.isCompactionInProgress,
              setCompactionInProgress:
                bridgeRuntime.lifecycle.setCompactionInProgress,
              updateStatus,
              dispatchNextQueuedTelegramTurn,
              compact: Pi.compactExtensionContext,
              allocateItemOrder: bridgeRuntime.queue.allocateItemOrder,
              allocateControlOrder: bridgeRuntime.queue.allocateControlOrder,
              appendControlItem: queueMutationRuntime.append,
              showStatus: menuActions.sendStatusMessage,
              openModelMenu: menuActions.openModelMenu,
              getAllowedUserId: configStore.getAllowedUserId,
              setAllowedUserId: configStore.setAllowedUserId,
              setMyCommands,
              persistConfig: configStore.persist,
              sendTextReply,
              recordRuntimeEvent: runtimeEvents.record,
              handleProjects: handleProjectsCommand,
              // New: /extensions command — list available PI slash commands excluding BTW
              handleExtensions: async (message, _ctx) => {
                try {
                  const all = pi.getCommands();
                  const filtered = all.filter((c) => {
                    const base = c.name.split(":")[0];
                    return base !== "btw"; // exclude BTW variants
                  });
                  const bySource = (source: typeof filtered[number]["source"]) =>
                    filtered
                      .filter((c) => c.source === source)
                      .map((c) => `/${c.name}`)
                      .sort((a, b) => a.localeCompare(b));
                  const exts = bySource("extension");
                  const skills = bySource("skill");
                  const prompts = bySource("prompt");
                  const parts: string[] = [];
                  if (exts.length) parts.push(`Extensions: ${exts.join(", ")}`);
                  if (skills.length) parts.push(`Skills: ${skills.join(", ")}`);
                  if (prompts.length) parts.push(`Prompts: ${prompts.join(", ")}`);
                  const text = parts.join("\n\n").trim() || "(no commands found)";
                  // Telegram 4096 char limit safeguard — naive split
                  if (text.length <= 3500) {
                    await sendTextReply(message.chat.id, message.message_id, text);
                  } else {
                    const chunks: string[] = [];
                    let start = 0;
                    while (start < text.length) {
                      chunks.push(text.slice(start, start + 3000));
                      start += 3000;
                    }
                    for (const chunk of chunks) {
                      await sendTextReply(message.chat.id, message.message_id, chunk);
                    }
                  }
                } catch (error) {
                  const err = error instanceof Error ? error.message : String(error);
                  await sendTextReply(
                    message.chat.id,
                    message.message_id,
                    `Failed to list commands: ${err}`,
                  );
                }
              },
            }),
            enqueueTurn: (async (
              messages: Api.TelegramMessage[],
              ctx: Pi.ExtensionContext,
            ): Promise<void> => {
              const first = messages?.[0];
              if (first) {
                const pendingDeleteName = projectsRuntime.consumePendingDelete(
                  first.chat.id,
                  first.text || first.caption || "",
                );
                if (pendingDeleteName !== undefined) {
                  if (!pendingDeleteName) {
                    await sendTextReply(first.chat.id, first.message_id, "Project delete cancelled.");
                  } else {
                    const result = await projectsRuntime.deleteProject(pendingDeleteName);
                    await sendTextReply(
                      first.chat.id,
                      first.message_id,
                      `${result.ok ? "OK" : "Failed"}: project delete ${pendingDeleteName}\n${result.text}`,
                    );
                  }
                  await sendProjectsMenu(first.chat.id);
                  return;
                }
              }
              if (first && projectsRuntime.hasPendingCreate(first.chat.id)) {
                const result = await projectsRuntime.consumePendingCreate(
                  first.chat.id,
                  first.text || first.caption || "",
                );
                if (result) {
                  await sendTextReply(
                    first.chat.id,
                    first.message_id,
                    `${result.ok ? "OK" : "Failed"}: project create\n${result.text}`,
                  );
                  await sendProjectsMenu(first.chat.id);
                  return;
                }
              }
              // Extension-level ACK: put a salute reaction under the user's message (no text).
              if (first) {
                // Reactions under user messages are disabled by policy.
                // Intentionally no Telegram addMessageReaction call here.
                // Also send a short textual ACK as a reply (not emoji-only to avoid big bubble)
                try {
                  await sendTextReply(first.chat.id, first.message_id, "🫡 Принял, работаем.");
                } catch {
                  // ignore
                }
                // No special-casing of short test messages — always enqueue to the model.
              }
              const baseEnqueue = Queue.createTelegramPromptEnqueueController<
                Api.TelegramMessage,
                Pi.ExtensionContext
              >({
                ...telegramQueueStore,
                getPreserveQueuedTurnsAsHistory:
                  bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory,
                setPreserveQueuedTurnsAsHistory:
                  bridgeRuntime.lifecycle.setPreserveQueuedTurnsAsHistory,
                createTurn:
                  Turns.createTelegramPromptTurnRuntimeBuilder<Api.TelegramMessage>(
                    {
                      allocateQueueOrder: bridgeRuntime.queue.allocateItemOrder,
                      downloadFile: downloadTelegramBridgeFile,
                    },
                  ),
                updateStatus,
                dispatchNextQueuedTelegramTurn,
              }).enqueue;
              await baseEnqueue(messages, ctx);
            }),
          }).dispatchMessages,
        }).handleMessage,
      handleAuthorizedTelegramEditedMessage:
        Turns.createTelegramQueuedPromptEditRuntime<
          Api.TelegramMessage,
          Pi.ExtensionContext
        >({
          ...telegramQueueStore,
          updateStatus,
        }).updateFromEditedMessage,
    }).handleUpdate,
    stopTypingLoop: bridgeRuntime.typing.stop,
    updateStatus,
    recordRuntimeEvent: runtimeEvents.record,
  });

  // --- Extension Registration ---

  Registration.registerTelegramAttachmentTool(pi, {
    getActiveTurn: activeTurnRuntime.get,
    recordRuntimeEvent: runtimeEvents.record,
  });

  Registration.registerTelegramCommands(pi, {
    promptForConfig: Setup.createTelegramSetupPromptRuntime({
      getConfig: configStore.get,
      setConfig: configStore.set,
      setupGuard: bridgeRuntime.setup,
      getMe: Api.fetchTelegramBotIdentity,
      persistConfig: configStore.persist,
      startPolling: pollingRuntime.start,
      updateStatus,
      recordRuntimeEvent: runtimeEvents.record,
    }),
    getStatusLines,
    reloadConfig: configStore.load,
    hasBotToken: configStore.hasBotToken,
    startPolling: pollingRuntime.start,
    stopPolling: pollingRuntime.stop,
    updateStatus,
  });

  Registration.registerTelegramAutoReloadCommand(pi);

  // --- Lifecycle Hooks ---

  const sessionLifecycleRuntime = Queue.createTelegramSessionLifecycleRuntime<
    Pi.ExtensionContext,
    RuntimeTelegramQueueItem,
    ActivePiModel
  >({
    getCurrentModel: Pi.getExtensionContextModel,
    loadConfig: configStore.load,
    setQueuedItems: telegramQueueStore.setQueuedItems,
    setCurrentModel: currentModelRuntime.set,
    setPendingModelSwitch: pendingModelSwitchStore.set,
    syncCounters: bridgeRuntime.queue.syncCounters,
    syncFlags: bridgeRuntime.lifecycle.syncFlags,
    prepareTempDir,
    updateStatus,
    clearPendingMediaGroups: mediaGroupRuntime.clear,
    clearModelMenuState: modelMenuRuntime.clear,
    getActiveTurnChatId: activeTurnRuntime.getChatId,
    clearPreview: previewRuntime.clear,
    clearActiveTurn: activeTurnRuntime.clear,
    clearAbort: bridgeRuntime.abort.clearHandler,
    stopPolling: pollingRuntime.stop,
    recordRuntimeEvent: runtimeEvents.record,
  });

  Registration.registerTelegramLifecycleHooks(pi, {
    ...sessionLifecycleRuntime,
    async onSessionStart(event, ctx) {
      await sessionLifecycleRuntime.onSessionStart(event, ctx);
      if (configStore.hasBotToken() && telegramAutostartEnabled) {
        await pollingRuntime.start(ctx);
      }
    },
    onBeforeAgentStart: Registration.createTelegramBeforeAgentStartHook(),
    onModelSelect: currentModelRuntime.onModelSelect,
    ...Queue.createTelegramAgentLifecycleHooks<
      Queue.PendingTelegramTurn,
      Pi.ExtensionContext,
      unknown
    >({
      setAbortHandler: Runtime.createTelegramContextAbortHandlerSetter(
        bridgeRuntime.abort,
      ),
      getQueuedItems: telegramQueueStore.getQueuedItems,
      hasPendingDispatch: bridgeRuntime.lifecycle.hasDispatchPending,
      hasActiveTurn: activeTurnRuntime.has,
      resetToolExecutions: bridgeRuntime.lifecycle.resetActiveToolExecutions,
      resetPendingModelSwitch: modelSwitchController.clearPendingSwitch,
      setQueuedItems: telegramQueueStore.setQueuedItems,
      clearDispatchPending: bridgeRuntime.lifecycle.clearDispatchPending,
      setActiveTurn: activeTurnRuntime.set,
      createPreviewState: previewRuntime.resetState,
      startTypingLoop: promptDispatchRuntime.startTypingLoop,
      updateStatus,
      getActiveTurn: activeTurnRuntime.get,
      extractAssistant: Replies.extractLatestAssistantMessageText,
      getPreserveQueuedTurnsAsHistory:
        bridgeRuntime.lifecycle.shouldPreserveQueuedTurnsAsHistory,
      resetRuntimeState: Runtime.createTelegramAgentEndResetter({
        abort: bridgeRuntime.abort,
        typing: bridgeRuntime.typing,
        clearActiveTurn: activeTurnRuntime.clear,
        resetToolExecutions: bridgeRuntime.lifecycle.resetActiveToolExecutions,
        clearPendingModelSwitch: modelSwitchController.clearPendingSwitch,
        clearDispatchPending: bridgeRuntime.lifecycle.clearDispatchPending,
      }),
      dispatchNextQueuedTelegramTurn,
      clearPreview: previewRuntime.clear,
      setPreviewPendingText: previewRuntime.setPendingText,
      finalizeMarkdownPreview: previewRuntime.finalizeMarkdown,
      sendMarkdownReply,
      sendTextReply,
      sendQueuedAttachments: Attachments.createTelegramQueuedAttachmentSender({
        sendMultipart: callMultipart,
        sendTextReply,
        recordRuntimeEvent: runtimeEvents.record,
      }),
      getActiveToolExecutions: bridgeRuntime.lifecycle.getActiveToolExecutions,
      setActiveToolExecutions: bridgeRuntime.lifecycle.setActiveToolExecutions,
      triggerPendingModelSwitchAbort: modelSwitchController.triggerPendingAbort,
    }),
    onMessageStart: previewRuntime.onMessageStart,
    onMessageUpdate: previewRuntime.onMessageUpdate,
  });
}
