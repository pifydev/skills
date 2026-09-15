import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  commitLedger,
  mergeLedgers,
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

test("a skill read by a path relative to cwd still fires", () => {
  // pi loads a skill from an absolute path, but the model may read it by a path
  // relative to the project root. Without resolving against cwd the read never
  // matches and the skill silently looks unused.
  const cwd = resolve("/home/me/proj");
  const skills = [{ name: "review", filePath: resolve(cwd, "skills/review/SKILL.md") }];
  assert.equal(skillForRead("skills/review/SKILL.md", skills, cwd), "review");
  assert.equal(skillForRead("./skills/review/SKILL.md", skills, cwd), "review");
  // An absolute read still matches, and a relative miss stays a miss.
  assert.equal(skillForRead(resolve(cwd, "skills/review/SKILL.md"), skills, cwd), "review");
  assert.equal(skillForRead("skills/other/SKILL.md", skills, cwd), null);
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

test("mergeLedgers sums tallies, keeps the newest time, and copies loners", () => {
  const a: Ledger = { review: { count: 2, lastAt: 100, byModel: 2, byCommand: 0 } };
  const b: Ledger = {
    review: { count: 1, lastAt: 300, byModel: 0, byCommand: 1 },
    deploy: { count: 5, lastAt: 50, byModel: 5, byCommand: 0 },
  };
  const merged = mergeLedgers(a, b);
  assert.deepEqual(merged.review, { count: 3, lastAt: 300, byModel: 2, byCommand: 1 });
  assert.deepEqual(merged.deploy, { count: 5, lastAt: 50, byModel: 5, byCommand: 0 });
  // Inputs are left untouched.
  assert.equal(a.review!.count, 2);
  assert.equal(b.deploy!.count, 5);
});

test("concurrent saves merge instead of clobbering: both stale increments survive", () => {
  // Two sessions share one ledger file. The old write held an in-memory copy
  // and wrote it whole — last-writer-wins, so whoever saved second erased the
  // other's counts. commitLedger re-reads and folds in only its pending delta.
  const dir = mkdtempSync(join(tmpdir(), "pify-skills-ledger-"));
  const file = join(dir, "ledger.json");
  try {
    // A baseline both sessions loaded from disk.
    commitLedger(file, record({}, { name: "review", by: "model", at: 100 })); // count 1

    // Each session captured that baseline, then recorded ONE more firing
    // locally. Their pending deltas are what they still owe disk.
    const pendingA = record({}, { name: "review", by: "model", at: 200 });
    const pendingB = record({}, { name: "review", by: "command", at: 300 });

    // They save in turn; the second re-reads what the first committed.
    commitLedger(file, pendingA);
    const merged = commitLedger(file, pendingB);

    const onDisk = parseLedger(readFileSync(file, "utf8"));
    assert.deepEqual(onDisk, merged, "the returned ledger matches what landed on disk");
    assert.equal(onDisk.review!.count, 3, "baseline + both increments, none clobbered");
    assert.equal(onDisk.review!.byModel, 2);
    assert.equal(onDisk.review!.byCommand, 1);
    assert.equal(onDisk.review!.lastAt, 300, "the newest firing time wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commitLedger treats a missing or corrupt file as nothing recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "pify-skills-ledger-"));
  const file = join(dir, "nested", "ledger.json"); // dir does not exist yet
  try {
    // No file on disk: the delta is written as-is, creating the directory.
    const first = commitLedger(file, record({}, { name: "deploy", by: "command", at: 10 }));
    assert.equal(first.deploy!.count, 1);
    assert.deepEqual(parseLedger(readFileSync(file, "utf8")), first);

    // A hostile file on disk reads as empty, so the delta is not lost.
    rmSync(file);
    writeFileSync(file, "{ not json");
    const second = commitLedger(file, record({}, { name: "deploy", by: "model", at: 20 }));
    assert.equal(second.deploy!.count, 1, "corrupt disk contributes nothing, delta survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
