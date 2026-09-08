/**
 * @pify/skills — the skills pi has loaded, what they cost, and which ones fire.
 *
 * pi already finds skills, formats them into the system prompt, and runs
 * `/skill:name`. What it does not do is tell you what that surface costs or
 * whether any of it earns the charge — and a subscribed collection is easy to
 * grow and impossible to audit by reading transcripts.
 *
 * Nothing here is estimated where it can be measured. Cost comes from pi's own
 * `formatSkillsForPrompt`, the same function that builds the block it sends.
 * Firing is counted from the two ways a skill is actually invoked: pi's prompt
 * tells the model to READ the skill's file when the task matches, so a read of
 * that path is a model invocation, and `/skill:name` is the explicit one.
 *
 * The extension adds nothing to the prompt. Measuring a cost by adding to it
 * would be its own joke.
 */
import {
  formatSkillsForPrompt,
  getAgentDir,
  loadSkills,
  type ExtensionAPI,
  type ExtensionContext,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { buildInventory, type Inventory, type SkillLike } from "../src/inventory.ts";
import { parseLedger, record, skillForCommand, skillForRead, type Ledger } from "../src/ledger.ts";
import { checkSkill } from "../src/spec.ts";
import {
  formatCheck,
  formatCost,
  formatOverview,
  formatUnused,
  parseRoute,
  type CheckedSkill,
} from "../src/format.ts";

type UiContext = ExtensionContext;

export default function skillsExtension(pi: ExtensionAPI) {
  let skills: Skill[] = [];
  let inventory: Inventory | null = null;
  let ledger: Ledger = {};
  let ledgerFile: string | null = null;

  /**
   * One ledger per project, keyed the way the rest of the suite keys
   * per-project state. Skills are mostly global, but whether a skill earns its
   * place is a question about the work — and the work is the project.
   */
  function resolveLedger(cwd: string): string {
    const key = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 12);
    return join(getAgentDir(), "pify-skills", `${key}.json`);
  }

  function loadLedger(): void {
    if (!ledgerFile) return;
    try {
      ledger = parseLedger(readFileSync(ledgerFile, "utf8"));
    } catch {
      ledger = {};
    }
  }

  function saveLedger(): void {
    if (!ledgerFile) return;
    try {
      mkdirSync(dirname(ledgerFile), { recursive: true });
      writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    } catch {
      // A ledger that cannot be written costs a count, never a turn.
    }
  }

  function refresh(ctx: UiContext): void {
    try {
      const loaded = loadSkills({
        cwd: ctx.cwd,
        agentDir: getAgentDir(),
        skillPaths: [],
        includeDefaults: true,
      });
      skills = loaded.skills;
      inventory = buildInventory(
        skills as unknown as SkillLike[],
        (subset) => formatSkillsForPrompt(subset as unknown as Skill[]),
      );
    } catch {
      skills = [];
      inventory = null;
    }
  }

  function note(name: string, by: "model" | "command"): void {
    ledger = record(ledger, { name, by, at: Date.now() });
    saveLedger();
  }

  // ── Counting what fires ──────────────────────────────────────────────

  pi.on("tool_call", async (event) => {
    // pi's own skills prompt says: read the skill's file when the task
    // matches. That read IS the invocation.
    if ((event as { toolName?: string }).toolName !== "read") return undefined;
    const path = (event as { input?: { path?: unknown } }).input?.path;
    if (typeof path !== "string") return undefined;
    const name = skillForRead(path, skills);
    if (name) note(name, "model");
    return undefined;
  });

  pi.on("input", async (event) => {
    // The explicit half. Extension-sourced input is this suite talking to
    // itself and is not a person choosing a skill.
    if ((event as { source?: string }).source === "extension") return undefined;
    const text = (event as { text?: unknown }).text;
    if (typeof text !== "string") return undefined;
    const name = skillForCommand(text);
    if (name) note(name, "command");
    return undefined;
  });

  // ── Lifecycle ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ledgerFile = resolveLedger(ctx.cwd);
    loadLedger();
    refresh(ctx);
  });

  // ── Command ──────────────────────────────────────────────────────────

  pi.registerCommand("skills", {
    description: "What skills are loaded, what they cost per request, and which ones fire: /skills [cost|unused|check]",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const route = parseRoute(args ?? "");
      if (route.kind === "error") {
        ctx.ui.notify(route.message, "warning");
        return;
      }

      // Skills can be added mid-session; a stale inventory would quietly
      // report yesterday's answer.
      refresh(ctx);
      if (!inventory) {
        ctx.ui.notify("Could not read the loaded skills.", "error");
        return;
      }

      switch (route.kind) {
        case "overview":
          ctx.ui.notify(formatOverview(inventory, ledger, Date.now()), "info");
          return;
        case "cost":
          ctx.ui.notify(formatCost(inventory), "info");
          return;
        case "unused":
          ctx.ui.notify(formatUnused(inventory, ledger), "info");
          return;
        case "check": {
          const checked: CheckedSkill[] = skills.map((skill) => {
            let text = "";
            try {
              text = readFileSync(skill.filePath, "utf8");
            } catch {
              return {
                name: skill.name,
                filePath: skill.filePath,
                problems: [{ level: "error" as const, message: "could not be read" }],
              };
            }
            return {
              name: skill.name,
              filePath: skill.filePath,
              problems: checkSkill(text, basename(dirname(skill.filePath))),
            };
          });
          ctx.ui.notify(formatCheck(checked), "info");
          return;
        }
      }
    },
  });
}
