import path from "node:path";
import type {
  AgentRunResult,
  ChatMessage,
  FinishPayload,
  ModelConfig,
  ModelProvider,
  RunEvent,
  RunEventHandler,
  ToolCall,
  Usage
} from "./types.js";
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS } from "./tools.js";
import { Sandbox } from "./sandbox.js";
import { listArtifactFiles, createRunId, stringifyError, sumUsage, truncate } from "./utils.js";

export interface RunAgentOptions {
  task: string;
  modelConfig: ModelConfig;
  provider: ModelProvider;
  sandbox: Sandbox;
  maxTurns?: number;
  onEvent?: RunEventHandler;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
  const started = new Date();
  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: options.task }
  ];
  const usages: Usage[] = [];
  let finish: FinishPayload | undefined;
  let finalContent: string | undefined;
  let turns = 0;

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
      const result = await executeTool(options.sandbox, toolCall.name, toolCall.arguments);
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
    turns
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

async function executeTool(sandbox: Sandbox, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case "write_file": {
        const relativePath = expectString(args.path, "path");
        const content = expectString(args.content, "content");
        return sandbox.writeFile(relativePath, content);
      }
      case "read_file": {
        const relativePath = expectString(args.path, "path");
        return { path: relativePath, content: truncate(await sandbox.readFile(relativePath), 12000) };
      }
      case "list_files": {
        const relativePath = typeof args.path === "string" ? args.path : ".";
        return { path: relativePath, files: await sandbox.listFiles(relativePath) };
      }
      case "search_files": {
        const query = expectString(args.query, "query");
        const relativePath = typeof args.path === "string" ? args.path : ".";
        return { query, path: relativePath, matches: await sandbox.searchFiles(query, relativePath) };
      }
      case "replace_in_file": {
        const relativePath = expectString(args.path, "path");
        const search = expectString(args.search, "search");
        const replace = expectString(args.replace, "replace");
        const all = typeof args.all === "boolean" ? args.all : false;
        return sandbox.replaceInFile(relativePath, search, replace, all);
      }
      case "run_command": {
        const command = expectString(args.command, "command");
        const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
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
