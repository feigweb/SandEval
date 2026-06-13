import { checkbox, confirm, input, select } from "@inquirer/prompts";
import password from "@inquirer/password";
import type { CommandModelConfig, HttpModelConfig, ModelConfig, SandEvalConfig } from "./types.js";
import { createDefaultConfig, listModelNames, loadConfig, saveConfig } from "./config.js";

export async function runConfigWizard(cwd: string, configPath?: string): Promise<string> {
  let config: SandEvalConfig;
  try {
    config = await loadConfig(cwd, configPath);
  } catch {
    config = createDefaultConfig();
  }

  config.version = 1;
  config.reportDir = await input({ message: "Report directory", default: config.reportDir ?? ".sandeval/reports" });
  config.sandbox = config.sandbox ?? {};
  config.sandbox.mode = await select({
    message: "Sandbox mode",
    choices: [
      { name: "Local workspace", value: "local" },
      { name: "Docker container", value: "docker" },
      { name: "Podman container", value: "podman" },
      { name: "Bubblewrap Linux sandbox", value: "bubblewrap" },
      { name: "Firejail Linux sandbox", value: "firejail" },
      { name: "nsjail Linux sandbox", value: "nsjail" }
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
  } else if (config.sandbox.mode !== "local") {
    config.sandbox.network = await confirm({ message: "Allow network in sandbox?", default: config.sandbox.network ?? false });
  }

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

  const selectedProviders = await checkbox({
    message: "Providers to keep/add",
    choices: [
      { name: "Mock", value: "mock", checked: true },
      { name: "OpenAI compatible", value: "openai-compatible", checked: hasKind(config, "openai-compatible") },
      { name: "Anthropic compatible", value: "anthropic-compatible", checked: hasKind(config, "anthropic-compatible") },
      { name: "Gemini compatible", value: "gemini-compatible", checked: hasKind(config, "gemini-compatible") },
      { name: "Command adapter (Codex/Claude Code/custom)", value: "command", checked: hasKind(config, "command") },
      { name: "Custom JS provider module", value: "custom", checked: hasKind(config, "custom") }
    ],
    required: true
  });

  config.models = [];
  if (selectedProviders.includes("mock")) {
    config.models.push({ name: "mock", provider: "mock", kind: "mock", model: "mock-agent", modelIds: ["mock-agent"] });
  }
  for (const kind of selectedProviders) {
    if (kind === "openai-compatible" || kind === "anthropic-compatible" || kind === "gemini-compatible") {
      config.models.push(await promptHttpModel(kind));
    }
    if (kind === "command") {
      config.models.push(await promptCommandModel());
    }
    if (kind === "custom") {
      config.models.push(await promptCustomModel());
    }
  }

  const modelRefs = listModelNames(config);
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

  config.agent = config.agent ?? {};
  config.agent.maxTurns = Number(
    await input({ message: "Max agent turns", default: String(config.agent.maxTurns ?? 12), validate: positiveInteger })
  );
  config.scoring = config.scoring ?? {};
  config.scoring.enabled = await confirm({ message: "Enable judge scoring by default?", default: config.scoring.enabled ?? true });
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

  return saveConfig(config, cwd, configPath);
}

async function promptHttpModel(kind: HttpModelConfig["kind"]): Promise<HttpModelConfig> {
  const defaults = defaultHttp(kind);
  const name = await input({ message: `${kind} name`, default: defaults.name });
  const model = await input({ message: `${name} model id`, default: defaults.model });
  const baseUrl = await input({ message: `${name} base URL`, default: defaults.baseUrl });
  const apiKeyEnv = await input({ message: `${name} API key env var`, default: defaults.apiKeyEnv });
  const storeKey = await confirm({ message: `Store an API key directly in config for ${name}?`, default: false });
  const apiKey = storeKey
    ? await password({ message: `${name} API key`, mask: "*", validate: (value) => (value.trim() ? true : "Required") })
    : undefined;
  return {
    name,
    provider: name,
    kind,
    model,
    modelIds: [model],
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
  const modulePath = await input({ message: "Provider module path", default: "./sandeval-provider.js" });
  return {
    name,
    provider: name,
    kind: "custom",
    model: name,
    modelIds: [name],
    modulePath,
    exportName: "createProvider"
  };
}

function defaultHttp(kind: HttpModelConfig["kind"]): Pick<HttpModelConfig, "name" | "model" | "baseUrl" | "apiKeyEnv"> {
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

function hasKind(config: SandEvalConfig, kind: ModelConfig["kind"]): boolean {
  return config.models.some((model) => model.kind === kind);
}

function positiveInteger(value: string): true | string {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? true : "Enter a positive integer";
}
