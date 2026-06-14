import path from "node:path";
import type {
  AgentRunResult,
  ChatMessage,
  FinishPayload,
  ModelConfig,
  ModelProvider,
  RunEvent,
  RunEventHandler,
  RunPlan,
  AppliedRule,
  AppliedSkill,
  ToolsConfig,
  ToolCall,
  Usage,
  WorkflowEvent,
  WorkflowRawArtifact
} from "./types.js";
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } from "./tools.js";
import { Sandbox } from "./sandbox.js";
import { listArtifactFiles, createRunId, stringifyError, sumUsage, truncate } from "./utils.js";
import { parseWorkflowResponse, workflowEventsToRunEvents } from "./workflow.js";

export interface RunAgentOptions {
  task: string;
  modelConfig: ModelConfig;
  provider: ModelProvider;
  sandbox: Sandbox;
  maxTurns?: number;
  systemPrompt?: string;
  toolPermissions?: ToolsConfig;
  activeRules?: AppliedRule[];
  activeSkills?: AppliedSkill[];
  plan?: RunPlan;
  onEvent?: RunEventHandler;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const started = new Date();
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt ?? AGENT_SYSTEM_PROMPT },
    { role: "user", content: options.task }
  ];
  const usages: Usage[] = [];
  let finish: FinishPayload | undefined;
  let finalContent: string | undefined;
  let turns = 0;
  const workflowEvents: WorkflowEvent[] = [];
  const workflowRaw: WorkflowRawArtifact[] = [];
  const workflowAdapter = options.modelConfig.kind === "command" ? options.modelConfig.workflowAdapter : undefined;

  await options.sandbox.init();
  emit(options.onEvent, {
    type: "run-start",
    modelName: options.modelConfig.name,
    message: `Run started for ${options.modelConfig.name}`,
    detail: { sandbox: options.sandbox.root }
  });

  for (let turnIndex = 0; turnIndex < (options.maxTurns ?? 12); turnIndex += 1) {
    turns += 1;
    emit(options.onEvent, {
      type: "model-turn-start",
      modelName: options.modelConfig.name,
      turn: turns,
      message: `Turn ${turns}: sending task context to model`
    });
    const response = await options.provider.chat({
      messages,
      tools: AGENT_TOOLS,
      temperature: options.modelConfig.temperature,
      maxTokens: options.modelConfig.maxTokens,
      metadata: {
        sandbox: options.sandbox.root
      }
    });
    emit(options.onEvent, {
      type: "model-turn-finish",
      modelName: options.modelConfig.name,
      turn: turns,
      message: response.toolCalls.length
        ? `Turn ${turns}: model requested ${response.toolCalls.length} tool call(s)`
        : `Turn ${turns}: model returned final content`,
      detail: {
        contentPreview: truncate(response.content, 240),
        toolCalls: response.toolCalls.map((toolCall) => toolCall.name),
        usage: response.usage
      }
    });

    const workflow = parseWorkflowResponse(options.modelConfig, response, turns);
    if (workflow.raw) {
      workflowRaw.push(workflow.raw);
    }
    if (workflow.events.length) {
      workflowEvents.push(...workflow.events);
      for (const event of workflowEventsToRunEvents(workflow.events, options.modelConfig.name)) {
        emit(options.onEvent, event);
      }
    }

    usages.push(response.usage ?? {});
    messages.push({
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls
    });

    if (response.toolCalls.length === 0) {
      finalContent = response.content;
      break;
    }

    for (const toolCall of response.toolCalls) {
      emit(options.onEvent, {
        type: "tool-start",
        modelName: options.modelConfig.name,
        turn: turns,
        toolName: toolCall.name,
        message: describeToolStart(toolCall),
        detail: toolCall.arguments
      });
      const result = await executeTool(options.sandbox, toolCall.name, toolCall.arguments, options.toolPermissions);
      emit(options.onEvent, {
        type: "tool-finish",
        modelName: options.modelConfig.name,
        turn: turns,
        toolName: toolCall.name,
        message: describeToolFinish(toolCall, result),
        level: hasToolError(result) ? "error" : "success",
        detail: normalizeToolResult(result)
      });
      messages.push({
        role: "tool",
        name: toolCall.name,
        toolCallId: toolCall.id,
        content: JSON.stringify(result)
      });

      if (toolCall.name === "finish") {
        finish = result as FinishPayload;
      }
    }

    if (finish) {
      break;
    }
  }

  const finished = new Date();
  const files = await listArtifactFiles(options.sandbox.root);
  emit(options.onEvent, {
    type: "run-finish",
    modelName: options.modelConfig.name,
    message: `Run finished for ${options.modelConfig.name}`,
    level: "success",
    detail: { files: files.map((file) => file.path), commands: options.sandbox.commandResults.length }
  });

  return {
    id: path.basename(options.sandbox.root) || createRunId(),
    modelName: options.modelConfig.name,
    task: options.task,
    workspace: options.sandbox.root,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    messages,
    finish,
    finalContent,
    commands: options.sandbox.commandResults,
    files,
    usage: sumUsage(usages),
    turns,
    activeRules: options.activeRules,
    activeSkills: options.activeSkills,
    plan: options.plan,
    toolPermissions: options.toolPermissions,
    workflowAdapter,
    workflowEvents,
    workflowRaw
  };
}

