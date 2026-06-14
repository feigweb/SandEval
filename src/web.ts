import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { generateModelScoreDashboard } from "./analytics.js";
import { runArena } from "./arena.js";
import { packageArenaArtifacts, packageRunArtifacts } from "./artifacts.js";
import { loginModel } from "./auth.js";
import { findModel, getConfigPath, listModelNames, loadConfig, saveConfig, validateConfig } from "./config.js";
import { listContextNames } from "./contexts.js";
import { ensureSandboxEnvironment } from "./environment.js";
import { createProvider } from "./providers/index.js";
import { saveArenaReport, saveRunReport } from "./report.js";
import { runTask } from "./runner.js";
import { scoreRun } from "./scorer.js";
import { listSkills } from "./skills.js";
import { createStorage } from "./storage.js";
import type { ArenaReport, RunEvent, RunPlan, RunReport, SandEvalConfig, StoredRunSummary } from "./types.js";
import { stringifyError } from "./utils.js";

export interface RunWebOptions {
  cwd: string;
  configPath?: string;
  host?: string;
  port?: number;
}

type RunMode = "single" | "arena";
type ScreenState = "idle" | "running" | "planApproval" | "error";

interface WebState {
  status: ScreenState;
  message: string;
  events: RunEvent[];
  result?: RunReport | ArenaReport;
  resultMode?: RunMode;
  error?: string;
  pendingPlan?: RunPlan;
}

interface RunRequest {
  mode?: RunMode;
  prompt?: string;
  model?: string;
  models?: string[];
  score?: boolean;
  contextNames?: string[];
  review?: string;
}

interface PlanApprovalRequest {
  approved?: boolean;
  feedback?: string;
}

interface WebRuntime {
  config: SandEvalConfig;
  state: WebState;
  planResolver?: (plan: RunPlan) => void;
}

