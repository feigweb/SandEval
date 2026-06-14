# SandEval

CLI/TUI tool for evaluating coding agents in a sandboxed workspace.

A configured model receives a task, creates artifacts through tool calls, runs verification commands, and returns a report with artifacts, command output, token usage, and judge-model scoring.

## Features

- **Single or Arena** - Run one model or compare multiple models on the same task
- **Judge Scoring** - Automated scoring with configurable weighted dimensions
- **Sandbox Execution** - Local, Docker, Podman, bubblewrap, firejail, nsjail, or external
- **TUI & Web UI** - Interactive terminal UI with `Ctrl+K` command palette, or web interface
- **SDK** - Embed in Node.js applications
- **Multi-Provider** - OpenAI, Anthropic, Gemini, Ollama, LM Studio, command models, custom providers

## Quick Start

```bash
# Install and build
npm install
npm run build

# Initialize config
node dist/cli.js init

# Configure your provider
node dist/cli.js config wizard

# Run a task
node dist/cli.js run --prompt "Create a tiny Node script that prints a haiku"

# Launch TUI
node dist/cli.js tui

# Launch Web UI
node dist/cli.js web
```

## Documentation

| Document | Description |
|----------|-------------|
| [Configuration](docs/configuration.md) | Providers, sandbox, tools, scoring, and all config options |
| [CLI Reference](docs/cli.md) | All CLI commands and options |
| [SDK Usage](docs/sdk.md) | Programmatic usage in Node.js |
| [CHANGELOG](CHANGELOG.md) | Version history |
| [CONTRIBUTING](CONTRIBUTING.md) | How to contribute |

## Quick Examples

### Run a Task

```bash
sandeval run task.md --model openai/gpt-5.4 --judge openai/gpt-5.4
sandeval run --prompt "Build a CLI calculator" --review "Works, but lacks tests"
```

### Arena Comparison

```bash
sandeval arena task.md --models openai/gpt-5.4,anthropic/claude-sonnet-4-5
sandeval arena --prompt "Build a Vite app" --concurrency 2
```

### Score Dashboard

```bash
sandeval score-index openai/gpt-5.4
```

## Configuration

Set API keys as environment variables, then edit `.sandeval/config.json`:

```json
{
  "defaultModel": "openai/gpt-5.4",
  "models": [
    {
      "name": "openai",
      "kind": "openai-compatible",
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-5.4",
      "modelIds": ["gpt-5.4", "gpt-4.1"]
    }
  ]
}
```

Use `sandeval config wizard` for interactive setup, or see [Configuration](docs/configuration.md) for all options.

## License

Apache License 2.0
