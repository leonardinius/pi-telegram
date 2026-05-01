# Plan: Add /freemodel Command

## Why
Users want easy access to current free LLMs listed on https://shir-man.com/free-llm/ directly from the Telegram interface.

## What
Objective: Add a new command `/freemodel` to `pi-telegram` that displays a summary of free model updates and provides an interactive menu for switching to one of the listed models.

## Acceptance criteria
- `/freemodel` appears in the Telegram menu immediately after `/model`.
- Clicking `/freemodel` fetches/refreshes the JSON cache if older than 1 hour.
- A summary text is sent **before** the menu, containing:
  - Total model count and `updatedAt` timestamp from JSON.
  - Top 5 models with name, score, and context length.
  - Any notes from the JSON.
- An interactive menu appears below the summary, listing **all** models in JSON order (by `rank`).
- Menu uses `id` for selection callback data (`freemodel:pick:<id>`).
- Selecting a model updates the active Pi session model via `modelSwitchController` (same mechanics as `/model`, including in-flight switching if Pi is busy).
- Error handling: if fetch fails, falls back to cached data; if no cache, sends error.
- No regressions in existing `/model` functionality.

## Data Source
- **Endpoint**: `https://shir-man.com/api/free-llm/top-models`
- **Cache**: `~/.pi/agent/prusax0/cache/free-models.json`
- **TTL**: Refresh if cache older than 1 hour
- **JSON Structure**:
  - `updatedAt`: ISO timestamp
  - `count`: Total number of models
  - `models`: Array with `rank`, `id`, `name`, `score`, `contextLength`, `supportsTools`, etc.
  - `notes`: Array of informational notes

## Steps
1. **Register command** (depends_on: none)
   - In `lib/commands.ts`:
     - Insert `{ command: "freemodel", description: "🆓 Free models" }` after `model` entry in `TELEGRAM_BOT_COMMANDS`.
     - Extend `TelegramCommandAction` type: `| { kind: "freemodel"; executionMode: "control-queue" }`.
     - Add `handleFreeModel: (message: TMessage, ctx: TContext) => Promise<void>` to `TelegramCommandActionDeps`.
     - Add `case "freemodel": await deps.handleFreeModel(message, ctx); return true;` in `executeTelegramCommandAction` switch.

2. **Create FreeModel service** (depends_on: none)
   - Create `lib/freemodel.ts`:
     - `CACHE_PATH = path.join(os.homedir(), '.pi/agent/prusax0/cache/free-models.json')`
     - `TTL_MS = 3600000` (1 hour)
     - `ensureCacheDir()`: Creates `~/.pi/agent/prusax0/cache/` if not exists.
     - `fetchAndCacheModels()`: 
       - Uses `globalThis.fetch('https://shir-man.com/api/free-llm/top-models')`
       - Validates response JSON structure (`updatedAt`, `models` array)
       - Saves to `CACHE_PATH`
       - Throws on fetch/parse failure
     - `getModels(): Promise<FreeModelData>`:
       - Checks if `CACHE_PATH` exists and mtime < TTL_MS ago
       - If fresh: returns parsed cache
       - If stale/missing: calls `fetchAndCacheModels()`, falls back to stale cache on fetch failure
     - `generateSummary(data: FreeModelData): string`:
       - Formats Telegram HTML text with: 🆓 header, count, updatedAt, Top 5 models (name, score, contextLength), notes
     - Types: `FreeModelData`, `FreeModel` (mirroring JSON structure)

3. **Create FreeModel menu handler** (depends_on: Step 2)
   - In `lib/menu.ts`:
     - Add `openTelegramFreeModelMenu(chatId, replyToMessageId, models: FreeModel[])` function
     - Builds inline keyboard: 1 button per model (order by `rank`), button text = `name`, callback_data = `freemodel:pick:<id>`
     - Uses existing `sendInteractiveMessage(chatId, 'Choose a free model:', 'html', replyMarkup)`
     - Does NOT reuse `TelegramModelMenuState` (separate concern)

4. **Wire handler in index.ts** (depends_on: Steps 1, 2, 3)
   - Import `freeModelService` from `lib/freemodel.ts`
   - Create `handleFreeModel` closure:
     - `const data = await freeModelService.getModels()`
     - `await sendTextReply(message.chat.id, message.message_id, freeModelService.generateSummary(data))`
     - `await menu.openTelegramFreeModelMenu(message.chat.id, message.message_id, data.models)`
   - Wire into `commands.createTelegramCommandActionRuntime` deps

5. **Handle model selection callback** (depends_on: Step 3)
   - In callback handler (`lib/updates.ts` or `lib/menu.ts`):
     - Parse `freemodel:pick:<id>` from callback data
     - Find model by `id` in the models list
     - Use `modelSwitchController` to switch (same as `/model`):
       - If idle: `Pi.setModel(id)`
       - If busy: in-flight switch (abort + restart with new model)
     - Answer callback with model name confirmation

6. **Error handling & edge cases** (depends_on: Steps 2, 5)
   - Fetch fails: use cached data if available, send warning in summary
   - No cache exists + fetch fails: send error message "⚠️ Failed to load free models. Try again later."
   - Corrupted cache: delete and re-fetch
   - Empty models array: send "No free models available."

7. **Test** (depends_on: Steps 4, 5, 6)
   - Run `npm test` to ensure no regressions
   - Manual test: send `/freemodel`, verify summary + menu
   - Test model selection: pick a model, verify Pi switches
   - Test TTL: wait 1h, verify refresh on next command

## Progress
- [x] Step 1: Register command in lib/commands.ts (added to TELEGRAM_BOT_COMMANDS, types, deps, switch cases)
- [x] Step 2: Create lib/freemodel.ts service (cache, fetch, summary generation, types)
- [x] Step 3: Create FreeModel menu handler in lib/menu.ts (openTelegramFreeModelMenu function)
- [x] Step 4: Wire handler in index.ts (import freemodel, add handleFreeModel to deps)
- [x] Step 5: Handle model selection callback (basic: freemodel:pick:id routing, pi.setModel, callback answer)
- [x] Step 6: Error handling & edge cases (freemodel.ts: FreeModelGetResult, isStale flag, generateSummary warnings, empty models)
- [ ] Step 7: Test (npm test + manual)

## Dependencies
- None.

## Constraints / non-goals
- Do not block the main command loop; use the control-queue where appropriate.