function emit(onEvent: RunEventHandler | undefined, event: Omit<RunEvent, "at">): void {
  onEvent?.({
    at: new Date().toISOString(),
    level: "info",
    ...event
  });
}

function describeToolStart(toolCall: ToolCall): string {
  if (toolCall.name === "write_file" && typeof toolCall.arguments.path === "string") {
    return `Writing file ${toolCall.arguments.path}`;
  }
  if (toolCall.name === "read_file" && typeof toolCall.arguments.path === "string") {
    return `Reading file ${toolCall.arguments.path}`;
  }
  if (toolCall.name === "list_files") {
    return `Listing files in ${typeof toolCall.arguments.path === "string" ? toolCall.arguments.path : "."}`;
  }
  if (toolCall.name === "run_command") {
    const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "command";
    const args = Array.isArray(toolCall.arguments.args) ? toolCall.arguments.args.map(String).join(" ") : "";
    return `Running terminal command: ${command}${args ? ` ${args}` : ""}`;
  }
  if (toolCall.name === "finish") {
    return "Finishing task";
  }
  return `Calling tool ${toolCall.name}`;
}

function describeToolFinish(toolCall: ToolCall, result: unknown): string {
  if (hasToolError(result)) {
    return `${toolCall.name} failed`;
  }
  if (toolCall.name === "write_file" && isRecord(result)) {
    return `Wrote ${String(result.path ?? toolCall.arguments.path ?? "file")} (${String(result.bytes ?? "?")} bytes)`;
  }
  if (toolCall.name === "run_command" && isRecord(result)) {
    return `Command exited ${String(result.exitCode ?? "?")} in ${String(result.durationMs ?? "?")}ms`;
  }
  if (toolCall.name === "finish") {
    return "Task marked complete";
  }
  return `${toolCall.name} completed`;
}

function normalizeToolResult(result: unknown): Record<string, unknown> | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const normalized = { ...result };
  if (typeof normalized.stdout === "string") {
    normalized.stdout = truncate(normalized.stdout, 1200);
  }
  if (typeof normalized.stderr === "string") {
    normalized.stderr = truncate(normalized.stderr, 1200);
  }
  if (typeof normalized.content === "string") {
    normalized.content = truncate(normalized.content, 1200);
  }
  return normalized;
}

