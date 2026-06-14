# Contributing to SandEval

Thank you for your interest in contributing to SandEval! This document provides guidelines and instructions for contributing.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```

## Development

### Build

```bash
npm run build
```

### Type Check

```bash
npm run typecheck
```

### Run

```bash
npm run dev
```

## Making Changes

1. Keep changes focused and minimal
2. Follow existing code style and patterns
3. Add tests for new functionality
4. Update documentation if needed
5. Write clear commit messages

## Pull Request Process

1. Update README.md with details of changes if applicable
2. Ensure the build passes
3. Create a pull request with a clear description
4. Link any related issues

## Code Style

- TypeScript strict mode
- No `any` types unless absolutely necessary
- No `console.log` in library code (CLI output is acceptable)
- Use descriptive variable and function names
- Keep functions small and focused

## Reporting Issues

- Use GitHub Issues
- Include reproduction steps
- Include expected vs actual behavior
- Include environment details (Node version, OS)

## License

By contributing, you agree that your contributions will be licensed under the Apache License 2.0.
