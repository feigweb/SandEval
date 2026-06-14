import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArenaReport, RunReport, SandEvalConfig, ScoreDimensionResult, StoredRunSummary } from "./types.js";
import { createStorage, type StorageAdapter } from "./storage.js";
import { ensureDir } from "./utils.js";

export interface ModelScoreEntry {
  runId: string;
  modelName: string;
  taskPreview: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  score: number;
  dimensions: ScoreDimensionResult[];
  summary?: string;
  reportPath?: string;
}

export interface ModelScoreIndex {
  modelName: string;
  generatedAt: string;
  reviewCount: number;
  averageScore: number;
  bestScore: number;
  latestScore: number;
  trend: "up" | "down" | "flat";
  dimensionAverages: ScoreDimensionResult[];
  entries: ModelScoreEntry[];
}

export interface ModelScoreDashboard {
  index: ModelScoreIndex;
  htmlPath: string;
}

export async function buildModelScoreIndex(options: {
  config: SandEvalConfig;
  cwd?: string;
  modelName: string;
  limit?: number;
  storage?: StorageAdapter;
}): Promise<ModelScoreIndex> {
  const cwd = options.cwd ?? process.cwd();
  const storage = options.storage ?? (await createStorage(options.config, cwd));
  const summaries = await storage.listRuns(options.limit ?? 1000);
  const entries = await collectModelScoreEntries(storage, summaries, options.modelName);
  if (entries.length < 2) {
    throw new Error(`Model "${options.modelName}" has ${entries.length} scored review(s). At least 2 are required to generate an index.`);
  }
  return summarizeModelScores(options.modelName, entries);
}

export async function saveModelScoreDashboard(options: {
  index: ModelScoreIndex;
  cwd?: string;
  outputDir?: string;
  fileName?: string;
}): Promise<ModelScoreDashboard> {
  const cwd = options.cwd ?? process.cwd();
  const outputDir = path.resolve(cwd, options.outputDir ?? ".sandeval/dashboards");
  await ensureDir(outputDir);
  const fileName = options.fileName ?? `${safeFileName(options.index.modelName)}-score-index.html`;
  const htmlPath = path.join(outputDir, fileName);
  await writeFile(htmlPath, renderModelScoreDashboardHtml(options.index), "utf8");
  return { index: options.index, htmlPath };
}

export async function generateModelScoreDashboard(options: {
  config: SandEvalConfig;
  cwd?: string;
  modelName: string;
  limit?: number;
  outputDir?: string;
  storage?: StorageAdapter;
}): Promise<ModelScoreDashboard> {
  const index = await buildModelScoreIndex(options);
  return saveModelScoreDashboard({ index, cwd: options.cwd, outputDir: options.outputDir });
}

async function collectModelScoreEntries(
  storage: StorageAdapter,
  summaries: StoredRunSummary[],
  modelName: string
): Promise<ModelScoreEntry[]> {
  const byRunId = new Map<string, ModelScoreEntry>();
  for (const summary of summaries) {
    const report = await storage.loadReport?.(summary);
    if (!report) {
      continue;
    }
    for (const entry of entriesFromReport(report, summary.reportPath)) {
      if (entry.modelName === modelName && !byRunId.has(entry.runId)) {
        byRunId.set(entry.runId, entry);
      }
    }
  }
  return [...byRunId.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

function entriesFromReport(report: RunReport | ArenaReport, fallbackReportPath?: string): ModelScoreEntry[] {
  if ("results" in report) {
    return report.results.flatMap((result) => entriesFromRunReport(result, result.reportPaths?.markdownPath ?? report.reportPaths?.markdownPath ?? fallbackReportPath));
  }
  return entriesFromRunReport(report, report.reportPaths?.markdownPath ?? fallbackReportPath);
}

function entriesFromRunReport(report: RunReport, reportPath?: string): ModelScoreEntry[] {
  if (typeof report.score?.score !== "number") {
    return [];
  }
  return [
    {
      runId: report.run.id,
      modelName: report.run.modelName,
      taskPreview: report.run.task.replace(/\s+/g, " ").slice(0, 140),
      startedAt: report.run.startedAt,
      finishedAt: report.run.finishedAt,
      durationMs: report.run.durationMs,
      score: report.score.score,
      dimensions: report.score.dimensions ?? [],
      summary: report.score.summary,
      reportPath
    }
  ];
}

function summarizeModelScores(modelName: string, entries: ModelScoreEntry[]): ModelScoreIndex {
  const scores = entries.map((entry) => entry.score);
  const latestScore = entries.at(-1)?.score ?? 0;
  const firstScore = entries[0]?.score ?? latestScore;
  return {
    modelName,
    generatedAt: new Date().toISOString(),
    reviewCount: entries.length,
    averageScore: round(average(scores)),
    bestScore: Math.max(...scores),
    latestScore,
    trend: latestScore > firstScore ? "up" : latestScore < firstScore ? "down" : "flat",
    dimensionAverages: summarizeDimensions(entries),
    entries
  };
}

function summarizeDimensions(entries: ModelScoreEntry[]): ScoreDimensionResult[] {
  const buckets = new Map<string, { label?: string; weight: number; scores: number[] }>();
  for (const entry of entries) {
    for (const dimension of entry.dimensions) {
      const bucket = buckets.get(dimension.key) ?? { label: dimension.label, weight: dimension.weight, scores: [] };
      bucket.label = bucket.label ?? dimension.label;
      bucket.weight = dimension.weight;
      bucket.scores.push(dimension.score);
      buckets.set(dimension.key, bucket);
    }
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    label: bucket.label,
    weight: bucket.weight,
    score: round(average(bucket.scores)),
    summary: `${bucket.scores.length} scored review(s)`
  }));
}

