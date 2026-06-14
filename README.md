# SandEval

SandEval is a CLI/TUI tool for evaluating coding agents in a sandboxed workspace. A configured model receives a task, creates artifacts through tool calls, runs its own verification commands, and returns a report with artifacts, command output, token usage, elapsed time, human feedback, and judge-model scoring.

## What You Can Do

- Run one model or an Arena of models against the same task.
- Evaluate artifacts with a judge model, optional human review, and weighted score dimensions.
- Generate a score index and self-contained Chart HTML dashboard once a model has at least two scored reviews.
- Use the SDK from application code for sandbox runs, Arena runs, history, scoring indexes, and dashboards.
- Work interactively in the Ink TUI with a workspace-first composer and `Ctrl+K` command palette.
- Configure OpenAI-compatible, Anthropic-compatible, Gemini-compatible, command, custom, Ollama, and LM Studio providers.
- Run agents inside local, Docker, Podman, Linux sandbox, or external sandbox backends.
- Attach project contexts with `@workspace`, trigger Skills with `@skill:name`, and inject reusable Rules.

## Quick Start

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js config wizard
node dist/cli.js login codex-cli
node dist/cli.js run --prompt "Create a tiny Node script that prints a haiku"
node dist/cli.js run --prompt "Smoke test the SandEval loop" --model mock/mock-agent --no-score --json
node dist/cli.js tui
```

In the TUI, SandEval opens directly into the run workspace. Use `Ctrl+K` for the command palette: switch Single/Arena mode, choose models, select contexts, toggle Skills and Rules, toggle scoring, change sandbox/tool settings, open history, login providers, package artifacts, or score a result. Type `@workspace` to attach a context and `@skill:verification` or `@skill:{tui-design}` to attach a Skill. Generation runs from the workspace with Enter.

`sandeval init` creates `.sandeval/config.json`. The generated config defaults to the OpenAI provider, not mock mode. A deterministic `mock/mock-agent` model is still included for CI or smoke tests, but SandEval only allows it for JSON CLI runs and hides it from the TUI because it produces fixed test artifacts rather than following arbitrary prompts.

## Common Commands

```bash
sandeval init
sandeval config wizard
sandeval config show
sandeval config get sandbox.mode
sandeval config set tools.gitRemote true
sandeval login codex-cli
sandeval auth

sandeval run task.md --model openai/gpt-5.4 --judge openai/gpt-5.4
sandeval run --prompt "Build a CLI calculator" --review "Works, but lacks tests"
sandeval arena task.md --models openai/gpt-5.4,anthropic/claude-sonnet-4-5,gemini/gemini-2.5-pro
sandeval arena --prompt "Build a tiny Vite app" --models openai/gpt-5.4,ollama/qwen2.5-coder:latest --concurrency 2

sandeval history
sandeval score-index openai/gpt-5.4
sandeval score-index openai/gpt-5.4 --output-dir reports/model-panels --json
sandeval tui
```

`score-index` scans stored scored reports, de-duplicates repeated saves of the same run, and requires at least two scored reviews for the requested model. It writes an HTML dashboard under `.sandeval/dashboards` by default.

## SDK Usage

SandEval can be embedded in Node.js code. The SDK uses the same config, sandbox, report, and storage paths as the CLI.

```ts
import { createSandEval } from "sandeval";

const sandeval = await createSandEval({ cwd: process.cwd() });

const report = await sandeval.run({
  prompt: "Create a tiny Node script that prints ok",
  modelName: "openai/gpt-5.4",
  judgeName: "openai/gpt-5.4"
});

console.log(report.score?.score);

const arena = await sandeval.arena({
  prompt: "Build a minimal landing page",
  models: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"],
  concurrency: 2
});

