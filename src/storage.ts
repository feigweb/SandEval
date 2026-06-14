import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ArenaReport, RunReport, SandEvalConfig, StorageConfig, StoredRunSummary } from "./types.js";
import { ensureDir, truncate } from "./utils.js";

export interface StorageAdapter {
  saveRun(report: RunReport): Promise<void>;
  saveArena(report: ArenaReport): Promise<void>;
  listRuns(limit?: number): Promise<StoredRunSummary[]>;
  loadReport?(summary: StoredRunSummary): Promise<RunReport | ArenaReport | undefined>;
}

export async function createStorage(config: SandEvalConfig, cwd = process.cwd()): Promise<StorageAdapter> {
  const storageConfig = config.storage ?? { kind: "filesystem" as const };
  if (storageConfig.kind === "custom") {
    return loadCustomStorage(storageConfig, cwd);
  }
  return new FileStorage(storageConfig, cwd);
}

export class FileStorage implements StorageAdapter {
  private readonly root: string;
  private readonly indexPath: string;

  constructor(config: StorageConfig = {}, cwd = process.cwd()) {
    this.root = path.resolve(cwd, config.root ?? ".sandeval/storage");
    this.indexPath = path.resolve(this.root, config.indexFile ?? "runs.jsonl");
  }

  async saveRun(report: RunReport): Promise<void> {
    await this.append(summaryFromRun(report));
  }

  async saveArena(report: ArenaReport): Promise<void> {
    await this.append(summaryFromArena(report));
  }

  async listRuns(limit = 20): Promise<StoredRunSummary[]> {
    if (!existsSync(this.indexPath)) {
      return [];
    }
    const lines = (await readFile(this.indexPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((line) => JSON.parse(line) as StoredRunSummary);
  }

  async loadReport(summary: StoredRunSummary): Promise<RunReport | ArenaReport | undefined> {
    if (!summary.reportPath) {
      return undefined;
    }
    const reportPath = await resolveReadableReportPath(summary.reportPath, this.root);
    if (!existsSync(reportPath)) {
      return undefined;
    }
    const parsed = JSON.parse(await readFile(reportPath, "utf8")) as RunReport | ArenaReport;
    return parsed;
  }

  private async append(summary: StoredRunSummary): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await appendFile(this.indexPath, `${JSON.stringify(summary)}\n`, "utf8");
  }
}

async function loadCustomStorage(config: StorageConfig, cwd: string): Promise<StorageAdapter> {
  if (!config.modulePath) {
    throw new Error("storage.kind is custom but storage.modulePath is not configured.");
  }
  const modulePath = path.isAbsolute(config.modulePath) ? config.modulePath : path.resolve(cwd, config.modulePath);
  const module = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
  const exported = module.createStorage ?? module.default;

  const adapter = typeof exported === "function" ? await exported(config) : exported;
  if (
    !adapter ||
    typeof adapter !== "object" ||
    typeof (adapter as StorageAdapter).saveRun !== "function" ||
    typeof (adapter as StorageAdapter).saveArena !== "function" ||
    typeof (adapter as StorageAdapter).listRuns !== "function"
  ) {
    throw new Error("Custom storage must expose saveRun(), saveArena(), and listRuns().");
  }
  return adapter as StorageAdapter;
}

function summaryFromRun(report: RunReport): StoredRunSummary {
  return {
    id: report.run.id,
    type: "run",
    modelNames: [report.run.modelName],
    taskPreview: truncate(report.run.task.replace(/\s+/g, " "), 120),
    score: report.score?.score,
    startedAt: report.run.startedAt,
    finishedAt: report.run.finishedAt,
    durationMs: report.run.durationMs,
    reportPath: report.reportPaths?.jsonPath ?? report.reportPaths?.markdownPath
  };
}

function summaryFromArena(report: ArenaReport): StoredRunSummary {
  return {
    id: report.id,
    type: "arena",
    modelNames: report.results.map((result) => result.run.modelName),
    taskPreview: truncate(report.task.replace(/\s+/g, " "), 120),
    score: average(report.results.map((result) => result.score?.score)),
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    durationMs: report.durationMs,
    reportPath: report.reportPaths?.jsonPath ?? report.reportPaths?.markdownPath
  };
}

async function resolveReadableReportPath(reportPath: string, root: string): Promise<string> {
  const absolutePath = path.isAbsolute(reportPath) ? reportPath : path.resolve(root, reportPath);
  if (absolutePath.endsWith(".md")) {
    const jsonPath = `${absolutePath.slice(0, -3)}.json`;
    if (existsSync(jsonPath)) {
      return jsonPath;
    }
  }
  return absolutePath;
}

function average(values: Array<number | undefined>): number | undefined {
  const numeric = values.filter((value): value is number => typeof value === "number");
  if (numeric.length === 0) {
    return undefined;
  }
  return Math.round(numeric.reduce((sum, value) => sum + value, 0) / numeric.length);
}

export async function ensureStorage(config: SandEvalConfig, cwd = process.cwd()): Promise<StorageAdapter> {
  await ensureDir(path.resolve(cwd, config.storage?.root ?? ".sandeval/storage"));
  return createStorage(config, cwd);
}
