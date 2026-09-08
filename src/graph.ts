/**
 * Skills that point at other skills.
 *
 * Collections are written whole and installed piecemeal. A skill says "use
 * the `test-driven-development` skill first" because in its own repository
 * that skill is right there — but the tooling around these collections hands
 * them out one at a time (`--skill NAME`, a copy of one directory), and the
 * instruction survives the trip while its target does not.
 *
 * Measured on a real published collection: 5 of its 15 skills name a sibling,
 * one of them naming six. Installed alone, every one of those references
 * points at something that is not there, and the model is told to invoke it
 * anyway. At least one author works around this by hand — "skip this section
 * entirely if the `triage` skill isn't installed" — which is the workaround
 * you write when nothing checks for you.
 *
 * Pure: extraction and resolution. Reading files belongs to the extension.
 */

/**
 * Reference forms this recognises, taken from what published collections
 * actually write rather than from a syntax anyone invented:
 *
 *   `namespace:skill-name`   — the plugin-qualified form
 *   `` `skill-name` skill``  — a backticked name followed by the word "skill"
 *
 * Deliberately not recognised: bare paths like `skills/foo`. In practice
 * those are relative links to documentation as often as they are references,
 * and a check that cries wolf is a check people learn to skip.
 */
const QUALIFIED = /\b([a-z][a-z0-9-]{2,}):([a-z][a-z0-9-]{2,})\b/g;
const BACKTICKED = /`([a-z][a-z0-9-]{2,})`\s+skill\b/g;

/**
 * Prefixes that are never a skill namespace, however much they look like one.
 * The language names are here because a fenced block can be opened with
 * ```json:metadata — measured on a real collection, which is where two of
 * these came from.
 */
const NOT_NAMESPACES = new Set([
  "http",
  "https",
  "file",
  "npm",
  "note",
  "warning",
  "example",
  "usage",
  "json",
  "yaml",
  "toml",
  "bash",
  "sh",
  "shell",
  "text",
  "diff",
  "dot",
  "mermaid",
]);

/**
 * Fenced code blocks are not prose, and a fence can be opened with a tag
 * shaped exactly like a reference. Removing them first is cheaper than
 * teaching every pattern to recognise where it is.
 */
function withoutFences(body: string): string {
  return body.replace(/^```[\s\S]*?^```/gm, "");
}

export interface Reference {
  /** The skill doing the referring. */
  from: string;
  /** The name it refers to. */
  to: string;
}

export function extractReferences(name: string, body: string): string[] {
  const found = new Set<string>();
  const prose = withoutFences(body);
  for (const match of prose.matchAll(QUALIFIED)) {
    const namespace = match[1]!;
    const target = match[2]!;
    if (NOT_NAMESPACES.has(namespace)) continue;
    if (target !== name) found.add(target);
  }
  for (const match of prose.matchAll(BACKTICKED)) {
    const target = match[1]!;
    if (target !== name) found.add(target);
  }
  return [...found].sort();
}

export interface Dangling {
  from: string;
  missing: string[];
}

/**
 * References whose target is not among the loaded skills. The comparison is
 * against what pi actually loaded, not against what is on disk: a skill
 * shadowed by a name collision is missing as far as the model is concerned.
 */
export function danglingReferences(
  skills: ReadonlyArray<{ name: string; references: readonly string[] }>,
  loadedNames: ReadonlySet<string>,
): Dangling[] {
  return skills
    .map((skill) => ({
      from: skill.name,
      missing: skill.references.filter((target) => !loadedNames.has(target)),
    }))
    .filter((entry) => entry.missing.length > 0)
    .sort((a, b) => b.missing.length - a.missing.length || a.from.localeCompare(b.from));
}

/**
 * A skill that lost a name collision. pi reports these as diagnostics and then
 * carries on with the winner, so without surfacing them a project's own skill
 * can be replaced by a global one of the same name with nothing said.
 */
export interface Shadowed {
  name: string;
  winner: string;
  loser: string;
}

export interface DiagnosticLike {
  type?: string;
  collision?: { resourceType?: string; name?: string; winnerPath?: string; loserPath?: string } | undefined;
}

export function shadowedSkills(diagnostics: readonly DiagnosticLike[]): Shadowed[] {
  const out: Shadowed[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.type !== "collision") continue;
    const collision = diagnostic.collision;
    if (!collision || collision.resourceType !== "skill") continue;
    if (!collision.name || !collision.winnerPath || !collision.loserPath) continue;
    out.push({ name: collision.name, winner: collision.winnerPath, loser: collision.loserPath });
  }
  return out;
}
