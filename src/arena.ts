import type { ArenaReport, RunEventHandler, RunReport, SandEvalConfig } from "./types.js";
import { runTask } from "./runner.js";
import { createRunId } from "./utils.js";

export interface RunArenaOptions {
  config: SandEvalConfig;
  cwd: string;
  prompt?: string;
  taskFile?: string;
  models: string[];
  judgeName?: string;
  userReview?: string;
  score?: boolean;
  maxTurns?: number;
  onEvent?: RunEventHandler;
  contextNames?: string[];
}

export async function runArena(options: RunArenaOptions): Promise<ArenaReport> {
  const started = new Date();
  const results: RunReport[] = [];
  let task = "";

  for (const modelName of options.models) {
    options.onEvent?.({
      type: "arena-model-start",
      at: new Date().toISOString(),
      modelName,
      message: `Arena model started: ${modelName}`
    });
    const report = await runTask({
      config: options.config,
      cwd: options.cwd,
      prompt: options.prompt,
      taskFile: options.taskFile,
      modelName,
      judgeName: options.judgeName,
      userReview: options.userReview,
      score: options.score,
      maxTurns: options.maxTurns,
      onEvent: options.onEvent,
      contextNames: options.contextNames
    });
    task = report.run.task;
    results.push(report);
    options.onEvent?.({
      type: "arena-model-finish",
      at: new Date().toISOString(),
      modelName,
      level: "success",
      message: `Arena model finished: ${modelName}`,
      detail: { score: report.score?.score }
    });
  }

  const finished = new Date();
  return {
    id: createRunId("arena"),
    task,
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: finished.getTime() - started.getTime(),
    results
  };
}
