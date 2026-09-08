import { test } from "node:test";
import assert from "node:assert/strict";
import {
  neverFired,
  parseLedger,
  record,
  skillForCommand,
  skillForRead,
  usageRows,
  type Ledger,
} from "../src/ledger.ts";

test("a read of a skill's own file is a model invocation", () => {
  const skills = [
    { name: "review", filePath: "/home/me/.pi/skills/review/SKILL.md" },
    { name: "deploy", filePath: "/home/me/.pi/skills/deploy/SKILL.md" },
  ];
  assert.equal(skillForRead("/home/me/.pi/skills/review/SKILL.md", skills), "review");
  // Separators and case must not decide whether a skill counts as used.
  assert.equal(skillForRead("\\home\\me\\.pi\\skills\\Deploy\\SKILL.md", skills), "deploy");
  assert.equal(skillForRead("/home/me/src/app.ts", skills), null);
});

test("supporting files in a skill directory are not invocations", () => {
  // A skill may tell the model to read references/ and scripts/ AFTER it has
  // fired; counting those would inflate a tally by however many files its
  // author split it into.
  const skills = [{ name: "review", filePath: "/skills/review/SKILL.md" }];
  assert.equal(skillForRead("/skills/review/references/checklist.md", skills), null);
  assert.equal(skillForRead("/skills/review/scripts/run.sh", skills), null);
});

test("/skill:name is the explicit invocation", () => {
  assert.equal(skillForCommand("/skill:review"), "review");
  assert.equal(skillForCommand("  /skill:code-review the diff"), "code-review");
  assert.equal(skillForCommand("/skill:a.b_c-1"), "a.b_c-1");
  assert.equal(skillForCommand("please run /skill:review"), null, "only at the start of the message");
  assert.equal(skillForCommand("/skills"), null);
  assert.equal(skillForCommand(""), null);
});

test("recording keeps both halves apart and the newest time", () => {
  let ledger: Ledger = {};
  ledger = record(ledger, { name: "review", by: "model", at: 100 });
  ledger = record(ledger, { name: "review", by: "command", at: 300 });
  ledger = record(ledger, { name: "review", by: "model", at: 200 });
  const usage = ledger.review!;
  assert.equal(usage.count, 3);
  assert.equal(usage.byModel, 2);
  assert.equal(usage.byCommand, 1);
  assert.equal(usage.lastAt, 300, "a late-arriving older event must not move the clock backwards");
});

test("a corrupt or hostile ledger reads as nothing recorded", () => {
  assert.deepEqual(parseLedger(null), {});
  assert.deepEqual(parseLedger("not json"), {});
  assert.deepEqual(parseLedger("[1,2]"), {});
  assert.deepEqual(parseLedger('{"a": 5}'), {});
  // A zero count is not a record of use, so it is dropped rather than shown.
  assert.deepEqual(parseLedger('{"a": {"count": 0}}'), {});
  assert.deepEqual(parseLedger('{"a": {"count": -3}}'), {});
  assert.deepEqual(parseLedger('{"a": {"count": 2.7, "lastAt": 5}}'), {
    a: { count: 2, lastAt: 5, byModel: 0, byCommand: 0 },
  });
});

test("every skill appears in the rows, used or not", () => {
  // The unused ones are the entire point, so they can never be left out.
  const rows = usageRows(
    [
      { name: "used", chars: 100, hidden: false },
      { name: "never", chars: 400, hidden: false },
      { name: "router", chars: 0, hidden: true },
    ],
    { used: { count: 3, lastAt: 10, byModel: 3, byCommand: 0 } },
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.name, "used", "most used first");
  assert.equal(rows.find((r) => r.name === "never")!.usage, null);
});

test("never-fired is costliest first, and excludes what costs nothing", () => {
  const rows = usageRows(
    [
      { name: "cheap", chars: 50, hidden: false },
      { name: "dear", chars: 900, hidden: false },
      { name: "hidden", chars: 0, hidden: true },
    ],
    {},
  );
  const unused = neverFired(rows).sort((a, b) => b.chars - a.chars);
  assert.deepEqual(
    unused.map((r) => r.name),
    ["dear", "cheap"],
    "a hidden skill is not in the prompt, so it is not part of the bill",
  );
});
