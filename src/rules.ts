import type { AppliedRule, RuleConfig, SandEvalConfig } from "./types.js";

export function activeRules(config: SandEvalConfig): RuleConfig[] {
  return (config.rules ?? []).filter((rule) => rule.enabled !== false);
}

export function appliedRules(config: SandEvalConfig): AppliedRule[] {
  return activeRules(config).map((rule) => ({
    name: rule.name,
    description: rule.description
  }));
}

export function renderRulesSystemPrompt(config: SandEvalConfig): string {
  const rules = activeRules(config);
  if (rules.length === 0) {
    return "";
  }

  return [
    "----- SANDEVAL ACTIVE RULES -----",
    "Follow these run-level rules. They are behavioral constraints, not user task content.",
    ...rules.flatMap((rule) => [`## ${rule.name}`, rule.description ? `Description: ${rule.description}` : "", rule.prompt, ""])
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeRules(config: SandEvalConfig): string {
  const rules = activeRules(config);
  return rules.length ? `rules ${rules.length}` : "rules off";
}
