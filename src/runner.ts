import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RunEventHandler, RunReport, SandEvalConfig } from "./types.js";
import { findModel } from "./config.js";
import { buildTaskWithContexts, materializeContexts } from "./contexts.js";
import { createProvider } from "./providers/index.js";
import { Sandbox } from "./sandbox.js";
import { runAgent } from "./agent.js";
import { scoreRun } from "./scorer.js";
import { createRunId } from "./utils.js";

export interface RunTaskOptions {
  config: SandEvalConfig;
  cwd: string;
  prompt?: string;
  taskFile?: string;
  modelName?: string;
  judgeName?: string;
  userReview?: string;
  score?: boolean;
  maxTurns?: number;
  onEvent?: RunEventHandler;
  contextNames?: string[];
}

export async function runTask(options: RunTaskOptions): Promise<RunReport> {
  const rawTask = await resolveTask(options);
  const task = await buildTaskWithContexts({
    config: options.config,
    cwd: options.cwd,
    task: rawTask,
    contextNames: options.contextNames
  });
  const modelConfig = findModel(options.config, options.modelName);
  const provider = createProvider(modelConfig);
  const runId = createRunId(safeName(modelConfig.name));
  const sandboxRoot = path.resolve(options.cwd, options.config.sandbox?.root ?? ".sandeval/runs", runId);
  const sandbox = new Sandbox(sandboxRoot, options.config.sandbox);
  await sandbox.init();
  const copiedContexts = await materializeContexts({
    config: options.config,
    cwd: options.cwd,
    sandboxRoot,
    task: rawTask,
    contextNames: options.contextNames
  });
  if (copiedContexts.length) {
    options.onEvent?.({
      type: "info",
      at: new Date().toISOString(),
      level: "success",
      modelName: modelConfig.name,
      message: `Copied ${copiedContexts.length} context file(s) into sandbox`,
      detail: { root: "@context", files: copiedContexts.slice(0, 20) }
    });
  }

  const run = await runAgent({
    task,
    modelConfig,
    provider,
    sandbox,
    maxTurns: options.maxTurns ?? options.config.agent?.maxTurns,
    onEvent: options.onEvent
  });

  const report: RunReport = {
    run,
    userReview: options.userReview
  };

  if (options.score !== false && options.config.scoring?.enabled !== false && (options.judgeName || options.config.judgeModel)) {
    const judgeConfig = findModel(options.config, options.judgeName ?? options.config.judgeModel);
    options.onEvent?.({
      type: "score-start",
      at: new Date().toISOString(),
      modelName: judgeConfig.name,
      message: `Scoring run with ${judgeConfig.name}`
    });
    report.score = await scoreRun({
      run,
      provider: createProvider(judgeConfig),
      modelConfig: judgeConfig,
      userReview: options.userReview
    });
    options.onEvent?.({
      type: "score-finish",
      at: new Date().toISOString(),
      modelName: judgeConfig.name,
      level: "success",
      message: `Score: ${report.score.score}/100`,
      detail: { summary: report.score.summary }
    });
  }

  return report;
}

export async function resolveTask(options: Pick<RunTaskOptions, "prompt" | "taskFile" | "cwd">): Promise<string> {
  if (options.prompt) {
    return options.prompt;
  }
  if (options.taskFile) {
    return readFile(path.resolve(options.cwd, options.taskFile), "utf8");
  }
  throw new Error("Provide a task file or --prompt.");
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
}
