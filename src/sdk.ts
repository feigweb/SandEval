import path from "node:path";
import { runArena, type RunArenaOptions } from "./arena.js";
import { loadConfig } from "./config.js";
import { generateModelScoreDashboard, buildModelScoreIndex, type ModelScoreDashboard, type ModelScoreIndex } from "./analytics.js";
import { saveArenaReport, saveRunReport } from "./report.js";
import { runTask, type RunTaskOptions } from "./runner.js";
import { createStorage, type StorageAdapter } from "./storage.js";
import type { ArenaReport, RunReport, SandEvalConfig, StoredRunSummary } from "./types.js";

export interface SandEvalSdkOptions {
  cwd?: string;
  configPath?: string;
  config?: SandEvalConfig;
}

export interface SdkRunOptions extends Omit<RunTaskOptions, "config" | "cwd"> {
  save?: boolean;
}

export interface SdkArenaOptions extends Omit<RunArenaOptions, "config" | "cwd"> {
  save?: boolean;
}

export class SandEvalSDK {
  readonly cwd: string;
  readonly configPath?: string;
  readonly config: SandEvalConfig;
  private storage?: StorageAdapter;

  private constructor(options: { cwd: string; configPath?: string; config: SandEvalConfig }) {
    this.cwd = options.cwd;
    this.configPath = options.configPath;
    this.config = options.config;
  }

  static async create(options: SandEvalSdkOptions = {}): Promise<SandEvalSDK> {
    const cwd = options.cwd ?? process.cwd();
    const config = options.config ?? (await loadConfig(cwd, options.configPath));
    return new SandEvalSDK({ cwd, configPath: options.configPath, config });
  }

  async run(options: SdkRunOptions): Promise<RunReport> {
    const report = await runTask({ ...options, config: this.config, cwd: this.cwd });
    if (options.save !== false) {
      await this.saveRun(report);
    }
    return report;
  }

  async arena(options: SdkArenaOptions): Promise<ArenaReport> {
    const report = await runArena({ ...options, config: this.config, cwd: this.cwd });
    if (options.save !== false) {
      await this.saveArena(report);
    }
    return report;
  }

  async saveRun(report: RunReport): Promise<RunReport> {
    const paths = await saveRunReport(report, this.reportDir());
    report.reportPaths = { ...report.reportPaths, ...paths };
    await (await this.getStorage()).saveRun(report);
    return report;
  }

  async saveArena(report: ArenaReport): Promise<ArenaReport> {
    const paths = await saveArenaReport(report, this.reportDir());
    report.reportPaths = { ...report.reportPaths, ...paths };
    await (await this.getStorage()).saveArena(report);
    return report;
  }

  async history(limit = 20): Promise<StoredRunSummary[]> {
    return (await this.getStorage()).listRuns(limit);
  }

  async modelScoreIndex(modelName: string, limit = 1000): Promise<ModelScoreIndex> {
    return buildModelScoreIndex({
      config: this.config,
      cwd: this.cwd,
      modelName,
      limit,
      storage: await this.getStorage()
    });
  }

  async modelScoreDashboard(modelName: string, options: { limit?: number; outputDir?: string } = {}): Promise<ModelScoreDashboard> {
    return generateModelScoreDashboard({
      config: this.config,
      cwd: this.cwd,
      modelName,
      limit: options.limit,
      outputDir: options.outputDir,
      storage: await this.getStorage()
    });
  }

  private async getStorage(): Promise<StorageAdapter> {
    this.storage = this.storage ?? (await createStorage(this.config, this.cwd));
    return this.storage;
  }

  private reportDir(): string {
    return path.resolve(this.cwd, this.config.reportDir ?? ".sandeval/reports");
  }
}

export async function createSandEval(options: SandEvalSdkOptions = {}): Promise<SandEvalSDK> {
  return SandEvalSDK.create(options);
}
