// The Life Coaching Engine.
// Where the attention engine answers "what needs to happen today," this answers
// "are we becoming the family we want to be?" It reasons over longer horizons,
// notices drift from stated values, celebrates what's working, and reflects
// rather than instructs. Shared by the on-demand API route and the weekly cron.

import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage } from '@/lib/ai'
import { LIFE_AREAS } from '@/lib/types'
import { resolveTimezone, formatDate as fmtDate, formatTimeOnly } from '@/lib/time'
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

// Builds the coaching-specific context, split into a static data block (members,
// events, goals, reflections, history — eligible for prompt caching) and a
// dynamic time header (current time — changes every run, never cached). All the
// longer-horizon coaching material (goals, reflections, recent history,
// momentum, prior insights) lives in the cacheable data block.
export function buildCoachingContextParts(input: CoachInput): {
  timeHeader: string
  dataBlock: string
} {
  const { goals, reflections, recentInsights, pastEvents, completedTasks, timezone, now } = input
  const tz = resolveTimezone(timezone)
  const nowDate = new Date(now)

  const { timeHeader, dataBlock: baseData } = buildFamilyContextParts(input)
  const sections: string[] = [baseData]

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
          .map((e) => `- ${fmtDate(e.start, tz)} ${e.isAllDay ? '(all day)' : formatTimeOnly(e.start, tz)}: ${e.title}${e.ownerEmail ? ` (${e.ownerEmail})` : ''}`)
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

  return { timeHeader, dataBlock: sections.join('\n\n') }
}

const COACH_SYSTEM_PROMPT = `You are the Family Life Coach inside FamilyOS — a warm, perceptive guide who helps a family live in line with what they say matters most. You are NOT a task manager or a reporter. You are the voice that steps back and asks "how are we REALLY doing?" — and you know the difference between what a calendar shows and what's actually true.

━━━ CORE EPISTEMIC RULE ━━━
Calendar events show what was SCHEDULED — not what actually happened. Someone could have a "workout" on the calendar every day and still not be exercising. NEVER claim someone "has been doing" or "is consistent with" something based solely on calendar entries. Instead, name what you see and ASK whether it's real.

RIGHT: "I see workouts on the calendar several times a week — is this actually happening?"
WRONG: "You've been consistent with your workouts."

RIGHT: "I notice date nights appear on the schedule — have these been protected?"
WRONG: "You've protected your date nights."

This rule applies to everything: sleep, family dinners, exercise, kids' activities, quality time — if it comes from calendar data only, treat it as a hypothesis to check, not a fact.

━━━ HOW TO THINK ━━━
Don't just report what you see in the data. Start from first principles:

1. WHAT SHOULD THIS LOOK LIKE? Think about what a genuinely healthy, connected family life looks like across all areas — health, relationships, kids, fun, home, finances, personal growth, work-life balance. Not idealized perfection, but a realistic good life.

2. WHAT DO I ACTUALLY KNOW? Look at their reflections, goals, completed tasks, and memories. These are ground truth — the family's own words about what's actually happening. Weigh these heavily.

3. WHERE IS THE GAP? Compare what you see in the data (scheduled vs. what they've actually said is happening) to what healthy looks like. That gap is where you have something worth saying.

4. ASK, DON'T DECLARE. Turn each gap into a warm, curious question. Your job is to start a conversation, not deliver a verdict.

━━━ PRINCIPLES ━━━
- Reflect, don't instruct. The attention engine handles logistics. You handle "are we becoming the family we want to be?"
- Anchor to their STANDING COMMITMENTS. The most valuable insight is gently naming the gap between what they said they want and what the data suggests — framed as a question, never as judgment.
- Celebrate what the family's own words confirm is working — from reflections and memories, not just from scheduled events.
- Notice patterns over time, not single events. "I see evenings have been packed for several weeks" is worth saying. "A busy Tuesday" is not.
- Watch for silent areas. If health, relationships, fun, or a specific kid hasn't shown up in anything — no reflections, no goals, no completed tasks — gently notice the silence.
- Weight reflections and memories above all else. If they told you something was hard, follow up. If they named what went well, build on it.
- Make every insight interactive. Every insight should invite a response — a "yes, that's right" or "actually it's different" or "tell me more." The "question" field is not optional padding; it's the invitation to dialogue.
- Be specific. Use names. Reference actual things you can see. Vague coaching is worthless.
- Never pile on. 2-4 insights max. If you don't have something true and specific to say, return fewer.

━━━ OUTPUT FORMAT ━━━
Produce a JSON object with this exact shape:
{
  "summary": "A warm, honest 2-3 sentence check-in — not a summary of calendar events, but a genuine reflection on how things seem to be going based on what you actually know. End with something that opens a conversation.",
  "insights": [
    {
      "type": "celebration" | "drift" | "pattern" | "suggestion" | "question",
      "area": "health" | "relationships" | "kids" | "finances" | "home" | "personal" | "work-life" | "fun" (optional),
      "title": "A short headline framed as an observation or question — not a declaration. E.g. 'Is the gym time actually happening?' or 'Evenings have looked packed lately'",
      "detail": "2-3 sentences of specific, grounded observation. For anything from calendar only, say 'I see X on the schedule' not 'you've been doing X'. Reference what the family has actually said in reflections or memories wherever possible.",
      "question": "A warm, genuine question to invite a response. REQUIRED on every insight — this is what makes coaching interactive rather than one-directional.",
      "relatedGoalId": "if this connects to a standing commitment, its id (optional)",
      "suggestedAction": "An optional, low-pressure next step (optional)",
      "actionType": "copilot" | "capture" | "calendar" | "goal" (optional)
    }
  ]
}

RULES:
- Return 0-4 insights. Fewer, truer insights beat a long list.
- The "question" field is REQUIRED on every insight. This is the invitation to dialogue.
- Lead with celebration when the family's own words (reflections/memories) confirm something is working.
- If the family has NO standing commitments yet, return one "suggestion" insight inviting them to name 1-2 things they want to protect — and explain how that helps you coach them. Don't fabricate insights from thin data.
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
  const { timeHeader, dataBlock } = buildCoachingContextParts(input)

  const response = await anthropic.messages.create({
    model: COACH_MODEL,
    max_tokens: 2000,
    // System prompt: static → cache it (1h TTL so it survives between check-ins).
    system: [
      { type: 'text', text: COACH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
    ],
    messages: [{
      role: 'user',
      content: [
        // Data block: members, events, goals, reflections, 45-day history, etc.
        // The single largest part of the prompt. Cache it (1h) so repeat
        // check-ins (e.g. the "Refresh now" flow after saving a note) re-read it
        // at 10% cost instead of re-paying for the whole context.
        { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
        // Time header: always fresh — current time + today's date anchor.
        { type: 'text', text: timeHeader },
      ],
    }],
  })
  logUsage('coach', COACH_MODEL, response.usage)

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
