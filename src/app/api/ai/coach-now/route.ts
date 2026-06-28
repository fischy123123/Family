import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage } from '@/lib/ai'
import {
  MOMENT_COACH_MODEL, MOMENT_COACH_MAX_TOKENS, MOMENT_COACH_SYSTEM_PROMPT,
} from '@/lib/momentCoachPrompt'
import type {
  PersonalProfile, MomentEnergy, MomentMood, MomentGuidance, MomentMove, MomentCheckIn,
} from '@/lib/types'

const MODEL = MOMENT_COACH_MODEL

// The Moment Coach engine. Takes the same family context as the attention engine
// (so it sees the real calendar, tasks, and people) PLUS the signed-in person's
// personal profile and their current energy/mood check-in, and returns ONE
// in-the-moment move tuned to how they feel right now.
type CoachNowInput = FamilyContextInput & {
  personalProfile?: PersonalProfile | null
  energy?: MomentEnergy
  mood?: MomentMood
  // Free-text / transcribed "what's going on right now" — the highest-signal
  // situational input, true only for this moment and present nowhere in the data.
  situation?: string
  // Titles of tasks the user has already completed today — momentum to build on.
  completedToday?: string[]
  // The user's recent logged check-ins, so the coach can read trends across
  // days (recurring drain, repeated situations) and address the pattern.
  recentCheckins?: MomentCheckIn[]
}

// Render the "ABOUT ME" block from the user's personal profile. This is the
// highest-priority personalization signal for the coach — kept compact.
function buildAboutMe(p?: PersonalProfile | null): string {
  if (!p) return ''
  const lines: string[] = []
  if (p.goals?.length) lines.push(`What I'm working toward: ${p.goals.join('; ')}`)
  if (p.biggestStruggle) lines.push(`What most gets in my way: ${p.biggestStruggle}`)
  if (p.hasAdhd) lines.push(`I have ADHD — task initiation is hard; tiny first steps and momentum help me a lot.`)
  if (p.startStrategies?.length) lines.push(`Things that actually help me start: ${p.startStrategies.join('; ')}`)
  if (p.energizers?.length) lines.push(`What energizes me: ${p.energizers.join('; ')}`)
  if (p.drainers?.length) lines.push(`What drains me: ${p.drainers.join('; ')}`)
  if (p.avoiding?.length) lines.push(`Things I keep putting off: ${p.avoiding.join('; ')}`)
  if (p.freeform) lines.push(`Also: ${p.freeform}`)
  if (!lines.length) return ''
  return `\n\nABOUT ME (the signed-in person — highest-priority personalization. Tune every suggestion to this person; use a start-strategy they told you works):\n${lines.join('\n')}`
}

// Render the current-state check-in. This is decisive for the coach — it sizes
// and shapes the move to how the person actually feels in this moment.
function buildCheckIn(energy?: MomentEnergy, mood?: MomentMood, completedToday?: string[]): string {
  const parts: string[] = []
  if (energy) parts.push(`Energy right now: ${energy}`)
  if (mood) parts.push(`Mood right now: ${mood}`)
  const done = (completedToday ?? []).filter(Boolean)
  if (done.length) {
    parts.push(`Already done today (momentum to build on / celebrate): ${done.slice(0, 8).join('; ')}`)
  } else {
    parts.push(`Nothing checked off yet today.`)
  }
  if (!parts.length) return ''
  return `\n\nRIGHT-NOW CHECK-IN (decisive — match the move to this state; a drained person should not be handed the hardest task):\n${parts.join('\n')}`
}

// The free-text "what's going on right now." This is the single highest-signal
// input — it's true only for this moment and appears nowhere else in the data.
function buildSituation(situation?: string): string {
  const s = (situation ?? '').trim()
  if (!s) return ''
  return `\n\nWHAT'S HAPPENING RIGHT NOW (the user just told you, in their own words — TREAT THIS AS THE MOST IMPORTANT INPUT. It overrides assumptions; build the move around what they actually said):\n"${s.slice(0, 800)}"`
}

