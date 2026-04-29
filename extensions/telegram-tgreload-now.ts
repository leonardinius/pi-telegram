import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("telegram-tgreload-now", {
    description: "Reload Telegram integration now",
    handler: async (_args, ctx) => {
      try {
        await ctx.reload();
        ctx.ui?.notify("Telegram integration reloaded", "info");
        return { content: [{ type: "text", text: "Telegram integration reloaded" }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: "Reload failed: " + (err?.message ?? String(err)) }] };
      }
    }
  });
}
