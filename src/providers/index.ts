import type { ModelConfig, ModelProvider } from "../types.js";
import { AnthropicCompatibleProvider } from "./anthropic.js";
import { CommandProvider } from "./command.js";
import { GeminiCompatibleProvider } from "./gemini.js";
import { MockProvider } from "./mock.js";
import { OpenAICompatibleProvider } from "./openai.js";
import { CustomProvider } from "./custom.js";

export function createProvider(config: ModelConfig): ModelProvider {
  switch (config.kind) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
    case "anthropic-compatible":
      return new AnthropicCompatibleProvider(config);
    case "gemini-compatible":
      return new GeminiCompatibleProvider(config);
    case "command":
      return new CommandProvider(config);
    case "custom":
      return new CustomProvider(config);
    case "mock":
      return new MockProvider(config.name);
    default:
      throw new Error(`Unsupported model kind: ${(config as ModelConfig).kind}`);
  }
}
