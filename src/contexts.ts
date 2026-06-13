import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ContextConfig, SandEvalConfig } from "./types.js";
import { truncate } from "./utils.js";

export function extractContextMentions(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((match) => match[1]).filter(Boolean))];
}

export function listContextNames(config: SandEvalConfig): string[] {
  return config.contexts?.map((context) => context.name) ?? [];
}

export async function buildTaskWithContexts(options: {
  config: SandEvalConfig;
  cwd: string;
  task: string;
  contextNames?: string[];
}): Promise<string> {
  const names = [...new Set([...(options.contextNames ?? []), ...extractContextMentions(options.task)])];
  if (names.length === 0) {
    return options.task;
  }

  const contexts = options.config.contexts?.filter((context) => names.includes(context.name)) ?? [];
  if (contexts.length === 0) {
    return options.task;
  }

  const rendered = await Promise.all(contexts.map((context) => renderContext(context, options.cwd)));
  return [
    options.task,
    "",
    "----- SANDEVAL CONTEXT -----",
    "The following project context was selected by the user. Use it to understand and modify existing code.",
    ...rendered
  ].join("\n");
}

export async function materializeContexts(options: {
  config: SandEvalConfig;
  cwd: string;
  sandboxRoot: string;
  task: string;
  contextNames?: string[];
}): Promise<string[]> {
  const names = [...new Set([...(options.contextNames ?? []), ...extractContextMentions(options.task)])];
  const contexts = options.config.contexts?.filter((context) => names.includes(context.name)) ?? [];
  const copied: string[] = [];
  for (const context of contexts) {
    const root = path.resolve(options.cwd, context.path);
    const files = await collectFiles(root, root, context);
    for (const file of files) {
      const source = path.join(root, file);
      const target = path.join(options.sandboxRoot, "@context", context.name, file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { force: true });
      copied.push(path.relative(options.sandboxRoot, target));
    }
  }
  return copied;
}

async function renderContext(context: ContextConfig, cwd: string): Promise<string> {
  const root = path.resolve(cwd, context.path);
  const files = await collectFiles(root, root, context);
  const sections = await Promise.all(
    files.map(async (file) => {
      const fullPath = path.join(root, file);
      const info = await stat(fullPath);
      if (info.size > (context.maxFileBytes ?? 12000) || !isText(file)) {
        return `### ${file}\n<${info.size} bytes, preview skipped>`;
      }
      const content = await readFile(fullPath, "utf8");
      return `### ${file}\n\`\`\`\n${truncate(content, context.maxFileBytes ?? 12000)}\n\`\`\``;
    })
  );

  return [
    "",
    `## @${context.name}`,
    context.description ? context.description : "",
    `Root: ${root}`,
    `Files included: ${files.length}`,
    ...sections
  ]
    .filter(Boolean)
    .join("\n");
}

async function collectFiles(root: string, current: string, context: ContextConfig, out: string[] = []): Promise<string[]> {
  if (out.length >= (context.maxFiles ?? 40)) {
    return out;
  }
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= (context.maxFiles ?? 40)) {
      break;
    }
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath);
    if (shouldExclude(relative, entry.name, context)) {
      continue;
    }
    if (entry.isDirectory()) {
      await collectFiles(root, fullPath, context, out);
      continue;
    }
    if (entry.isFile() && shouldInclude(relative, context) && isText(relative)) {
      out.push(relative);
    }
  }
  return out;
}

function shouldExclude(relative: string, basename: string, context: ContextConfig): boolean {
  const exclude = context.exclude ?? ["node_modules", "dist", ".git", ".sandeval", ".DS_Store", "package-lock.json"];
  if (basename === ".DS_Store" || basename.endsWith("-artifacts.tar.gz")) {
    return true;
  }
  return exclude.some((pattern) => relative === pattern || relative.startsWith(`${pattern}/`) || basename === pattern);
}

function shouldInclude(relative: string, context: ContextConfig): boolean {
  const include = context.include;
  if (!include?.length) {
    return true;
  }
  return include.some((pattern) => relative.includes(pattern) || relative.endsWith(pattern));
}

function isText(file: string): boolean {
  return /\.(txt|md|json|js|jsx|ts|tsx|mjs|cjs|css|html|py|rb|go|rs|java|kt|swift|sh|yaml|yml|toml|xml|sql|graphql)$/i.test(file);
}
