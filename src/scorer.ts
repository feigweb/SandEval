import { z } from "zod";
import type { AgentRunResult, ModelConfig, ModelProvider, SandEvalConfig, ScoreDimensionResult, ScoreResult, Usage } from "./types.js";
import { defaultScoringDimensions } from "./config.js";
import { SCORING_SYSTEM_PROMPT } from "./tools.js";
import { stripJsonFence, truncate } from "./utils.js";

const scoreSchema = z.object({
  score: z.number().min(0).max(100).optional(),
  overall: z.number().min(0).max(100).optional(),
  dimensions: z
    .array(
      z.object({
        key: z.string(),
        label: z.string().optional(),
        score: z.number().min(0).max(100),
        weight: z.number().nonnegative().optional(),
        summary: z.string().optional()
      })
    )
    .optional(),
  summary: z.string(),
  strengths: z.array(z.string()).default([]),
  weaknesses: z.array(z.string()).default([]),
  userFeedbackImpact: z.string().optional()
});

const scoreJsonSchema = {
  type: "object",
  properties: {
    dimensions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          score: { type: "number", minimum: 0, maximum: 100 },
          weight: { type: "number", minimum: 0 },
          summary: { type: "string" }
        },
        required: ["key", "score", "summary"],
        additionalProperties: false
      }
    },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    userFeedbackImpact: { type: "string" }
  },
  required: ["dimensions", "summary", "strengths", "weaknesses"],
  additionalProperties: false
} satisfies Record<string, unknown>;

export async function scoreRun(options: {
  run: AgentRunResult;
  provider: ModelProvider;
  modelConfig: ModelConfig;
  config?: SandEvalConfig;
  userReview?: string;
}): Promise<ScoreResult> {
  const dimensions = options.config?.scoring?.dimensions?.length ? options.config.scoring.dimensions : defaultScoringDimensions();
  const messages = [
    { role: "system" as const, content: SCORING_SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: buildScoringPrompt(options.run, dimensions, options.config?.scoring?.rubric, options.userReview)
    }
  ];
  const maxRetries = options.config?.scoring?.maxRetries ?? 2;
  let raw = "";
  let usage: Usage | undefined;
  let lastError: unknown;
  let useStructuredResponse = true;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const request = {
      messages: attempt === 0 ? messages : withRetryInstruction(messages, raw, lastError, attempt),
      temperature: attempt === 0 ? options.modelConfig.temperature ?? 0 : 0,
      maxTokens: options.modelConfig.maxTokens,
      responseFormat: useStructuredResponse
        ? {
            type: "json_schema" as const,
            name: "sandeval_score",
            description: "Structured judge score for one SandEval run.",
            schema: scoreJsonSchema,
            strict: true
          }
        : undefined
    };
    let response;
    try {
      response = await options.provider.chat(request);
    } catch (error) {
      if (!useStructuredResponse || !isStructuredOutputUnsupported(error)) {
        throw error;
      }
      useStructuredResponse = false;
      response = await options.provider.chat({ ...request, responseFormat: undefined });
    }
    raw = response.content;
    usage = response.usage;
    try {
      const parsed = parseScoreResponse(raw);
      const scoredDimensions = normalizeDimensions(parsed.dimensions, dimensions);
      const overall = scoredDimensions.length
        ? weightedAverage(scoredDimensions)
        : Math.round(parsed.overall ?? parsed.score ?? 0);
      return {
        ...parsed,
        score: overall,
        overall,
        dimensions: scoredDimensions,
        raw,
        usage
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`Judge returned invalid score JSON after ${maxRetries + 1} attempt(s): ${formatParseError(lastError)}\nRaw:\n${truncate(raw, 4000)}`);
}

function parseScoreResponse(raw: string): z.infer<typeof scoreSchema> {
  const parsed = JSON.parse(extractJsonObject(stripJsonFence(raw)));
  return scoreSchema.parse(parsed);
}

function withRetryInstruction(
  messages: Array<{ role: "system" | "user"; content: string }>,
  raw: string,
  error: unknown,
  attempt: number
): Array<{ role: "system" | "user"; content: string }> {
  return [
    ...messages,
    {
      role: "user",
      content: [
        `The previous judge response could not be parsed or did not match the required schema. Retry ${attempt}.`,
        `Validation error:\n${formatParseError(error)}`,
        `Previous response:\n${truncate(raw || "empty response", 3000)}`,
        "Return only one valid compact JSON object matching the schema. Do not include markdown fences or commentary."
      ].join("\n\n")
    }
  ];
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

function formatParseError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isStructuredOutputUnsupported(error: unknown): boolean {
  const message = formatParseError(error).toLowerCase();
  return (
    (message.includes("response_format") || message.includes("responseschema") || message.includes("response schema")) &&
    (message.includes("unavailable") ||
      message.includes("unsupported") ||
      message.includes("not support") ||
      message.includes("invalid") ||
      message.includes("unknown"))
  );
}

function buildScoringPrompt(
  run: AgentRunResult,
  dimensions: NonNullable<SandEvalConfig["scoring"]>["dimensions"],
  rubric?: string,
  userReview?: string
): string {
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
    "Return compact JSON with keys: dimensions, summary, strengths, weaknesses, userFeedbackImpact.",
    "Each dimensions item must include key, score, and summary. Scores are 0..100. SandEval will compute the weighted overall score locally.",
    `Dimensions:\n${(dimensions ?? [])
      .map((dimension) => `- ${dimension.key} (${dimension.label ?? dimension.key}, weight ${dimension.weight ?? 1}): ${dimension.description ?? ""}`)
      .join("\n")}`,
    rubric ? `Rubric:\n${rubric}` : "",
    `Task:\n${run.task}`,
    `Model: ${run.modelName}`,
    run.plan
      ? [
          "Plan:",
          run.plan.content,
          `Approved: ${run.plan.approved} (${run.plan.approvalMode})`,
          run.plan.revisions.length ? `Revisions: ${run.plan.revisions.length}` : "Revisions: none",
          "Plan quality and plan/execution alignment should affect only workflowQuality."
        ].join("\n")
      : "Plan: none",
    `Agent summary:\n${run.finish?.summary ?? run.finalContent ?? "No final summary."}`,
    `Agent instructions:\n${run.finish?.instructions ?? "None."}`,
    `Files:\n${files || "No files."}`,
    `Commands:\n${commands || "No commands."}`,
    `User review:\n${userReview || "No user review provided."}`
  ]
    .filter(Boolean)
    .join("\n\n---\n\n");
}

function normalizeDimensions(
  returned: z.infer<typeof scoreSchema>["dimensions"],
  configured: NonNullable<SandEvalConfig["scoring"]>["dimensions"]
): ScoreDimensionResult[] {
  if (!returned?.length) {
    return [];
  }
  const byKey = new Map((returned ?? []).map((dimension) => [dimension.key, dimension]));
  const config = configured?.length ? configured : defaultScoringDimensions();
  return config.map((dimension) => {
    const scored = byKey.get(dimension.key);
    return {
      key: dimension.key,
      label: dimension.label,
      score: clampScore(scored?.score ?? 0),
      weight: dimension.weight ?? scored?.weight ?? 1,
      summary: scored?.summary
    };
  });
}

function weightedAverage(dimensions: ScoreDimensionResult[]): number {
  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  if (totalWeight <= 0) {
    return Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / Math.max(1, dimensions.length));
  }
  return Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score * dimension.weight, 0) / totalWeight);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}
