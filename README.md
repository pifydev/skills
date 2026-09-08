# @pify/skills

The skills [pi](https://github.com/earendil-works/pi) has loaded, what they cost in every request, and which ones ever fire.

Part of the [Pify suite](https://github.com/pifydev). Install with [`pify install skills`](https://github.com/pifydev/cli) or `pi install npm:@pify/skills`.

## Why

Skills are easy to acquire and impossible to audit. You subscribe to a collection, or copy a few in from a repo you liked, and every one of them puts its name, description and path into the system prompt of **every request for the rest of the session** — whether or not it is ever used.

A dozen skills is a rounding error. Eighty is a standing charge you are paying on every turn, and nothing tells you, because the cost is spread across requests you never see. Meanwhile some of those skills have never once matched a task, and the only way to find that out is to read your own transcripts.

This package answers three questions pi does not: what is loaded, what it costs, and what earns it.

It adds nothing to the prompt itself. Measuring a cost by adding to it would be its own joke.

## The numbers are measured, not estimated

pi exports `formatSkillsForPrompt` — the same function that builds the block it sends — so the cost of the skill surface is obtained by asking pi, not by guessing. A single skill's share is the difference the block shows when that skill is left out, which is the only definition that adds up to the whole. `test/live/skills-wire.mjs` asserts exactly that against pi's real loader: **per-skill shares plus framing equal the whole block.**

Firing is counted the same way. pi's own prompt tells the model to *read a skill's file* when the task matches its description, so a `read` of that path is a model invocation; `/skill:name` is the explicit one. Counting those two is counting all of them.

Only the skill's own `SKILL.md` counts. A skill directory can hold references, scripts and examples that the skill tells the model to read *after* it has fired — counting those would inflate a skill's tally by however many files its author happened to split it into.

## Commands

### `/skills`

```
12 skills in the system prompt (+1 hidden from the model), 4.1k tokens on every request.
9 of them have never fired, costing 3.0k tokens per request for nothing.

By source:
  global      9 skills    3.0k
  project     3 skills    1.1k

Most used:
  code-review               14×  last today
  codebase-design            3×  last 4d ago
```

### `/skills cost`

Every skill, dearest first — the order you would remove them in. Skills hidden from the model with `disable-model-invocation` are marked as costing nothing, because they are genuinely absent from the block pi sends. The framing is reported separately: it is charged once, however many skills you have.

### `/skills unused`

The skills that have never fired, costliest first, with the total they cost per request.

It refuses to call them useless, and that matters — a skill for a rare job earns its place by being there when the rare job happens. This is a prompt to look, not a verdict.

### `/skills check`

Validates every loaded skill against the [Agent Skills specification](https://agentskills.io/specification): the closed frontmatter field set, a name matching its directory, and the length limits. Errors break the spec; a long body is reported as the spec's own guidance rather than a failure.

pi is forgiving about all of this — it will happily load a skill whose name disagrees with its directory. Those load fine here and break somewhere else: another host, a validator, a share.

## The ledger

Counts live in `<agentDir>/pify-skills/<project>.json`, one per project. Skills are mostly global, but whether a skill earns its place is a question about the work, and the work is the project.

The count starts when this extension is installed — it cannot see the sessions you ran before it — and `/skills` says so rather than presenting an empty tally as a finding.

## A note on project skills

pi loads project skills from `.pi/skills` only once project trust has been granted, because `.pi/skills` is one of the resources pi itself asks about. If a project's skills seem to be missing, that is usually why: this package reports what pi actually loaded, which is the honest answer even when it is not the expected one.

## Where this sits in the suite

[`@pify/usage`](https://github.com/pifydev/usage) shows skills as one row of the whole context window — the view from above. This is the view from inside that row: which skills, whose, and whether they pull their weight.

## License

MIT © [Pify maintainers](https://github.com/pifydev)
