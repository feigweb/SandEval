import type { ModelConfig, ModelResponse, WorkflowEvent, WorkflowRawArtifact } from "./types.js";
import { truncate } from "./utils.js";

export interface WorkflowParseResult {
  adapter?: string;
  events: WorkflowEvent[];
  raw?: WorkflowRawArtifact;
}

interface RawCommandOutput {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  timedOut?: boolean;
}

export function parseWorkflowResponse(modelConfig: ModelConfig, response: ModelResponse, turn: number): WorkflowParseResult {
  const adapter = modelConfig.kind === "command" ? normalizeAdapter(modelConfig.workflowAdapter) : undefined;
  if (!adapter || adapter === "none") {
    return { events: [] };
  }

  const rawOutput = extractRawCommandOutput(response.raw);
  const raw: WorkflowRawArtifact | undefined = rawOutput
    ? {
        adapter,
        stdout: rawOutput.stdout ? truncate(rawOutput.stdout, 20000) : undefined,
        stderr: rawOutput.stderr ? truncate(rawOutput.stderr, 20000) : undefined,
        exitCode: rawOutput.exitCode,
        timedOut: rawOutput.timedOut
      }
    : undefined;

  const text = [rawOutput?.stdout, rawOutput?.stderr].filter(Boolean).join("\n");
  const jsonLines = parseJsonRecords(text);
  const events =
    adapter === "claude-code"
      ? parseClaudeCodeEvents(adapter, jsonLines, response, turn)
      : adapter === "codex"
        ? parseCodexEvents(adapter, jsonLines, response, turn)
        : parseGenericJsonlEvents(adapter, jsonLines, response, turn);

  if (raw && jsonLines.length) {
    raw.jsonLineCount = jsonLines.length;
  }

  if (events.length === 0 && response.content.trim()) {
    events.push(createWorkflowEvent(adapter, "assistant-message", turn, "Final output", response.content.trim()));
  }

  if (events.length === 0 && rawOutput?.stderr) {
    events.push(createWorkflowEvent(adapter, "raw", turn, "Raw stderr", truncate(rawOutput.stderr, 1200), { level: "warning" }));
  }

  return { adapter, events, raw };
}

export function workflowEventsToRunEvents(events: WorkflowEvent[], modelName: string): Array<{
  type: "info" | "error";
  modelName: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  detail: Record<string, unknown>;
}> {
  return events.map((event) => ({
    type: event.level === "error" ? "error" : "info",
    modelName,
    level: event.level ?? "info",
    message: `[${event.adapter}] ${event.title}${event.message ? `: ${truncate(event.message, 160)}` : ""}`,
    detail: {
      workflowEventId: event.id,
      adapter: event.adapter,
      kind: event.kind,
      phase: event.phase,
      status: event.status,
      toolName: event.toolName,
      command: event.command,
      path: event.path,
      rawType: event.rawType
    }
  }));
}

function normalizeAdapter(adapter?: string): string | undefined {
  if (!adapter) {
    return undefined;
  }
  const normalized = adapter.trim().toLowerCase();
  if (["claude", "claude_code", "claude-code"].includes(normalized)) {
    return "claude-code";
  }
  if (["codex", "codex-cli", "openai-codex"].includes(normalized)) {
    return "codex";
  }
  if (["jsonl", "stream-json", "stream_json"].includes(normalized)) {
    return "jsonl";
  }
  return normalized;
}

function parseClaudeCodeEvents(
  adapter: string,
  jsonLines: Array<Record<string, unknown>>,
  response: ModelResponse,
  turn: number
): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  for (const line of jsonLines) {
    const type = stringValue(line.type);
    const message = recordValue(line.message);
    if (type === "assistant" && message) {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (!isRecord(item)) {
          continue;
        }
        const itemType = stringValue(item.type);
        if (itemType === "text") {
          events.push(createWorkflowEvent(adapter, "assistant-message", turn, "Assistant", stringValue(item.text), { raw: line, rawType: type }));
        } else if (itemType === "tool_use") {
          events.push(toolUseEvent(adapter, turn, stringValue(item.name) ?? "tool", item.input, line, type));
        }
      }
      continue;
    }

    if (type === "user" && message) {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (isRecord(item) && stringValue(item.type) === "tool_result") {
          events.push(
            createWorkflowEvent(adapter, "tool-result", turn, "Tool result", stringifyShort(item.content), {
              level: boolValue(item.is_error) ? "error" : "success",
              raw: line,
              rawType: type
            })
          );
        }
      }
      continue;
    }

    if (type === "system") {
      events.push(createWorkflowEvent(adapter, "status", turn, "System", stringValue(line.subtype) ?? "Claude Code system event", { raw: line, rawType: type }));
      continue;
    }

    if (type === "result") {
      events.push(
        createWorkflowEvent(adapter, boolValue(line.is_error) ? "error" : "result", turn, "Result", stringValue(line.result) ?? stringValue(line.error), {
          level: boolValue(line.is_error) ? "error" : "success",
          raw: line,
          rawType: type
        })
      );
    }
  }

  if (events.length === 0) {
    events.push(...parseGenericJsonlEvents(adapter, jsonLines, response, turn));
  }
  return events;
}

