import { writeFile } from "node:fs/promises";
import path from "node:path";
import Table from "cli-table3";
import type { ArenaReport, RunReport } from "./types.js";
import { ensureDir } from "./utils.js";

export async function saveRunReport(report: RunReport, reportDir: string): Promise<{ jsonPath: string; markdownPath: string }> {
  await ensureDir(reportDir);
  const artifactPath = report.reportPaths?.artifactPath;
  const base = path.join(reportDir, report.run.id);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderRunMarkdown(report), "utf8");
  report.reportPaths = { jsonPath, markdownPath, artifactPath };
  return { jsonPath, markdownPath };
}

export async function saveArenaReport(report: ArenaReport, reportDir: string): Promise<{ jsonPath: string; markdownPath: string }> {
  await ensureDir(reportDir);
  const artifactPath = report.reportPaths?.artifactPath;
  const base = path.join(reportDir, report.id);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderArenaMarkdown(report), "utf8");
  report.reportPaths = { jsonPath, markdownPath, artifactPath };
  return { jsonPath, markdownPath };
}

export function renderRunTable(report: RunReport): string {
  const table = new Table({
    head: ["Model", "Score", "Turns", "Tokens", "Duration", "Workspace"],
    wordWrap: true
  });
  table.push([
    report.run.modelName,
    report.score?.score ?? "-",
    report.run.turns,
    report.run.usage.totalTokens ?? "-",
    `${Math.round(report.run.durationMs / 1000)}s`,
    report.run.workspace
  ]);
  return table.toString();
}

export function renderArenaTable(report: ArenaReport): string {
  const table = new Table({
    head: ["Model", "Score", "Turns", "Tokens", "Duration", "Workspace"],
    wordWrap: true
  });
  for (const result of report.results) {
    table.push([
      result.run.modelName,
      result.score?.score ?? "-",
      result.run.turns,
      result.run.usage.totalTokens ?? "-",
      `${Math.round(result.run.durationMs / 1000)}s`,
      result.run.workspace
    ]);
  }
  return table.toString();
}

function renderRunMarkdown(report: RunReport): string {
  const run = report.run;
  return [
    `# SandEval Report: ${run.modelName}`,
    "",
    `- Run: ${run.id}`,
    `- Workspace: \`${run.workspace}\``,
    `- Duration: ${run.durationMs} ms`,
    `- Turns: ${run.turns}`,
    `- Tokens: ${run.usage.totalTokens ?? "unknown"}`,
    report.score ? `- Score: ${report.score.score}/100` : "- Score: not requested",
    report.reportPaths?.artifactPath ? `- Artifact package: \`${report.reportPaths.artifactPath}\`` : "",
    run.activeSkills?.length ? `- Skills: ${run.activeSkills.map((skill) => `${skill.name} (${skill.source})`).join(", ")}` : "- Skills: none",
    run.activeRules?.length ? `- Rules: ${run.activeRules.map((rule) => rule.name).join(", ")}` : "- Rules: none",
    run.workflowAdapter ? `- Workflow adapter: ${run.workflowAdapter}` : "- Workflow adapter: none",
    run.workflowEvents?.length ? `- Workflow events: ${run.workflowEvents.length}` : "- Workflow events: none",
    "",
    "## Tool Permissions",
    "",
    renderToolPermissions(run.toolPermissions),
    "",
    "## Task",
    "",
    run.task,
    "",
    "## Agent Summary",
    "",
    run.finish?.summary ?? run.finalContent ?? "No final summary.",
    "",
    "## Plan",
    "",
    renderPlan(run.plan),
    "",
    "## User Review",
    "",
    report.userReview || "No user review provided.",
    "",
    "## Judge",
    "",
    report.score?.summary ?? "No judge score.",
    "",
    "## Score Dimensions",
    "",
    renderScoreDimensions(report.score),
    "",
    "## Workflow Events",
    "",
    renderWorkflowEvents(run.workflowEvents),
    "",
    "## Workflow Raw Artifacts",
    "",
    renderWorkflowRaw(run.workflowRaw),
    "",
    "## Files",
    "",
    ...run.files.map((file) => `- \`${file.path}\` (${file.sizeBytes} bytes)`),
    "",
    "## Commands",
    "",
    ...run.commands.flatMap((command) => [
      `### \`${command.command} ${command.args.join(" ")}\``,
      "",
      `Exit: ${command.exitCode}; Duration: ${command.durationMs} ms; Timed out: ${command.timedOut}`,
      "",
      "```stdout",
      command.stdout,
      "```",
      "",
      "```stderr",
      command.stderr,
      "```",
      ""
    ])
  ].join("\n");
}

