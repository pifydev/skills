import { test } from "node:test";
import assert from "node:assert/strict";
import { danglingReferences, extractReferences, shadowedSkills } from "../src/graph.ts";

test("the qualified form is recognised, as published collections write it", () => {
  const body = "First use superpowers:test-driven-development, then superpowers:writing-plans.";
  assert.deepEqual(extractReferences("executing-plans", body), [
    "test-driven-development",
    "writing-plans",
  ]);
});

test("a backticked name followed by the word skill is a reference", () => {
  // Taken verbatim from a real collection, which works around the missing
  // check by hand: "skip this section entirely if the `triage` skill isn't
  // installed".
  const body = "Skip this section entirely if the `triage` skill isn't installed.";
  assert.deepEqual(extractReferences("red-green", body), ["triage"]);
});

test("a skill naming itself is not a reference", () => {
  assert.deepEqual(extractReferences("writing-plans", "See superpowers:writing-plans above."), []);
  assert.deepEqual(extractReferences("triage", "The `triage` skill does this."), []);
});

test("things shaped like a namespace but obviously not are left alone", () => {
  // A check that cries wolf is a check people learn to skip.
  const body = [
    "See https://example.com/skills for more.",
    "Install with npm:some-package.",
    "note: this-is-prose and not a reference.",
  ].join("\n");
  assert.deepEqual(extractReferences("x", body), []);
});

test("bare paths are deliberately not treated as references", () => {
  // `skills/overview` is a relative documentation link as often as it is a
  // reference, and guessing wrong produces a false warning.
  assert.deepEqual(extractReferences("x", "See skills/overview and skills/testing."), []);
});

test("duplicates collapse and the result is sorted", () => {
  const body = "superpowers:review and superpowers:review and `audit` skill and superpowers:audit";
  assert.deepEqual(extractReferences("x", body), ["audit", "review"]);
});

test("names shorter than three characters are not matched, and that is the trade", () => {
  // `ratio:1` and `key:ab` are ordinary prose. Requiring three characters on
  // both sides buys silence on those at the cost of missing a two-letter
  // skill name — a name almost nobody writes, against a false warning that
  // would teach people to ignore this check.
  assert.deepEqual(extractReferences("x", "superpowers:ab and key:va"), []);
});

test("dangling references are the ones whose target is not loaded", () => {
  const loaded = new Set(["writing-plans", "executing-plans"]);
  const dangling = danglingReferences(
    [
      { name: "executing-plans", references: ["writing-plans", "using-git-worktrees"] },
      { name: "writing-plans", references: ["executing-plans"] },
      { name: "lonely", references: ["a", "b", "c"] },
    ],
    loaded,
  );
  // Worst first: the skill missing the most is the one most likely to misfire.
  assert.equal(dangling[0]!.from, "lonely");
  assert.deepEqual(dangling[0]!.missing, ["a", "b", "c"]);
  assert.equal(dangling.length, 2);
  assert.ok(!dangling.some((d) => d.from === "writing-plans"), "a resolving reference is not reported");
});

test("a shadowed skill counts as missing, because the model cannot see it", () => {
  // Resolution is against what pi LOADED, not what is on disk.
  const dangling = danglingReferences([{ name: "a", references: ["review"] }], new Set(["a"]));
  assert.deepEqual(dangling, [{ from: "a", missing: ["review"] }]);
});

test("pi's collision diagnostics become a readable answer", () => {
  const shadowed = shadowedSkills([
    { type: "warning", collision: undefined },
    {
      type: "collision",
      collision: {
        resourceType: "skill",
        name: "review",
        winnerPath: "/home/me/.pi/agent/skills/review/SKILL.md",
        loserPath: "/proj/.pi/skills/review/SKILL.md",
      },
    },
    // Collisions for other resource types are not this package's business.
    { type: "collision", collision: { resourceType: "prompt", name: "x", winnerPath: "/a", loserPath: "/b" } },
    // A malformed diagnostic must not produce a half-empty row.
    { type: "collision", collision: { resourceType: "skill", name: "y" } },
  ]);
  assert.equal(shadowed.length, 1);
  assert.equal(shadowed[0]!.name, "review");
  assert.match(shadowed[0]!.winner, /agent[\\/]skills/);
  assert.match(shadowed[0]!.loser, /proj/);
});

test("no diagnostics means nothing shadowed", () => {
  assert.deepEqual(shadowedSkills([]), []);
});

test("a fenced code block is not prose, so its tag is not a reference", () => {
  // Measured on a real collection: ```json:metadata opened a fence and was
  // read as a reference to a skill called "metadata", in two files.
  const body = [
    "Tag each task in a fence:",
    "```json:metadata",
    '{ "modelTier": "high" }',
    "```",
    "Then use superpowers:writing-plans.",
  ].join("\n");
  assert.deepEqual(extractReferences("x", body), ["writing-plans"]);
});

test("an inline code span with a language tag is not a reference either", () => {
  assert.deepEqual(extractReferences("x", "Each task's `json:metadata` fence carries a tier."), []);
});

test("a reference into another plugin is still a reference", () => {
  // superpowers does exactly this, hedged with "if available" — the hedge an
  // author writes when nothing checks for them.
  const body = "- Use elements-of-style:writing-clearly-and-concisely skill if available";
  assert.deepEqual(extractReferences("brainstorming", body), ["writing-clearly-and-concisely"]);
});
