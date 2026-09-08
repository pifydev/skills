import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInventory, type SkillLike } from "../src/inventory.ts";
import {
  formatCheck,
  formatCost,
  formatOverview,
  formatTokens,
  formatUnused,
  parseRoute,
} from "../src/format.ts";

const skill = (name: string, description: string, over: Partial<SkillLike> = {}): SkillLike => ({
  name,
  description,
  filePath: `/skills/${name}/SKILL.md`,
  disableModelInvocation: false,
  sourceInfo: { type: "project" },
  ...over,
});

const format = (list: SkillLike[]): string => {
  const visible = list.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  return ["FRAMING", ...visible.map((s) => `${s.name}:${s.description}`)].join("\n");
};

const NOW = 1_700_000_000_000;

test("the overview says the cost is per request, not once", () => {
  // "4.1k tokens" means nothing until it says on every request.
  const inv = buildInventory([skill("a", "x".repeat(400)), skill("b", "y".repeat(400))], format);
  const text = formatOverview(inv, {}, NOW);
  assert.match(text, /on every request/);
  assert.match(text, /2 skills in the system prompt/);
  assert.match(text, /have never fired/);
});

test("the overview counts the unused bill and names the sources", () => {
  const inv = buildInventory(
    [skill("used", "x".repeat(100), { sourceInfo: { type: "global" } }), skill("idle", "y".repeat(300))],
    format,
  );
  const text = formatOverview(inv, { used: { count: 4, lastAt: NOW, byModel: 4, byCommand: 0 } }, NOW);
  assert.match(text, /1 of them has never fired/);
  assert.match(text, /By source:/);
  assert.match(text, /global/);
  assert.match(text, /Most used:/);
  assert.match(text, /used\s+4×\s+last today/);
});

test("with nothing recorded the overview says why, rather than looking broken", () => {
  const inv = buildInventory([skill("a", "x")], format);
  const text = formatOverview(inv, {}, NOW);
  assert.match(text, /nothing has fired yet/);
  assert.match(text, /when this extension is installed/);
});

test("no skills at all says where pi looks for them", () => {
  const inv = buildInventory([], format);
  assert.match(formatOverview(inv, {}, NOW), /\.pi\/skills/);
  assert.equal(formatCost(inv), "No skills loaded.");
});

test("cost lists the dearest first and marks what is free", () => {
  const inv = buildInventory(
    [skill("small", "x"), skill("large", "y".repeat(800)), skill("router", "z", { disableModelInvocation: true })],
    format,
  );
  const text = formatCost(inv);
  const large = text.indexOf("large");
  const small = text.indexOf("small");
  assert.ok(large < small && large > 0, "dearest first");
  assert.match(text, /router {2}\(hidden from the model: costs nothing\)/);
  assert.match(text, /charged once however many skills you have/);
});

test("unused refuses to call a rare skill useless", () => {
  const inv = buildInventory([skill("rare", "x".repeat(200))], format);
  const text = formatUnused(inv, {});
  assert.match(text, /never fired/);
  assert.match(text, /earns its place by being there when it happens/);
  assert.match(text, /a prompt to look, not a verdict/);
});

test("unused says so plainly when everything has fired", () => {
  const inv = buildInventory([skill("a", "x")], format);
  const text = formatUnused(inv, { a: { count: 1, lastAt: NOW, byModel: 1, byCommand: 0 } });
  assert.equal(text, "Every loaded skill has fired at least once.");
});

test("check separates errors from guidance and totals both", () => {
  const clean = formatCheck([{ name: "a", filePath: "/a", problems: [] }]);
  assert.match(clean, /1 skill conform/);

  const mixed = formatCheck([
    { name: "a", filePath: "/a/SKILL.md", problems: [{ level: "error", message: "bad name" }] },
    { name: "b", filePath: "/b/SKILL.md", problems: [{ level: "warning", message: "long body" }] },
    { name: "c", filePath: "/c/SKILL.md", problems: [] },
  ]);
  assert.match(mixed, /3 checked · 1 with errors · 1 with warnings only/);
  assert.match(mixed, /error   bad name/);
  assert.match(mixed, /warning long body/);
  assert.ok(!mixed.includes("c —"), "a clean skill is not listed among the problems");
});

test("routes, including the ones people would guess", () => {
  assert.deepEqual(parseRoute(""), { kind: "overview" });
  assert.deepEqual(parseRoute("  COST "), { kind: "cost" });
  assert.deepEqual(parseRoute("tokens"), { kind: "cost" });
  assert.deepEqual(parseRoute("unused"), { kind: "unused" });
  assert.deepEqual(parseRoute("never"), { kind: "unused" });
  assert.deepEqual(parseRoute("check"), { kind: "check" });
  assert.deepEqual(parseRoute("lint"), { kind: "check" });
  assert.equal(parseRoute("nonsense").kind, "error");
});

test("token formatting stays readable at every scale", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(4100), "4.1k");
  assert.equal(formatTokens(2_500_000), "2.5M");
});