function renderArenaMarkdown(report: ArenaReport): string {
  return [
    `# SandEval Arena: ${report.id}`,
    "",
    `- Duration: ${report.durationMs} ms`,
    report.reportPaths?.artifactPath ? `- Artifact package: \`${report.reportPaths.artifactPath}\`` : "",
    "",
    "## Task",
    "",
    report.task,
    "",
    "## Results",
    "",
    "| Model | Score | Turns | Tokens | Workspace |",
    "| --- | ---: | ---: | ---: | --- |",
    ...report.results.map(
      (result) =>
        `| ${result.run.modelName} | ${result.score?.score ?? "-"} | ${result.run.turns} | ${result.run.usage.totalTokens ?? "-"} | \`${result.run.workspace}\` |`
    ),
    "",
    "## Workflow Events",
    "",
    ...report.results.flatMap((result) => [
      `### ${result.run.modelName}`,
      "",
      renderWorkflowEvents(result.run.workflowEvents),
      ""
    ])
  ].join("\n");
}

function renderPlan(plan: RunReport["run"]["plan"]): string {
  if (!plan) {
    return "No enforced plan recorded.";
  }
  return [
    `- Approved: ${plan.approved ? "yes" : "no"}`,
    `- Approval mode: ${plan.approvalMode}`,
    `- Revisions: ${plan.revisions.length}`,
    "",
    plan.content
  ].join("\n");
}

function renderScoreDimensions(score: RunReport["score"]): string {
  if (!score?.dimensions?.length) {
    return "No score dimensions recorded.";
  }
  return [
    "| Dimension | Score | Weight | Summary |",
    "| --- | ---: | ---: | --- |",
    ...score.dimensions.map(
      (dimension) =>
        `| ${dimension.label ?? dimension.key} | ${dimension.score} | ${dimension.weight} | ${(dimension.summary ?? "").replace(/\|/g, "\\|")} |`
    )
  ].join("\n");
}

function renderToolPermissions(tools: RunReport["run"]["toolPermissions"]): string {
  if (!tools) {
    return "No tool permission metadata recorded.";
  }
  return [
    `- Files: ${tools.files !== false ? "on" : "off"}`,
    `- Shell: ${tools.shell !== false ? "on" : "off"}`,
    `- Git: ${tools.git ?? "full"}`,
    `- Git remote: ${tools.gitRemote === true ? "on" : "off"}`,
    `- Package manager: ${tools.packageManager !== false ? "on" : "off"}`,
    tools.maxCommandTimeoutMs ? `- Max command timeout: ${tools.maxCommandTimeoutMs} ms` : "",
    tools.blockedCommands?.length ? `- Blocked commands: ${tools.blockedCommands.join(", ")}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function renderWorkflowEvents(events: RunReport["run"]["workflowEvents"]): string {
  if (!events?.length) {
    return "No workflow events recorded.";
  }
  return events
    .map((event) => {
      const detail = [
        event.command ? `command=\`${event.command}\`` : "",
        event.path ? `path=\`${event.path}\`` : "",
        event.toolName ? `tool=${event.toolName}` : ""
      ]
        .filter(Boolean)
        .join("; ");
      return `- ${event.kind}: ${event.title}${event.message ? ` - ${event.message.replace(/\s+/g, " ")}` : ""}${detail ? ` (${detail})` : ""}`;
    })
    .join("\n");
}

function renderWorkflowRaw(rawArtifacts: RunReport["run"]["workflowRaw"]): string {
  if (!rawArtifacts?.length) {
    return "No raw workflow artifact recorded.";
  }
  return rawArtifacts
    .flatMap((artifact, index) => [
      `### ${artifact.adapter} turn ${index + 1}`,
      "",
      `- Exit: ${artifact.exitCode ?? "unknown"}`,
      `- Timed out: ${artifact.timedOut === true ? "yes" : "no"}`,
      artifact.jsonLineCount !== undefined ? `- JSON lines: ${artifact.jsonLineCount}` : "",
      "",
      "```stdout",
      artifact.stdout ?? "",
      "```",
      "",
      "```stderr",
      artifact.stderr ?? "",
      "```",
      ""
    ])
    .filter(Boolean)
    .join("\n");
}
