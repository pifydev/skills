import { test } from "node:test";
import assert from "node:assert/strict";
import { bySource, buildInventory, estimateTokens, type SkillLike } from "../src/inventory.ts";

const skill = (name: string, description: string, over: Partial<SkillLike> = {}): SkillLike => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  disableModelInvocation: false,
  sourceInfo: { scope: "project", source: "local" },
  ...over,
});

/** Stands in for pi's formatSkillsForPrompt: framing plus one line per skill. */
const format = (list: SkillLike[]): string => {
  const visible = list.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  return ["FRAMING", ...visible.map((s) => `${s.name}:${s.description}`)].join("\n");
};

test("an empty set costs nothing", () => {
  const inv = buildInventory([], format);
  assert.equal(inv.totalChars, 0);
  assert.equal(inv.totalTokens, 0);
  assert.deepEqual(inv.costs, []);
  assert.equal(inv.visible, 0);
});

test("per-skill cost is what the block loses without it", () => {
  const inv = buildInventory([skill("a", "short"), skill("b", "a much longer description")], format);
  const a = inv.costs.find((c) => c.name === "a")!;
  const b = inv.costs.find((c) => c.name === "b")!;
  // "b:a much longer description" plus its newline.
  assert.equal(b.chars, "b:a much longer description".length + 1);
  assert.equal(a.chars, "a:short".length + 1);
  assert.ok(b.chars > a.chars);
  // Costliest first: that is the order you would remove them in.
  assert.equal(inv.costs[0]!.name, "b");
});

test("the shares plus the framing add up to the whole", () => {
  const skills = [skill("a", "one"), skill("b", "two"), skill("c", "three")];
  const inv = buildInventory(skills, format);
  const shares = inv.costs.reduce((sum, c) => sum + c.chars, 0);
  assert.equal(shares + inv.overheadChars, inv.totalChars, "attribution must not lose or invent characters");
  assert.equal(inv.overheadChars, "FRAMING".length);
});

test("a hidden skill is in the inventory and costs nothing", () => {
  const inv = buildInventory(
    [skill("seen", "x"), skill("router", "y", { disableModelInvocation: true })],
    format,
  );
  assert.equal(inv.visible, 1);
  assert.equal(inv.hidden, 1);
  const hidden = inv.costs.find((c) => c.name === "router")!;
  assert.equal(hidden.chars, 0);
  assert.equal(hidden.hidden, true);
});

test("grouping by source is how you would go and remove them", () => {
  const inv = buildInventory(
    [
      skill("a", "aaaa", { sourceInfo: { scope: "user", source: "local" } }),
      skill("b", "bb", { sourceInfo: { scope: "project", source: "local" } }),
      skill("c", "cccccc", { sourceInfo: { scope: "user", source: "local" } }),
    ],
    format,
  );
  const groups = bySource(inv);
  assert.equal(groups[0]!.source, "user", "costliest source first");
  assert.equal(groups[0]!.count, 2);
  assert.equal(groups.find((g) => g.source === "project")!.count, 1);
});

test("a skill with no source info is reported, not dropped", () => {
  const inv = buildInventory([skill("a", "x", { sourceInfo: undefined })], format);
  assert.equal(inv.costs[0]!.source, "unknown");
  assert.equal(bySource(inv)[0]!.count, 1);
});

test("token estimates use the suite's four-chars rule", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("an installed package names itself; your own skills are named by scope", () => {
  // Grouping exists so you know where to go and remove them, and "the
  // superpowers package" is a place you can go while "local" is not.
  const inv = buildInventory(
    [
      skill("a", "x", { sourceInfo: { scope: "user", source: "superpowers" } }),
      skill("b", "y", { sourceInfo: { scope: "project", source: "local" } }),
    ],
    format,
  );
  assert.equal(inv.costs.find((c) => c.name === "a")!.source, "superpowers");
  assert.equal(inv.costs.find((c) => c.name === "b")!.source, "project");
});
