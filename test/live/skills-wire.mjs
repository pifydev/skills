/**
 * Does any of this survive contact with real skills?
 *
 * Every number this package reports rests on two claims about pi that a unit
 * test cannot check, because both belong to the host: `loadSkills` finds what
 * pi will actually load, and `formatSkillsForPrompt` builds the block pi
 * actually sends. If either is wrong the costs are fiction.
 *
 * So this loads real skill directories through pi's own functions and checks
 * the arithmetic against them — including the one property everything else
 * depends on: the per-skill shares plus the framing equal the whole block.
 *
 *   bun run test/live/skills-wire.mjs [--dir <skills-dir>]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { formatSkillsForPrompt, loadSkills } from "@earendil-works/pi-coding-agent";

import { buildInventory } from "../../src/inventory.ts";
import { checkSkill } from "../../src/spec.ts";
import { skillForRead } from "../../src/ledger.ts";
import { danglingReferences, extractReferences, shadowedSkills } from "../../src/graph.ts";

const NL = String.fromCharCode(10);
let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

const root = mkdtempSync(join(tmpdir(), "pify-skills-"));
const cwd = join(root, "project");
const agentDir = join(root, "agent");

function writeSkill(base, name, frontmatter, body = "# Title" + NL) {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---${NL}${frontmatter}${NL}---${NL}${body}`);
  return join(dir, "SKILL.md");
}

try {
  mkdirSync(join(cwd, ".pi", "skills"), { recursive: true });
  mkdirSync(join(agentDir, "skills"), { recursive: true });

  // Shapes taken from real published collections: a long routing description,
  // a short one, and a router hidden from model invocation.
  const bigPath = writeSkill(
    join(cwd, ".pi", "skills"),
    "code-review",
    "name: code-review" +
      NL +
      "description: " +
      JSON.stringify(
        "Review the changes since a fixed point along two axes: standards and spec. " +
          "Use when the user wants to review a branch, a PR, or work-in-progress changes.",
      ),
  );
  writeSkill(join(cwd, ".pi", "skills"), "tiny", "name: tiny" + NL + "description: A short one.");
  writeSkill(
    join(agentDir, "skills"),
    "ask-router",
    "name: ask-router" + NL + "description: A router over the other skills." + NL + "disable-model-invocation: true",
  );

  const loaded = loadSkills({ cwd, agentDir, skillPaths: [], includeDefaults: true });
  const names = loaded.skills.map((s) => s.name).sort();
  console.log(`loaded: ${names.join(", ")}`);
  check("pi's loader finds project and global skills", names.length === 3, names.join(", "));

  const inv = buildInventory(loaded.skills, (subset) => formatSkillsForPrompt(subset));
  console.log(
    `block: ${inv.totalChars} chars / ${inv.totalTokens} tokens · visible ${inv.visible} · hidden ${inv.hidden}`,
  );
  for (const c of inv.costs) console.log(`  ${String(c.chars).padStart(5)}  ${c.name}${c.hidden ? " (hidden)" : ""}`);

  check("the block is non-empty and measured, not estimated", inv.totalChars > 0, `${inv.totalChars} chars`);
  check(
    "a skill hidden from the model is charged nothing",
    inv.costs.find((c) => c.name === "ask-router")?.chars === 0 && inv.hidden === 1,
  );
  check(
    "the longer description costs more than the short one",
    (inv.costs.find((c) => c.name === "code-review")?.chars ?? 0) >
      (inv.costs.find((c) => c.name === "tiny")?.chars ?? 0),
  );

  // The property every reported number depends on.
  const shares = inv.costs.reduce((sum, c) => sum + c.chars, 0);
  check(
    "per-skill shares plus framing equal the whole block",
    shares + inv.overheadChars === inv.totalChars,
    `${shares} + ${inv.overheadChars} vs ${inv.totalChars}`,
  );

  // A skill fires when pi's prompt says it does: by reading the skill's file.
  const prompt = formatSkillsForPrompt(loaded.skills);
  check("pi still tells the model to read the skill file", /read tool to load a skill/i.test(prompt));
  check(
    "that read resolves back to the right skill",
    skillForRead(bigPath, loaded.skills) === "code-review",
    bigPath,
  );
  check(
    "a hidden skill is absent from the block pi sends",
    !prompt.includes("ask-router"),
    "otherwise charging it nothing would be wrong",
  );

  // The spec checker against a file pi actually loaded.
  const problems = checkSkill(
    `---${NL}name: code-review${NL}description: d${NL}---${NL}# t${NL}`,
    "code-review",
  );
  check("the spec checker passes a well-formed real skill", problems.length === 0, JSON.stringify(problems));
  // ── Name collisions: pi reports them and carries on with the winner ──
  const collide = join(root, "collide");
  const cCwd = join(collide, "p");
  const cAgent = join(collide, "a");
  writeSkill(join(cCwd, ".pi", "skills"), "review", "name: review" + NL + "description: the project one");
  writeSkill(join(cAgent, "skills"), "review", "name: review" + NL + "description: the global one");
  const collided = loadSkills({ cwd: cCwd, agentDir: cAgent, skillPaths: [], includeDefaults: true });
  const shadowed = shadowedSkills(collided.diagnostics ?? []);
  check("a duplicate name loads only once", collided.skills.length === 1, `${collided.skills.length}`);
  check("and pi says which one it dropped", shadowed.length === 1, JSON.stringify(shadowed[0] ?? null));
  if (shadowed[0]) {
    console.log(`  kept ${shadowed[0].winner}`);
    console.log(`  drop ${shadowed[0].loser}`);
  }

  // ── The extractor against the collection it was built from ───────────
  const collection = process.env.SKILLS_COLLECTION;
  if (collection) {
    const { readdirSync, readFileSync, existsSync: exists } = await import("node:fs");
    const dirs = readdirSync(collection).filter((d) => exists(join(collection, d, "SKILL.md")));
    const parsed = dirs.map((d) => {
      const text = readFileSync(join(collection, d, "SKILL.md"), "utf8");
      const m = /^name:\s*(.+)$/m.exec(text);
      return { name: (m ? m[1] : d).trim(), text };
    });
    const names = new Set(parsed.map((p) => p.name));
    const withRefs = parsed.map((p) => ({ name: p.name, references: extractReferences(p.name, p.text) }));
    const referencing = withRefs.filter((p) => p.references.length > 0);
    console.log(`${NL}collection at ${collection}: ${parsed.length} skills, ${referencing.length} reference a sibling`);
    for (const r of referencing) console.log(`  ${r.name} -> ${r.references.join(", ")}`);

    check("the extractor finds the references a real collection writes", referencing.length > 0);

    // A complete collection is not necessarily self-contained: this one names
    // a skill belonging to a different plugin, and hedges it with "if
    // available" — the workaround an author writes when nothing checks.
    const whole = danglingReferences(withRefs, names);
    const siblings = withRefs.map((r) => ({
      name: r.name,
      references: r.references.filter((t) => names.has(t)),
    }));
    check(
      "installed whole, no reference to a sibling dangles",
      danglingReferences(siblings, names).length === 0,
      JSON.stringify(danglingReferences(siblings, names)),
    );
    check(
      "a reference to a skill outside the collection is still reported",
      whole.length > 0,
      whole.map((d) => `${d.from} -> ${d.missing.join(",")}`).join(" · "),
    );
    // The failure the ecosystem actually produces: one skill, taken alone.
    const alone = referencing[0];
    if (alone) {
      const solo = danglingReferences([alone], new Set([alone.name]));
      check(
        "installed alone, every sibling reference dangles",
        solo.length === 1 && solo[0].missing.length === alone.references.length,
        `${alone.name} would name ${alone.references.length} missing skills`,
      );
    }
  } else {
    console.log(`${NL}(set SKILLS_COLLECTION=<dir of skill folders> to check a real collection)`);
  }
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

console.log(`${NL}${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
