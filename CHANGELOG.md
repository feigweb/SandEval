# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Context trimming feature for model requests (configurable via `agent.contextTrimmer`)
- Configurable max tokens (10,000 - 1,000,000 range)
- Code block truncation in conversation history
- Assistant reply truncation for older messages

### Changed
- Simplified README for better onboarding
- Added comprehensive documentation in `docs/`

## [0.1.0] - 2026-06-14

### Added
- Initial release
- CLI/TUI interface for evaluating coding agents
- Sandbox execution (local, Docker, Podman, bubblewrap, firejail, nsjail, external)
- Multi-model arena comparison
- Judge-based scoring with weighted dimensions
- SDK for programmatic usage
- Web UI with Bootstrap
- Ink-based TUI with `Ctrl+K` command palette
- Provider support: OpenAI, Anthropic, Gemini, Ollama, LM Studio, command models, custom providers
- Context and skill system
- Rule-based behavior constraints
- Artifact packaging and score dashboards
