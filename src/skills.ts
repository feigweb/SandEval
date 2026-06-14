import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AppliedSkill, SandEvalConfig } from "./types.js";

export interface SkillDefinition {
  name: string;
  description?: string;
  instructions: string;
  source: "builtin" | "local" | "global";
  path?: string;
  tags?: string[];
  triggers?: string[];
}

const BUILTIN_SKILLS: SkillDefinition[] = [
  {
    name: "verification",
    description: "Choose and run a relevant verification command before finishing.",
    source: "builtin",
    instructions:
      "Identify the smallest relevant verification command for the artifact, run it when possible, and report the result. If no command is available, state the reason clearly."
  },
  {
    name: "tui-design",
    description: "Improve terminal UI workflows with keyboard-first interaction.",
    source: "builtin",
    instructions:
      "Design terminal UI flows around keyboard-first operation, concise status lines, predictable escape/back behavior, and clear live feedback for long-running work."
  },
  {
    name: "codex-workflow",
    description: "Account for Codex CLI style coding-agent workflows.",
    source: "builtin",
    instructions:
      "When evaluating or invoking Codex-style workflows, preserve task context, capture command output and artifacts, and summarize file changes, verification, and final status."
  },
  {
    name: "claude-code-workflow",
    description: "Account for Claude Code style coding-agent workflows.",
    source: "builtin",
    instructions:
      "When evaluating or invoking Claude Code style workflows, preserve the transcript, capture tool-like actions when available, and summarize planning, commands, file changes, and final status."
  }
];

export function extractSkillMentions(prompt: string): string[] {
  const names: string[] = [];
  for (const match of prompt.matchAll(/@skill:\{([^}]+)\}|@skill:([a-zA-Z0-9_.-]+)/g)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    if (name && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

export async function listSkills(config: SandEvalConfig, cwd: string): Promise<SkillDefinition[]> {
  const skills = new Map<string, SkillDefinition>();
  for (const skill of BUILTIN_SKILLS) {
    skills.set(skill.name, skill);
  }
  for (const skill of await readSkillDir(resolveGlobalSkillDir(config))) {
    skills.set(skill.name, { ...skill, source: "global" });
  }
  for (const skill of await readSkillDir(resolveLocalSkillDir(config, cwd))) {
    skills.set(skill.name, { ...skill, source: "local" });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveMentionedSkills(config: SandEvalConfig, cwd: string, prompt: string): Promise<SkillDefinition[]> {
  const names = extractSkillMentions(prompt);
  if (names.length === 0) {
    return [];
  }

  const skills = await listSkills(config, cwd);
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return names.map((name) => {
    const skill = byName.get(name);
    if (!skill) {
      throw new Error(`Skill "${name}" not found.`);
    }
    return skill;
  });
}

export function appliedSkills(skills: SkillDefinition[]): AppliedSkill[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    source: skill.source
  }));
}

export function renderSkillsTaskBlock(skills: SkillDefinition[]): string {
  if (skills.length === 0) {
    return "";
  }

  return [
    "----- SANDEVAL SKILLS -----",
    "The following skills were explicitly selected by the user with @skill mentions. Use them as task-level workflow guidance.",
    ...skills.flatMap((skill) => [
      `## @skill:${skill.name}`,
      skill.description ? `Description: ${skill.description}` : "",
      skill.instructions,
      ""
    ])
  ]
    .filter(Boolean)
    .join("\n");
}

async function readSkillDir(dir: string | undefined): Promise<SkillDefinition[]> {
  if (!dir || !existsSync(dir)) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && /\.md$/i.test(entry.name));
  const skills: SkillDefinition[] = [];
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    const content = await readFile(fullPath, "utf8");
    skills.push(parseSkillMarkdown(content, fullPath));
  }
  return skills;
}

function parseSkillMarkdown(content: string, filePath: string): SkillDefinition {
  const parsed = parseFrontmatter(content);
  const name = String(parsed.attributes.name ?? "").trim();
  if (!name) {
    throw new Error(`Skill file ${filePath} is missing required frontmatter field "name".`);
  }
  return {
    name,
    description: optionalString(parsed.attributes.description),
    instructions: parsed.body.trim(),
    source: "local",
    path: filePath,
    tags: optionalStringList(parsed.attributes.tags),
    triggers: optionalStringList(parsed.attributes.triggers)
  };
}

function parseFrontmatter(content: string): { attributes: Record<string, unknown>; body: string } {
  if (!content.startsWith("---\n")) {
    return { attributes: {}, body: content };
  }
  const end = content.indexOf("\n---", 4);
  if (end === -1) {
    return { attributes: {}, body: content };
  }
  const raw = content.slice(4, end).trim();
  const body = content.slice(end + 4).replace(/^\r?\n/, "");
  const attributes: Record<string, unknown> = {};
  let currentList: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && currentList) {
      const current = attributes[currentList];
      attributes[currentList] = Array.isArray(current) ? [...current, listItem[1].trim()] : [listItem[1].trim()];
      continue;
    }

    const pair = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!pair) {
      currentList = undefined;
      continue;
    }
    const key = pair[1];
    const value = pair[2].trim();
    if (value === "") {
      attributes[key] = [];
      currentList = key;
    } else {
      attributes[key] = stripQuotes(value);
      currentList = undefined;
    }
  }
  return { attributes, body };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.map(String).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function resolveLocalSkillDir(config: SandEvalConfig, cwd: string): string {
  const localDir = config.skills?.localDir ?? ".sandeval/skills";
  return path.isAbsolute(localDir) ? localDir : path.resolve(cwd, localDir);
}

function resolveGlobalSkillDir(config: SandEvalConfig): string {
  const globalDir = config.skills?.globalDir ?? "~/.sandeval/skills";
  if (globalDir.startsWith("~/")) {
    return path.join(process.env.HOME ?? "", globalDir.slice(2));
  }
  return path.resolve(globalDir);
}
