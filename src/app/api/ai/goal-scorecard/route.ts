import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { logUsage } from '@/lib/ai'
import type { FamilyGoal, Reflection, GoalGrade } from '@/lib/types'

const MODEL = 'claude-sonnet-4-6'

// One day's worth of planned activity, distilled to what matters for grading.
type ActivityDay = {
  date: string
  items: { title: string; category?: string; kind?: string; done: boolean }[]
}

type ScorecardInput = {
  goals: FamilyGoal[]
  reflections?: Reflection[]
  activity: ActivityDay[]
  timezone?: string
}

const SYSTEM_PROMPT = `You are a candid, encouraging accountability coach. You grade how a person is doing against EACH of their standing goals/commitments, based ONLY on what they actually planned and completed (and planned-but-missed) over recent days.

You are given:
- GOALS: each has an id, the commitment text, a life area, an optional cadence, and an optional "why".
- RECENT ACTIVITY: their daily plans for recent days. Each item has a title, a type, and whether it was completed (✓) or not (✗ = planned but not done).

For EACH goal, judge how well their recent behavior advanced it:
- MAP activity to goals by meaning, not exact words — a "gym"/"walk"/"run" item advances a "move my body" goal; a "family dinner"/"call mom" advances a connection goal; "no work after 6" relates to a boundary goal, etc. One item can support more than one goal.
- COMPLETED items count strongly in the goal's favor. PLANNED-BUT-MISSED items (✗) count against it — repeated misses on a goal-relevant activity mean they're slipping. A goal with NO related activity at all is stalled (be honest, low score).
- Weigh against the goal's cadence when given (e.g. "4x/week" — did they hit roughly that?).
- score 0-100. status: "on_track" (>=75), "building" (50-74), "slipping" (25-49), "stalled" (<25).
- headline: 3-6 words. story: 2-3 HONEST sentences that cite SPECIFIC evidence (name the real items they did and missed) and end with one concrete nudge for the days ahead. No vague platitudes — point to the actual data.

Also write a short OVERALL summary (1-2 sentences) naming the brightest spot and the area most in need of attention.

Output ONLY this JSON, nothing else:
{"overall":"...","cards":[{"goalId":"<exact id from GOALS>","status":"on_track|building|slipping|stalled","score":0-100,"headline":"...","story":"..."}]}
Include exactly one card per goal, using the goal's exact id.`

function buildContext(input: ScorecardInput): string {
  const goalLines = input.goals.map((g) =>
    `- id:${g.id} [${g.area}] "${g.text}"${g.cadence ? ` (cadence: ${g.cadence})` : ''}${g.why ? ` — why: ${g.why}` : ''}`,
  ).join('\n')

  const activityLines = input.activity
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))  // newest first
    .map((d) => {
      const items = d.items.map((it) => `${it.done ? '✓' : '✗'} ${it.title}${it.category ? ` [${it.category}]` : ''}`).join('; ')
      return `  ${d.date}: ${items || '(no items)'}`
    }).join('\n')

  const reflections = (input.reflections ?? [])
    .slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 2)
    .map((r) => {
      const parts: string[] = []
      if (r.wentWell) parts.push(`went well: ${r.wentWell}`)
      if (r.wasHard) parts.push(`was hard: ${r.wasHard}`)
      if (r.wouldChange) parts.push(`would change: ${r.wouldChange}`)
      return `  - ${parts.join('; ')}`
    }).join('\n')

  return [
    `GOALS:\n${goalLines || '(none)'}`,
    `RECENT ACTIVITY (daily plans; ✓ = completed, ✗ = planned but not done):\n${activityLines || '(no recent plans)'}`,
    reflections ? `RECENT REFLECTIONS:\n${reflections}` : '',
  ].filter(Boolean).join('\n\n')
}

const GRADES: GoalGrade[] = ['on_track', 'building', 'slipping', 'stalled']

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }
  let ctx: ScorecardInput
  try { ctx = (await request.json()) as ScorecardInput } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!ctx.goals?.length) {
    return NextResponse.json({ overall: '', cards: [], generatedAt: new Date().toISOString() })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  try {
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1800,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: buildContext(ctx) }],
    }, { signal: request.signal })

    logUsage('goal-scorecard', MODEL, msg.usage)
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    let parsed: Record<string, unknown> = {}
    try { if (match) parsed = JSON.parse(match[0]) } catch { /* fall through */ }

    const validIds = new Set(ctx.goals.map((g) => g.id))
    const cards = (Array.isArray(parsed.cards) ? parsed.cards : [])
      .map((c) => {
        const r = c as Record<string, unknown>
        const goalId = typeof r.goalId === 'string' ? r.goalId : ''
        if (!validIds.has(goalId)) return null
        const status = typeof r.status === 'string' && GRADES.includes(r.status as GoalGrade) ? (r.status as GoalGrade) : 'building'
        const score = typeof r.score === 'number' ? Math.max(0, Math.min(100, Math.round(r.score))) : 50
        return {
          goalId, status, score,
          headline: typeof r.headline === 'string' ? r.headline.trim() : '',
          story: typeof r.story === 'string' ? r.story.trim() : '',
        }
      })
      .filter(Boolean)

    return NextResponse.json({
      overall: typeof parsed.overall === 'string' ? parsed.overall.trim() : '',
      cards,
      generatedAt: new Date().toISOString(),
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return NextResponse.json({ error: 'aborted' }, { status: 499 })
    const errMsg = e instanceof Error ? e.message : 'Scorecard failed'
    console.error('[goal-scorecard] error', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
