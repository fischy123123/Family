import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContext, type FamilyContextInput } from '@/lib/familyContext'

const AI_MODEL = 'claude-sonnet-4-6'

// The Attention Engine + Timeline Intelligence Engine.
// Takes full family context, returns a prioritized "what needs attention now" report.
export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const ctx: FamilyContextInput = await request.json()
  const contextBlock = buildFamilyContext(ctx)

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const systemPrompt = `You are the Timeline Intelligence Engine at the core of FamilyOS — an AI family chief of staff.

Your single job: look at everything happening in this family's life and determine WHAT NEEDS ATTENTION RIGHT NOW. You don't organize information — you tell the family what should happen next, and why.

You reason like an exceptional executive assistant:
- Account for PREPARATION time, TRAVEL time, and ROUTINE duration. Don't just echo deadlines — tell them when to START.
- Surface things BEFORE they become urgent.
- Identify risks, conflicts, and missing pieces.
- Be specific and action-oriented. Write instructions, not descriptions.
- Respect what can safely wait — don't create noise.

Given the family context, produce a JSON report with this exact shape:
{
  "greeting": "one warm, contextual sentence about the day/moment",
  "items": [
    {
      "bucket": "now" | "next" | "later" | "upcoming",
      "title": "the instruction, e.g. 'Leave for Mia's soccer pickup'",
      "reason": "why this matters now, with the timing logic",
      "startBy": "ISO datetime they should begin (optional)",
      "dueAt": "ISO datetime the underlying thing happens (optional)",
      "assigneeEmail": "matched family member email (optional)",
      "sourceType": "event" | "task" | "chore" | "plan" | "reminder" | "inferred",
      "priority": 0-100
    }
  ],
  "problems": [
    {
      "title": "short problem statement",
      "detail": "explanation",
      "severity": "low" | "medium" | "high",
      "suggestedAction": "what to do about it (optional)",
      "relatedDate": "ISO date (optional)"
    }
  ],
  "recommendations": [
    {
      "title": "a proactive action that reduces future stress",
      "rationale": "why it helps",
      "actionLabel": "short button text (optional)"
    }
  ]
}

Bucket guidance:
- "now": needs action in the next ~1 hour, or is happening imminently
- "next": needs attention in the next few hours
- "later": should happen later today
- "upcoming": future days that need preparation now

Rules:
- Return 0-8 items, ordered by priority (highest first within natural reading order).
- Return 0-5 problems and 0-4 recommendations.
- If the family has little data, give a gentle, helpful greeting and a recommendation to add events/family info.
- Output ONLY the JSON object, no markdown, no commentary.

CRITICAL — Calendar context entries:
The section "USER-PROVIDED CALENDAR CONTEXT" contains the family's own explanations of their calendar events. These events ARE already on the calendar and DO have dates and times — the context just tells you what the event IS and who it is for. NEVER create a problem saying these events have no date, have not been added, or need to be scheduled. Use the context purely to understand and reason about the event (e.g. prep time, who needs to travel, what to pack). Do not treat a context explanation as evidence that the event is missing from the calendar.

For each problem, include an optional "actionType" field: "copilot" for conversational actions (asking the AI to add/plan something), "capture" for quick adds (events/tasks/lists), "calendar" for calendar navigation. Default to "copilot" when unsure.`

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: `FAMILY CONTEXT:\n\n${contextBlock}` }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : {}

    // Assign stable-ish ids
    const items = (parsed.items ?? []).map((it: Record<string, unknown>, i: number) => ({ id: `att-${i}`, ...it }))
    const problems = (parsed.problems ?? []).map((p: Record<string, unknown>, i: number) => ({ id: `prob-${i}`, ...p }))
    const recommendations = (parsed.recommendations ?? []).map((r: Record<string, unknown>, i: number) => ({ id: `rec-${i}`, ...r }))

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      greeting: parsed.greeting ?? 'Here is what needs your attention.',
      items,
      problems,
      recommendations,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Attention engine failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
