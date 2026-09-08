/**
 * What the skills you installed actually cost.
 *
 * Every model-invocable skill puts its name, description and path into the
 * system prompt of every request, whether or not it is ever used. A dozen
 * skills is a rounding error; a subscribed collection of eighty is a standing
 * charge on every turn for the rest of the session — and nothing tells you
 * that, because the cost is spread across requests you never see.
 *
 * The numbers here are not estimates. pi exports `formatSkillsForPrompt`, the
 * same function that builds the block it sends, so the cost of the surface is
 * measured by asking it. A skill's own share is the difference the block shows
 * when that skill is left out, which is the only definition that adds up to
 * the whole.
 */

/** The part of pi's `Skill` this package needs. */
export interface SkillLike {
  name: string;
  description: string;
  filePath: string;
  disableModelInvocation: boolean;
  sourceInfo?: { type?: string; path?: string } | undefined;
}

/** Rough token count, the same 4-chars-per-token rule the suite uses elsewhere. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface SkillCost {
  name: string;
  /** Characters this skill contributes to the prompt block. */
  chars: number;
  tokens: number;
  /** True when the skill is hidden from the model and costs nothing. */
  hidden: boolean;
  source: string;
  filePath: string;
}

export interface Inventory {
  costs: SkillCost[];
  /** Characters of the whole block, including its framing. */
  totalChars: number;
  totalTokens: number;
  /** Framing that exists once, no matter how many skills there are. */
  overheadChars: number;
  visible: number;
  hidden: number;
}

export type FormatSkills = (skills: SkillLike[]) => string;

/**
 * Measure the block, then measure it again without each skill. Attributing by
 * difference is what makes the per-skill numbers sum to the total instead of
 * ignoring the framing or double-counting it.
 */
export function buildInventory(skills: readonly SkillLike[], format: FormatSkills): Inventory {
  const all = [...skills];
  const whole = format(all);
  const visible = all.filter((s) => !s.disableModelInvocation);
  const overheadChars = visible.length === 0 ? 0 : format([]).length === 0 ? framing(format, visible) : 0;

  const costs: SkillCost[] = all.map((skill) => {
    if (skill.disableModelInvocation) {
      return { name: skill.name, chars: 0, tokens: 0, hidden: true, source: sourceOf(skill), filePath: skill.filePath };
    }
    const without = format(all.filter((s) => s !== skill));
    const chars = Math.max(0, whole.length - without.length);
    return {
      name: skill.name,
      chars,
      tokens: estimateTokens("x".repeat(chars)),
      hidden: false,
      source: sourceOf(skill),
      filePath: skill.filePath,
    };
  });

  return {
    costs: costs.sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name)),
    totalChars: whole.length,
    totalTokens: estimateTokens(whole),
    overheadChars,
    visible: visible.length,
    hidden: all.length - visible.length,
  };
}

/**
 * The framing charged once: what remains of the block after every skill's own
 * share is taken out.
 */
function framing(format: FormatSkills, visible: readonly SkillLike[]): number {
  const whole = format([...visible]);
  let shares = 0;
  for (const skill of visible) shares += Math.max(0, whole.length - format(visible.filter((s) => s !== skill)).length);
  return Math.max(0, whole.length - shares);
}

function sourceOf(skill: SkillLike): string {
  const type = skill.sourceInfo?.type;
  return typeof type === "string" && type ? type : "unknown";
}

/** Group by where the skills came from, because that is how you remove them. */
export function bySource(inventory: Inventory): Array<{ source: string; count: number; chars: number }> {
  const groups = new Map<string, { count: number; chars: number }>();
  for (const cost of inventory.costs) {
    const group = groups.get(cost.source) ?? { count: 0, chars: 0 };
    group.count++;
    group.chars += cost.chars;
    groups.set(cost.source, group);
  }
  return [...groups.entries()]
    .map(([source, g]) => ({ source, ...g }))
    .sort((a, b) => b.chars - a.chars || a.source.localeCompare(b.source));
}
