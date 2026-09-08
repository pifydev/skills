import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_DESCRIPTION, body, checkSkill, readFrontmatter, worst } from "../src/spec.ts";

const skill = (frontmatter: string, bodyText = "# Title\n\nSome guidance.\n") =>
  `---\n${frontmatter}\n---\n${bodyText}`;

test("a conforming skill has nothing to say about it", () => {
  const text = skill('name: code-review\ndescription: Review a diff for correctness.');
  assert.deepEqual(checkSkill(text, "code-review"), []);
  assert.equal(worst([]), "ok");
});

test("the frontmatter field set is closed", () => {
  const text = skill("name: a\ndescription: d\nauthor: someone\nversion: 2");
  const problems = checkSkill(text, "a");
  const messages = problems.map((p) => p.message).join(" | ");
  assert.match(messages, /unknown frontmatter field "author"/);
  assert.match(messages, /unknown frontmatter field "version"/);
  assert.equal(worst(problems), "error");
});

test("the spec's own optional fields are allowed", () => {
  const text = skill("name: a\ndescription: d\nlicense: MIT\ncompatibility: pi\nallowed-tools: read, grep");
  assert.deepEqual(checkSkill(text, "a"), []);
});

test("a nested mapping is recognised as present rather than misread", () => {
  const text = skill("name: a\ndescription: d\nmetadata:\n  category: engineering\n  tier: 2");
  // The indented lines belong to metadata; they must not read as unknown fields.
  assert.deepEqual(checkSkill(text, "a"), []);
});

test("the name must match its directory, because that is how it is found", () => {
  const problems = checkSkill(skill("name: review\ndescription: d"), "code-review");
  assert.match(problems[0]!.message, /does not match its directory/);
});

test("names are lowercase-hyphenated", () => {
  assert.match(checkSkill(skill("name: Code_Review\ndescription: d"), "Code_Review")[0]!.message, /lowercase-hyphenated/);
  assert.deepEqual(checkSkill(skill("name: a1-b2\ndescription: d"), "a1-b2"), []);
});

test("a missing description is an error, not a formality", () => {
  // The description is how the model decides whether to fire the skill, so a
  // skill without one can never be chosen.
  const problems = checkSkill(skill("name: a"), "a");
  assert.ok(problems.some((p) => p.message.includes("missing required field: description")));
});

test("length limits are enforced where the spec sets them", () => {
  const long = "d".repeat(MAX_DESCRIPTION + 1);
  const problems = checkSkill(skill(`name: a\ndescription: ${long}`), "a");
  assert.match(problems[0]!.message, new RegExp(`over the ${MAX_DESCRIPTION} limit`));
});

test("a long body is guidance, not a failure", () => {
  const problems = checkSkill(skill("name: a\ndescription: d", "x\n".repeat(600)), "a");
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.level, "warning");
  assert.equal(worst(problems), "warning", "a warning must not read as a broken skill");
});

test("no frontmatter at all is the one fatal shape", () => {
  const problems = checkSkill("# Just a document\n", "a");
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.message, /no YAML frontmatter/);
});

test("quoted values are compared unquoted", () => {
  assert.deepEqual(checkSkill(skill('name: "a"\ndescription: "Review a diff."'), "a"), []);
  assert.deepEqual(checkSkill(skill("name: 'a'\ndescription: 'Review a diff.'"), "a"), []);
});

test("frontmatter and body split on the real delimiter", () => {
  const text = skill("name: a\ndescription: d", "body line\n---\nnot frontmatter\n");
  assert.deepEqual(readFrontmatter(text), { name: "a", description: "d" });
  assert.match(body(text), /^body line/);
  assert.equal(readFrontmatter("no block here"), null);
});

test("CRLF files are handled, because Windows authors them", () => {
  const text = "---\r\nname: a\r\ndescription: d\r\n---\r\n# Title\r\n";
  assert.deepEqual(checkSkill(text, "a"), []);
});
