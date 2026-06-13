import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ArtifactFile, Usage } from "./types.js";

export function createRunId(prefix = "run"): string {
  const date = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}-${date}-${randomUUID().slice(0, 8)}`;
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function sumUsage(usages: Array<Usage | undefined>): Usage {
  const usage: Usage = {};
  for (const item of usages) {
    if (!item) {
      continue;
    }
    usage.inputTokens = addOptional(usage.inputTokens, item.inputTokens);
    usage.outputTokens = addOptional(usage.outputTokens, item.outputTokens);
    usage.totalTokens = addOptional(usage.totalTokens, item.totalTokens);
    usage.costUsd = addOptional(usage.costUsd, item.costUsd);
  }
  if (usage.totalTokens === undefined && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
    usage.totalTokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return usage;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function listArtifactFiles(root: string, maxPreviewBytes = 4000): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  await walk(root, root, files, maxPreviewBytes);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function truncate(text: string, maxLength = 5000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}\n...<truncated ${text.length - maxLength} chars>`;
}

export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function addOptional(left?: number, right?: number): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

async function walk(root: string, current: string, files: ArtifactFile[], maxPreviewBytes: number): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }

    const fullPath = path.join(current, entry.name);
    const relativePath = path.relative(root, fullPath);
    if (entry.isDirectory()) {
      await walk(root, fullPath, files, maxPreviewBytes);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

    const info = await stat(fullPath);
    const file: ArtifactFile = {
      path: relativePath,
      sizeBytes: info.size
    };

    if (info.size <= maxPreviewBytes && isLikelyTextFile(entry.name)) {
      file.preview = await readFile(fullPath, "utf8");
    }
    files.push(file);
  }
}

function isLikelyTextFile(name: string): boolean {
  return /\.(txt|md|json|js|jsx|ts|tsx|mjs|cjs|css|html|py|rb|go|rs|java|kt|swift|sh|yaml|yml|toml|xml)$/i.test(name);
}
