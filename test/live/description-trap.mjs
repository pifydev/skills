/**
 * Does a description that summarises the skill make the model skip the body?
 *
 * A published collection reports discovering this by testing: a description
 * saying "code review between tasks" produced ONE review, though the skill
 * body specified two. Their conclusion — a description must say when to use
 * the skill and never what it does — is load-bearing for how skills are
 * written, and it is a claim about model behaviour, so it can be measured
 * rather than believed.
 *
 * Two skills, identical bodies specifying THREE steps. One description names
 * only the trigger; the other also summarises the workflow as two steps. If
 * the trap is real, the summarising one produces two.
 *
 * RESULT so far: it does not reproduce here. 3 runs x 2 models
 * (claude-sonnet-4.5, qwen3-235b), including a body that buries the third
 * step under a heading after a natural stopping point — 3/3 reached it in
 * both arms, every time.
 *
 * A plausible reason is architectural rather than a disagreement about
 * models. Under a Skill tool that loads content, acting on the description
 * alone is available; under pi the description sits in the system prompt
 * beside a <location> and the prompt says to READ the file, so by the time
 * the skill is in play its body is in context and the description is not
 * competing with it. Six runs is not proof of absence — a longer body, more
 * skills competing, or a weaker model may still show it — which is why this
 * stays runnable instead of being written up as settled.
 *
 *   bun run test/live/description-trap.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROVIDER = process.env.PI_LIVE_PROVIDER ?? "openrouter";
const MODEL = process.env.PI_LIVE_MODEL ?? "anthropic/claude-sonnet-4.5";
const RUNS = Number(process.env.TRAP_RUNS ?? 3);
const NL = String.fromCharCode(10);

/** The body is identical in both arms; only the description differs. */
const BODY = [
  "# Release check",
  "",
  "Run the checks and print one line for each.",
  "",
  "1. Print `STEP-TYPECHECK ok`",
  "2. Print `STEP-TESTS ok`",
  "",
  "That covers the build. Once both have passed, the release is verified.",
  "",
  "## Before you report",
  "",
  "The verification is not complete until the changelog has been confirmed;",
  "print `STEP-CHANGELOG ok` as well.",
].join(NL);

const ARMS = {
  // Triggering conditions only.
  trigger: "Use when the user asks to run the release check.",
  // The same trigger, plus a summary of the workflow that is deliberately
  // short by one step — the shape the collection warns about.
  summary:
    "Use when the user asks to run the release check - runs the typecheck step and the tests step and reports each",
};

function run(arm, description) {
  const repo = mkdtempSync(join(tmpdir(), `trap-${arm}-`));
  try {
    mkdirSync(join(repo, ".pi", "skills", "release-check"), { recursive: true });
    writeFileSync(
      join(repo, ".pi", "skills", "release-check", "SKILL.md"),
      `---${NL}name: release-check${NL}description: ${description}${NL}---${NL}${BODY}${NL}`,
    );
    writeFileSync(join(repo, "README.md"), `# demo${NL}`);

    const result = spawnSync(
      "pi",
      [
        "--provider", PROVIDER,
        "--model", MODEL,
        "--approve",
        "--no-extensions",
        "-p", '"Run the release check."',
      ],
      { cwd: repo, encoding: "utf8", timeout: 300_000, shell: true, windowsHide: true },
    );
    const out = `${result.stdout ?? ""}`;
    return {
      typecheck: out.includes("STEP-TYPECHECK"),
      tests: out.includes("STEP-TESTS"),
      changelog: out.includes("STEP-CHANGELOG"),
      text: out.trim().slice(0, 160),
    };
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

const tally = { trigger: 0, summary: 0 };
for (let i = 0; i < RUNS; i++) {
  for (const [arm, description] of Object.entries(ARMS)) {
    const r = run(arm, description);
    const steps = [r.typecheck, r.tests, r.changelog].filter(Boolean).length;
    if (r.changelog) tally[arm]++;
    console.log(`  run ${i + 1} ${arm.padEnd(8)} steps=${steps}/3 third-step=${r.changelog ? "yes" : "NO "} | ${r.text.replace(/\s+/g, " ")}`);
  }
}

let passed = 0;
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
};

console.log(
  `${NL}third step reached — trigger-only: ${tally.trigger}/${RUNS} · summarising: ${tally.summary}/${RUNS}`,
);
check("a trigger-only description lets the body be followed", tally.trigger > 0, `${tally.trigger}/${RUNS}`);
check(
  "the summarising description loses the step it left out at least as often",
  tally.summary <= tally.trigger,
  `${tally.summary} vs ${tally.trigger}`,
);

console.log(`${NL}${passed}/${passed + failed} passed`);
process.exitCode = failed === 0 ? 0 : 1;
