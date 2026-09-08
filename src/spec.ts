/**
 * Does a skill conform to the Agent Skills specification?
 *
 * A skill that pi loads is not a skill that is well-formed. pi is forgiving:
 * it will happily load a SKILL.md whose name disagrees with its directory, or
 * whose description is a paragraph nobody will read, or which carries
 * frontmatter fields the spec does not define. Those load fine here and break
 * somewhere else — another host, a validator, a share.
 *
 * The rules are the spec's, restated (https://agentskills.io/specification): a
 * closed field set, a name matching its directory, and the length limits. Zero
 * dependencies, no network, no YAML parser — nested mappings are read as
 * present-but-unparsed, which is all the field checks need.
 */

export const ALLOWED_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_COMPATIBILITY = 500;
/** The spec's guidance rather than a hard rule: past this, split into references/. */
export const BODY_LINE_GUIDANCE = 500;

export interface Problem {
  /** Errors break the spec; warnings are its guidance. */
  level: "error" | "warning";
  message: string;
}

/**
 * Frontmatter as flat key/value pairs. A nested mapping records its key with
 * an empty value — enough to know the field is present, which is all the
 * closed-field-set check asks.
 */
export function readFrontmatter(text: string): Record<string, string> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    // Indented lines belong to the mapping above; the key itself is recorded.
    if (/^\s/.test(line) || line.trim() === "") continue;
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (pair) fields[pair[1]!] = pair[2]!.trim();
  }
  return fields;
}

/** Everything after the frontmatter block. */
export function body(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Check one skill. `directory` is the name of the folder holding SKILL.md,
 * which the spec requires the `name` field to match.
 */
export function checkSkill(text: string, directory: string): Problem[] {
  const problems: Problem[] = [];
  const fields = readFrontmatter(text);
  if (!fields) {
    return [{ level: "error", message: "no YAML frontmatter block" }];
  }

  for (const key of Object.keys(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      problems.push({
        level: "error",
        message: `unknown frontmatter field "${key}" — the spec's field set is closed`,
      });
    }
  }

  const name = unquote(fields.name ?? "");
  if (!name) {
    problems.push({ level: "error", message: "missing required field: name" });
  } else {
    if (!NAME_RE.test(name)) {
      problems.push({ level: "error", message: `name "${name}" is not lowercase-hyphenated` });
    }
    if (name.length > MAX_NAME) {
      problems.push({ level: "error", message: `name is ${name.length} characters, over the ${MAX_NAME} limit` });
    }
    if (directory && name !== directory) {
      problems.push({
        level: "error",
        message: `name "${name}" does not match its directory "${directory}"`,
      });
    }
  }

  // A description is how the model decides whether to fire the skill, so an
  // empty one is not a formality — it is a skill that can never be chosen.
  const description = unquote(fields.description ?? "");
  if (!description) {
    problems.push({ level: "error", message: "missing required field: description" });
  } else if (description.length > MAX_DESCRIPTION) {
    problems.push({
      level: "error",
      message: `description is ${description.length} characters, over the ${MAX_DESCRIPTION} limit`,
    });
  }

  const compatibility = unquote(fields.compatibility ?? "");
  if (compatibility.length > MAX_COMPATIBILITY) {
    problems.push({
      level: "error",
      message: `compatibility is ${compatibility.length} characters, over the ${MAX_COMPATIBILITY} limit`,
    });
  }

  const lines = body(text).split(/\r?\n/).length;
  if (lines > BODY_LINE_GUIDANCE) {
    problems.push({
      level: "warning",
      message: `body is ${lines} lines; past ${BODY_LINE_GUIDANCE} the spec suggests splitting into references/`,
    });
  }

  return problems;
}

export function worst(problems: readonly Problem[]): "error" | "warning" | "ok" {
  if (problems.some((p) => p.level === "error")) return "error";
  if (problems.length > 0) return "warning";
  return "ok";
}
