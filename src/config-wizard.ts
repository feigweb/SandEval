import { existsSync } from "node:fs";
import { checkbox, confirm, input, select } from "@inquirer/prompts";
import password from "@inquirer/password";
import type { CommandModelConfig, HttpModelConfig, ModelConfig, SandEvalConfig } from "./types.js";
import { createDefaultConfig, getConfigPath, listModelNames, loadConfig, saveConfig } from "./config.js";

export async function runConfigWizard(cwd: string, configPath?: string): Promise<string> {
  const resolvedConfigPath = getConfigPath(cwd, configPath);
  const config: SandEvalConfig = existsSync(resolvedConfigPath) ? await loadConfig(cwd, configPath) : createDefaultConfig();

  config.version = 1;

  const selectedProviders = await checkbox({
    message: "Providers/models to add",
    choices: [
      { name: "Mock", value: "mock", checked: config.models.length === 0 },
      { name: "OpenAI compatible", value: "openai-compatible" },
      { name: "Anthropic compatible", value: "anthropic-compatible" },
      { name: "Gemini compatible", value: "gemini-compatible" },
      { name: "Command adapter (Codex/Claude Code/custom)", value: "command" },
      { name: "Custom JS provider module", value: "custom" }
    ]
  });

  if (selectedProviders.includes("mock")) {
    appendModel(config, { name: "mock", provider: "mock", kind: "mock", model: "mock-agent", modelIds: ["mock-agent"] });
  }
  for (const kind of selectedProviders) {
    if (kind === "openai-compatible" || kind === "anthropic-compatible" || kind === "gemini-compatible") {
      appendModel(config, await promptHttpModel(kind));
    }
    if (kind === "command") {
      appendModel(config, await promptCommandModel());
    }
    if (kind === "custom") {
      appendModel(config, await promptCustomModel());
    }
  }

  await promptDefaultModels(config, selectedProviders.length > 0);
  await promptUxImprovement(config);

  return saveConfig(config, cwd, configPath);
}

async function promptDefaultModels(config: SandEvalConfig, addedModels: boolean): Promise<void> {
  const modelRefs = listModelNames(config);
  if (modelRefs.length === 0) {
    config.defaultModel = undefined;
    config.judgeModel = undefined;
    return;
  }

  const needsDefault = !config.defaultModel || !modelRefs.includes(config.defaultModel);
  const shouldUpdate = needsDefault
    ? true
    : await confirm({ message: "Update default/judge model now?", default: addedModels });
  if (!shouldUpdate) {
    return;
  }

  config.defaultModel = await select({
    message: "Default model",
    choices: modelRefs.map((model) => ({ name: model, value: model })),
    default: config.defaultModel && modelRefs.includes(config.defaultModel) ? config.defaultModel : modelRefs[0]
  });
  config.judgeModel = await select({
    message: "Judge model",
    choices: modelRefs.map((model) => ({ name: model, value: model })),
    default: config.judgeModel && modelRefs.includes(config.judgeModel) ? config.judgeModel : config.defaultModel
  });
}

async function promptUxImprovement(config: SandEvalConfig): Promise<void> {
  const sections = await checkbox({
    message: "UX Improvement details to configure",
    choices: [
      { name: "Run/report directories", value: "paths" },
      { name: "Sandbox backend", value: "sandbox" },
      { name: "Storage backend", value: "storage" },
      { name: "Agent planning", value: "agent" },
      { name: "Judge scoring", value: "scoring" },
      { name: "Arena/workflow display", value: "workflow" },
      { name: "TUI theme", value: "theme" }
    ]
  });

  if (sections.includes("paths")) {
    await promptRunPaths(config);
  }
  if (sections.includes("sandbox")) {
    await promptSandbox(config);
  }
  if (sections.includes("storage")) {
    await promptStorage(config);
  }
  if (sections.includes("agent")) {
    await promptAgent(config);
  }
  if (sections.includes("scoring")) {
    await promptScoring(config);
  }
  if (sections.includes("workflow")) {
    await promptArenaWorkflow(config);
  }
  if (sections.includes("theme")) {
    await promptTheme(config);
  }
}

