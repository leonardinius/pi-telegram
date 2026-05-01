/**
 * Free model service
 * Owns fetching, caching, and summary generation for free LLM models from shir-man.com
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface FreeModel {
  rank: number;
  id: string;
  name: string;
  score: number;
  contextLength: number;
  supportsTools: boolean;
  [key: string]: unknown;
}

export interface FreeModelData {
  updatedAt: string;
  count: number;
  models: FreeModel[];
  notes: string[];
}

const CACHE_DIR = join(homedir(), ".pi/agent/prusax0/cache");
const CACHE_PATH = join(CACHE_DIR, "free-models.json");
const TTL_MS = 3600000; // 1 hour
const API_URL = "https://shir-man.com/api/free-llm/top-models";

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
}

async function readCache(): Promise<FreeModelData | null> {
  try {
    const raw = await readFile(CACHE_PATH, "utf-8");
    return JSON.parse(raw) as FreeModelData;
  } catch {
    return null;
  }
}

async function writeCache(data: FreeModelData): Promise<void> {
  await ensureCacheDir();
  await writeFile(CACHE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

async function fetchAndCacheModels(): Promise<FreeModelData> {
  const response = await globalThis.fetch(API_URL);
  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }
  const data = (await response.json()) as unknown;
  if (
    typeof data !== "object" ||
    data === null ||
    !("updatedAt" in data) ||
    !Array.isArray((data as Record<string, unknown>).models)
  ) {
    throw new Error("Invalid JSON structure: missing updatedAt or models array");
  }
  const modelData = data as FreeModelData;
  await writeCache(modelData);
  return modelData;
}

export async function getModels(): Promise<FreeModelData> {
  const cached = await readCache();
  if (cached) {
    try {
      const stats = await stat(CACHE_PATH);
      const age = Date.now() - stats.mtimeMs;
      if (age < TTL_MS) {
        return cached;
      }
    } catch {
      // ignore stat error, treat as stale
    }
  }
  try {
    return await fetchAndCacheModels();
  } catch (error) {
    if (cached) {
      return cached; // fallback to stale cache
    }
    throw error;
  }
}

export function generateSummary(data: FreeModelData): string {
  const lines: string[] = [
    "🆓 <b>Free Models</b>",
    "",
    `Total: ${data.count} models`,
    `Updated: ${data.updatedAt}`,
    "",
    "<b>Top 5 models:</b>",
  ];
  const topFive = data.models.slice(0, 5);
  for (const model of topFive) {
    lines.push(
      `• ${model.name} — score: ${model.score}, context: ${model.contextLength}`,
    );
  }
  if (data.notes && data.notes.length > 0) {
    lines.push("");
    lines.push("<b>Notes:</b>");
    for (const note of data.notes) {
      lines.push(`• ${note}`);
    }
  }
  return lines.join("\n");
}
