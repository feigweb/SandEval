#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import ora from "ora";
import { runArena } from "./arena.js";
import { checkModelAuth, loginModel } from "./auth.js";
import { runConfigWizard } from "./config-wizard.js";
import { findModel, getConfigPath, listModelNames, loadConfig, saveConfig, writeDefaultConfig } from "./config.js";
import { renderArenaTable, renderRunTable, saveArenaReport, saveRunReport } from "./report.js";
import { runTask } from "./runner.js";
import { scaffoldCustomProvider } from "./scaffold.js";
import { createStorage } from "./storage.js";
import { runTui } from "./tui.js";
import { stringifyError } from "./utils.js";

const program = new Command();

program
  .name("sandeval")
  .description("Evaluate coding agents in sandboxed CLI/TUI workflows.")
  .version("0.1.0")
  .option("-c, --config <path>", "Path to config file");

program
  .command("init")
  .description("Create .sandeval/config.json")
  .action(async () => {
    await main(async () => {
      const configPath = await writeDefaultConfig(process.cwd());
      console.log(chalk.green(`Config ready: ${configPath}`));
    });
  });

program
  .command("run")
  .argument("[taskFile]", "Task prompt file")
  .description("Run one model against a task")
  .option("-p, --prompt <text>", "Task prompt text")
  .option("-m, --model <name>", "Model name from config")
  .option("-j, --judge <name>", "Judge model name from config")
  .option("-r, --review <text>", "Human review text included in judging")
  .option("--review-file <path>", "Read human review from file")
  .option("--no-score", "Skip judge scoring")
  .option("--max-turns <n>", "Maximum agent turns", parseInteger)
  .option("--json", "Print JSON report to stdout")
  .action(async (taskFile: string | undefined, options: RunCommandOptions) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      const userReview = await resolveReview(options.review, options.reviewFile);
      const spinner = ora("Running SandEval agent").start();
      const report = await runTask({
        config,
        cwd: process.cwd(),
        taskFile,
        prompt: options.prompt,
        modelName: options.model,
        judgeName: options.judge,
        userReview,
        score: options.score,
        maxTurns: options.maxTurns
      });
      spinner.succeed("Run complete");
      const paths = await saveRunReport(report, path.resolve(process.cwd(), config.reportDir ?? ".sandeval/reports"));
      report.reportPaths = paths;
      await (await createStorage(config, process.cwd())).saveRun(report);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderRunTable(report));
        console.log(chalk.green(`Report: ${paths.markdownPath}`));
      }
    });
  });

program
  .command("arena")
  .argument("[taskFile]", "Task prompt file")
  .description("Run multiple models on the same task")
  .requiredOption("-m, --models <names>", "Comma-separated model names")
  .option("-p, --prompt <text>", "Task prompt text")
  .option("-j, --judge <name>", "Judge model name from config")
  .option("-r, --review <text>", "Human review text included in judging")
  .option("--review-file <path>", "Read human review from file")
  .option("--no-score", "Skip judge scoring")
  .option("--max-turns <n>", "Maximum agent turns", parseInteger)
  .option("--concurrency <n>", "Maximum concurrent model runs", parseInteger)
  .option("--json", "Print JSON report to stdout")
  .action(async (taskFile: string | undefined, options: ArenaCommandOptions) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      const userReview = await resolveReview(options.review, options.reviewFile);
      const models = options.models
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean);
      const spinner = ora(`Running arena for ${models.length} models`).start();
      const report = await runArena({
        config,
        cwd: process.cwd(),
        taskFile,
        prompt: options.prompt,
        models,
        judgeName: options.judge,
        userReview,
        score: options.score,
        maxTurns: options.maxTurns,
        concurrency: options.concurrency
      });
      spinner.succeed("Arena complete");
      const paths = await saveArenaReport(report, path.resolve(process.cwd(), config.reportDir ?? ".sandeval/reports"));
      report.reportPaths = paths;
      await (await createStorage(config, process.cwd())).saveArena(report);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderArenaTable(report));
        console.log(chalk.green(`Report: ${paths.markdownPath}`));
      }
    });
  });

const configCommand = program.command("config").description("Inspect or interactively edit config.json");

configCommand
  .command("wizard")
  .description("Interactive guided config.json setup")
  .action(async () => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const configPath = await runConfigWizard(process.cwd(), globalOptions.config);
      console.log(chalk.green(`Config saved: ${configPath}`));
    });
  });