async function promptRunPaths(config: SandEvalConfig): Promise<void> {
  config.reportDir = await input({ message: "Report directory", default: config.reportDir ?? ".sandeval/reports" });
  config.sandbox = config.sandbox ?? {};
  config.sandbox.root = await input({ message: "Sandbox runs directory", default: config.sandbox.root ?? ".sandeval/runs" });
}

async function promptSandbox(config: SandEvalConfig): Promise<void> {
  config.sandbox = config.sandbox ?? {};
  config.sandbox.mode = await select({
    message: "Sandbox mode",
    choices: [
      { name: "Local workspace", value: "local" },
      { name: "Docker container", value: "docker" },
      { name: "Podman container", value: "podman" },
      { name: "Bubblewrap Linux sandbox", value: "bubblewrap" },
      { name: "Firejail Linux sandbox", value: "firejail" },
      { name: "nsjail Linux sandbox", value: "nsjail" },
      { name: "External sandbox command", value: "external" }
    ],
    default: config.sandbox.mode ?? "local"
  });
  config.sandbox.root = await input({ message: "Sandbox runs directory", default: config.sandbox.root ?? ".sandeval/runs" });
  if (config.sandbox.mode === "docker") {
    config.sandbox.dockerImage = await input({
      message: "Docker image",
      default: config.sandbox.dockerImage ?? "node:22-bookworm"
    });
    config.sandbox.dockerRuntime = await input({
      message: "Docker runtime (optional, e.g. runsc for gVisor)",
      default: config.sandbox.dockerRuntime ?? ""
    });
    config.sandbox.network = await confirm({ message: "Allow network in Docker sandbox?", default: config.sandbox.network ?? false });
  } else if (config.sandbox.mode === "podman") {
    config.sandbox.podmanImage = await input({
      message: "Podman image",
      default: config.sandbox.podmanImage ?? config.sandbox.dockerImage ?? "node:22-bookworm"
    });
    config.sandbox.network = await confirm({ message: "Allow network in Podman sandbox?", default: config.sandbox.network ?? false });
  } else if (config.sandbox.mode === "nsjail") {
    config.sandbox.nsjailRootfs = await input({
      message: "nsjail rootfs absolute path",
      default: config.sandbox.nsjailRootfs ?? ""
    });
    config.sandbox.network = await confirm({ message: "Allow network in sandbox?", default: config.sandbox.network ?? false });
  } else if (config.sandbox.mode === "external") {
    config.sandbox.external = config.sandbox.external ?? { command: "sandeval-sandbox-runner" };
    config.sandbox.external.command = await input({
      message: "External sandbox command",
      default: config.sandbox.external.command
    });
    const externalArgs = await input({
      message: "External sandbox args. Templates: {{workspace}} {{command}} {{args}} {{argsJson}}",
      default: (config.sandbox.external.args ?? ["--workspace", "{{workspace}}", "--", "{{command}}", "{{args}}"]).join(" ")
    });
    config.sandbox.external.args = externalArgs.split(/\s+/).filter(Boolean);
  } else if (config.sandbox.mode !== "local") {
    config.sandbox.network = await confirm({ message: "Allow network in sandbox?", default: config.sandbox.network ?? false });
  }
}

async function promptStorage(config: SandEvalConfig): Promise<void> {
  config.storage = config.storage ?? {};
  config.storage.kind = await select({
    message: "Storage backend",
    choices: [
      { name: "Filesystem JSONL index", value: "filesystem" },
      { name: "Custom storage module", value: "custom" }
    ],
    default: config.storage.kind ?? "filesystem"
  });
  config.storage.root = await input({ message: "Storage root", default: config.storage.root ?? ".sandeval/storage" });
  if (config.storage.kind === "custom") {
    config.storage.modulePath = await input({
      message: "Custom storage module path",
      default: config.storage.modulePath ?? "./sandeval-storage.js"
    });
  }
}

