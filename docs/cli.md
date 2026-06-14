# CLI Reference

## Commands

### `sandeval init`

Initialize a new SandEval project by creating `.sandeval/config.json`.

```bash
sandeval init
```

### `sandeval config`

Manage configuration.

```bash
sandeval config wizard          # Interactive setup
sandeval config show            # Display current config
sandeval config get <path>      # Get a config value
sandeval config set <path> <value>  # Set a config value
```

### `sandeval login`

Authenticate with a provider.

```bash
sandeval login codex-cli
sandeval login claude-code
```

### `sandeval auth`

Check authentication status.

```bash
sandeval auth
```

### `sandeval run`

Execute a single task.

```bash
sandeval run task.md --model openai/gpt-5.4
sandeval run --prompt "Build a CLI calculator" --review "Works, but lacks tests"
sandeval run --prompt "Test" --model mock/mock-agent --no-score --json
```

Options:
- `--model <model>` - Model to use
- `--judge <model>` - Judge model for scoring
- `--review <text>` - Human feedback
- `--no-score` - Skip scoring
- `--json` - Output raw JSON
- `--max-turns <n>` - Max agent turns

### `sandeval arena`

Run multiple models on the same task.

```bash
sandeval arena task.md --models openai/gpt-5.4,anthropic/claude-sonnet-4-5
sandeval arena --prompt "Build a Vite app" --concurrency 2
```

Options:
- `--models <list>` - Comma-separated model list
- `--concurrency <n>` - Parallel runs (default: 1)

### `sandeval history`

View run history.

```bash
sandeval history
```

### `sandeval score-index`

Generate a model score dashboard.

```bash
sandeval score-index openai/gpt-5.4
sandeval score-index openai/gpt-5.4 --output-dir reports --json
```

### `sandeval tui`

Launch the interactive TUI.

```bash
sandeval tui
```

### `sandeval web`

Launch the web UI.

```bash
sandeval web
sandeval web --port 8790 --host 127.0.0.1
```

## Task Files

Task files are Markdown files describing the coding task:

```md
Create a small Node.js program named `haiku.js`.

Requirements:
- Print a three-line haiku about sandboxes.
- Add a `package.json` script named `start`.
- Run the program and report the output.
```

## Context Mentions

Use `@contextname` in prompts to attach project contexts:

```bash
sandeval run --prompt "@workspace Build a login page"
```

## Skill Mentions

Use `@skill:name` to attach skills:

```bash
sandeval run --prompt "@skill:frontend-ui Build a dashboard"
```
