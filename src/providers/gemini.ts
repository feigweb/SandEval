import type { ChatMessage, HttpModelConfig, ModelChatRequest, ModelProvider, ModelResponse, ToolCall } from "../types.js";
import { fetchJson, getApiKey, joinUrl, normalizeToolCall, normalizeUsage } from "./base.js";

export class GeminiCompatibleProvider implements ModelProvider {
  readonly name: string;

  constructor(private readonly config: HttpModelConfig) {
    this.name = config.name;
  }

  async chat(request: ModelChatRequest): Promise<ModelResponse> {
    const apiKey = await getApiKey(this.config);
    const url = `${joinUrl(this.config.baseUrl, `/models/${this.config.model}:generateContent`)}?key=${encodeURIComponent(apiKey)}`;
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");

    const raw = (await fetchJson(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.config.headers
      },
      body: JSON.stringify({
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: toGeminiContents(request.messages.filter((message) => message.role !== "system")),
        tools: request.tools?.length
          ? [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema
                }))
              }
            ]
          : undefined,
        generationConfig: {
          temperature: request.temperature ?? this.config.temperature,
          maxOutputTokens: request.maxTokens ?? this.config.maxTokens
        }
      })
    })) as GeminiResponse;

    const parts = raw.candidates?.[0]?.content?.parts ?? [];
    const content = parts
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    const toolCalls: ToolCall[] = parts
      .filter((part) => part.functionCall?.name)
      .map((part, index) =>
        normalizeToolCall(`gemini_${Date.now()}_${index}`, part.functionCall?.name ?? "tool", part.functionCall?.args, index)
      );

    return {
      content,
      toolCalls,
      usage: normalizeUsage(
        raw.usageMetadata?.promptTokenCount,
        raw.usageMetadata?.candidatesTokenCount,
        raw.usageMetadata?.totalTokenCount
      ),
      raw
    };
  }
}

function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.name ?? "tool",
              response: {
                content: message.content
              }
            }
          }
        ]
      };
    }

    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "model",
        parts: [
          ...(message.content ? [{ text: message.content }] : []),
          ...message.toolCalls.map((toolCall) => ({
            functionCall: {
              name: toolCall.name,
              args: toolCall.arguments
            }
          }))
        ]
      };
    }

    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }]
    };
  });
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        functionCall?: {
          name?: string;
          args?: unknown;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}