export async function runWeb(options: RunWebOptions): Promise<void> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const runtime: WebRuntime = {
    config: await loadConfig(options.cwd, options.configPath),
    state: {
      status: "idle",
      message: "Ready",
      events: []
    }
  };

  const server = createServer((request, response) => {
    void routeRequest(request, response, runtime, options).catch((error) => {
      sendJson(response, 500, { error: stringifyError(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  console.log(`SandEval Web: http://${host}:${resolvedPort}`);

  await new Promise<void>((resolve) => {
    const close = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: WebRuntime,
  options: RunWebOptions
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, renderWebHtml());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    const history = await (await createStorage(runtime.config, options.cwd)).listRuns(runtime.config.ui?.pageSize ?? 12);
    const skills = await listSkills(runtime.config, options.cwd).catch(() => []);
    sendJson(response, 200, {
      cwd: options.cwd,
      configPath: getConfigPath(options.cwd, options.configPath),
      config: runtime.config,
      models: webModelNames(runtime.config),
      contexts: listContextNames(runtime.config),
      skills: skills.map((skill) => ({ name: skill.name, description: skill.description, source: skill.source })),
      history,
      state: serializeState(runtime.state)
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    sendJson(response, 200, serializeState(runtime.state));
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/history") {
    const limit = Number.parseInt(url.searchParams.get("limit") ?? String(runtime.config.ui?.pageSize ?? 20), 10);
    const history = await (await createStorage(runtime.config, options.cwd)).listRuns(Number.isFinite(limit) ? limit : 20);
    sendJson(response, 200, { history });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/history/open") {
    const body = (await readJson(request)) as { summary?: StoredRunSummary };
    if (!body.summary) {
      sendJson(response, 400, { error: "Missing history summary." });
      return;
    }
    const report = await (await createStorage(runtime.config, options.cwd)).loadReport?.(body.summary);
    if (!report) {
      sendJson(response, 404, { error: "Report not found." });
      return;
    }
    runtime.state = {
      status: "idle",
      message: `Opened ${body.summary.id}`,
      events: [],
      result: report,
      resultMode: "results" in report ? "arena" : "single"
    };
    sendJson(response, 200, serializeState(runtime.state));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/run") {
    const body = (await readJson(request)) as RunRequest;
    startRun(runtime, options, body);
    sendJson(response, 202, serializeState(runtime.state));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/plan") {
    const body = (await readJson(request)) as PlanApprovalRequest;
    resolvePendingPlan(runtime, body);
    sendJson(response, 200, serializeState(runtime.state));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/config") {
    const body = (await readJson(request)) as { config?: unknown };
    const next = validateConfig(body.config);
    await saveConfig(next, options.cwd, options.configPath);
    runtime.config = next;
    runtime.state.message = "Config saved";
    sendJson(response, 200, { config: runtime.config, models: webModelNames(runtime.config), contexts: listContextNames(runtime.config) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = (await readJson(request)) as { model?: string };
    const message = await loginModel({ config: runtime.config, cwd: options.cwd, modelName: body.model, configPath: options.configPath });
    runtime.state.message = message;
    sendJson(response, 200, { message });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/package") {
    const artifactPath = await packageCurrentResult(runtime, options.cwd);
    sendJson(response, 200, { artifactPath, state: serializeState(runtime.state) });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/score") {
    const body = (await readJson(request)) as { review?: string };
    await scoreCurrentResult(runtime, options.cwd, body.review ?? "");
    sendJson(response, 200, serializeState(runtime.state));
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/dashboard") {
    const body = (await readJson(request)) as { model?: string };
    const modelName = body.model ?? resolveResultModel(runtime.state.result, runtime.state.resultMode, runtime.config.defaultModel);
    if (!modelName) {
      sendJson(response, 400, { error: "No model selected for dashboard." });
      return;
    }
    const dashboard = await generateModelScoreDashboard({ config: runtime.config, cwd: options.cwd, modelName });
    runtime.state.message = `Dashboard ready: ${dashboard.htmlPath}`;
    sendJson(response, 200, { htmlPath: dashboard.htmlPath });
    return;
  }
  sendJson(response, 404, { error: "Not found." });
}

function startRun(runtime: WebRuntime, options: RunWebOptions, request: RunRequest): void {
  if (runtime.state.status === "running" || runtime.state.status === "planApproval") {
    throw new Error("A SandEval run is already active.");
  }
  const prompt = request.prompt?.trim();
  if (!prompt) {
    throw new Error("Enter a task prompt first.");
  }
  const mode = request.mode ?? "single";
  const events: RunEvent[] = [];
  const appendEvent = (event: RunEvent) => {
    events.push(event);
    runtime.state = {
      ...runtime.state,
      events: events.slice(-(runtime.config.workflow?.maxWorkflowEvents ?? 200)),
      message: event.message
    };
  };
  runtime.state = {
    status: "running",
    message: mode === "arena" ? "Running arena" : `Running ${request.model ?? runtime.config.defaultModel ?? "model"}`,
    events,
    result: undefined,
    resultMode: undefined,
    error: undefined
  };

  const run = async () => {
    try {
      await ensureSandboxEnvironment({ sandbox: runtime.config.sandbox, prompt: false, context: "web" });
      if (mode === "arena") {
        const models = request.models?.filter(Boolean) ?? [];
        if (models.length < 2) {
          throw new Error("Select at least two models for Arena.");
        }
        const report = await runArena({
          config: runtime.config,
          cwd: options.cwd,
          prompt,
          models,
          score: request.score,
          userReview: request.review,
          concurrency: requiresInteractivePlanApproval(runtime.config) ? 1 : runtime.config.arena?.concurrency,
          onEvent: appendEvent,
          contextNames: request.contextNames,
          onPlanApproval: (plan) => approvePlanInWeb(runtime, plan)
        });
        const paths = await saveArenaReport(report, resolveReportDir(runtime.config, options.cwd));
        report.reportPaths = paths;
        await (await createStorage(runtime.config, options.cwd)).saveArena(report);
        runtime.state = {
          status: "idle",
          message: `Arena complete: ${paths.markdownPath}`,
          events,
          result: report,
          resultMode: "arena"
        };
        return;
      }
      const report = await runTask({
        config: runtime.config,
        cwd: options.cwd,
        prompt,
        modelName: request.model,
        score: request.score,
        userReview: request.review,
        onEvent: appendEvent,
        contextNames: request.contextNames,
        onPlanApproval: (plan) => approvePlanInWeb(runtime, plan)
      });
      const paths = await saveRunReport(report, resolveReportDir(runtime.config, options.cwd));
      report.reportPaths = paths;
      await (await createStorage(runtime.config, options.cwd)).saveRun(report);
      runtime.state = {
        status: "idle",
        message: `Run complete: ${paths.markdownPath}`,
        events,
        result: report,
        resultMode: "single"
      };
    } catch (error) {
      runtime.state = {
        status: "error",
        message: "Run failed",
        events,
        error: stringifyError(error)
      };
    }
  };

  void run();
}

function approvePlanInWeb(runtime: WebRuntime, plan: RunPlan): Promise<RunPlan> {
  return new Promise((resolve) => {
    runtime.planResolver = resolve;
    runtime.state = {
      ...runtime.state,
      status: "planApproval",
      message: "Plan awaiting approval",
      pendingPlan: plan
    };
  });
}

function resolvePendingPlan(runtime: WebRuntime, request: PlanApprovalRequest): void {
  if (!runtime.planResolver || !runtime.state.pendingPlan) {
    throw new Error("No plan is waiting for approval.");
  }
  const plan = runtime.state.pendingPlan;
  const next: RunPlan =
    request.approved === false
      ? {
          ...plan,
          approved: false,
          approvalMode: "interactive",
          revisions: [...plan.revisions, { feedback: request.feedback || "Revise the plan.", content: plan.content }]
        }
      : { ...plan, approved: true, approvalMode: "interactive" };
  const resolve = runtime.planResolver;
  runtime.planResolver = undefined;
  runtime.state = {
    ...runtime.state,
    status: "running",
    message: next.approved ? "Plan approved, continuing run" : "Plan feedback sent",
    pendingPlan: undefined
  };
  resolve(next);
}

async function packageCurrentResult(runtime: WebRuntime, cwd: string): Promise<string> {
  if (!runtime.state.result) {
    throw new Error("No result to package.");
  }
  const artifactPath =
    runtime.state.resultMode === "arena" && "results" in runtime.state.result
      ? await packageArenaArtifacts(runtime.state.result, cwd)
      : await packageRunArtifacts(runtime.state.result as RunReport, cwd);
  if (runtime.state.resultMode === "arena" && "results" in runtime.state.result) {
    const paths = await saveArenaReport(runtime.state.result, resolveReportDir(runtime.config, cwd));
    runtime.state.result.reportPaths = { ...paths, artifactPath };
    await (await createStorage(runtime.config, cwd)).saveArena(runtime.state.result);
  } else {
    const report = runtime.state.result as RunReport;
    const paths = await saveRunReport(report, resolveReportDir(runtime.config, cwd));
    report.reportPaths = { ...paths, artifactPath };
    await (await createStorage(runtime.config, cwd)).saveRun(report);
  }
  runtime.state.message = `Artifacts packaged: ${artifactPath}`;
  return artifactPath;
}

async function scoreCurrentResult(runtime: WebRuntime, cwd: string, review: string): Promise<void> {
  if (!runtime.state.result) {
    throw new Error("No result to score.");
  }
  const judgeConfig = findModel(runtime.config, runtime.config.judgeModel);
  const judgeProvider = createProvider(judgeConfig);
  const events = runtime.state.events;
  const appendScoreEvent = (event: RunEvent) => {
    events.push(event);
    runtime.state = { ...runtime.state, events: events.slice(-(runtime.config.workflow?.maxWorkflowEvents ?? 200)), message: event.message };
  };
  const scoreOne = async (report: RunReport) => {
    appendScoreEvent({
      type: "score-start",
      at: new Date().toISOString(),
      modelName: judgeConfig.name,
      message: `Scoring ${report.run.modelName} with ${judgeConfig.name}`
    });
    report.userReview = review || undefined;
    report.score = await scoreRun({
      run: report.run,
      provider: judgeProvider,
      modelConfig: judgeConfig,
      config: runtime.config,
      userReview: report.userReview
    });
    appendScoreEvent({
      type: "score-finish",
      at: new Date().toISOString(),
      modelName: judgeConfig.name,
      level: "success",
      message: `${report.run.modelName} score: ${report.score.score}/100`
    });
  };

  runtime.state = { ...runtime.state, status: "running", message: "Scoring with judge model" };
  const currentResult = runtime.state.result;
  if (runtime.state.resultMode === "arena" && currentResult && "results" in currentResult) {
    for (const report of currentResult.results) {
      await scoreOne(report);
    }
    const paths = await saveArenaReport(currentResult, resolveReportDir(runtime.config, cwd));
    currentResult.reportPaths = { ...currentResult.reportPaths, ...paths };
    await (await createStorage(runtime.config, cwd)).saveArena(currentResult);
  } else {
    const report = currentResult as RunReport;
    await scoreOne(report);
    const paths = await saveRunReport(report, resolveReportDir(runtime.config, cwd));
    report.reportPaths = { ...report.reportPaths, ...paths };
    await (await createStorage(runtime.config, cwd)).saveRun(report);
  }
  runtime.state = { ...runtime.state, status: "idle", message: "Review and scoring complete" };
}

function serializeState(state: WebState): WebState {
  return {
    ...state,
    events: state.events.slice(-200),
    result: state.result ? summarizeResult(state.result) : undefined
  };
}

function summarizeResult(result: RunReport | ArenaReport): RunReport | ArenaReport {
  return result;
}

function webModelNames(config: SandEvalConfig): string[] {
  return listModelNames(config).filter((model) => findModel(config, model).kind !== "mock");
}

function resolveReportDir(config: SandEvalConfig, cwd: string): string {
  return path.resolve(cwd, config.reportDir ?? ".sandeval/reports");
}

function requiresInteractivePlanApproval(config: SandEvalConfig): boolean {
  return config.agent?.planMode === "enforced" && config.agent?.planApproval === "interactive";
}

function resolveResultModel(result?: RunReport | ArenaReport, mode?: RunMode, fallback?: string): string | undefined {
  if (!result) {
    return fallback;
  }
  if (mode === "arena" && "results" in result) {
    return result.results[0]?.run.modelName ?? fallback;
  }
  return (result as RunReport).run.modelName ?? fallback;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body));
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(body);
}

function renderWebHtml(): string {
  return String.raw`<!doctype html>
<html lang="en" data-bs-theme="light">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SandEval Web</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
  <style>
    :root {
      --sand-bg: #f7f3ec;
      --sand-panel: #fffdf8;
      --sand-line: #ddd3c2;
      --sand-ink: #27221b;
      --sand-muted: #766b5c;
      --sand-accent: #b9792f;
      --sand-blue: #2f6976;
    }
    body {
      min-height: 100vh;
      background: var(--sand-bg);
      color: var(--sand-ink);
      letter-spacing: 0;
    }
    .app-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr) 340px;
    }
    .sidebar {
      border-right: 1px solid var(--sand-line);
      background: #fbf8f1;
    }
    .inspector {
      border-left: 1px solid var(--sand-line);
      background: #fbf8f1;
    }
    .workspace {
      min-width: 0;
    }
    .brand-mark {
      inline-size: 36px;
      block-size: 36px;
      border-radius: 8px;
      background: var(--sand-ink);
      color: #fff8e8;
      display: inline-grid;
      place-items: center;
      font-weight: 700;
    }
    .nav-pills .nav-link {
      color: var(--sand-muted);
      border-radius: 8px;
      text-align: left;
    }
    .nav-pills .nav-link.active {
      background: var(--sand-ink);
      color: #fff8e8;
    }
    .surface {
      background: var(--sand-panel);
      border: 1px solid var(--sand-line);
      border-radius: 8px;
    }
    .btn-primary {
      --bs-btn-bg: var(--sand-ink);
      --bs-btn-border-color: var(--sand-ink);
      --bs-btn-hover-bg: #3b3329;
      --bs-btn-hover-border-color: #3b3329;
    }
    .btn-outline-primary {
      --bs-btn-color: var(--sand-ink);
      --bs-btn-border-color: var(--sand-ink);
      --bs-btn-hover-bg: var(--sand-ink);
      --bs-btn-hover-border-color: var(--sand-ink);
    }
    .form-control:focus, .form-select:focus {
      border-color: var(--sand-accent);
      box-shadow: 0 0 0 .2rem rgba(185, 121, 47, .14);
    }
    .status-dot {
      inline-size: 10px;
      block-size: 10px;
      border-radius: 50%;
      background: #87806f;
      display: inline-block;
    }
    .status-running { background: var(--sand-blue); }
    .status-error { background: #b54a3b; }
    .event-list {
      max-height: 46vh;
      overflow: auto;
    }
    .event-row {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: .75rem;
      padding: .45rem 0;
      border-bottom: 1px solid rgba(221, 211, 194, .65);
      font-size: .9rem;
    }
    .command-palette {
      position: fixed;
      inset: 0;
      display: none;
      align-items: flex-start;
      justify-content: center;
      padding-top: 10vh;
      background: rgba(29, 26, 22, .28);
      z-index: 1080;
    }
    .command-palette.open { display: flex; }
    .palette-panel {
      width: min(720px, calc(100vw - 24px));
      background: #fffdf8;
      border: 1px solid var(--sand-line);
      border-radius: 8px;
      box-shadow: 0 24px 80px rgba(34, 29, 23, .22);
      overflow: hidden;
    }
    .palette-row {
      cursor: pointer;
      border-top: 1px solid rgba(221, 211, 194, .7);
    }
    .palette-row:hover, .palette-row.active {
      background: #f1eadf;
    }
    .result-summary {
      white-space: pre-wrap;
      max-height: 220px;
      overflow: auto;
    }
    .table {
      --bs-table-bg: transparent;
    }
    @media (max-width: 1100px) {
      .app-shell {
        grid-template-columns: 220px minmax(0, 1fr);
      }
      .inspector {
        display: none;
      }
    }
    @media (max-width: 760px) {
      .app-shell {
        display: block;
      }
      .sidebar {
        border-right: 0;
        border-bottom: 1px solid var(--sand-line);
      }
      .nav-pills {
        flex-direction: row !important;
        gap: .25rem;
        overflow-x: auto;
      }
      .nav-pills .nav-link {
        white-space: nowrap;
      }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar p-3">
      <div class="d-flex align-items-center gap-2 mb-4">
        <span class="brand-mark">S</span>
        <div>
          <div class="fw-semibold">SandEval</div>
          <div class="small text-secondary">Web workspace</div>
        </div>
      </div>
      <nav class="nav nav-pills flex-column gap-1" id="mainTabs">
        <button class="nav-link active" data-tab="run"><i class="bi bi-play-circle me-2"></i>Run</button>
        <button class="nav-link" data-tab="history"><i class="bi bi-clock-history me-2"></i>History</button>
        <button class="nav-link" data-tab="config"><i class="bi bi-sliders me-2"></i>Config</button>
        <button class="nav-link" data-tab="workflow"><i class="bi bi-list-check me-2"></i>Workflow</button>
        <button class="nav-link" data-tab="result"><i class="bi bi-bar-chart-line me-2"></i>Result</button>
      </nav>
      <hr>
      <button class="btn btn-outline-primary w-100" id="openPalette"><i class="bi bi-command me-2"></i>Command</button>
      <div class="small text-secondary mt-3" id="cwdLabel"></div>
    </aside>

    <main class="workspace p-3 p-lg-4">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3">
        <div>
          <h1 class="h3 mb-1">Workspace</h1>
          <div class="text-secondary" id="configPathLabel"></div>
        </div>
        <div class="d-flex align-items-center gap-2">
          <span class="status-dot" id="statusDot"></span>
          <span class="fw-medium" id="statusText">Loading</span>
        </div>
      </div>

      <section class="tab-view" id="tab-run">
        <div class="surface p-3 p-lg-4">
          <div class="d-flex flex-wrap gap-3 align-items-end mb-3">
            <div>
              <label class="form-label">Mode</label>
              <div class="btn-group" role="group">
                <input type="radio" class="btn-check" name="mode" id="modeSingle" value="single" checked>
                <label class="btn btn-outline-primary" for="modeSingle"><i class="bi bi-person me-1"></i>Single</label>
                <input type="radio" class="btn-check" name="mode" id="modeArena" value="arena">
                <label class="btn btn-outline-primary" for="modeArena"><i class="bi bi-columns-gap me-1"></i>Arena</label>
              </div>
            </div>
            <div class="flex-grow-1" id="singleModelGroup">
              <label class="form-label" for="modelSelect">Model</label>
              <select class="form-select" id="modelSelect"></select>
            </div>
            <div class="flex-grow-1 d-none" id="arenaModelGroup">
              <label class="form-label" for="arenaModels">Arena models</label>
              <select class="form-select" id="arenaModels" multiple size="4"></select>
            </div>
            <div>
              <label class="form-label" for="scoreToggle">Scoring</label>
              <div class="form-check form-switch">
                <input class="form-check-input" type="checkbox" role="switch" id="scoreToggle" checked>
                <label class="form-check-label" for="scoreToggle">Judge</label>
              </div>
            </div>
          </div>

          <div class="mb-3">
            <label class="form-label" for="promptInput">Task prompt</label>
            <textarea class="form-control" id="promptInput" rows="8" placeholder="Describe a task. Type @workspace in the prompt or select context below."></textarea>
          </div>
          <div class="row g-3">
            <div class="col-md-7">
              <label class="form-label" for="contextSelect">Contexts</label>
              <select class="form-select" id="contextSelect" multiple size="3"></select>
            </div>
            <div class="col-md-5">
              <label class="form-label" for="reviewInput">Human review</label>
              <textarea class="form-control" id="reviewInput" rows="3"></textarea>
            </div>
          </div>
          <div class="d-flex flex-wrap gap-2 mt-3">
            <button class="btn btn-primary" id="runButton"><i class="bi bi-play-fill me-1"></i>Run</button>
            <button class="btn btn-outline-primary" id="loginButton"><i class="bi bi-key me-1"></i>Login</button>
            <button class="btn btn-outline-primary" id="refreshButton"><i class="bi bi-arrow-clockwise me-1"></i>Refresh</button>
          </div>
        </div>

        <div class="surface p-3 mt-3 d-none" id="planPanel">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h2 class="h6 mb-0">Plan approval</h2>
            <span class="badge text-bg-warning">Waiting</span>
          </div>
          <pre class="small mb-3" id="planContent"></pre>
          <textarea class="form-control mb-2" id="planFeedback" rows="2" placeholder="Feedback for revision"></textarea>
          <div class="d-flex gap-2">
            <button class="btn btn-primary" id="approvePlan"><i class="bi bi-check2 me-1"></i>Approve</button>
            <button class="btn btn-outline-primary" id="revisePlan"><i class="bi bi-pencil-square me-1"></i>Revise</button>
          </div>
        </div>
      </section>

      <section class="tab-view d-none" id="tab-history">
        <div class="surface p-3">
          <div class="d-flex justify-content-between align-items-center mb-2">
            <h2 class="h5 mb-0">History</h2>
            <button class="btn btn-sm btn-outline-primary" id="historyRefresh"><i class="bi bi-arrow-clockwise"></i></button>
          </div>
          <div class="table-responsive">
            <table class="table align-middle">
              <thead><tr><th>Started</th><th>Type</th><th>Score</th><th>Models</th><th>Task</th><th></th></tr></thead>
              <tbody id="historyRows"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="tab-view d-none" id="tab-config">
        <div class="surface p-3 p-lg-4">
          <div class="row g-3">
            <div class="col-md-6">
              <label class="form-label" for="defaultModel">Default model</label>
              <select class="form-select" id="defaultModel"></select>
            </div>
            <div class="col-md-6">
              <label class="form-label" for="judgeModel">Judge model</label>
              <select class="form-select" id="judgeModel"></select>
            </div>
            <div class="col-md-4">
              <label class="form-label" for="sandboxMode">Sandbox</label>
              <select class="form-select" id="sandboxMode">
                <option>local</option><option>docker</option><option>podman</option><option>bubblewrap</option><option>firejail</option><option>nsjail</option><option>external</option>
              </select>
            </div>
            <div class="col-md-4">
              <label class="form-label" for="uiTheme">Theme</label>
              <select class="form-select" id="uiTheme"><option>sand</option><option>dark</option><option>mono</option></select>
            </div>
            <div class="col-md-4">
              <label class="form-label" for="arenaConcurrency">Arena concurrency</label>
              <input class="form-control" id="arenaConcurrency" type="number" min="1">
            </div>
          </div>
          <hr>
          <div class="row g-3">
            <div class="col-md-6">
              <h3 class="h6">Tools</h3>
              <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="toolFiles"><label class="form-check-label" for="toolFiles">Files</label></div>
              <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="toolShell"><label class="form-check-label" for="toolShell">Shell</label></div>
              <div class="form-check form-switch"><input class="form-check-input" type="checkbox" id="toolGitRemote"><label class="form-check-label" for="toolGitRemote">Git remote</label></div>
              <label class="form-label mt-2" for="toolGit">Git</label>
              <select class="form-select" id="toolGit"><option>off</option><option>read</option><option>full</option></select>
            </div>
            <div class="col-md-6">
              <h3 class="h6">Rules</h3>
              <div id="ruleToggles" class="vstack gap-1"></div>
            </div>
          </div>
          <div class="d-flex gap-2 mt-3">
            <button class="btn btn-primary" id="saveConfig"><i class="bi bi-save me-1"></i>Save config</button>
            <button class="btn btn-outline-primary" id="showRawConfig"><i class="bi bi-braces me-1"></i>JSON</button>
          </div>
          <textarea class="form-control font-monospace small mt-3 d-none" id="rawConfig" rows="14"></textarea>
        </div>
      </section>

      <section class="tab-view d-none" id="tab-workflow">
        <div class="surface p-3">
          <h2 class="h5">Workflow</h2>
          <div class="event-list" id="workflowEvents"></div>
        </div>
      </section>

      <section class="tab-view d-none" id="tab-result">
        <div class="surface p-3 p-lg-4">
          <div class="d-flex flex-wrap justify-content-between gap-2 mb-3">
            <h2 class="h5 mb-0">Result</h2>
            <div class="d-flex flex-wrap gap-2">
              <button class="btn btn-sm btn-outline-primary" id="packageButton"><i class="bi bi-archive me-1"></i>Package</button>
              <button class="btn btn-sm btn-outline-primary" id="scoreButton"><i class="bi bi-stars me-1"></i>Score</button>
              <button class="btn btn-sm btn-outline-primary" id="dashboardButton"><i class="bi bi-graph-up me-1"></i>Dashboard</button>
            </div>
          </div>
          <div id="resultBody" class="text-secondary">No result yet.</div>
        </div>
      </section>
    </main>

    <aside class="inspector p-3">
      <div class="d-flex align-items-center justify-content-between mb-2">
        <h2 class="h6 mb-0">Live events</h2>
        <span class="badge text-bg-light" id="eventCount">0</span>
      </div>
      <div class="event-list" id="sideEvents"></div>
    </aside>
  </div>

  <div class="command-palette" id="palette">
    <div class="palette-panel">
      <div class="p-3">
        <input class="form-control form-control-lg" id="paletteInput" placeholder="Search commands">
      </div>
      <div id="paletteRows"></div>
    </div>
  </div>

  <div class="toast-container position-fixed bottom-0 end-0 p-3">
    <div id="toast" class="toast" role="status" aria-live="polite" aria-atomic="true">
      <div class="toast-body" id="toastBody"></div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
  <script>
    const app = {
      config: null,
      models: [],
      contexts: [],
      skills: [],
      history: [],
      state: { status: 'idle', message: 'Ready', events: [] },
      activeTab: 'run'
    };
    const $ = (id) => document.getElementById(id);
    const toast = () => bootstrap.Toast.getOrCreateInstance($('toast'), { delay: 3200 });

    async function api(path, options = {}) {
      const response = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data;
    }
    function notify(message) {
      $('toastBody').textContent = message;
      toast().show();
    }
    function setTab(tab) {
      app.activeTab = tab;
      document.querySelectorAll('#mainTabs .nav-link').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
      document.querySelectorAll('.tab-view').forEach((view) => view.classList.add('d-none'));
      $('tab-' + tab).classList.remove('d-none');
    }
    function optionList(select, values, selected, multiple = false) {
      select.innerHTML = values.map((value) => {
        const isSelected = multiple ? (selected || []).includes(value) : selected === value;
        return '<option value="' + escapeHtml(value) + '"' + (isSelected ? ' selected' : '') + '>' + escapeHtml(value) + '</option>';
      }).join('');
    }
    function selectedValues(select) {
      return [...select.selectedOptions].map((option) => option.value);
    }
    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    }
    function formatTime(value) {
      if (!value) return '';
      return new Date(value).toLocaleTimeString();
    }
    function renderBootstrap(data) {
      app.config = data.config;
      app.models = data.models;
      app.contexts = data.contexts;
      app.skills = data.skills;
      app.history = data.history;
      app.state = data.state;
      $('cwdLabel').textContent = data.cwd;
      $('configPathLabel').textContent = data.configPath;
      optionList($('modelSelect'), app.models, app.config.defaultModel || app.models[0]);
      optionList($('arenaModels'), app.models, [app.config.defaultModel || app.models[0]].filter(Boolean), true);
      optionList($('contextSelect'), app.contexts, [], true);
      renderConfigForm();
      renderHistory();
      renderState();
    }
    function renderConfigForm() {
      optionList($('defaultModel'), app.models, app.config.defaultModel);
      optionList($('judgeModel'), app.models, app.config.judgeModel || app.config.defaultModel);
      $('sandboxMode').value = app.config.sandbox?.mode || 'local';
      $('uiTheme').value = app.config.ui?.theme || 'sand';
      $('arenaConcurrency').value = app.config.arena?.concurrency || 1;
      $('toolFiles').checked = app.config.tools?.files !== false;
      $('toolShell').checked = app.config.tools?.shell !== false;
      $('toolGitRemote').checked = app.config.tools?.gitRemote === true;
      $('toolGit').value = app.config.tools?.git || 'full';
      $('ruleToggles').innerHTML = (app.config.rules || []).map((rule, index) => (
        '<div class="form-check form-switch">' +
        '<input class="form-check-input rule-toggle" type="checkbox" id="rule-' + index + '" data-index="' + index + '"' + (rule.enabled !== false ? ' checked' : '') + '>' +
        '<label class="form-check-label" for="rule-' + index + '">' + escapeHtml(rule.name) + '</label>' +
        '</div>'
      )).join('');
      $('rawConfig').value = JSON.stringify(app.config, null, 2);
    }
    function readConfigForm() {
      const next = JSON.parse($('rawConfig').classList.contains('d-none') ? JSON.stringify(app.config) : $('rawConfig').value);
      next.defaultModel = $('defaultModel').value;
      next.judgeModel = $('judgeModel').value;
      next.sandbox = { ...(next.sandbox || {}), mode: $('sandboxMode').value };
      next.ui = { ...(next.ui || {}), theme: $('uiTheme').value };
      next.arena = { ...(next.arena || {}), concurrency: Number($('arenaConcurrency').value || 1) };
      next.tools = {
        ...(next.tools || {}),
        files: $('toolFiles').checked,
        shell: $('toolShell').checked,
        gitRemote: $('toolGitRemote').checked,
        git: $('toolGit').value
      };
      document.querySelectorAll('.rule-toggle').forEach((input) => {
        const index = Number(input.dataset.index);
        if (next.rules?.[index]) next.rules[index].enabled = input.checked;
      });
      return next;
    }
    function renderHistory() {
      $('historyRows').innerHTML = app.history.length ? app.history.map((item, index) => (
        '<tr>' +
        '<td class="small">' + escapeHtml(item.startedAt) + '</td>' +
        '<td>' + escapeHtml(item.type) + '</td>' +
        '<td>' + escapeHtml(item.score ?? '-') + '</td>' +
        '<td class="small">' + escapeHtml(item.modelNames.join(', ')) + '</td>' +
        '<td>' + escapeHtml(item.taskPreview) + '</td>' +
        '<td class="text-end"><button class="btn btn-sm btn-outline-primary open-history" data-index="' + index + '"><i class="bi bi-box-arrow-in-right"></i></button></td>' +
        '</tr>'
      )).join('') : '<tr><td colspan="6" class="text-secondary">No stored runs yet.</td></tr>';
    }
    function renderState() {
      $('statusText').textContent = app.state.error || app.state.message || app.state.status;
      $('statusDot').className = 'status-dot ' + (app.state.status === 'running' || app.state.status === 'planApproval' ? 'status-running' : app.state.status === 'error' ? 'status-error' : '');
      $('eventCount').textContent = String(app.state.events?.length || 0);
      renderEvents($('sideEvents'), app.state.events || []);
      renderEvents($('workflowEvents'), app.state.events || []);
      renderResult();
      if (app.state.pendingPlan) {
        $('planPanel').classList.remove('d-none');
        $('planContent').textContent = app.state.pendingPlan.content || '';
      } else {
        $('planPanel').classList.add('d-none');
      }
      $('runButton').disabled = app.state.status === 'running' || app.state.status === 'planApproval';
    }
    function renderEvents(target, events) {
      target.innerHTML = events.length ? events.slice(-80).reverse().map((event) => (
        '<div class="event-row">' +
        '<div class="text-secondary">' + escapeHtml(formatTime(event.at)) + '</div>' +
        '<div><div class="fw-medium text-truncate">' + escapeHtml(event.message) + '</div>' +
        '<div class="small text-secondary">' + escapeHtml([event.type, event.modelName, event.toolName].filter(Boolean).join(' · ')) + '</div></div>' +
        '</div>'
      )).join('') : '<div class="text-secondary small">No events yet.</div>';
    }
    function renderResult() {
      const result = app.state.result;
      if (!result) {
        $('resultBody').innerHTML = '<div class="text-secondary">No result yet.</div>';
        return;
      }
      if (result.results) {
        $('resultBody').innerHTML = '<div class="table-responsive"><table class="table align-middle"><thead><tr><th>Model</th><th>Score</th><th>Turns</th><th>Tokens</th><th>Workspace</th></tr></thead><tbody>' +
          result.results.map((item) => '<tr><td>' + escapeHtml(item.run.modelName) + '</td><td>' + escapeHtml(item.score?.score ?? '-') + '</td><td>' + escapeHtml(item.run.turns) + '</td><td>' + escapeHtml(item.run.usage?.totalTokens ?? '-') + '</td><td class="small">' + escapeHtml(item.run.workspace) + '</td></tr>').join('') +
          '</tbody></table></div><div class="small text-secondary">' + escapeHtml(result.reportPaths?.markdownPath || '') + '</div>';
        return;
      }
      const run = result.run;
      $('resultBody').innerHTML =
        '<div class="row g-3">' +
        '<div class="col-md-3"><div class="small text-secondary">Model</div><div class="fw-semibold">' + escapeHtml(run.modelName) + '</div></div>' +
        '<div class="col-md-3"><div class="small text-secondary">Score</div><div class="fw-semibold">' + escapeHtml(result.score?.score ?? '-') + '</div></div>' +
        '<div class="col-md-3"><div class="small text-secondary">Turns</div><div class="fw-semibold">' + escapeHtml(run.turns) + '</div></div>' +
        '<div class="col-md-3"><div class="small text-secondary">Tokens</div><div class="fw-semibold">' + escapeHtml(run.usage?.totalTokens ?? '-') + '</div></div>' +
        '</div><hr><div class="result-summary">' + escapeHtml(run.finish?.summary || run.finalContent || 'No summary.') + '</div>' +
        '<div class="small text-secondary mt-3">' + escapeHtml(result.reportPaths?.markdownPath || '') + '</div>';
    }
    function currentRunPayload() {
      const mode = document.querySelector('input[name="mode"]:checked').value;
      return {
        mode,
        prompt: $('promptInput').value,
        model: $('modelSelect').value,
        models: selectedValues($('arenaModels')),
        score: $('scoreToggle').checked,
        contextNames: selectedValues($('contextSelect')),
        review: $('reviewInput').value
      };
    }
    async function refreshHistory() {
      const data = await api('/api/history');
      app.history = data.history;
      renderHistory();
    }
    async function refreshState() {
      app.state = await api('/api/state');
      renderState();
    }
    async function saveConfig() {
      const data = await api('/api/config', { method: 'POST', body: JSON.stringify({ config: readConfigForm() }) });
      app.config = data.config;
      app.models = data.models;
      app.contexts = data.contexts;
      renderConfigForm();
      notify('Config saved');
    }
    const commands = [
      { label: 'Run task', hint: 'Start current prompt', action: () => $('runButton').click() },
      { label: 'Switch to Single', hint: 'Run mode', action: () => { $('modeSingle').checked = true; updateMode(); } },
      { label: 'Switch to Arena', hint: 'Run mode', action: () => { $('modeArena').checked = true; updateMode(); } },
      { label: 'Open history', hint: 'Stored runs', action: () => setTab('history') },
      { label: 'Open config', hint: 'Visual settings', action: () => setTab('config') },
      { label: 'Open workflow', hint: 'Live events', action: () => setTab('workflow') },
      { label: 'Open result', hint: 'Latest report', action: () => setTab('result') },
      { label: 'Toggle scoring', hint: 'Judge on/off', action: () => { $('scoreToggle').checked = !$('scoreToggle').checked; } },
      { label: 'Save config', hint: 'Persist settings', action: () => saveConfig() },
      { label: 'Login selected model', hint: 'Auth', action: () => $('loginButton').click() },
      { label: 'Package artifacts', hint: 'Current result', action: () => $('packageButton').click() },
      { label: 'Review and score', hint: 'Current result', action: () => $('scoreButton').click() },
      { label: 'Score dashboard', hint: 'Current model', action: () => $('dashboardButton').click() }
    ];
    function openPalette() {
      $('palette').classList.add('open');
      $('paletteInput').value = '';
      renderPalette();
      $('paletteInput').focus();
    }
    function closePalette() {
      $('palette').classList.remove('open');
    }
    function renderPalette() {
      const query = $('paletteInput').value.toLowerCase();
      const rows = commands.filter((command) => (command.label + ' ' + command.hint).toLowerCase().includes(query));
      $('paletteRows').innerHTML = rows.map((command, index) => (
        '<div class="palette-row p-3 ' + (index === 0 ? 'active' : '') + '" data-index="' + commands.indexOf(command) + '">' +
        '<div class="fw-semibold">' + escapeHtml(command.label) + '</div><div class="small text-secondary">' + escapeHtml(command.hint) + '</div></div>'
      )).join('');
    }
    function updateMode() {
      const arena = $('modeArena').checked;
      $('singleModelGroup').classList.toggle('d-none', arena);
      $('arenaModelGroup').classList.toggle('d-none', !arena);
    }
    document.addEventListener('click', async (event) => {
      const target = event.target.closest('button, .palette-row');
      if (!target) return;
      try {
        if (target.dataset.tab) setTab(target.dataset.tab);
        if (target.id === 'openPalette') openPalette();
        if (target.id === 'runButton') {
          app.state = await api('/api/run', { method: 'POST', body: JSON.stringify(currentRunPayload()) });
          renderState();
          setTab('workflow');
        }
        if (target.id === 'refreshButton') location.reload();
        if (target.id === 'historyRefresh') await refreshHistory();
        if (target.classList.contains('open-history')) {
          app.state = await api('/api/history/open', { method: 'POST', body: JSON.stringify({ summary: app.history[Number(target.dataset.index)] }) });
          renderState();
          setTab('result');
        }
        if (target.id === 'saveConfig') await saveConfig();
        if (target.id === 'showRawConfig') $('rawConfig').classList.toggle('d-none');
        if (target.id === 'loginButton') {
          const model = $('modelSelect').value;
          const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ model }) });
          notify(data.message);
        }
        if (target.id === 'approvePlan') app.state = await api('/api/plan', { method: 'POST', body: JSON.stringify({ approved: true }) });
        if (target.id === 'revisePlan') app.state = await api('/api/plan', { method: 'POST', body: JSON.stringify({ approved: false, feedback: $('planFeedback').value }) });
        if (target.id === 'packageButton') {
          const data = await api('/api/package', { method: 'POST', body: '{}' });
          app.state = data.state;
          notify('Artifacts packaged');
        }
        if (target.id === 'scoreButton') {
          app.state = await api('/api/score', { method: 'POST', body: JSON.stringify({ review: $('reviewInput').value }) });
          notify('Scoring complete');
        }
        if (target.id === 'dashboardButton') {
          const data = await api('/api/dashboard', { method: 'POST', body: JSON.stringify({ model: $('modelSelect').value }) });
          notify('Dashboard: ' + data.htmlPath);
        }
        if (target.classList.contains('palette-row')) {
          const command = commands[Number(target.dataset.index)];
          closePalette();
          command?.action();
        }
        renderState();
      } catch (error) {
        notify(error.message);
      }
    });
    document.addEventListener('change', (event) => {
      if (event.target.name === 'mode') updateMode();
    });
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        openPalette();
      }
      if (event.key === 'Escape') closePalette();
      if (event.key === 'Enter' && $('palette').classList.contains('open') && document.activeElement === $('paletteInput')) {
        const first = $('paletteRows .palette-row');
        if (first) first.click();
      }
    });
    $('palette').addEventListener('click', (event) => {
      if (event.target === $('palette')) closePalette();
    });
    $('paletteInput').addEventListener('input', renderPalette);
    (async function boot() {
      try {
        renderBootstrap(await api('/api/bootstrap'));
        updateMode();
        setInterval(refreshState, 1200);
      } catch (error) {
        notify(error.message);
      }
    })();
  </script>
</body>
</html>`;
}
