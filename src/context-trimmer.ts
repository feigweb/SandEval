import type { ChatMessage, ContextTrimmerConfig } from "./types.js";
import { estimateTokens, truncate } from "./utils.js";

export interface TrimContextOptions {
  messages: ChatMessage[];
  config?: ContextTrimmerConfig;
}

const DEFAULT_CONFIG: Required<ContextTrimmerConfig> = {
  maxTokens: 8000,
  maxMessages: 20,
  preserveSystemPrompt: true,
  preserveTask: true,
  truncateCodeBlocks: true,
  truncateAssistantReplies: true,
  maxCodeBlockLength: 500,
  maxAssistantReplyLength: 1000
};

const MAX_TOKENS_LIMIT = 1_000_000;
const MIN_TOKENS_LIMIT = 10_000;

export function trimContext(options: TrimContextOptions): ChatMessage[] {
  const config = { ...DEFAULT_CONFIG, ...options.config };

  if (config.maxTokens > MAX_TOKENS_LIMIT) {
    config.maxTokens = MAX_TOKENS_LIMIT;
  } else if (config.maxTokens < MIN_TOKENS_LIMIT) {
    config.maxTokens = MIN_TOKENS_LIMIT;
  }

  const messages = [...options.messages];

  // Step 1: Preserve system prompt and task if configured
  const preservedMessages: ChatMessage[] = [];
  const remainingMessages: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (config.preserveSystemPrompt && msg.role === "system" && preservedMessages.length === 0) {
      preservedMessages.push(msg);
    } else if (config.preserveTask && msg.role === "user" && preservedMessages.length <= 1) {
      preservedMessages.push(msg);
    } else {
      remainingMessages.push(msg);
    }
  }

  let trimmed = remainingMessages;

  // Step 2: Truncate code blocks in older messages
  if (config.truncateCodeBlocks) {
    trimmed = trimmed.map((msg) => truncateCodeBlocksInMessage(msg, config.maxCodeBlockLength));
  }

  // Step 3: Truncate assistant replies in older messages
  if (config.truncateAssistantReplies) {
    trimmed = trimmed.map((msg) => truncateAssistantRepliesInMessage(msg, config.maxAssistantReplyLength));
  }

  // Step 4: Limit by max messages
  if (config.maxMessages && trimmed.length > config.maxMessages) {
    trimmed = trimmed.slice(-config.maxMessages);
  }

  // Step 5: Combine preserved and remaining, then limit by tokens
  const combined = [...preservedMessages, ...trimmed];
  if (config.maxTokens) {
    return trimByTokens(combined, config.maxTokens);
  }

  return combined;
}

function truncateCodeBlocksInMessage(message: ChatMessage, maxCodeBlockLength: number): ChatMessage {
  if (message.role !== "assistant" || !message.content) {
    return message;
  }

  // Find code blocks and truncate them
  const truncatedContent = message.content.replace(/```[\s\S]*?```/g, (match) => {
    if (match.length > maxCodeBlockLength) {
      return match.slice(0, maxCodeBlockLength) + "\n...<code truncated>";
    }
    return match;
  });

  return { ...message, content: truncatedContent };
}

function truncateAssistantRepliesInMessage(message: ChatMessage, maxAssistantReplyLength: number): ChatMessage {
  if (message.role !== "assistant" || !message.content) {
    return message;
  }

  if (message.content.length > maxAssistantReplyLength) {
    return { ...message, content: truncate(message.content, maxAssistantReplyLength) };
  }

  return message;
}

function trimByTokens(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  // Estimate tokens for each message
  const tokenCounts = messages.map((msg) => estimateTokens(msg.content));
  const totalTokens = tokenCounts.reduce((sum, count) => sum + count, 0);

  if (totalTokens <= maxTokens) {
    return messages;
  }

  // Keep messages from the end until we hit the token limit
  const trimmedMessages: ChatMessage[] = [];
  let remainingTokens = maxTokens;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const msgTokens = tokenCounts[i];

    if (remainingTokens - msgTokens >= 0) {
      trimmedMessages.unshift(msg);
      remainingTokens -= msgTokens;
    } else {
      // If this is a system or user message, we should try to keep it
      if (msg.role === "system" || msg.role === "user") {
        // Truncate the content to fit
        const truncatedContent = truncate(msg.content, remainingTokens * 4); // rough estimate: 4 chars per token
        trimmedMessages.unshift({ ...msg, content: truncatedContent });
      }
      break;
    }
  }

  return trimmedMessages;
}