// Recent check-ins → a compact trend block. Lets the coach notice patterns
// across days (recurring drain, the same situation repeating, moves that never
// get done) and speak to the pattern instead of treating each moment in
// isolation. Most-recent first; capped so the prompt stays tight.
function buildTrends(recent?: MomentCheckIn[]): string {
  const items = (recent ?? [])
    .filter((c) => c && c.ts)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 12)
  if (items.length < 2) return ''  // need at least a couple to be a "trend"
  const lines = items.map((c) => {
    const when = (() => {
      try {
        return new Date(c.ts).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
      } catch { return c.ts }
    })()
    const bits = [`energy ${c.energy}`]
    if (c.mood) bits.push(`mood ${c.mood}`)
    if (c.situation) bits.push(`"${c.situation.slice(0, 100)}"`)
    if (c.outcome) bits.push(c.outcome === 'did_it' ? '✓ acted on it' : 'moved past it')
    return `  - ${when}: ${bits.join(', ')}`
  })
  return `\n\nRECENT CHECK-INS (this person's last several moments with you — newest first. Look for PATTERNS: a recurring low/drain at a certain time, the same situation coming up again and again, or suggestions that keep going undone. When you see a real pattern, gently name it and let the move address the pattern, not just this instant. Don't force a pattern that isn't there):\n${lines.join('\n')}`
}

// Coerce one move object from the model into a typed MomentMove, dropping junk.
function coerceMove(raw: unknown): MomentMove | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  if (!title) return undefined
  const kinds = ['family', 'personal', 'rest', 'admin', 'connection']
  const kind = typeof r.kind === 'string' && kinds.includes(r.kind) ? (r.kind as MomentMove['kind']) : undefined
  const minutes = typeof r.minutes === 'number' && r.minutes > 0 && r.minutes < 600 ? Math.round(r.minutes) : undefined
  return {
    title,
    why: typeof r.why === 'string' ? r.why.trim() : '',
    firstStep: typeof r.firstStep === 'string' ? r.firstStep.trim() : '',
    minutes,
    kind,
  }
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const reqStart = Date.now()
  let ctx: CoachNowInput
  try {
    ctx = (await request.json()) as CoachNowInput
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  // The static, cacheable family context — identical to what the attention
  // engine builds, so this call shares the family-context cache entry.
  const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)
  const aboutMe = buildAboutMe(ctx.personalProfile)
  const checkIn = buildCheckIn(ctx.energy, ctx.mood, ctx.completedToday)
  const situation = buildSituation(ctx.situation)
  const trends = buildTrends(ctx.recentCheckins)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const msg = await anthropic.messages.create(
      {
        model: MODEL,
        max_tokens: MOMENT_COACH_MAX_TOKENS,
        system: [
          { type: 'text', text: MOMENT_COACH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{
          role: 'user',
          content: [
            // Reuse the same cached family data block as the attention engine.
            { type: 'text', text: `FAMILY CONTEXT:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
            // Fresh tail: time anchor + this person + how they feel right now +
            // what they said is happening + their recent-check-in trends.
            { type: 'text', text: timeHeader + aboutMe + checkIn + situation + trends },
          ],
        }],
      },
      { signal: request.signal },
    )

    logUsage('coach-now', MODEL, msg.usage)

    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    let parsed: Record<string, unknown> = {}
    try { if (match) parsed = JSON.parse(match[0]) } catch { /* fall through to error below */ }

    const primary = coerceMove(parsed.primary)
    if (!primary) {
      return NextResponse.json({ error: 'Coach could not form a suggestion — tap to try again.' }, { status: 502 })
    }

    const guidance: MomentGuidance = {
      pep: typeof parsed.pep === 'string' ? parsed.pep.trim() : '',
      primary,
      fallback: coerceMove(parsed.fallback),
      bigPicture: typeof parsed.bigPicture === 'string' && parsed.bigPicture.trim() ? parsed.bigPicture.trim() : undefined,
      generatedAt: new Date().toISOString(),
      energy: ctx.energy,
      mood: ctx.mood,
    }

    console.log(`[coach-now] wall=${Date.now() - reqStart}ms energy=${ctx.energy ?? '-'} mood=${ctx.mood ?? '-'} kind=${primary.kind ?? '-'} stop=${msg.stop_reason}`)

    return NextResponse.json(guidance)
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'aborted' }, { status: 499 })
    }
    const errMsg = e instanceof Error ? e.message : 'Moment Coach failed'
    console.error('[coach-now] error', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
