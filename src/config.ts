import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelConfig, SandEvalConfig, ScoringDimensionConfig } from "./types.js";

const authSchema = z.object({
  type: z.enum(["none", "api-key", "command", "command-token"]).optional(),
  apiKeyEnv: z.string().optional(),
  tokenCommand: z.string().optional(),
  tokenArgs: z.array(z.string()).optional(),
  loginCommand: z.string().optional(),
  loginArgs: z.array(z.string()).optional(),
  checkCommand: z.string().optional(),
  checkArgs: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional()
});

const baseModelSchema = z.object({
  name: z.string().min(1),
  model: z.string().min(1).optional(),
  provider: z.string().optional(),
  modelIds: z.array(z.string().min(1)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  auth: authSchema.optional()
});

const httpModelSchema = baseModelSchema.extend({
  kind: z.enum(["openai-compatible", "anthropic-compatible", "gemini-compatible"]),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional()
});

const commandModelSchema = baseModelSchema.extend({
  kind: z.literal("command"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().positive().optional(),
  protocol: z.enum(["sandeval-json", "plain-final"]).optional(),
  workflowAdapter: z.string().optional()
});

const customModelSchema = baseModelSchema.extend({
  kind: z.literal("custom"),
  modulePath: z.string().min(1),
  exportName: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional()
});

const mockModelSchema = baseModelSchema.extend({
  kind: z.literal("mock")
});

const configSchema = z.object({
  version: z.number().optional(),
  defaultModel: z.string().optional(),
  judgeModel: z.string().optional(),
  reportDir: z.string().optional(),
  sandbox: z
    .object({
      mode: z.enum(["local", "docker", "podman", "bubblewrap", "firejail", "nsjail", "external"]).optional(),
      root: z.string().optional(),
      dockerImage: z.string().optional(),
      dockerRuntime: z.string().optional(),
      podmanImage: z.string().optional(),
      nsjailRootfs: z.string().optional(),
      commandTimeoutMs: z.number().positive().optional(),
      network: z.boolean().optional(),
      env: z.record(z.string(), z.string()).optional(),
      sandboxExtraArgs: z.array(z.string()).optional(),
      external: z
        .object({
          command: z.string().min(1),
          args: z.array(z.string()).optional(),
          cwd: z.string().optional(),
          env: z.record(z.string(), z.string()).optional(),
          timeoutMs: z.number().positive().optional()
        })
        .optional(),
      preserveRuns: z.number().int().positive().optional(),
      copyTaskFiles: z.boolean().optional()
    })
    .optional(),
  tools: z
    .object({
      files: z.boolean().optional(),
      shell: z.boolean().optional(),
      git: z.enum(["off", "read", "full"]).optional(),
      gitRemote: z.boolean().optional(),
      packageManager: z.boolean().optional(),
      maxCommandTimeoutMs: z.number().positive().optional(),
      blockedCommands: z.array(z.string()).optional(),
      allowedHosts: z.array(z.string()).optional()
    })
    .optional(),
  rules: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        prompt: z.string().min(1),
        enabled: z.boolean().optional()
      })
    )
    .optional(),
  skills: z
    .object({
      localDir: z.string().optional(),
      globalDir: z.string().optional()
    })
    .optional(),
  agent: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      systemPrompt: z.string().optional(),
      toolTimeoutMs: z.number().positive().optional(),
      autoRunVerification: z.boolean().optional(),
      planMode: z.enum(["off", "prompt", "enforced"]).optional(),
      planApproval: z.enum(["auto", "interactive"]).optional()
    })
    .optional(),
  scoring: z
    .object({
      enabled: z.boolean().optional(),
      mode: z.enum(["single", "multi"]).optional(),
      rubric: z.string().optional(),
      maxRetries: z.number().int().nonnegative().optional(),
      minScore: z.number().optional(),
      maxScore: z.number().optional(),
      dimensions: z
        .array(
          z.object({
            key: z.string().min(1),
            label: z.string().optional(),
            description: z.string().optional(),
            weight: z.number().nonnegative().optional()
          })
        )
        .optional()
    })
    .optional(),
  arena: z
    .object({
      concurrency: z.number().int().positive().optional()
    })
    .optional(),
  workflow: z
    .object({
      compact: z.boolean().optional(),
      collapseSimilar: z.boolean().optional(),
      maxLiveEvents: z.number().int().positive().optional(),
      maxWorkflowEvents: z.number().int().positive().optional()
    })
    .optional(),
  storage: z
    .object({
      kind: z.enum(["filesystem", "custom"]).optional(),
      root: z.string().optional(),
      indexFile: z.string().optional(),
      modulePath: z.string().optional(),
      options: z.record(z.string(), z.unknown()).optional()
    })
    .optional(),
  ui: z
    .object({
      theme: z.enum(["sand", "mono", "dark"]).optional(),
      pageSize: z.number().int().positive().optional(),
      showRawUsage: z.boolean().optional(),
      confirmBeforeRun: z.boolean().optional()
    })
    .optional(),
  contexts: z
    .array(
      z.object({
        name: z.string().min(1),
        path: z.string().min(1),
        description: z.string().optional(),
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
        maxFiles: z.number().int().positive().optional(),
        maxFileBytes: z.number().int().positive().optional()
      })
    )
    .optional(),
  models: z.array(z.discriminatedUnion("kind", [httpModelSchema, commandModelSchema, customModelSchema, mockModelSchema])).min(1)
});

