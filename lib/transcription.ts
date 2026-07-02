/**
 * Telegram voice transcription adapter for the extension entrypoint.
 */

import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";


export function transcribeVoiceFileWithScript(
  filePath: string,
  lang = "auto",
  model = "tiny",
): Promise<string | undefined> {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "transcribe-voice.sh");
  return new Promise((resolve, reject) => {
    execFile(scriptPath, [filePath, lang, model], { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || String(error)));
        return;
      }
      const text = stdout.trim();
      resolve(text || undefined);
    });
  });
}