function hasToolError(result: unknown): boolean {
  return isRecord(result) && typeof result.error === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function executeTool(sandbox: Sandbox, name: string, args: Record<string, unknown>, tools: ToolsConfig = {}): Promise<unknown> {
  try {
    switch (name) {
      case "write_file": {
        ensureFilesEnabled(tools);
        const relativePath = expectString(args.path, "path");
        const content = expectString(args.content, "content");
        return sandbox.writeFile(relativePath, content);
      }
      case "read_file": {
        ensureFilesEnabled(tools);
        const relativePath = expectString(args.path, "path");
        return { path: relativePath, content: truncate(await sandbox.readFile(relativePath), 12000) };
      }
      case "list_files": {
        ensureFilesEnabled(tools);
        const relativePath = typeof args.path === "string" ? args.path : ".";
        return { path: relativePath, files: await sandbox.listFiles(relativePath) };
      }
      case "search_files": {
        ensureFilesEnabled(tools);
        const query = expectString(args.query, "query");
        const relativePath = typeof args.path === "string" ? args.path : ".";
        return { query, path: relativePath, matches: await sandbox.searchFiles(query, relativePath) };
      }
      case "replace_in_file": {
        ensureFilesEnabled(tools);
        const relativePath = expectString(args.path, "path");
        const search = expectString(args.search, "search");
        const replace = expectString(args.replace, "replace");
        const all = typeof args.all === "boolean" ? args.all : false;
        return sandbox.replaceInFile(relativePath, search, replace, all);
      }
      case "run_command": {
        const command = expectString(args.command, "command");
        const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        ensureCommandAllowed(command, commandArgs, tools);
        const requestedTimeout = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        const timeoutMs = tools.maxCommandTimeoutMs
          ? Math.min(requestedTimeout ?? tools.maxCommandTimeoutMs, tools.maxCommandTimeoutMs)
          : requestedTimeout;
        return sandbox.runCommand(command, commandArgs, timeoutMs);
      }
      case "finish": {
        return {
          summary: typeof args.summary === "string" ? args.summary : undefined,
          instructions: typeof args.instructions === "string" ? args.instructions : undefined,
          artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : undefined
        } satisfies FinishPayload;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      error: stringifyError(error)
    };
  }
}

function expectString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${name} to be a string.`);
  }
  return value;
}

function ensureFilesEnabled(tools: ToolsConfig): void {
  if (tools.files === false) {
    throw new Error("File tools are disabled by config.tools.files.");
  }
}

function ensureCommandAllowed(command: string, args: string[], tools: ToolsConfig): void {
  if (tools.shell === false) {
    throw new Error("Shell commands are disabled by config.tools.shell.");
  }

  const executable = baseCommand(command);
  if ((tools.blockedCommands ?? []).includes(executable)) {
    throw new Error(`Command "${executable}" is blocked by config.tools.blockedCommands.`);
  }

  if (executable === "git") {
    ensureGitAllowed(args, tools);
    return;
  }

  if (tools.packageManager === false && isPackageManager(executable)) {
    throw new Error(`Package manager command "${executable}" is disabled by config.tools.packageManager.`);
  }
}

function ensureGitAllowed(args: string[], tools: ToolsConfig): void {
  const mode = tools.git ?? "full";
  if (mode === "off") {
    throw new Error("Git commands are disabled by config.tools.git.");
  }

  const subcommand = args[0] ?? "";
  const remoteSubcommands = new Set(["push", "pull", "fetch", "clone", "remote"]);
  if (remoteSubcommands.has(subcommand) && tools.gitRemote !== true) {
    throw new Error(`Git remote command "git ${subcommand}" is disabled by config.tools.gitRemote.`);
  }

  const readOnly = new Set(["status", "diff", "log", "show", "rev-parse"]);
  if (mode === "read") {
    if (!readOnly.has(subcommand)) {
      throw new Error(`Git command "git ${subcommand}" requires config.tools.git to be "full".`);
    }
    return;
  }

  if (subcommand === "reset" && args.includes("--hard")) {
    throw new Error("Dangerous Git command \"git reset --hard\" is disabled.");
  }
  if (subcommand === "clean" && args.some((arg) => arg.includes("f"))) {
    throw new Error("Dangerous Git clean with force is disabled.");
  }
  if (subcommand === "checkout" && !args.includes("-b")) {
    throw new Error("Git checkout is limited to branch creation with -b.");
  }
  if (subcommand === "switch" && !args.includes("-c")) {
    throw new Error("Git switch is limited to branch creation with -c.");
  }
}

function baseCommand(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

function isPackageManager(command: string): boolean {
  return new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "uv", "poetry", "cargo", "go"]).has(command);
}