function parseCodexEvents(
  adapter: string,
  jsonLines: Array<Record<string, unknown>>,
  response: ModelResponse,
  turn: number
): WorkflowEvent[] {
  const events: WorkflowEvent[] = [];
  for (const line of jsonLines) {
    const type = stringValue(line.type) ?? stringValue(line.event) ?? stringValue(line.name);
    const item = recordValue(line.item) ?? line;
    const itemType = isRecord(item) ? stringValue(item.type) ?? stringValue(item.kind) : undefined;
    const title = titleFromCodexType(type, itemType);

    if (containsAny([type, itemType], ["command", "exec", "shell"])) {
      const command = commandFromRecord(item) ?? commandFromRecord(line);
      events.push(createWorkflowEvent(adapter, "command", turn, title ?? "Command", command, { command, raw: line, rawType: type }));
      continue;
    }

    if (containsAny([type, itemType], ["tool"])) {
      const toolName = stringValue((item as Record<string, unknown>).name) ?? stringValue(line.toolName) ?? "tool";
      events.push(toolUseEvent(adapter, turn, toolName, isRecord(item) ? item.input ?? item.arguments : undefined, line, type));
      continue;
    }

    if (containsAny([type, itemType], ["file", "patch", "edit", "write"])) {
      events.push(
        createWorkflowEvent(adapter, "file-change", turn, title ?? "File change", stringValue((item as Record<string, unknown>).path) ?? stringValue(line.path), {
          path: stringValue((item as Record<string, unknown>).path) ?? stringValue(line.path),
          raw: line,
          rawType: type
        })
      );
      continue;
    }

    if (containsAny([type, itemType], ["message", "reasoning", "assistant"])) {
      events.push(createWorkflowEvent(adapter, "assistant-message", turn, title ?? "Assistant", textFromRecord(item) ?? textFromRecord(line), { raw: line, rawType: type }));
      continue;
    }

    if (containsAny([type, itemType], ["completed", "result", "finish"])) {
      events.push(createWorkflowEvent(adapter, "result", turn, title ?? "Result", textFromRecord(line), { level: "success", raw: line, rawType: type }));
      continue;
    }

    if (containsAny([type, itemType], ["error", "failed"])) {
      events.push(createWorkflowEvent(adapter, "error", turn, title ?? "Error", textFromRecord(line), { level: "error", raw: line, rawType: type }));
    }
  }

  if (events.length === 0) {
    events.push(...parseGenericJsonlEvents(adapter, jsonLines, response, turn));
  }
  return events;
}

function parseGenericJsonlEvents(
  adapter: string,
  jsonLines: Array<Record<string, unknown>>,
  response: ModelResponse,
  turn: number
): WorkflowEvent[] {
  const events = jsonLines.map((line) => {
    const rawType = stringValue(line.type) ?? stringValue(line.event) ?? "json";
    const kind = inferKind(rawType, line);
    const title = titleCase(rawType.replace(/[._-]+/g, " "));
    return createWorkflowEvent(adapter, kind, turn, title, textFromRecord(line), {
      level: kind === "error" ? "error" : "info",
      raw: line,
      rawType
    });
  });

  if (events.length === 0 && response.content.trim()) {
    events.push(createWorkflowEvent(adapter, "assistant-message", turn, "Final output", response.content.trim()));
  }
  return events;
}

function createWorkflowEvent(
  adapter: string,
  kind: WorkflowEvent["kind"],
  turn: number,
  title: string,
  message?: string,
  options: Partial<WorkflowEvent> = {}
): WorkflowEvent {
  return {
    id: `${adapter}-${turn}-${Math.random().toString(36).slice(2, 10)}`,
    adapter,
    kind,
    turn,
    title,
    message: message ? truncate(message, 2400) : undefined,
    phase: options.phase ?? phaseForKind(kind, title),
    status: options.status ?? statusForLevel(options.level, kind),
    level: options.level ?? "info",
    toolName: options.toolName,
    command: options.command,
    path: options.path,
    rawType: options.rawType,
    raw: options.raw
  };
}

