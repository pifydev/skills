/**
 * Does the "— explains …" tail help the model pick the right skill?
 *
 * Every skill in the Pify suite describes itself as
 * `Use when <trigger> — explains <what it covers>`. Trimming that tail would
 * save a measured 22% of the skills block (~275 tokens on every request), and
 * a published collection argues the tail is actively harmful. That harm did
 * not reproduce here (see description-trap.mjs), which leaves the opposite
 * question unanswered: does the tail *help*?
 *
 * Removing it would otherwise trade a measured cost against an unmeasured
 * benefit. So: the real thirteen descriptions, in both forms, and a task that
 * only one of them fits. The model picks by reading a skill file, which is
 * observable — so what is counted is which skill it opened.
 *
 * RESULT: the tail changes nothing. claude-sonnet-4.5 routed 2/5 in BOTH
 * arms, and identically per task — memory and usage hit in both, plan-mode,
 * subagent and goal missed in both. qwen3-235b routed 0/5 in both arms: it
 * does not invoke a skill for a conversational prompt at all, which is the
 * ecosystem's own complaint rather than anything about descriptions.
 *
 * So the tail neither helps nor harms routing on this evidence, while costing
 * a measured 22% of the skills block. That is what makes trimming it safe.
 *
 *   bun run test/live/routing.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SUITE = process.env.PIFY_SUITE ?? "D:/project/pify-plugins";
const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "qwen/qwen3-235b-a22b-2507";
const RUNS = Number(process.env.ROUTING_RUNS ?? 2);
const NL = String.fromCharCode(10);

/** The suite's real skills, read from the packages themselves. */
function realSkills() {
  const out = [];
  for (const pkg of readdirSync(SUITE)) {
    const dir = join(SUITE, pkg, "skills");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      if (!fm) continue;
      const d = /^description:\s*([\s\S]*?)(?=\n[a-z-]+:|$)/m.exec(fm[1]);
      if (!d) continue;
      out.push({
        name,
        description: d[1].split(/\s+/).join(" ").trim(),
        body: text.slice(fm[0].length).trim(),
      });
    }
  }
  return out;
}

/** Drop the "— explains …" / "— suggests …" tail. */
const trim = (description) => description.replace(/\s+[-–—]\s+(explains|suggests)\b[\s\S]*$/i, "").trim();

/**
 * Tasks with one clearly correct skill each. Worded as a user would, not
 * echoing the skill's own words, so the model must actually route.
 */
const TASKS = [
  { prompt: "I keep having to re-explain our commit message rules to you every session. Fix that.", want: "memory" },
  { prompt: "Before you touch anything: this change spans a dozen files and I want to see the approach first.", want: "plan-mode" },
  { prompt: "Check whether this refactor is going to cost me a fortune before you start.", want: "usage" },
  { prompt: "Have a second pair of eyes go over the diff while you keep working on the tests.", want: "subagent" },
  { prompt: "This is going to be a long job and I want you to keep at it until it is actually finished.", want: "goal" },
];

function run(arm, skills, task) {
  const repo = mkdtempSync(join(tmpdir(), `route-${arm}-`));
  const agentDir = mkdtempSync(join(tmpdir(), `route-agent-`));
  try {
    for (const skill of skills) {
      const dir = join(agentDir, "skills", skill.name);
      mkdirSync(dir, { recursive: true });
      const description = arm === "trimmed" ? trim(skill.description) : skill.description;
      writeFileSync(
        join(dir, "SKILL.md"),
        `---${NL}name: ${skill.name}${NL}description: ${description}${NL}---${NL}${skill.body}${NL}`,
      );
    }
    writeFileSync(join(repo, "README.md"), `# demo${NL}`);

    // Print mode reports only the final text, never the tool calls, so the
    // skill that fired is read from this package's own ledger instead — the
    // instrument it exists to be.
    spawnSync(
      "pi",
      [
        "--provider", PROVIDER,
        "--model", MODEL,
        "--no-extensions",
        "-e", join(PKG, "extensions", "skills.ts"),
        "-p", `"${task.prompt.replace(/"/g, '\\"')}"`,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 300_000,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      },
    );
    const ledgerDir = join(agentDir, "pify-skills");
    let opened = [];
    try {
      for (const f of readdirSync(ledgerDir)) {
        opened = opened.concat(Object.keys(JSON.parse(readFileSync(join(ledgerDir, f), "utf8"))));
      }
    } catch {
      opened = [];
    }
    return { opened };
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(agentDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const skills = realSkills();
console.log(`${skills.length} real skills from the suite; ${TASKS.length} tasks x ${RUNS} runs x 2 arms${NL}`);

const tally = { full: { hit: 0, total: 0 }, trimmed: { hit: 0, total: 0 } };
for (let i = 0; i < RUNS; i++) {
  for (const task of TASKS) {
    for (const arm of ["full", "trimmed"]) {
      const { opened } = run(arm, skills, task);
      const hit = opened.includes(task.want);
      tally[arm].total++;
      if (hit) tally[arm].hit++;
      console.log(`  ${arm.padEnd(7)} want=${task.want.padEnd(10)} opened=${opened.join(",") || "(none)"}${hit ? "" : "   MISS"}`);
    }
  }
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

console.log(`${NL}routed correctly — full: ${tally.full.hit}/${tally.full.total} · trimmed: ${tally.trimmed.hit}/${tally.trimmed.total}`);
check("the descriptions route at all", tally.full.hit > 0);
check(
  "trimming the tail does not route worse",
  tally.trimmed.hit >= tally.full.hit,
  `${tally.trimmed.hit} vs ${tally.full.hit}`,
);

console.log(`${NL}${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
