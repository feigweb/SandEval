import { describe, it, expect } from "vitest";
import { trimContext } from "./context-trimmer.js";
import type { ChatMessage } from "./types.js";

describe("trimContext", () => {
  const systemMsg: ChatMessage = { role: "system", content: "You are a helpful assistant" };
  const userMsg: ChatMessage = { role: "user", content: "Hello" };
  const assistantMsg: ChatMessage = { role: "assistant", content: "Hi there!" };

  it("returns messages unchanged when disabled", () => {
    const messages = [systemMsg, userMsg, assistantMsg];
    const result = trimContext({ messages, config: {} });
    expect(result).toEqual(messages);
  });

  it("preserves system and task messages", () => {
    const messages = [systemMsg, userMsg, assistantMsg];
    const result = trimContext({
      messages,
      config: { preserveSystemPrompt: true, preserveTask: true }
    });
    expect(result[0]).toEqual(systemMsg);
    expect(result[1]).toEqual(userMsg);
  });

  it("limits by maxMessages", () => {
    const messages: ChatMessage[] = [
      systemMsg,
      userMsg,
      { role: "assistant", content: "1" },
      { role: "assistant", content: "2" },
      { role: "assistant", content: "3" }
    ];
    const result = trimContext({
      messages,
      config: { maxMessages: 2 }
    });
    expect(result.length).toBeLessThanOrEqual(4); // system + task + 2 messages
  });

  it("truncates code blocks in assistant messages", () => {
    const longCode = "```javascript\n" + "console.log('test');\n".repeat(100) + "```";
    const messages: ChatMessage[] = [
      systemMsg,
      userMsg,
      { role: "assistant", content: longCode }
    ];
    const result = trimContext({
      messages,
      config: { truncateCodeBlocks: true, maxCodeBlockLength: 100 }
    });
    const assistantMsg = result.find((m) => m.role === "assistant");
    if (assistantMsg) {
      expect(assistantMsg.content.length).toBeLessThan(longCode.length);
    }
  });

  it("truncates long assistant replies", () => {
    const longReply = "a".repeat(2000);
    const messages: ChatMessage[] = [
      systemMsg,
      userMsg,
      { role: "assistant", content: longReply }
    ];
    const result = trimContext({
      messages,
      config: { truncateAssistantReplies: true, maxAssistantReplyLength: 500 }
    });
    const assistantMsg = result.find((m) => m.role === "assistant");
    if (assistantMsg) {
      expect(assistantMsg.content.length).toBeLessThan(2000);
    }
  });
});
