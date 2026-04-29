import type { ExtensionAPI, SlashCommandInfo } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("extensions", {
    description: "List all available slash commands (extensions, skills, prompts). BTW excluded.",
    handler: async (_args, _ctx) => {
      const commands: SlashCommandInfo[] = pi.getCommands();

      // Log raw commands for debugging duplicates
      console.log("RAW_COMMANDS_START");
      console.log(JSON.stringify(commands.map(c => ({ name: c.name, source: c.source })), null, 2));
      console.log("RAW_COMMANDS_END");

      // Exclude BTW and its suffixed duplicates (e.g., btw:1)
      const filtered = commands.filter((c) => c.name.split(":")[0] !== "btw");

      const format = (items: SlashCommandInfo[]) => items.map((c) => `/${c.name}`).sort((a, b) => a.localeCompare(b));
      const bySource = (source: "extension" | "skill" | "prompt") => format(filtered.filter((c) => c.source === source));

      const tgreloadCmdBase = "/telegram-tgreload-now";
      const extRaw = bySource("extension").filter((c) => c !== "/extensions");
      const hasTgreload = extRaw.some((c) => c.startsWith("/telegram-tgreload-now"));
      const extWithoutTgreload = extRaw.filter((c) => !c.startsWith("/telegram-tgreload-now"));
      const extsFinal = hasTgreload ? [...extWithoutTgreload, tgreloadCmdBase] : extWithoutTgreload;

      const skills = bySource("skill");
      const prompts = bySource("prompt");

      const parts: string[] = [];
      if (extsFinal.length) parts.push(`Extensions: ${extsFinal.join(", ")}`);
      if (skills.length) parts.push(`Skills: ${skills.join(", ")}`);
      if (prompts.length) parts.push(`Prompts: ${prompts.join(", ")}`);
      const text = parts.join("\n\n").trim() || "(no commands found)";

      // Send as a normal assistant message so it reaches Telegram too
      pi.sendMessage({ customType: "extensions-list", content: text, display: true, details: { count: filtered.length } });
    },
  });
}
