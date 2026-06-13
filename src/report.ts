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
    "",
    "## Task",
    "",
    run.task,
    "",
    "## Agent Summary",
    "",
    run.finish?.summary ?? run.finalContent ?? "No final summary.",
    "",
    "## User Review",
    "",
    report.userReview || "No user review provided.",
    "",
    "## Judge",
    "",
    report.score?.summary ?? "No judge score.",
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
    )
  ].join("\n");
}
