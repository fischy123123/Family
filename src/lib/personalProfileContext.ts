import type { PersonalProfile } from '@/lib/types'

const PLAN_STYLE_HINT: Record<NonNullable<PersonalProfile['planStyle']>, string> = {
  minimal: 'Keep days light — few moves, lots of breathing room.',
  balanced: 'A balanced day — a handful of meaningful moves with slack between them.',
  packed: 'They like a fuller day — more moves are welcome, but never at the cost of the anchors or rest.',
}

// Renders the signed-in person's profile into one context block, used by BOTH
// the Day Planner and the Moment Coach so they reason from the exact same
// picture of who this person is and how their days actually work. Kept compact;
// every line is a high-signal personalization the engine should honor.
export function buildPersonalProfileBlock(p?: PersonalProfile | null): string {
  if (!p) return ''
  const lines: string[] = []

  // Who they are / what they're working on
  if (p.goals?.length) lines.push(`Working toward: ${p.goals.join('; ')}.`)
  if (p.biggestStruggle) lines.push(`What most gets in their way: ${p.biggestStruggle}.`)
  if (p.hasAdhd) lines.push(`Has ADHD — task initiation is hard; lean on tiny first steps, momentum, and a short, forgiving plan.`)
  if (p.startStrategies?.length) lines.push(`What actually helps them start: ${p.startStrategies.join('; ')}.`)
  if (p.energizers?.length) lines.push(`Energizes them: ${p.energizers.join('; ')}.`)
  if (p.drainers?.length) lines.push(`Drains them: ${p.drainers.join('; ')}.`)
  if (p.avoiding?.length) lines.push(`Keeps putting off: ${p.avoiding.join('; ')}.`)

  // Their days (rhythm + non-calendar anchors)
  if (p.rhythm) lines.push(`Daily rhythm (plan hard things for their good windows, light things for the dips): ${p.rhythm}.`)
  if (p.fixedAnchors?.length) {
    lines.push(`Fixed daily anchors NOT on the calendar (treat these as real constraints — plan around them): ${p.fixedAnchors.join('; ')}.`)
  }

  // Household dynamic (who does what / who's around)
  if (p.householdRoles) lines.push(`Division of labor (who handles what by default — use this to keep the plan to what is genuinely THEIRS today): ${p.householdRoles}.`)
  if (p.careSchedule) lines.push(`Care / partner schedule (who has the kids, partner availability — decisive for what's on their plate today): ${p.careSchedule}.`)

  // Plan preferences
  if (p.planStyle) lines.push(`Preferred plan density: ${PLAN_STYLE_HINT[p.planStyle]}`)
  if (p.protectRest) lines.push(`Protect rest: explicitly include downtime/recovery in the day; do not fill every gap.`)
  if (p.nonNegotiables?.length) lines.push(`NON-NEGOTIABLES (hard rules the plan must never break): ${p.nonNegotiables.join('; ')}.`)

  if (p.freeform) lines.push(`Also: ${p.freeform}.`)

  if (!lines.length) return ''
  return `\n\nABOUT ME (the signed-in person — highest-priority personalization. Tune the whole plan/suggestion to this; honor their rhythm, anchors, household roles, and non-negotiables as real constraints, not nice-to-haves):\n${lines.map((l) => `- ${l}`).join('\n')}`
}
