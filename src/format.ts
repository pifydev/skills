/**
 * Rendering. Every number here is measured elsewhere; this only decides how to
 * say it — and the framing matters, because "4.1k tokens" means nothing until
 * it says *on every request*.
 */

import type { Inventory, SkillCost } from "./inventory.ts";
import { bySource } from "./inventory.ts";
import type { Ledger, UsageRow } from "./ledger.ts";
import { neverFired, usageRows } from "./ledger.ts";
import type { Problem } from "./spec.ts";
import type { Dangling, Shadowed } from "./graph.ts";

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function ago(now: number, then: number): string {
  if (then <= 0) return "never";
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/** The headline: what the whole surface costs, and how much of it earns that. */
export function formatOverview(inventory: Inventory, ledger: Ledger, now: number): string {
  if (inventory.costs.length === 0) {
    return "No skills loaded. pi reads them from .pi/skills and <agentDir>/skills.";
  }
  const rows = usageRows(inventory.costs, ledger);
  const unused = neverFired(rows);
  const wasted = unused.reduce((sum, row) => sum + row.chars, 0);

  const lines = [
    `${inventory.visible} skill${inventory.visible === 1 ? "" : "s"} in the system prompt` +
      (inventory.hidden > 0 ? ` (+${inventory.hidden} hidden from the model)` : "") +
      `, ${formatTokens(inventory.totalTokens)} tokens on every request.`,
  ];

  if (unused.length > 0) {
    lines.push(
      `${unused.length} of them ${unused.length === 1 ? "has" : "have"} never fired, costing ` +
        `${formatTokens(Math.ceil(wasted / 4))} tokens per request for nothing.`,
    );
  }

  lines.push("", "By source:");
  for (const group of bySource(inventory)) {
    lines.push(`  ${group.source.padEnd(10)} ${String(group.count).padStart(3)} skills  ${formatTokens(Math.ceil(group.chars / 4)).padStart(7)}`);
  }

  lines.push("", "Most used:");
  const top = rows.filter((r) => r.usage !== null).slice(0, 5);
  if (top.length === 0) {
    lines.push("  (nothing has fired yet — the count starts when this extension is installed)");
  } else {
    for (const row of top) {
      lines.push(
        `  ${row.name.padEnd(24)} ${String(row.usage?.count ?? 0).padStart(4)}×  last ${ago(now, row.usage?.lastAt ?? 0)}`,
      );
    }
  }
  lines.push("", "/skills cost · /skills unused · /skills check");
  return lines.join("\n");
}

/** Costliest first, because that is the order you would remove them in. */
export function formatCost(inventory: Inventory): string {
  if (inventory.costs.length === 0) return "No skills loaded.";
  const lines = [
    `The skills block is ${formatTokens(inventory.totalTokens)} tokens (${inventory.totalChars} chars), sent with every request.`,
    "",
  ];
  for (const cost of inventory.costs) {
    lines.push(
      cost.hidden
        ? `  ${"—".padStart(7)}  ${cost.name}  (hidden from the model: costs nothing)`
        : `  ${formatTokens(cost.tokens).padStart(7)}  ${cost.name}`,
    );
  }
  if (inventory.overheadChars > 0) {
    lines.push(
      "",
      `Plus ${formatTokens(Math.ceil(inventory.overheadChars / 4))} tokens of framing, charged once however many skills you have.`,
    );
  }
  return lines.join("\n");
}

/** The bet that did not pay: never fired, costliest first. */
export function formatUnused(inventory: Inventory, ledger: Ledger): string {
  const rows = usageRows(inventory.costs, ledger);
  const unused = neverFired(rows).sort((a, b) => b.chars - a.chars);
  if (unused.length === 0) {
    return rows.length === 0 ? "No skills loaded." : "Every loaded skill has fired at least once.";
  }
  const wasted = unused.reduce((sum, row) => sum + row.chars, 0);
  return [
    `${unused.length} skill${unused.length === 1 ? "" : "s"} ${unused.length === 1 ? "has" : "have"} never fired, ` +
      `together ${formatTokens(Math.ceil(wasted / 4))} tokens on every request:`,
    "",
    ...unused.map((row) => `  ${formatTokens(Math.ceil(row.chars / 4)).padStart(7)}  ${row.name}`),
    "",
    "Never firing is not the same as useless — a skill for a rare job earns its place by being there when it happens.",
    "It is a prompt to look, not a verdict.",
  ].join("\n");
}

export interface CheckedSkill {
  name: string;
  filePath: string;
  problems: Problem[];
}

export function formatCheck(
  checked: readonly CheckedSkill[],
  dangling: readonly Dangling[] = [],
  shadowed: readonly Shadowed[] = [],
): string {
  if (checked.length === 0) return "No skills loaded, so there is nothing to check.";
  const bad = checked.filter((c) => c.problems.length > 0);
  const lines: string[] = [];

  for (const skill of bad) {
    lines.push(`${skill.name} — ${skill.filePath}`);
    for (const problem of skill.problems) {
      lines.push(`  ${problem.level === "error" ? "error  " : "warning"} ${problem.message}`);
    }
  }

  // A skill telling the model to use something that is not installed is not a
  // malformed file — every one of these passes the spec — so it gets its own
  // section rather than being buried among frontmatter complaints.
  if (dangling.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("References to skills that are not installed:");
    for (const entry of dangling) {
      lines.push(`  ${entry.from} → ${entry.missing.join(", ")}`);
    }
    lines.push(
      "  Collections are written whole and handed out one skill at a time. The instruction",
      "  survives the trip; its target does not, and the model is told to use it anyway.",
    );
  }

  if (shadowed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Shadowed by a name collision — pi kept one and dropped the other:");
    for (const entry of shadowed) {
      lines.push(`  ${entry.name}`, `    kept    ${entry.winner}`, `    dropped ${entry.loser}`);
    }
  }

  if (lines.length === 0) {
    return (
      `${checked.length} skill${checked.length === 1 ? "" : "s"} conform to the Agent Skills specification, ` +
      "with every reference resolving."
    );
  }

  const errors = bad.filter((c) => c.problems.some((p) => p.level === "error")).length;
  lines.push(
    "",
    `${checked.length} checked · ${errors} with errors · ${bad.length - errors} with warnings only` +
      (dangling.length > 0 ? ` · ${dangling.length} with unresolved references` : "") +
      (shadowed.length > 0 ? ` · ${shadowed.length} shadowed` : "") +
      ".",
  );
  return lines.join("\n");
}

export type SkillsRoute =
  | { kind: "overview" }
  | { kind: "cost" }
  | { kind: "unused" }
  | { kind: "check" }
  | { kind: "error"; message: string };

export function parseRoute(args: string): SkillsRoute {
  const route = args.trim().toLowerCase();
  if (route === "") return { kind: "overview" };
  if (route === "cost" || route === "tokens") return { kind: "cost" };
  if (route === "unused" || route === "never") return { kind: "unused" };
  if (route === "check" || route === "lint") return { kind: "check" };
  return { kind: "error", message: `Unknown route "${route}". Usage: /skills [cost | unused | check]` };
}

export type { SkillCost, UsageRow };