function toolUseEvent(adapter: string, turn: number, toolName: string, input: unknown, raw: Record<string, unknown>, rawType?: string): WorkflowEvent {
  const command = toolName.toLowerCase() === "bash" ? commandFromUnknown(input) : undefined;
  const path = pathFromUnknown(input);
  return createWorkflowEvent(adapter, command ? "command" : path ? "file-change" : "tool-call", turn, toolName, stringifyShort(input), {
    toolName,
    command,
    path,
    raw,
    rawType
  });
}

function extractRawCommandOutput(raw: unknown): RawCommandOutput | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const stdout = typeof raw.stdout === "string" ? raw.stdout : undefined;
  const stderr = typeof raw.stderr === "string" ? raw.stderr : undefined;
  if (stdout === undefined && stderr === undefined) {
    return undefined;
  }
  return {
    stdout,
    stderr,
    exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
    timedOut: typeof raw.timedOut === "boolean" ? raw.timedOut : undefined
  };
}

function parseJsonRecords(text: string): Array<Record<string, unknown>> {
  const trimmedText = text.trim();
  if (trimmedText.startsWith("{") || trimmedText.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmedText) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter(isRecord);
      }
      if (isRecord(parsed)) {
        return [parsed];
      }
    } catch {
      // Fall back to JSONL parsing below.
    }
  }

  const lines: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        lines.push(parsed);
      }
    } catch {
      // Best-effort parser: non-JSON log lines still remain available in raw output.
    }
  }
  return lines;
}

function inferKind(rawType: string, line: Record<string, unknown>): WorkflowEvent["kind"] {
  const lowered = rawType.toLowerCase();
  if (lowered.includes("error") || lowered.includes("fail")) {
    return "error";
  }
  if (lowered.includes("tool")) {
    return "tool-call";
  }
  if (lowered.includes("command") || lowered.includes("exec") || stringValue(line.command)) {
    return "command";
  }
  if (lowered.includes("result") || lowered.includes("finish") || lowered.includes("complete")) {
    return "result";
  }
  if (lowered.includes("usage") || stringValue(line.usage)) {
    return "usage";
  }
  if (lowered.includes("message") || lowered.includes("assistant")) {
    return "assistant-message";
  }
  return "status";
}

function phaseForKind(kind: WorkflowEvent["kind"], title: string): WorkflowEvent["phase"] {
  if (kind === "command") {
    const lowered = title.toLowerCase();
    return lowered.includes("test") || lowered.includes("verify") || lowered.includes("build") ? "verify" : "command";
  }
  if (kind === "tool-call" || kind === "tool-result") {
    return "tool";
  }
  if (kind === "file-change") {
    return "file";
  }
  if (kind === "result") {
    return "finish";
  }
  if (kind === "assistant-message") {
    return "think";
  }
  if (kind === "error") {
    return "raw";
  }
  return "raw";
}

function statusForLevel(level: WorkflowEvent["level"] | undefined, kind: WorkflowEvent["kind"]): WorkflowEvent["status"] {
  if (level === "error" || kind === "error") {
    return "error";
  }
  if (level === "success" || kind === "result" || kind === "tool-result") {
    return "success";
  }
  return "running";
}

function titleFromCodexType(type?: string, itemType?: string): string | undefined {
  const value = itemType ?? type;
  return value ? titleCase(value.replace(/[._-]+/g, " ")) : undefined;
}

function containsAny(values: Array<string | undefined>, needles: string[]): boolean {
  return values.some((value) => {
    const lowered = value?.toLowerCase() ?? "";
    return needles.some((needle) => lowered.includes(needle));
  });
}

function commandFromRecord(record: unknown): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  return stringValue(record.command) ?? stringValue(record.cmd) ?? stringValue(record.input);
}

function commandFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.command) ?? stringValue(value.cmd) ?? stringValue(value.input);
}

function pathFromUnknown(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return stringValue(value.path) ?? stringValue(value.file_path) ?? stringValue(value.filePath);
}

function textFromRecord(record: unknown): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }
  return (
    stringValue(record.text) ??
    stringValue(record.message) ??
    stringValue(record.summary) ??
    stringValue(record.result) ??
    stringValue(record.output) ??
    stringValue(record.content) ??
    stringifyShort(record)
  );
}

function stringifyShort(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return truncate(value, 2400);
  }
  try {
    return truncate(JSON.stringify(value), 2400);
  } catch {
    return String(value);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