function renderModelScoreDashboardHtml(index: ModelScoreIndex): string {
  const scores = index.entries.map((entry) => entry.score);
  const chartPoints = scores.map((score, position) => {
    const x = scores.length === 1 ? 0 : (position / (scores.length - 1)) * 100;
    const y = 100 - score;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const bars = index.dimensionAverages
    .map(
      (dimension) => `
        <div class="bar-row">
          <span>${escapeHtml(dimension.label ?? dimension.key)}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${dimension.score}%"></div></div>
          <strong>${dimension.score}</strong>
        </div>`
    )
    .join("");
  const rows = index.entries
    .map(
      (entry) => `
        <tr>
          <td>${escapeHtml(formatDate(entry.startedAt))}</td>
          <td>${entry.score}</td>
          <td>${escapeHtml(entry.taskPreview)}</td>
          <td>${entry.reportPath ? `<a href="${escapeAttribute(entry.reportPath)}">report</a>` : ""}</td>
        </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SandEval Score Index - ${escapeHtml(index.modelName)}</title>
  <style>
    :root { color-scheme: light; --ink:#1f2933; --muted:#667085; --line:#d0d5dd; --paper:#fffdf7; --accent:#b7791f; --accent-2:#2f855a; }
    * { box-sizing: border-box; }
    body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:#f8f5ec; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px 20px 48px; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:flex-end; border-bottom:1px solid var(--line); padding-bottom:18px; }
    h1 { margin:0; font-size:30px; line-height:1.15; letter-spacing:0; }
    h2 { margin:28px 0 12px; font-size:18px; letter-spacing:0; }
    .muted { color:var(--muted); }
    .metrics { display:grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap:12px; margin:22px 0; }
    .metric { border:1px solid var(--line); background:var(--paper); border-radius:8px; padding:14px; }
    .metric span { display:block; color:var(--muted); font-size:12px; text-transform:uppercase; }
    .metric strong { display:block; font-size:28px; margin-top:4px; }
    .chart, .panel { border:1px solid var(--line); background:var(--paper); border-radius:8px; padding:16px; }
    svg { width:100%; height:280px; display:block; overflow:visible; }
    .grid { stroke:#d8d1c3; stroke-width:.4; }
    .line { fill:none; stroke:var(--accent); stroke-width:2.4; vector-effect:non-scaling-stroke; }
    .dot { fill:var(--accent); stroke:white; stroke-width:1.5; }
    .bar-row { display:grid; grid-template-columns: 150px 1fr 48px; gap:12px; align-items:center; margin:10px 0; }
    .bar-track { height:12px; border-radius:999px; background:#ebe3d4; overflow:hidden; }
    .bar-fill { height:100%; background:linear-gradient(90deg, var(--accent), var(--accent-2)); }
    table { width:100%; border-collapse:collapse; font-size:14px; }
    th, td { text-align:left; border-bottom:1px solid var(--line); padding:10px 8px; vertical-align:top; }
    a { color:#975a16; }
    @media (max-width: 760px) { header { display:block; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .bar-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="muted">SandEval model score index</p>
        <h1>${escapeHtml(index.modelName)}</h1>
      </div>
      <p class="muted">Generated ${escapeHtml(formatDate(index.generatedAt))}</p>
    </header>
    <section class="metrics">
      <div class="metric"><span>Reviews</span><strong>${index.reviewCount}</strong></div>
      <div class="metric"><span>Average</span><strong>${index.averageScore}</strong></div>
      <div class="metric"><span>Latest</span><strong>${index.latestScore}</strong></div>
      <div class="metric"><span>Best</span><strong>${index.bestScore}</strong></div>
    </section>
    <section class="chart">
      <h2>Score Trend</h2>
      <svg viewBox="-4 -8 108 116" role="img" aria-label="Score trend chart">
        <line class="grid" x1="0" y1="0" x2="100" y2="0"></line>
        <line class="grid" x1="0" y1="25" x2="100" y2="25"></line>
        <line class="grid" x1="0" y1="50" x2="100" y2="50"></line>
        <line class="grid" x1="0" y1="75" x2="100" y2="75"></line>
        <line class="grid" x1="0" y1="100" x2="100" y2="100"></line>
        <polyline class="line" points="${chartPoints.join(" ")}"></polyline>
        ${chartPoints
          .map((point, index) => {
            const [x, y] = point.split(",");
            return `<circle class="dot" cx="${x}" cy="${y}" r="2.4"><title>${scores[index]}</title></circle>`;
          })
          .join("")}
      </svg>
      <p class="muted">Trend: ${index.trend}. Scores are normalized on a 0-100 scale.</p>
    </section>
    <section class="panel">
      <h2>Dimension Averages</h2>
      ${bars || '<p class="muted">No dimension scores recorded.</p>'}
    </section>
    <section class="panel">
      <h2>Reviews</h2>
      <table>
        <thead><tr><th>Date</th><th>Score</th><th>Task</th><th>Report</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>
  </main>
</body>
</html>
`;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "model";
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return replacements[character] ?? character;
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
