import type { ChatMessage, HttpModelConfig, ModelChatRequest, ModelProvider, ModelResponse, ToolCall } from "../types.js";
import { fetchJson, getApiKey, joinUrl, normalizeToolCall, normalizeUsage } from "./base.js";

export class AnthropicCompatibleProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: HttpModelConfig) {
    this.name = config.name;
  }

  async chat(request: ModelChatRequest): Promise<ModelResponse> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const body = {
      model: this.config.model,
      system: system || undefined,
      messages: toAnthropicMessages(request.messages.filter((message) => message.role !== "system")),
      tools: request.tools?.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      })),
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens ?? this.config.maxTokens ?? 4096
    };

    const raw = (await fetchJson(joinUrl(this.config.baseUrl, "/v1/messages"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": await getApiKey(this.config),
        "anthropic-version": this.config.headers?.["anthropic-version"] ?? "2023-06-01",
        ...this.config.headers
      },
      body: JSON.stringify(body)
    })) as AnthropicMessageResponse;

    const text = raw.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n") ?? "";

    const toolCalls: ToolCall[] =
      raw.content
        ?.filter((block) => block.type === "tool_use" && typeof block.name === "string")
        .map((block, index) => normalizeToolCall(block.id, block.name ?? "tool", block.input, index)) ?? [];

    return {
      content: text,
      toolCalls,
      usage: normalizeUsage(raw.usage?.input_tokens, raw.usage?.output_tokens),
      raw
    };
  }
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content
          }
        ]
      });
      continue;
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      result.push({
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.arguments
          }))
        ]
      });
      continue;
    }

    result.push({
      role: message.role === "assistant" ? "assistant" : "user",
      content: message.content
    });
  }

  return result;
}

interface AnthropicMessageResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}