export const CONFIG_DIR = ".sandeval";
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

export function getConfigPath(cwd = process.cwd(), explicitPath?: string): string {
  return explicitPath ? path.resolve(cwd, explicitPath) : path.resolve(cwd, CONFIG_PATH);
}

export async function loadConfig(cwd = process.cwd(), explicitPath?: string): Promise<SandEvalConfig> {
  const configPath = getConfigPath(cwd, explicitPath);
  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run "sandeval init" first.`);
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return withDefaults(configSchema.parse(parsed) as SandEvalConfig);
}

export async function saveConfig(config: SandEvalConfig, cwd = process.cwd(), explicitPath?: string): Promise<string> {
  const configPath = getConfigPath(cwd, explicitPath);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export async function writeDefaultConfig(cwd = process.cwd()): Promise<string> {
  const dir = path.resolve(cwd, CONFIG_DIR);
  const configPath = path.resolve(cwd, CONFIG_PATH);
  await mkdir(dir, { recursive: true });
  if (existsSync(configPath)) {
    return configPath;
  }

  const config = createDefaultConfig();
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function createDefaultConfig(): SandEvalConfig {
  return {
    version: 1,
    defaultModel: "mock",
    judgeModel: "mock",
    reportDir: ".sandeval/reports",
    sandbox: {
      mode: "local",
      root: ".sandeval/runs",
      commandTimeoutMs: 120000,
      network: false,
      preserveRuns: 50,
      copyTaskFiles: false
    },
    tools: {
      files: true,
      shell: true,
      git: "full",
      gitRemote: false,
      packageManager: true,
      maxCommandTimeoutMs: 120000,
      blockedCommands: ["shutdown", "reboot"]
    },
    rules: [
      {
        name: "verify-before-finish",
        description: "Require relevant verification before finishing.",
        enabled: true,
        prompt:
          "Before finishing, run the most relevant verification command when the task produced runnable code or artifacts. If verification is not possible, explain why in the finish summary."
      },
      {
        name: "prefer-small-runnable-artifacts",
        description: "Prefer compact, complete runnable artifacts.",
        enabled: true,
        prompt:
          "Prefer small, complete, runnable artifacts. Avoid unnecessary dependencies and broad rewrites unless the task clearly requires them."
      },
      {
        name: "report-changed-files",
        description: "Summarize important changed files and commands.",
        enabled: true,
        prompt:
          "When finishing, summarize the important files changed and the verification commands that were run."
      }
    ],
    skills: {
      localDir: ".sandeval/skills",
      globalDir: "~/.sandeval/skills"
    },
    agent: {
      maxTurns: 12,
      toolTimeoutMs: 120000,
      autoRunVerification: true,
      planMode: "prompt",
      planApproval: "auto"
    },
    scoring: {
      enabled: true,
      mode: "multi",
      maxRetries: 2,
      minScore: 0,
      maxScore: 100,
      dimensions: defaultScoringDimensions()
    },
    arena: {
      concurrency: 1
    },
    workflow: {
      compact: true,
      collapseSimilar: true,
      maxLiveEvents: 40,
      maxWorkflowEvents: 200
    },
    storage: {
      kind: "filesystem",
      root: ".sandeval/storage",
      indexFile: "runs.jsonl"
    },
    ui: {
      theme: "sand",
      pageSize: 12,
      showRawUsage: false,
      confirmBeforeRun: false
    },
    contexts: [
      {
        name: "workspace",
        path: ".",
        description: "Current project workspace",
        exclude: ["node_modules", "dist", ".git", ".sandeval", "package-lock.json"],
        maxFiles: 40,
        maxFileBytes: 12000
      }
    ],
    models: [
      {
        name: "mock",
        provider: "mock",
        kind: "mock",
        model: "mock-agent",
        modelIds: ["mock-agent"]
      },
      {
        name: "openai",
        provider: "openai",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-5.4",
        modelIds: ["gpt-5.4", "gpt-4.1", "gpt-4.1-mini"],
        temperature: 0.2,
        auth: {
          type: "api-key",
          apiKeyEnv: "OPENAI_API_KEY"
        }
      },
      {
        name: "anthropic",
        provider: "anthropic",
        kind: "anthropic-compatible",
        baseUrl: "https://api.anthropic.com",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        model: "claude-sonnet-4-5",
        modelIds: ["claude-sonnet-4-5", "claude-opus-4-1"],
        temperature: 0.2,
        auth: {
          type: "api-key",
          apiKeyEnv: "ANTHROPIC_API_KEY"
        }
      },
      {
        name: "gemini",
        provider: "gemini",
        kind: "gemini-compatible",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        apiKeyEnv: "GEMINI_API_KEY",
        model: "gemini-2.5-pro",
        modelIds: ["gemini-2.5-pro", "gemini-2.5-flash"],
        temperature: 0.2,
        auth: {
          type: "api-key",
          apiKeyEnv: "GEMINI_API_KEY"
        }
      },
      {
        name: "ollama",
        provider: "ollama",
        kind: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "ollama",
        model: "qwen2.5-coder:latest",
        modelIds: ["qwen2.5-coder:latest", "llama3.1:latest", "mistral:latest"],
        temperature: 0.2,
        enabled: false
      },
      {
        name: "lmstudio",
        provider: "lmstudio",
        kind: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "lm-studio",
        model: "local-model",
        modelIds: ["local-model"],
        temperature: 0.2,
        enabled: false
      },
      {
        name: "claude-code",
        provider: "claude-code",
        kind: "command",
        model: "claude-code",
        modelIds: ["claude-sonnet-4-5", "claude-opus-4-1"],
        command: "claude",
        args: ["-p", "{{task}}", "--output-format", "json"],
        protocol: "plain-final",
        workflowAdapter: "claude-code",
        timeoutMs: 600000,
        auth: {
          type: "command",
          loginCommand: "claude",
          loginArgs: ["login"],
          checkCommand: "claude",
          checkArgs: ["--version"]
        }
      },
      {
        name: "codex-cli",
        provider: "codex",
        kind: "command",
        model: "codex-cli",
        modelIds: ["gpt-5.4", "gpt-4.1"],
        command: "codex",
        args: ["exec", "--json", "{{task}}"],
        protocol: "plain-final",
        workflowAdapter: "codex",
        timeoutMs: 600000,
        auth: {
          type: "command",
          loginCommand: "codex",
          loginArgs: ["login"],
          checkCommand: "codex",
          checkArgs: ["--version"]
        }
      }
    ] satisfies ModelConfig[]
  };
}

function withDefaults(config: SandEvalConfig): SandEvalConfig {
  return {
    ...config,
    tools: {
      files: true,
      shell: true,
      git: "full",
      gitRemote: false,
      packageManager: true,
      maxCommandTimeoutMs: config.sandbox?.commandTimeoutMs ?? 120000,
      blockedCommands: ["shutdown", "reboot"],
      ...config.tools
    },
    rules: config.rules ?? createDefaultRules(),
    skills: {
      localDir: ".sandeval/skills",
      globalDir: "~/.sandeval/skills",
      ...config.skills
    },
    contexts: config.contexts?.length
      ? config.contexts
      : [
          {
            name: "workspace",
            path: ".",
            description: "Current project workspace",
            exclude: ["node_modules", "dist", ".git", ".sandeval", "package-lock.json"],
            maxFiles: 40,
            maxFileBytes: 12000
          }
        ]
  };
}

function createDefaultRules(): NonNullable<SandEvalConfig["rules"]> {
  return [
    {
      name: "verify-before-finish",
      description: "Require relevant verification before finishing.",
      enabled: true,
      prompt:
        "Before finishing, run the most relevant verification command when the task produced runnable code or artifacts. If verification is not possible, explain why in the finish summary."
    },
    {
      name: "prefer-small-runnable-artifacts",
      description: "Prefer compact, complete runnable artifacts.",
      enabled: true,
      prompt:
        "Prefer small, complete, runnable artifacts. Avoid unnecessary dependencies and broad rewrites unless the task clearly requires them."
    },
    {
      name: "report-changed-files",
      description: "Summarize important changed files and commands.",
      enabled: true,
      prompt:
        "When finishing, summarize the important files changed and the verification commands that were run."
    }
  ];
}

export function findModel(config: SandEvalConfig, name?: string): ModelConfig {
  const modelName = name ?? config.defaultModel;
  if (!modelName) {
    throw new Error("No model specified and config.defaultModel is not set.");
  }

  const model = resolveModelRef(config, modelName);
  if (!model) {
    throw new Error(`Model "${modelName}" not found in config.`);
  }

  return model;
}

export function listModelNames(config: SandEvalConfig): string[] {
  return listModelRefs(config);
}

export function defaultScoringDimensions(): ScoringDimensionConfig[] {
  return [
    {
      key: "taskSatisfaction",
      label: "Task",
      weight: 30,
      description: "How completely the output satisfies the task."
    },
    {
      key: "correctness",
      label: "Correctness",
      weight: 25,
      description: "Whether the solution is logically and functionally correct."
    },
    {
      key: "runnability",
      label: "Runnable",
      weight: 15,
      description: "Whether the artifact can run and was meaningfully verified."
    },
    {
      key: "codeQuality",
      label: "Quality",
      weight: 15,
      description: "Maintainability, clarity, and fit of the implementation or artifact."
    },
    {
      key: "workflowQuality",
      label: "Workflow",
      weight: 10,
      description: "Quality of planning, tool use, iteration, and evidence."
    },
    {
      key: "userFeedbackImpact",
      label: "Feedback",
      weight: 5,
      description: "How well explicit user feedback was incorporated."
    }
  ];
}

export function listModelRefs(config: SandEvalConfig): string[] {
  const refs = config.models.flatMap((model) => {
    const provider = model.provider ?? model.name;
    const ids = model.modelIds?.length ? model.modelIds : model.model ? [model.model] : [];
    return ids.map((id) => `${provider}/${id}`);
  });
  return [...new Set(refs)];
}

export function formatModelRef(model: ModelConfig): string {
  if (!model.model) {
    return model.name;
  }
  return `${model.provider ?? model.name}/${model.model}`;
}

function resolveModelRef(config: SandEvalConfig, value: string): ModelConfig | undefined {
  const direct = config.models.find((candidate) => candidate.name === value);
  if (direct) {
    return { ...direct, name: formatModelRef(direct) };
  }

  const slash = value.indexOf("/");
  if (slash === -1) {
    return undefined;
  }
  const provider = value.slice(0, slash);
  const modelId = value.slice(slash + 1);
  const base = config.models.find((candidate) => {
    if ((candidate.provider ?? candidate.name) !== provider) {
      return false;
    }
    if (candidate.modelIds?.length) {
      return candidate.modelIds.includes(modelId);
    }
    return !candidate.model || candidate.model === modelId;
  });
  if (!base) {
    return undefined;
  }
  return {
    ...base,
    name: `${provider}/${modelId}`,
    provider,
    model: modelId
  } as ModelConfig;
}