configCommand
  .command("show")
  .description("Print current config.json")
  .option("--json", "Print raw JSON")
  .action(async (options: { json?: boolean }) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      if (options.json) {
        console.log(JSON.stringify(config, null, 2));
        return;
      }
      console.log(chalk.bold("Config"));
      console.log(`Path: ${getConfigPath(process.cwd(), globalOptions.config)}`);
      console.log(`Default model: ${config.defaultModel ?? "-"}`);
      console.log(`Judge model: ${config.judgeModel ?? "-"}`);
      console.log(`Sandbox: ${config.sandbox?.mode ?? "local"} (${config.sandbox?.root ?? ".sandeval/runs"})`);
      console.log(`Plan: ${config.agent?.planMode ?? "prompt"} (${config.agent?.planApproval ?? "auto"})`);
      console.log(`Scoring: ${config.scoring?.mode ?? "multi"}`);
      console.log(`Arena concurrency: ${config.arena?.concurrency ?? 1}`);
      console.log(
        `Tools: files ${config.tools?.files !== false ? "on" : "off"}, shell ${config.tools?.shell !== false ? "on" : "off"}, git ${config.tools?.git ?? "full"}, gitRemote ${config.tools?.gitRemote === true ? "on" : "off"}`
      );
      console.log(`Rules: ${(config.rules ?? []).filter((rule) => rule.enabled !== false).map((rule) => rule.name).join(", ") || "none"}`);
      console.log(`Skills: local ${config.skills?.localDir ?? ".sandeval/skills"}, global ${config.skills?.globalDir ?? "~/.sandeval/skills"}`);
      console.log(`Storage: ${config.storage?.kind ?? "filesystem"} (${config.storage?.root ?? ".sandeval/storage"})`);
      console.log(`Models: ${listModelNames(config).join(", ")}`);
    });
  });

configCommand
  .command("path")
  .description("Print config path")
  .action(() => {
    const globalOptions = program.opts<{ config?: string }>();
    console.log(getConfigPath(process.cwd(), globalOptions.config));
  });

configCommand
  .command("set-default")
  .argument("<model>", "Model name")
  .description("Set default model")
  .action(async (model: string) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      if (!listModelNames(config).includes(model)) {
        throw new Error(`Model "${model}" not found.`);
      }
      config.defaultModel = model;
      await saveConfig(config, process.cwd(), globalOptions.config);
      console.log(chalk.green(`Default model set to ${model}`));
    });
  });

configCommand
  .command("set-judge")
  .argument("<model>", "Model name")
  .description("Set judge model")
  .action(async (model: string) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      if (!listModelNames(config).includes(model)) {
        throw new Error(`Model "${model}" not found.`);
      }
      config.judgeModel = model;
      await saveConfig(config, process.cwd(), globalOptions.config);
      console.log(chalk.green(`Judge model set to ${model}`));
    });
  });

configCommand
  .command("scaffold-provider")
  .argument("[path]", "Provider module path", "./sandeval-provider.js")
  .description("Create a custom provider module template")
  .option("-f, --force", "Overwrite existing file")
  .action(async (targetPath: string, options: { force?: boolean }) => {
    await main(async () => {
      const filePath = await scaffoldCustomProvider(process.cwd(), targetPath, Boolean(options.force));
      console.log(chalk.green(`Custom provider scaffolded: ${filePath}`));
    });
  });

program
  .command("login")
  .argument("[model]", "Model name from config")
  .description("Login or configure credentials for a model")
  .option("--api-key <key>", "API key for API-key providers")
  .option("--store <mode>", "Store mode: env or config", "env")
  .action(async (model: string | undefined, options: { apiKey?: string; store: "config" | "env" }) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      const message = await loginModel({
        config,
        cwd: process.cwd(),
        modelName: model,
        configPath: globalOptions.config,
        apiKey: options.apiKey,
        store: options.store
      });
      console.log(chalk.green(message));
    });
  });

program
  .command("auth")
  .description("Check model authentication status")
  .argument("[model]", "Optional model name")
  .action(async (modelName?: string) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      const models = modelName ? [findModel(config, modelName)] : config.models;
      if (models.length === 0) {
        throw new Error(`Model "${modelName}" not found.`);
      }
      for (const model of models) {
        const result = await checkModelAuth(model, process.cwd());
        const mark = result.ok ? chalk.green("ok") : chalk.red("missing");
        console.log(`${model.name}: ${mark} ${result.message}`);
      }
    });
  });

program
  .command("history")
  .description("List stored run and arena summaries")
  .option("-n, --limit <n>", "Number of entries", parseInteger, 20)
  .action(async (options: { limit: number }) => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      const config = await loadConfig(process.cwd(), globalOptions.config);
      const items = await (await createStorage(config, process.cwd())).listRuns(options.limit);
      if (items.length === 0) {
        console.log("No stored runs yet.");
        return;
      }
      for (const item of items) {
        console.log(
          `${item.startedAt} ${item.type.padEnd(5)} ${String(item.score ?? "-").padStart(3)} ${item.modelNames.join(",")} ${item.taskPreview}`
        );
      }
    });
  });

program
  .command("tui")
  .description("Start interactive terminal UI")
  .action(async () => {
    await main(async () => {
      const globalOptions = program.opts<{ config?: string }>();
      await runTui(process.cwd(), globalOptions.config);
    });
  });

program.parseAsync(process.argv);

async function main(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    console.error(chalk.red(stringifyError(error)));
    process.exitCode = 1;
  }
}

async function resolveReview(review?: string, reviewFile?: string): Promise<string | undefined> {
  if (reviewFile) {
    return readFile(path.resolve(process.cwd(), reviewFile), "utf8");
  }
  return review;
}

function parseInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, got ${value}`);
  }
  return parsed;
}

interface RunCommandOptions {
  prompt?: string;
  model?: string;
  judge?: string;
  review?: string;
  reviewFile?: string;
  score: boolean;
  maxTurns?: number;
  concurrency?: number;
  json?: boolean;
}

interface ArenaCommandOptions extends RunCommandOptions {
  models: string;
}
