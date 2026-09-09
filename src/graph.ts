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
  /** True when the author named these in metadata.requires rather than prose. */
  declared: boolean;
}

/**
 * References whose target is not among the loaded skills. The comparison is
 * against what pi actually loaded, not against what is on disk: a skill
 * shadowed by a name collision is missing as far as the model is concerned.
 */
export function danglingReferences(
  skills: ReadonlyArray<{ name: string; references: readonly string[]; requires?: readonly string[] }>,
  loadedNames: ReadonlySet<string>,
): Dangling[] {
  const out: Dangling[] = [];
  for (const skill of skills) {
    const requires = skill.requires ?? [];
    const missingDeclared = requires.filter((target) => !loadedNames.has(target));
    // A declared requirement is not also reported as a prose mention, or the
    // same fact would appear twice under two different confidences.
    const missingMentioned = skill.references.filter(
      (target) => !loadedNames.has(target) && !requires.includes(target),
    );
    if (missingDeclared.length > 0) out.push({ from: skill.name, missing: missingDeclared, declared: true });
    if (missingMentioned.length > 0) out.push({ from: skill.name, missing: missingMentioned, declared: false });
  }
  return out.sort(
    (a, b) =>
      Number(b.declared) - Number(a.declared) ||
      b.missing.length - a.missing.length ||
      a.from.localeCompare(b.from),
  );
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

/**
 * Dependencies a skill *declares*, rather than ones inferred from its prose.
 *
 * Scraping references out of sentences works and is guesswork: it cannot tell
 * a hard requirement from a passing mention, and it is tuned to be quiet
 * rather than complete. A manifest solves that by asking the author. The
 * Agent Skills specification has a closed field set, but `metadata` is its
 * sanctioned open one, so a declaration costs no deviation from the spec:
 *
 *   metadata:
 *     requires:
 *       - test-driven-development
 *       - writing-plans
 *
 * The idea is spec-kit's, whose extension manifests state `requires` and
 * `provides` instead of leaving a reader to infer them. What a declaration
 * buys here is precision: a declared dependency that is missing is a fact,
 * not a heuristic, and can be reported as an error without the risk of crying
 * wolf that keeps the prose extractor conservative.
 */
export function declaredRequires(frontmatter: string): string[] {
  const lines = frontmatter.split(/\r?\n/);
  const start = lines.findIndex((line) => /^metadata\s*:/.test(line));
  if (start === -1) return [];

  const found: string[] = [];
  const inline = /^metadata\s*:\s*\{?[^}]*\brequires\s*:\s*\[([^\]]*)\]/.exec(lines[start]!);
  if (inline) return names(inline[1]!.split(","));

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // A non-indented line ends the mapping.
    if (line.trim() !== "" && !/^\s/.test(line)) break;

    const flow = /^\s+requires\s*:\s*\[([^\]]*)\]/.exec(line);
    if (flow) return names(flow[1]!.split(","));

    if (/^\s+requires\s*:\s*$/.test(line)) {
      // A block sequence: the `- item` lines that follow, until the
      // indentation returns to a sibling key.
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+-\s*(.+)$/.exec(lines[j]!);
        if (!item) break;
        found.push(item[1]!);
      }
      return names(found);
    }
  }
  return [];
}

function names(raw: readonly string[]): string[] {
  const out = new Set<string>();
  for (const value of raw) {
    const name = value.trim().replace(/^["']|["']$/g, "").trim();
    // Same shape the rest of this module treats as a skill name.
    if (/^[a-z][a-z0-9-]*$/.test(name)) out.add(name);
  }
  return [...out].sort();
}
