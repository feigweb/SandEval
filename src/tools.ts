import type { ToolSpec } from "./types.js";

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: "write_file",
    description: "Create or replace a UTF-8 text file inside the sandbox workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the sandbox." },
        content: { type: "string", description: "Complete UTF-8 file content." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file from inside the sandbox workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path inside the sandbox." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "list_files",
    description: "List files inside the sandbox workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional relative directory path." }
      },
      additionalProperties: false
    }
  },
  {
    name: "search_files",
    description: "Search text files in the sandbox workspace for a substring.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for." },
        path: { type: "string", description: "Optional relative directory path." }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "replace_in_file",
    description: "Replace text in a UTF-8 file inside the sandbox workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" },
        all: { type: "boolean", description: "Replace all occurrences when true; otherwise only the first occurrence." }
      },
      required: ["path", "search", "replace"],
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    description: "Run a command inside the sandbox workspace and capture stdout, stderr, exit code, and duration.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable name, such as node, npm, python, or bash." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Command arguments. Prefer args instead of shell strings."
        },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds." }
      },
      required: ["command"],
      additionalProperties: false
    }
  },
  {
    name: "finish",
    description: "Finish the task with a concise summary and list of important artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        instructions: { type: "string", description: "How to run or inspect the artifact." },
        artifacts: {
          type: "array",
          items: { type: "string" },
          description: "Relative artifact paths created in the sandbox."
        }
      },
      additionalProperties: false
    }
  }
];

export const SCORING_SYSTEM_PROMPT = [
  "You are SandEval Judge, a strict evaluator for coding-agent outputs.",
  "Score each requested dimension from 0 to 100 using the provided rubric, task, artifacts, commands, workflow, and user feedback.",
  "Do not let a strong plan compensate for incorrect or unrunnable work; plan quality affects only workflowQuality.",
  "Return only compact JSON with keys: dimensions, summary, strengths, weaknesses, userFeedbackImpact.",
  "strengths and weaknesses must be arrays of short strings."
].join("\n");

export const AGENT_SYSTEM_PROMPT = [
  "You are SandEval Agent, a coding agent running inside a sandbox workspace.",
  "Use tool calls to create artifacts and run verification commands.",
  "All file paths must be relative paths inside the sandbox.",
  "Prefer small, complete, runnable artifacts.",
  "Before finishing, run the most relevant command to verify the artifact when possible.",
  "Call finish when the artifact is ready."
].join("\n");