async function promptAgent(config: SandEvalConfig): Promise<void> {
  config.agent = config.agent ?? {};
  config.agent.maxTurns = Number(
    await input({ message: "Max agent turns", default: String(config.agent.maxTurns ?? 12), validate: positiveInteger })
  );
  config.agent.planMode = await select({
    message: "Plan mode",
    choices: [
      { name: "Prompt model to plan first", value: "prompt" },
      { name: "Enforce a separate planning step", value: "enforced" },
      { name: "Off", value: "off" }
    ],
    default: config.agent.planMode ?? "prompt"
  });
  config.agent.planApproval = await select({
    message: "Plan approval for enforced mode",
    choices: [
      { name: "Auto approve", value: "auto" },
      { name: "Interactive approval", value: "interactive" }
    ],
    default: config.agent.planApproval ?? "auto"
  });
}

async function promptScoring(config: SandEvalConfig): Promise<void> {
  config.scoring = config.scoring ?? {};
  config.scoring.enabled = await confirm({ message: "Enable judge scoring by default?", default: config.scoring.enabled ?? true });
  config.scoring.mode = await select({
    message: "Scoring mode",
    choices: [
      { name: "Multi-dimensional", value: "multi" },
      { name: "Legacy single score", value: "single" }
    ],
    default: config.scoring.mode ?? "multi"
  });
}

async function promptArenaWorkflow(config: SandEvalConfig): Promise<void> {
  config.arena = config.arena ?? {};
  config.arena.concurrency = Number(
    await input({ message: "Arena concurrency", default: String(config.arena.concurrency ?? 1), validate: positiveInteger })
  );
  config.workflow = config.workflow ?? {};
  config.workflow.collapseSimilar = await confirm({
    message: "Collapse similar workflow events in the TUI?",
    default: config.workflow.collapseSimilar ?? true
  });
  config.workflow.maxLiveEvents = Number(
    await input({ message: "Max live workflow events", default: String(config.workflow.maxLiveEvents ?? 40), validate: positiveInteger })
  );
}

async function promptTheme(config: SandEvalConfig): Promise<void> {
  config.ui = config.ui ?? {};
  config.ui.theme = await select({
    message: "TUI theme",
    choices: [
      { name: "Sand", value: "sand" },
      { name: "Dark", value: "dark" },
      { name: "Mono", value: "mono" }
    ],
    default: config.ui.theme ?? "sand"
  });
}

async function promptHttpModel(kind: HttpModelConfig["kind"]): Promise<HttpModelConfig> {
  const defaults = await selectHttpDefaults(kind);
  const name = await input({ message: `${kind} name`, default: defaults.name });
  const modelIds = await promptModelIds(name, defaults.model);
  const baseUrl = await input({ message: `${name} base URL`, default: defaults.baseUrl });
  const apiKeyEnv = await input({ message: `${name} API key env var`, default: defaults.apiKeyEnv });
  const storeKey = defaults.apiKey
    ? true
    : await confirm({ message: `Store an API key directly in config for ${name}?`, default: false });
  const apiKey = storeKey
    ? defaults.apiKey ?? (await password({ message: `${name} API key`, mask: "*", validate: (value) => (value.trim() ? true : "Required") }))
    : undefined;
  return {
    name,
    provider: name,
    kind,
    ...modelFields(modelIds),
    baseUrl,
    apiKeyEnv: storeKey ? undefined : apiKeyEnv,
    apiKey,
    temperature: 0.2,
    auth: {
      type: "api-key",
      apiKeyEnv: storeKey ? undefined : apiKeyEnv
    }
  };
}

