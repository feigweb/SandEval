import type { ArenaReport, RunEventHandler, RunPlan, RunReport, SandEvalConfig } from "./types.js";
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
  concurrency?: number;
  onEvent?: RunEventHandler;
  contextNames?: string[];
  onPlanApproval?: (plan: RunPlan) => Promise<RunPlan>;
}

export async function runArena(options: RunArenaOptions): Promise<ArenaReport> {
  const started = new Date();
  const results: RunReport[] = [];
  let task = "";

  const concurrency = Math.max(1, options.concurrency ?? options.config.arena?.concurrency ?? 1);
  await mapWithConcurrency(options.models, concurrency, async (modelName, modelIndex) => {
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
      contextNames: options.contextNames,
      onPlanApproval: options.onPlanApproval
    });
    task = report.run.task;
    results[modelIndex] = report;
    options.onEvent?.({
      type: "arena-model-finish",
      at: new Date().toISOString(),
      modelName,
      level: "success",
      message: `Arena model finished: ${modelName}`,
      detail: { score: report.score?.score }
    });
  });

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

async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const itemIndex = index;
      const item = items[index];
      index += 1;
      if (item !== undefined) {
        await fn(item, itemIndex);
      }
    }
  });
  await Promise.all(workers);
}
