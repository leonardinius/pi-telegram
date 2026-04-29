import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("ping", {
    description: "Test ping",
    handler: async () => {
      return { content: [{ type: "text", text: "pong" }] };
    },
  });
}