async function selectHttpDefaults(kind: HttpModelConfig["kind"]): Promise<Pick<HttpModelConfig, "name" | "baseUrl" | "apiKeyEnv" | "apiKey"> & { model: string }> {
  if (kind !== "openai-compatible") {
    return defaultHttp(kind);
  }
  const preset = await select({
    message: "OpenAI-compatible preset",
    choices: [
      { name: "OpenAI", value: "openai" },
      { name: "Ollama local", value: "ollama" },
      { name: "LM Studio local", value: "lmstudio" },
      { name: "Custom OpenAI-compatible", value: "custom" }
    ],
    default: "openai"
  });
  if (preset === "ollama") {
    return { name: "ollama", model: "qwen2.5-coder:latest", baseUrl: "http://localhost:11434/v1", apiKey: "ollama", apiKeyEnv: "" };
  }
  if (preset === "lmstudio") {
    return { name: "lmstudio", model: "local-model", baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio", apiKeyEnv: "" };
  }
  return defaultHttp(kind);
}

async function promptCommandModel(): Promise<CommandModelConfig> {
  const preset = await select({
    message: "Command adapter preset",
    choices: [
      { name: "Codex CLI", value: "codex" },
      { name: "Claude Code", value: "claude" },
      { name: "Custom command", value: "custom" }
    ]
  });
  if (preset === "codex") {
    return {
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
      auth: { type: "command", loginCommand: "codex", loginArgs: ["login"], checkCommand: "codex", checkArgs: ["--version"] }
    };
  }
  if (preset === "claude") {
    return {
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
      auth: { type: "command", loginCommand: "claude", loginArgs: ["login"], checkCommand: "claude", checkArgs: ["--version"] }
    };
  }
  const name = await input({ message: "Adapter name", default: "custom-command" });
  const command = await input({ message: "Command", required: true });
  const args = await input({ message: "Args, space separated. Templates: {{task}} {{prompt}} {{sandbox}}", default: "{{task}}" });
  return {
    name,
    provider: name,
    kind: "command",
    model: name,
    modelIds: [name],
    command,
    args: args.split(/\s+/).filter(Boolean),
    protocol: "plain-final",
    timeoutMs: 600000,
    auth: { type: "command", loginCommand: command, loginArgs: ["login"] }
  };
}

async function promptCustomModel(): Promise<ModelConfig> {
  const name = await input({ message: "Custom provider name", default: "custom-provider" });
  const modelIds = await promptModelIds(name, name);
  const modulePath = await input({ message: "Provider module path", default: "./sandeval-provider.js" });
  return {
    name,
    provider: name,
    kind: "custom",
    ...modelFields(modelIds),
    modulePath,
    exportName: "createProvider"
  };
}

async function promptModelIds(providerName: string, suggestedModel: string): Promise<string[]> {
  const addModels = await confirm({ message: `Add model IDs for ${providerName} now?`, default: true });
  if (!addModels) {
    return [];
  }
  const raw = await input({
    message: `${providerName} model ID(s), separated by comma or whitespace`,
    default: suggestedModel,
    validate: (value) => (parseModelIds(value).length > 0 ? true : "Enter at least one model ID or choose not to add models")
  });
  return parseModelIds(raw);
}

function modelFields(modelIds: string[]): Pick<ModelConfig, "model" | "modelIds"> {
  return modelIds.length > 0 ? { model: modelIds[0], modelIds } : {};
}

function parseModelIds(value: string): string[] {
  return [...new Set(value.split(/[,\s]+/).map((model) => model.trim()).filter(Boolean))];
}

function appendModel(config: SandEvalConfig, model: ModelConfig): void {
  config.models.push({ ...model, name: uniqueModelName(config, model.name) } as ModelConfig);
}

function uniqueModelName(config: SandEvalConfig, name: string): string {
  const existing = new Set(config.models.map((model) => model.name));
  if (!existing.has(name)) {
    return name;
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${name}-${index}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
}

function defaultHttp(kind: HttpModelConfig["kind"]): Pick<HttpModelConfig, "name" | "baseUrl" | "apiKeyEnv"> & { model: string } {
  if (kind === "anthropic-compatible") {
    return { name: "anthropic", model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com", apiKeyEnv: "ANTHROPIC_API_KEY" };
  }
  if (kind === "gemini-compatible") {
    return {
      name: "gemini",
      model: "gemini-2.5-pro",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKeyEnv: "GEMINI_API_KEY"
    };
  }
  return { name: "openai", model: "gpt-5.4", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" };
}

function positiveInteger(value: string): true | string {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? true : "Enter a positive integer";
}
