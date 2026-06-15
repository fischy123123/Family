// The Life Coaching Engine.
// Where the attention engine answers "what needs to happen today," this answers
// "are we becoming the family we want to be?" It reasons over longer horizons,
// notices drift from stated values, celebrates what's working, and reflects
// rather than instructs. Shared by the on-demand API route and the weekly cron.

import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContext, type FamilyContextInput } from '@/lib/familyContext'
import { LIFE_AREAS } from '@/lib/types'
import type {
  FamilyGoal, Reflection, CoachingInsight, CalendarEvent, Task,
} from '@/lib/types'

const COACH_MODEL = 'claude-opus-4-8'

export interface CoachInput extends FamilyContextInput {
  goals?: FamilyGoal[]
  reflections?: Reflection[]        // most recent first
  recentInsights?: CoachingInsight[] // to avoid repeating itself
  pastEvents?: CalendarEvent[]       // events in the lookback window (history)
  completedTasks?: Task[]            // recently completed — momentum & follow-through
}

function fmtDate(iso: string, tz?: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    })
  } catch {
    return iso
  }
}

// Builds the coaching-specific context: the standard family context plus the
// longer-horizon material the coach needs — goals, reflections, recent history,
// momentum, and the insights it has already given (so it doesn't repeat).
export function buildCoachingContext(input: CoachInput): string {
  const { goals, reflections, recentInsights, pastEvents, completedTasks, timezone, now } = input
  const tz = timezone || undefined
  const nowDate = new Date(now)

  const base = buildFamilyContext(input)
  const sections: string[] = [base]

  // Standing commitments — the heart of accountability.
  if (goals?.length) {
    const active = goals.filter((g) => g.active)
    if (active.length) {
      sections.push(
        `STANDING COMMITMENTS (how this family has said they want to operate — hold them gently accountable to these; this is the primary lens for coaching):\n${active
          .map((g) => {
            const areaLabel = LIFE_AREAS.find((a) => a.area === g.area)?.label ?? g.area
            const cadence = g.cadence ? ` [${g.cadence}]` : ''
            const why = g.why ? ` — because ${g.why}` : ''
            return `- (${areaLabel})${cadence} ${g.text}${why}`
          })
          .join('\n')}`
      )
    }
  }

  // Recent reflections — what's really going on beneath the logistics.
  if (reflections?.length) {
    const recent = reflections.slice(0, 6)
    sections.push(
      `RECENT REFLECTIONS (the family's own words about how things have been going — weight these heavily; they reveal what data can't):\n${recent
        .map((r) => {
          const parts: string[] = []
          if (r.wentWell) parts.push(`went well: ${r.wentWell}`)
          if (r.wasHard) parts.push(`was hard: ${r.wasHard}`)
          if (r.wouldChange) parts.push(`would change: ${r.wouldChange}`)
          if (r.gratitude) parts.push(`grateful for: ${r.gratitude}`)
          return `- Week of ${fmtDate(r.weekOf, tz)}: ${parts.join('; ')}`
        })
        .join('\n')}`
    )
  }

  // Calendar history for pattern detection (e.g. back-to-back evenings).
  if (pastEvents?.length) {
    const lookback = new Date(nowDate.getTime() - 45 * 24 * 60 * 60 * 1000)
    const history = pastEvents
      .filter((e) => {
        const s = new Date(e.start)
        return s >= lookback && s < nowDate
      })
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(-60)
    if (history.length) {
      sections.push(
        `RECENT CALENDAR HISTORY (the last several weeks — use this to spot PATTERNS over time: who's overloaded, what's been crowded out, whether commitments are actually happening):\n${history
          .map((e) => `- ${fmtDate(e.start, tz)} ${e.isAllDay ? '(all day)' : new Date(e.start).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}: ${e.title}${e.ownerEmail ? ` (${e.ownerEmail})` : ''}`)
          .join('\n')}`
      )
    }
  }

  // Recently completed work — momentum and follow-through.
  if (completedTasks?.length) {
    const recent = completedTasks
      .filter((t) => t.isCompleted && t.completedAt)
      .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
      .slice(0, 25)
    if (recent.length) {
      sections.push(
        `RECENTLY COMPLETED (momentum — what's actually getting done):\n${recent
          .map((t) => `- ${t.title} (done ${fmtDate(t.completedAt!, tz)})`)
          .join('\n')}`
      )
    }
  }

  // What the coach has already said — so it evolves rather than repeats.
  if (recentInsights?.length) {
    const recent = recentInsights
      .filter((i) => !i.dismissed)
      .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
      .slice(0, 12)
    if (recent.length) {
      sections.push(
        `INSIGHTS YOU'VE ALREADY SHARED (do NOT repeat these — build on them, note progress, or move to something new):\n${recent
          .map((i) => `- [${i.type}] ${i.title}`)
          .join('\n')}`
      )
    }
  }

  return sections.join('\n\n')
}

