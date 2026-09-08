/**
 * Which skills ever fire.
 *
 * A collection you subscribed to is a bet: these forty things will be useful.
 * Nothing checks the bet. The ones that never match a task keep paying rent in
 * the system prompt anyway, and the only way anyone finds out is by reading
 * their own transcripts.
 *
 * A skill fires in exactly two ways, and both are observable from an
 * extension. pi's prompt tells the model to *read the skill's file* when the
 * task matches, so a `read` of that path is a model invocation. And `/skill:name`
 * is the explicit one. Counting those two is counting all of them.
 *
 * Pure: the ledger and what counts. The extension owns the disk and the clock.
 */

export interface Firing {
  /** Skill name. */
  name: string;
  /** How it was invoked. */
  by: "model" | "command";
  at: number;
}

export interface SkillUsage {
  count: number;
  lastAt: number;
  byModel: number;
  byCommand: number;
}

export type Ledger = Record<string, SkillUsage>;

export function emptyLedger(): Ledger {
  return {};
}

/** Tolerate anything on disk: a corrupt ledger means "nothing recorded yet". */
export function parseLedger(raw: string | null): Ledger {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return {};
    const out: Ledger = {};
    for (const [name, value] of Object.entries(data as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const count = typeof v.count === "number" && v.count >= 0 ? Math.floor(v.count) : 0;
      if (count === 0) continue;
      out[name] = {
        count,
        lastAt: typeof v.lastAt === "number" ? v.lastAt : 0,
        byModel: typeof v.byModel === "number" && v.byModel >= 0 ? Math.floor(v.byModel) : 0,
        byCommand: typeof v.byCommand === "number" && v.byCommand >= 0 ? Math.floor(v.byCommand) : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function record(ledger: Ledger, firing: Firing): Ledger {
  const previous = ledger[firing.name] ?? { count: 0, lastAt: 0, byModel: 0, byCommand: 0 };
  return {
    ...ledger,
    [firing.name]: {
      count: previous.count + 1,
      lastAt: Math.max(previous.lastAt, firing.at),
      byModel: previous.byModel + (firing.by === "model" ? 1 : 0),
      byCommand: previous.byCommand + (firing.by === "command" ? 1 : 0),
    },
  };
}

function samePath(a: string, b: string): boolean {
  return a.replaceAll("\\", "/").toLowerCase() === b.replaceAll("\\", "/").toLowerCase();
}

/**
 * Whether a `read` was a skill invocation, and of which skill.
 *
 * Only the skill's own file counts. A skill directory can hold references,
 * scripts and examples the skill tells the model to read *after* it has been
 * invoked; counting those would inflate a skill's tally by however many
 * supporting files its author happened to split it into.
 */
export function skillForRead(
  path: string,
  skills: ReadonlyArray<{ name: string; filePath: string }>,
): string | null {
  for (const skill of skills) {
    if (samePath(path, skill.filePath)) return skill.name;
  }
  return null;
}

/** `/skill:name`, with or without arguments after it. */
export function skillForCommand(text: string): string | null {
  const match = /^\s*\/skill:([A-Za-z0-9._-]+)/.exec(text);
  return match?.[1] ?? null;
}

export interface UsageRow {
  name: string;
  usage: SkillUsage | null;
  /** Prompt cost, so the two halves can be read together. */
  chars: number;
  hidden: boolean;
}

/**
 * Every known skill, used or not — the unused ones are the point, so they can
 * never be left out of the answer.
 */
export function usageRows(
  skills: ReadonlyArray<{ name: string; chars: number; hidden: boolean }>,
  ledger: Ledger,
): UsageRow[] {
  return skills
    .map((skill) => ({
      name: skill.name,
      usage: ledger[skill.name] ?? null,
      chars: skill.chars,
      hidden: skill.hidden,
    }))
    .sort((a, b) => (b.usage?.count ?? 0) - (a.usage?.count ?? 0) || b.chars - a.chars || a.name.localeCompare(b.name));
}

/** Skills that have never fired, costliest first: the bill for an unused bet. */
export function neverFired(rows: readonly UsageRow[]): UsageRow[] {
  return rows.filter((row) => row.usage === null && !row.hidden);
}
