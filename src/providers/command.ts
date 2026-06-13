import { spawn } from "node:child_process";
import type { CommandModelConfig, ModelChatRequest, ModelProvider, ModelResponse, ToolCall } from "../types.js";
import { estimateTokens, stripJsonFence, truncate } from "../utils.js";
import { parseArguments } from "./base.js";

export class CommandProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: CommandModelConfig) {
    this.name = config.name;
  }

  async chat(request: ModelChatRequest): Promise<ModelResponse> {
    const prompt = request.messages.map((message) => `${message.role}: ${message.content}`).join("\n\n");
    const task = request.messages.find((message) => message.role === "user")?.content ?? prompt;
    const sandbox = typeof request.metadata?.sandbox === "string" ? request.metadata.sandbox : undefined;
    const args = (this.config.args ?? []).map((arg) =>
      arg
        .replaceAll("{{prompt}}", prompt)
        .replaceAll("{{task}}", task)
        .replaceAll("{{sandbox}}", sandbox ?? "")
    );
    const payload = {
      provider: this.config.name,
      model: this.config.model,
      messages: request.messages,
      tools: request.tools,
      metadata: request.metadata
    };

    const result = await runCommandProcess({
      command: this.config.command,
      args,
      cwd: this.config.cwd ?? sandbox ?? process.cwd(),
      env: { ...process.env, ...this.config.env },
      stdin: JSON.stringify(payload),
      timeoutMs: this.config.timeoutMs ?? 600000
    });

    if (result.exitCode !== 0) {
      throw new Error(`Command provider "${this.config.name}" failed with exit code ${result.exitCode}:\n${result.stderr}`);
    }

    if ((this.config.protocol ?? "sandeval-json") === "plain-final") {
      return {
        content: result.stdout.trim(),
        toolCalls: [],
        usage: {
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(result.stdout),
          totalTokens: estimateTokens(prompt) + estimateTokens(result.stdout)
        },
        raw: result
      };
    }

    const parsed = JSON.parse(stripJsonFence(result.stdout)) as {
      content?: string;
      toolCalls?: Array<{ id?: string; name: string; arguments?: unknown; args?: unknown }>;
      usage?: ModelResponse["usage"];
    };

    const toolCalls: ToolCall[] =
      parsed.toolCalls?.map((toolCall, index) => ({
        id: toolCall.id ?? `cmd_${Date.now()}_${index}`,
        name: toolCall.name,
        arguments: parseArguments(toolCall.arguments ?? toolCall.args)
      })) ?? [];

    return {
      content: parsed.content ?? "",
      toolCalls,
      usage: parsed.usage,
      raw: result
    };
  }
}

async function runCommandProcess(options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      shell: false
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: truncate(stdout, 20000),
        stderr: truncate(stderr, 20000),
        timedOut
      });
    });

    child.stdin.write(options.stdin);
    child.stdin.end();
  });
}
