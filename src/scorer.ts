import { z } from "zod";
import type { AgentRunResult, ModelConfig, ModelProvider, ScoreResult } from "./types.js";
import { SCORING_SYSTEM_PROMPT } from "./tools.js";
import { stripJsonFence, truncate } from "./utils.js";

const scoreSchema = z.object({
  score: z.number().min(0).max(100),
  summary: z.string(),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  userFeedbackImpact: z.string().optional()
});

export async function scoreRun(options: {
  run: AgentRunResult;
  provider: ModelProvider;
  modelConfig: ModelConfig;
  userReview?: string;
}): Promise<ScoreResult> {
  const response = await options.provider.chat({
    messages: [
      { role: "system", content: SCORING_SYSTEM_PROMPT },
      {
        role: "user",
        content: buildScoringPrompt(options.run, options.userReview)
      }
    ],
    temperature: options.modelConfig.temperature ?? 0,
    maxTokens: options.modelConfig.maxTokens
  });

  const raw = response.content;
  const parsed = scoreSchema.parse(JSON.parse(stripJsonFence(raw)));
  return {
    ...parsed,
    raw,
    usage: response.usage
  };
}

function buildScoringPrompt(run: AgentRunResult, userReview?: string): string {
  const files = run.files
    .map((file) => {
      const preview = file.preview ? `\nPreview:\n${truncate(file.preview, 2000)}` : "";
      return `- ${file.path} (${file.sizeBytes} bytes)${preview}`;
    })
    .join("\n\n");

  const commands = run.commands
    .map(
      (command) =>
        [
          `$ ${command.command} ${command.args.join(" ")}`,
          `exit=${command.exitCode} durationMs=${command.durationMs} timedOut=${command.timedOut}`,
          command.stdout ? `stdout:\n${truncate(command.stdout, 2000)}` : "",
          command.stderr ? `stderr:\n${truncate(command.stderr, 2000)}` : ""
        ]
          .filter(Boolean)
          .join("\n")
    )
    .join("\n\n");

  return [
    `Task:\n${run.task}`,
    `Model: ${run.modelName}`,
    `Agent summary:\n${run.finish?.summary ?? run.finalContent ?? "No final summary."}`,
    `Agent instructions:\n${run.finish?.instructions ?? "None."}`,
    `Files:\n${files || "No files."}`,
    `Commands:\n${commands || "No commands."}`,
    `User review:\n${userReview || "No user review provided."}`
  ].join("\n\n---\n\n");
}
