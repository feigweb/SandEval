import type { ChatMessage, HttpModelConfig, ModelChatRequest, ModelProvider, ModelResponse, ToolCall } from "../types.js";
import { fetchJson, getApiKey, joinUrl, normalizeToolCall, normalizeUsage, requireModelId } from "./base.js";

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: HttpModelConfig) {
    this.name = config.name;
  }

  async chat(request: ModelChatRequest): Promise<ModelResponse> {
    const body = {
      model: requireModelId(this.config),
      messages: request.messages.map(toOpenAIMessage),
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema
        }
      })),
      tool_choice: request.tools?.length ? "auto" : undefined,
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxTokens ?? this.config.maxTokens,
      response_format:
        request.responseFormat?.type === "json_schema"
          ? {
              type: "json_schema",
              json_schema: {
                name: request.responseFormat.name,
                description: request.responseFormat.description,
                schema: request.responseFormat.schema,
                strict: request.responseFormat.strict ?? true
              }
            }
          : undefined
    };

    const raw = (await fetchJson(joinUrl(this.config.baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${await getApiKey(this.config)}`,
        ...this.config.headers
      },
      body: JSON.stringify(body)
    })) as OpenAIChatResponse;

    const message = raw.choices?.[0]?.message;
    const toolCalls: ToolCall[] =
      message?.tool_calls?.map((call, index) =>
        normalizeToolCall(call.id, call.function.name, call.function.arguments, index)
      ) ?? [];

    return {
      content: typeof message?.content === "string" ? message.content : "",
      toolCalls,
      usage: normalizeUsage(raw.usage?.prompt_tokens, raw.usage?.completion_tokens, raw.usage?.total_tokens),
      raw
    };
  }
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content
    };
  }
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments)
        }
      }))
    };
  }
  return {
    role: message.role,
    content: message.content
  };
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