const dashboard = await sandeval.modelScoreDashboard("openai/gpt-5.4");
console.log(dashboard.htmlPath);
```

Useful SDK exports include `runTask`, `runArena`, `scoreRun`, `createStorage`, `buildModelScoreIndex`, `generateModelScoreDashboard`, config helpers, report helpers, and all public TypeScript types.

## Configuration

Set API keys through environment variables, then edit `.sandeval/config.json`.

```json
{
  "defaultModel": "openai/gpt-5.4",
  "judgeModel": "openai/gpt-5.4",
  "models": [
    {
      "name": "openai",
      "provider": "openai",
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-5.4",
      "modelIds": ["gpt-5.4", "gpt-4.1"]
    }
  ]
}
```

`.sandeval/config.json` is intentionally git-ignored because it may contain local command paths or secrets.

The config wizard appends new provider/model entries instead of replacing existing models. It accepts multiple model IDs for one provider, separated by comma or whitespace. You can also skip model IDs and save only the provider credentials/base URL, then run with an explicit reference such as `openai/gpt-5.4`. Less common setup such as sandbox, storage, scoring, workflow, and theme settings lives under the optional experience setup step.

Simple scalar config values can be read or changed without opening the full JSON:

```bash
sandeval config get sandbox.mode
sandeval config set sandbox.mode docker
sandeval config set tools.gitRemote true
sandeval config set scoring.enabled false
```

`config get/set` intentionally does not edit complex list-backed sections such as `models`, `rules`, `contexts`, or scoring `dimensions`. Use `sandeval config wizard` or edit `.sandeval/config.json` directly for provider and list configuration.

Ollama and LM Studio use the existing OpenAI-compatible provider path:

```json
{
  "models": [
    {
      "name": "ollama",
      "provider": "ollama",
      "kind": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "model": "qwen2.5-coder:latest",
      "modelIds": ["qwen2.5-coder:latest"]
    },
    {
      "name": "lmstudio",
      "provider": "lmstudio",
      "kind": "openai-compatible",
      "baseUrl": "http://localhost:1234/v1",
      "apiKey": "lm-studio",
      "model": "local-model"
    }
  ]
}
```

Command adapters run in the sandbox workspace by default. They receive a JSON payload on stdin and can use these argument templates:

- `{{task}}`: the original task prompt
- `{{prompt}}`: the full conversation transcript
- `{{sandbox}}`: the current sandbox path

By default a command should return a SandEval JSON response:

```json
{
  "content": "optional assistant text",
  "toolCalls": [
    {
      "id": "call_1",
      "name": "write_file",
      "arguments": {
        "path": "index.js",
        "content": "console.log('hello')"
      }
    }
  ],
  "usage": {
    "inputTokens": 100,
    "outputTokens": 20
  }
}
```

Use `protocol: "plain-final"` for commands that produce a final text answer instead of tool calls. In that mode, SandEval still captures any files the command writes inside the sandbox.

Command models can also set `workflowAdapter` to parse external agent CLI output into SandEval workflow events:

```json
{
  "kind": "command",
  "name": "codex-cli",
  "command": "codex",
  "args": ["exec", "--json", "{{task}}"],
  "protocol": "plain-final",
  "workflowAdapter": "codex"
}
```

Supported adapters are `codex`, `claude-code`, `jsonl`, and `none`. The Codex and Claude Code adapters recognize common JSON/JSONL event streams, including assistant messages, tool calls, shell commands, file changes, results, and errors. Parsed events are shown in the TUI Workflow view and saved in JSON/Markdown reports together with the raw stdout/stderr artifact.

## Codex / Claude Code Login

Command models can define auth commands:

```json
{
  "name": "codex-cli",
  "kind": "command",
  "command": "codex",
  "args": ["exec", "--json", "{{task}}"],
  "protocol": "plain-final",
  "auth": {
    "type": "command",
    "loginCommand": "codex",
    "loginArgs": ["login"],
    "checkCommand": "codex",
    "checkArgs": ["--version"]
  }
}
```

Run `sandeval login codex-cli` to launch the configured login flow.

To use a logged-in tool only as a token source for a normal API provider, configure `auth.type: "command-token"` instead of `kind: "command"`:

```json
{
  "name": "anthropic",
  "provider": "anthropic",
  "kind": "anthropic-compatible",
  "baseUrl": "https://api.anthropic.com",
  "model": "claude-sonnet-4-5",
  "modelIds": ["claude-sonnet-4-5", "claude-opus-4-1"],
  "auth": {
    "type": "command-token",
    "tokenCommand": "claude",
    "tokenArgs": ["auth", "token"]
  }
}
```

The token command must print the token on stdout. Codex-backed GPT access can be configured the same way with a command that prints a Codex credential token.

## Contexts

Contexts let an existing project participate in a task without modifying the original files. Selected context files are copied into the run sandbox under `@context/<name>` and summarized in the prompt.

```json
{
  "contexts": [
    {
      "name": "workspace",
      "path": ".",
      "exclude": ["node_modules", "dist", ".git", ".sandeval", "package-lock.json"],
      "maxFiles": 40,
      "maxFileBytes": 12000
    }
  ]
}
```

Use `@workspace` in a prompt or select it in the TUI.

## Custom Provider

Use `kind: "custom"` to load a provider module:

```json
{
  "name": "my-provider",
  "kind": "custom",
  "model": "my-provider",
  "modulePath": "./sandeval-provider.js",
  "exportName": "createProvider",
  "options": {}
}
```

The module should export `createProvider(config)` and return `{ chat(request) }`, where `chat` returns `{ content, toolCalls, usage }`.

## Storage

Filesystem storage writes a JSONL index for history:

```json
{
  "storage": {
    "kind": "filesystem",
    "root": ".sandeval/storage",
    "indexFile": "runs.jsonl"
  }
}
```

Custom storage modules can export `createStorage(config)` returning `saveRun(report)`, `saveArena(report)`, and `listRuns(limit)`.
Filesystem history can reopen saved JSON reports from the TUI history screen with Enter.

## Sandbox Notes

`sandbox.mode: "local"` runs commands in an isolated run directory under `.sandeval/runs`, with all model file operations confined to that directory. Local mode is convenient, but commands still run as normal host processes. For stronger command isolation, choose one of the optional open-source sandbox backends:

- `docker`: runs commands in a Docker container.
- `podman`: runs commands in a Podman container.
- `bubblewrap`: runs commands through Bubblewrap (`bwrap`) on Linux.
- `firejail`: runs commands through Firejail on Linux.
- `nsjail`: runs commands through nsjail on Linux.
- `external`: runs commands through your own sandbox adapter command.

All modes keep the same SandEval run directory, context copying, and artifact packaging flow. Container modes mount only the run directory at `/workspace` and disable network by default:

```json
{
  "sandbox": {
    "mode": "docker",
    "dockerImage": "node:22-bookworm",
    "network": false
  },
  "tools": {
    "files": true,
    "shell": true,
    "git": "full",
    "gitRemote": false,
    "packageManager": true
  }
}
```

Docker can also use gVisor's `runsc` runtime when it is installed and registered with Docker:

```json
{
  "sandbox": {
    "mode": "docker",
    "dockerImage": "node:22-bookworm",
    "dockerRuntime": "runsc",
    "network": false
  }
}
```

Podman uses the same `/workspace` contract:

```json
{
  "sandbox": {
    "mode": "podman",
    "podmanImage": "node:22-bookworm",
    "network": false
  }
}
```

External sandbox mode lets a third-party runner execute commands while SandEval still owns the run workspace and artifact collection:

```json
{
  "sandbox": {
    "mode": "external",
    "external": {
      "command": "my-sandbox-runner",
      "args": ["--workspace", "{{workspace}}", "--", "{{command}}", "{{args}}"]
    }
  }
}
```

The runner may either proxy stdout/stderr directly or return JSON with `exitCode`, `stdout`, `stderr`, `durationMs`, and `timedOut`.

## Plan And Scoring

Plan mode is controlled by `agent.planMode`:

```json
{
  "agent": {
    "planMode": "prompt",
    "planApproval": "auto"
  }
}
```

Use `enforced` to run a separate planning call before development. `planApproval: "interactive"` asks for approval in interactive CLI flows; non-interactive runs should use `auto`.

Scoring defaults to weighted dimensions and still writes the weighted overall score to the legacy `score` field:

```json
{
  "scoring": {
    "mode": "multi",
    "maxRetries": 2,
    "dimensions": [
      { "key": "taskSatisfaction", "label": "Task", "weight": 30 },
      { "key": "correctness", "label": "Correctness", "weight": 25 },
      { "key": "runnability", "label": "Runnable", "weight": 15 },
      { "key": "codeQuality", "label": "Quality", "weight": 15 },
      { "key": "workflowQuality", "label": "Workflow", "weight": 10 },
      { "key": "userFeedbackImpact", "label": "Feedback", "weight": 5 }
    ]
  }
}
```

Judge scoring asks providers for structured JSON when supported and retries invalid judge output before failing. Arena scoring records one judge score per participating model result.

## Tool Permissions

`sandbox` controls where commands run. `tools` controls what the agent may do:

```json
{
  "tools": {
    "files": true,
    "shell": true,
    "git": "full",
    "gitRemote": false,
    "packageManager": true,
    "maxCommandTimeoutMs": 120000,
    "blockedCommands": ["shutdown", "reboot"]
  }
}
```

`git: "full"` allows local sandbox Git operations such as `init`, `add`, `commit`, branch creation, tags, diffs, logs, and shows. Remote Git commands stay disabled unless `gitRemote` is true, and destructive commands such as `git reset --hard`, forced `git clean`, and non-branch-creation checkout/switch are blocked.

## Rules and Skills

Rules are run-level behavior constraints injected into the agent system prompt and recorded in reports:

```json
{
  "rules": [
    {
      "name": "verify-before-finish",
      "enabled": true,
      "prompt": "Before finishing, run the most relevant verification command when possible."
    }
  ]
}
```

Skills are Markdown instruction packs explicitly triggered in the task with `@skill:name` or `@skill:{name}`. SandEval loads built-in Skills first, then `~/.sandeval/skills/*.md`, then project-local `.sandeval/skills/*.md`; later sources override earlier ones by `name`.

```md
---
name: frontend-ui
description: Build polished frontend and terminal UI experiences.
---

Instructions for this skill...
```

Unknown `@skill` mentions fail the run instead of being silently ignored.

For Linux host sandbox tools, install the selected binary and set `sandbox.mode` to `bubblewrap`, `firejail`, or `nsjail`. You can pass backend-specific flags with `sandboxExtraArgs`:

```json
{
  "sandbox": {
    "mode": "bubblewrap",
    "network": false,
    "sandboxExtraArgs": ["--hostname", "sandeval"]
  }
}
```

`nsjail` also requires an absolute root filesystem path. SandEval bind-mounts the run directory into that rootfs at `/workspace`:

```json
{
  "sandbox": {
    "mode": "nsjail",
    "nsjailRootfs": "/opt/sandeval-rootfs",
    "network": false
  }
}
```
