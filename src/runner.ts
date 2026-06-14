import { readFile } from "node:fs/promises";
import path from "node:path";
import { confirm, input } from "@inquirer/prompts";
import type { ModelProvider, RunEventHandler, RunPlan, RunReport, SandEvalConfig } from "./types.js";
import { findModel } from "./config.js";
import { buildTaskWithContexts, materializeContexts } from "./contexts.js";
import { createProvider } from "./providers/index.js";
import { appliedRules, renderRulesSystemPrompt } from "./rules.js";
import { Sandbox } from "./sandbox.js";
import { appliedSkills, renderSkillsTaskBlock, resolveMentionedSkills } from "./skills.js";
import { runAgent } from "./agent.js";
import { AGENT_SYSTEM_PROMPT } from "./tools.js";
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
  onPlanApproval?: (plan: RunPlan) => Promise<RunPlan>;
}

export async function runTask(options: RunTaskOptions): Promise<RunReport> {
  const rawTask = await resolveTask(options);
  const contextTask = await buildTaskWithContexts({
    config: options.config,
    cwd: options.cwd,
    task: rawTask,
    contextNames: options.contextNames
  });
  const skills = await resolveMentionedSkills(options.config, options.cwd, rawTask);
  const skillBlock = renderSkillsTaskBlock(skills);
  const task = skillBlock ? [contextTask, "", skillBlock].join("\n") : contextTask;
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
  if (skills.length) {
    options.onEvent?.({
      type: "info",
      at: new Date().toISOString(),
      level: "success",
      modelName: modelConfig.name,
      message: `Loaded ${skills.length} skill(s): ${skills.map((skill) => skill.name).join(", ")}`,
      detail: { skills: skills.map((skill) => ({ name: skill.name, source: skill.source })) }
    });
  }

  const plan = await createPlanIfNeeded({
    config: options.config,
    provider,
    task,
    modelName: modelConfig.name,
    onEvent: options.onEvent,
    onPlanApproval: options.onPlanApproval
  });

  const run = await runAgent({
    task: plan ? withPlanForExecution(task, plan) : task,
    modelConfig,
    provider,
    sandbox,
    maxTurns: options.maxTurns ?? options.config.agent?.maxTurns,
    systemPrompt: buildSystemPrompt(options.config),
    toolPermissions: options.config.tools,
    activeRules: appliedRules(options.config),
    activeSkills: appliedSkills(skills),
    plan,
    onEvent: options.onEvent,
    contextTrimmer: options.config.agent?.contextTrimmer
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
      config: options.config,
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

function buildSystemPrompt(config: SandEvalConfig): string {
  return [
    AGENT_SYSTEM_PROMPT,
    renderPlanModePrompt(config),
    config.agent?.systemPrompt ? `----- SANDEVAL CONFIG SYSTEM PROMPT -----\n${config.agent.systemPrompt}` : "",
    renderRulesSystemPrompt(config),
    renderToolPolicyPrompt(config)
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function createPlanIfNeeded(options: {
  config: SandEvalConfig;
  provider: ModelProvider;
  task: string;
  modelName: string;
  onEvent?: RunEventHandler;
  onPlanApproval?: (plan: RunPlan) => Promise<RunPlan>;
}): Promise<RunPlan | undefined> {
  const planMode = options.config.agent?.planMode ?? "prompt";
  if (planMode !== "enforced") {
    return undefined;
  }

  options.onEvent?.({
    type: "info",
    at: new Date().toISOString(),
    modelName: options.modelName,
    message: "Generating plan before development",
    detail: { phase: "plan" }
  });
  let content = await generatePlan(options.provider, options.task);
  let plan: RunPlan = {
    content,
    approved: false,
    approvalMode: options.config.agent?.planApproval ?? "auto",
    revisions: []
  };

  for (let revision = 0; revision < 3; revision += 1) {
    plan = await approvePlan(options.config, plan, options.onPlanApproval);
    if (plan.approved) {
      options.onEvent?.({
        type: "info",
        at: new Date().toISOString(),
        level: "success",
        modelName: options.modelName,
        message: `Plan approved (${plan.approvalMode})`,
        detail: { revisions: plan.revisions.length }
      });
      return plan;
    }
    const last = plan.revisions.at(-1);
    if (!last?.feedback) {
      throw new Error("Plan was not approved.");
    }
    content = await generatePlan(options.provider, options.task, plan.content, last.feedback);
    plan = {
      ...plan,
      content,
      revisions: [...plan.revisions, { feedback: last.feedback, content }]
    };
  }

  throw new Error("Plan was not approved after 3 revisions.");
}

async function generatePlan(provider: ModelProvider, task: string, previousPlan?: string, feedback?: string): Promise<string> {
  const response = await provider.chat({
    messages: [
      {
        role: "system",
        content:
          "You are planning a coding-agent run. Produce a concise implementation plan only. Do not call tools. Include verification steps."
      },
      {
        role: "user",
        content: [
          `Task:\n${task}`,
          previousPlan ? `Previous plan:\n${previousPlan}` : "",
          feedback ? `Revision feedback:\n${feedback}` : ""
        ]
          .filter(Boolean)
          .join("\n\n---\n\n")
      }
    ],
    temperature: 0.2
  });
  return response.content.trim() || "No plan content returned.";
}

async function approvePlan(
  config: SandEvalConfig,
  plan: RunPlan,
  onPlanApproval?: (plan: RunPlan) => Promise<RunPlan>
): Promise<RunPlan> {
  if ((config.agent?.planApproval ?? "auto") === "auto") {
    return { ...plan, approved: true, approvalMode: "auto" };
  }
  if (onPlanApproval) {
    return onPlanApproval({ ...plan, approvalMode: "interactive" });
  }
  if (!process.stdin.isTTY) {
    return { ...plan, approved: true, approvalMode: "auto" };
  }
  console.log("\nSandEval plan:\n");
  console.log(plan.content);
  const approved = await confirm({ message: "Approve this plan?", default: true });
  if (approved) {
    return { ...plan, approved: true, approvalMode: "interactive" };
  }
  const feedback = await input({ message: "Revision feedback" });
  return {
    ...plan,
    approved: false,
    approvalMode: "interactive",
    revisions: [...plan.revisions, { feedback, content: plan.content }]
  };
}

function withPlanForExecution(task: string, plan: RunPlan): string {
  return [
    task,
    "----- APPROVED PLAN -----",
    plan.content,
    "Use this approved plan as guidance, but prioritize the user's task and verification evidence if reality differs."
  ].join("\n\n");
}

function renderPlanModePrompt(config: SandEvalConfig): string {
  const mode = config.agent?.planMode ?? "prompt";
  if (mode === "off" || mode === "enforced") {
    return "";
  }
  return [
    "----- SANDEVAL PLAN MODE -----",
    "Before making changes, briefly outline the implementation plan in your assistant response, then execute it with tools.",
    "Keep the plan practical and update course if verification shows it is wrong."
  ].join("\n");
}

function renderToolPolicyPrompt(config: SandEvalConfig): string {
  const tools = config.tools;
  if (!tools) {
    return "";
  }
  return [
    "----- SANDEVAL TOOL PERMISSIONS -----",
    `files: ${tools.files !== false ? "enabled" : "disabled"}`,
    `shell: ${tools.shell !== false ? "enabled" : "disabled"}`,
    `git: ${tools.git ?? "full"}`,
    `gitRemote: ${tools.gitRemote === true ? "enabled" : "disabled"}`,
    `packageManager: ${tools.packageManager !== false ? "enabled" : "disabled"}`,
    tools.maxCommandTimeoutMs ? `maxCommandTimeoutMs: ${tools.maxCommandTimeoutMs}` : "",
    tools.blockedCommands?.length ? `blockedCommands: ${tools.blockedCommands.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}
