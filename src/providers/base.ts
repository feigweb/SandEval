import { spawn } from "node:child_process";
import type { AuthConfig, HttpModelConfig, ToolCall, Usage } from "../types.js";

const tokenCache = new Map<string, string>();

export async function getApiKey(config: HttpModelConfig): Promise<string> {
  if (config.auth?.type === "command-token") {
    return getCommandToken(config.name, config.auth);
  }
  const key = config.apiKey ?? (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined);
  if (!key) {
    throw new Error(`API key missing for model "${config.name}". Set apiKey or ${config.apiKeyEnv ?? "apiKeyEnv"}.`);
  }
  return key;
}

async function getCommandToken(modelName: string, auth: AuthConfig): Promise<string> {
  if (!auth.tokenCommand) {
    throw new Error(`Model "${modelName}" uses command-token auth but auth.tokenCommand is not configured.`);
  }
  const cacheKey = `${auth.tokenCommand} ${(auth.tokenArgs ?? []).join(" ")}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const token = await runTokenCommand(auth);
  tokenCache.set(cacheKey, token);
  return token;
}

function runTokenCommand(auth: AuthConfig): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(auth.tokenCommand ?? "", auth.tokenArgs ?? [], {
      cwd: auth.cwd ?? process.cwd(),
      env: { ...process.env, ...auth.env },
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`Token command exited with ${exitCode}: ${stderr}`));
        return;
      }
      const token = stdout.trim().split(/\r?\n/)[0]?.trim();
      if (!token) {
        reject(new Error("Token command produced no stdout token."));
        return;
      }
      resolve(token);
    });
  });
}

export function joinUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

export function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return value.trim() ? (JSON.parse(value) as Record<string, unknown>) : {};
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function normalizeUsage(input?: number, output?: number, total?: number): Usage {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total ?? ((input ?? 0) + (output ?? 0) || undefined)
  };
}

export function normalizeToolCall(id: string | undefined, name: string, args: unknown, index: number): ToolCall {
  return {
    id: id || `call_${Date.now()}_${index}`,
    name,
    arguments: parseArguments(args)
  };
}