const COACH_SYSTEM_PROMPT = `You are the Family Life Coach inside FamilyOS — a warm, perceptive guide who helps a family live in line with what they say matters most. You are NOT a task manager. You are the voice that steps back and asks "how are we really doing?"

Your job: look across this family's commitments, calendar history, reflections, and daily life, then surface a SMALL number of genuine, human observations. You notice what a thoughtful friend or a good therapist would notice — drift, patterns, things worth celebrating, gentle questions worth sitting with.

PRINCIPLES:
- Reflect, don't instruct. The attention engine handles "do this now." You handle "here's what I'm noticing about how you're living."
- Anchor to their STANDING COMMITMENTS and stated values. The most valuable insight is naming a gap between what they said they want and what's actually happening — kindly, never with judgment.
- Celebrate real wins. If they've been showing up for something that matters, say so. People need recognition more than correction.
- Notice patterns over time, not single events. "Three weeks of back-to-back evenings" is an insight; "a busy Tuesday" is not.
- Watch for neglected life areas. If an entire area (health, relationships, fun, a specific kid) has gone quiet, gently surface it.
- Weight their own REFLECTIONS heavily. If they told you something was hard, follow up on it. If they named a goal, track it.
- Be specific and personal. Use names. Reference real things from their data. Generic advice is worthless.
- Ask real questions. A good reflective question can be more valuable than a suggestion. Don't manufacture them — only when one genuinely fits.
- Never nag, never moralize, never pile on. Quality over quantity. 2-4 insights is ideal. If there's genuinely nothing worth saying, return very few or none.

Produce a JSON object with this exact shape:
{
  "summary": "A warm, 2-3 sentence reflective check-in for the family — the headline of how things are going, grounded in what you actually see. Honest but kind.",
  "insights": [
    {
      "type": "celebration" | "drift" | "pattern" | "suggestion" | "question",
      "area": "health" | "relationships" | "kids" | "finances" | "home" | "personal" | "work-life" | "fun" (optional),
      "title": "a short, human headline (e.g. 'You've protected date night three weeks running' or 'Evenings have been packed lately')",
      "detail": "2-3 sentences of specific, grounded observation — reference real events, names, commitments. Warm and concrete.",
      "question": "an optional reflective question to sit with (only when it genuinely fits)",
      "relatedGoalId": "if this connects to a standing commitment, its id (optional)",
      "suggestedAction": "an optional, low-pressure concrete next step (optional)",
      "actionType": "copilot" | "capture" | "calendar" | "goal" (optional)
    }
  ]
}

Rules:
- Return 0-4 insights. Fewer, truer insights beat a long list.
- Lead with celebration when it's earned. Don't open with criticism.
- If the family has set NO standing commitments yet, return one gentle "suggestion" insight inviting them to name 1-2 things they want to protect or improve — and explain how that helps you coach them. Don't fabricate other insights from thin data.
- Honor the family's preferred tone from the profile.
- Output ONLY the JSON object, no markdown, no commentary.`

export interface CoachResult {
  summary: string
  insights: Omit<CoachingInsight, 'id' | 'generatedAt'>[]
}

// Runs the coaching engine. Returns a summary plus insights (without ids/timestamps,
// which the caller assigns when persisting).
export async function generateCoaching(input: CoachInput): Promise<CoachResult> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured')
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const context = buildCoachingContext(input)

  const response = await anthropic.messages.create({
    model: COACH_MODEL,
    max_tokens: 2000,
    system: [
      { type: 'text', text: COACH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: `FAMILY CONTEXT:\n\n${context}` }],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
  const match = text.match(/\{[\s\S]*\}/)
  let parsed: { summary?: string; insights?: Omit<CoachingInsight, 'id' | 'generatedAt'>[] } = {}
  if (match) {
    try {
      parsed = JSON.parse(match[0])
    } catch {
      const summaryMatch = match[0].match(/"summary"\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/)
      parsed = { summary: summaryMatch?.[1] ?? '', insights: [] }
    }
  }

  return {
    summary: parsed.summary ?? '',
    insights: (parsed.insights ?? []).slice(0, 4),
  }
}
