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
 * Mostly pure — the ledger and what counts — plus one guarded write:
 * `commitLedger` folds a session's firings into whatever is already on disk and
 * swaps the file atomically, so two sessions never clobber each other's counts.
 * The extension still owns the clock and decides *when* to save.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve, win32 } from "node:path";

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

/**
 * Combine two ledgers without losing either side's counts: sum every tally and
 * keep the newest time. Folding the on-disk ledger into a session's pending
 * firings this way is what stops two concurrent sessions — or a save after a
 * crash — from erasing each other, since the counts add up instead of the last
 * writer winning. Inputs are left untouched.
 */
export function mergeLedgers(a: Ledger, b: Ledger): Ledger {
  const out: Ledger = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[name];
    const y = b[name];
    if (x && y) {
      out[name] = {
        count: x.count + y.count,
        lastAt: Math.max(x.lastAt, y.lastAt),
        byModel: x.byModel + y.byModel,
        byCommand: x.byCommand + y.byCommand,
      };
    } else {
      out[name] = { ...(x ?? y)! };
    }
  }
  return out;
}

/**
 * Fold a session's uncommitted firings into the shared ledger file and swap it
 * in atomically.
 *
 * Re-reading the file first — rather than writing an in-memory copy whole —
 * means whatever another session committed since this one loaded is summed in,
 * not overwritten. The write goes to a temp file and is renamed over the
 * target, so a crash mid-write leaves the previous ledger intact instead of a
 * truncated one.
 *
 * Returns the merged ledger so the caller can adopt it as its in-memory view
 * and clear its pending delta. Throws only if the write itself fails; the
 * caller keeps its pending delta and retries on the next save.
 */
export function commitLedger(file: string, pending: Ledger): Ledger {
  let onDisk: Ledger = {};
  try {
    onDisk = parseLedger(readFileSync(file, "utf8"));
  } catch {
    // A missing or unreadable ledger is "nothing recorded yet", not a failure.
    onDisk = {};
  }
  const merged = mergeLedgers(onDisk, pending);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(tmp, file);
  return merged;
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
  cwd?: string,
): string | null {
  // The model may read a skill by a path relative to the project root; resolve
  // it against cwd first so it can match the absolute path pi loaded the skill
  // from. A path already absolute under either OS's rules — POSIX "/…" or
  // Windows "C:\…" / "\…" — is left untouched, so a Windows-style absolute path
  // still matches when the tests (or CI) run on POSIX.
  const abs =
    win32.isAbsolute(path) || posix.isAbsolute(path) ? path : resolve(cwd ?? "", path);
  for (const skill of skills) {
    if (samePath(abs, skill.filePath)) return skill.name;
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
