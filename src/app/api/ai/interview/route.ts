import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { logUsage } from '@/lib/ai'

const MODEL = 'claude-sonnet-4-6'

// The Interview Engine — how the app proactively gets to know the user instead
// of waiting to be told. Two modes:
//   • question: look at everything known (and how old it is) and pick the ONE
//     most valuable thing to ask right now. Either a LEARN question (new
//     ground) or a REFRESH question (an aging fact that may no longer be true —
//     work priorities, temporary states, logistics).
//   • ingest: take the user's answer and distill it into structured ops the
//     client applies — new memories, profile updates, expiring stale facts,
//     goal changes. The user never fills a form; they just answer one question.

type KnowledgeDigest = {
  members?: { name: string; role?: string }[]
  profile?: Record<string, unknown> | null
  personalProfile?: Record<string, unknown> | null
  memories?: { id: string; text: string; category?: string; notedOn: string; aging?: boolean; pinned?: boolean }[]
  goals?: { id: string; text: string; area?: string; cadence?: string }[]
  recentQuestions?: string[]
  now?: string
  timezone?: string
}

type InterviewInput = KnowledgeDigest & {
  mode: 'question' | 'ingest'
  question?: string
  questionKind?: 'learn' | 'refresh'
  target?: { type: 'memory' | 'goal'; id: string; currentText: string }
  answer?: string
}

function buildDigest(ctx: KnowledgeDigest): string {
  const parts: string[] = []
  if (ctx.members?.length) {
    parts.push(`FAMILY: ${ctx.members.map((m) => `${m.name}${m.role ? ` (${m.role})` : ''}`).join(', ')}`)
  }
  if (ctx.personalProfile && Object.keys(ctx.personalProfile).length) {
    parts.push(`SIGNED-IN USER'S PROFILE (their "about me"):\n${JSON.stringify(ctx.personalProfile, null, 1).slice(0, 2400)}`)
  }
  if (ctx.profile) {
    parts.push(`HOUSEHOLD PROFILE:\n${JSON.stringify(ctx.profile, null, 1).slice(0, 1200)}`)
  }
  if (ctx.goals?.length) {
    parts.push(`ACTIVE GOALS/COMMITMENTS:\n${ctx.goals.map((g) => `  - id:${g.id} [${g.area ?? '?'}] ${g.text}${g.cadence ? ` (${g.cadence})` : ''}`).join('\n')}`)
  }
  if (ctx.memories?.length) {
    parts.push(`KNOWN FACTS/MEMORIES (with when they were last noted or confirmed; "AGING" = old enough it may no longer be true):\n${ctx.memories
      .slice(0, 80)
      .map((m) => `  - id:${m.id}${m.category ? ` [${m.category}]` : ''} ${m.text} (${m.notedOn}${m.aging ? ', AGING' : ''}${m.pinned ? ', pinned' : ''})`)
      .join('\n')}`)
  }
  if (ctx.recentQuestions?.length) {
    parts.push(`RECENTLY ASKED (do NOT repeat these or near-duplicates):\n${ctx.recentQuestions.map((q) => `  - ${q}`).join('\n')}`)
  }
  parts.push(`Current time: ${ctx.now ?? new Date().toISOString()}${ctx.timezone ? ` (${ctx.timezone})` : ''}`)
  return parts.join('\n\n')
}

const QUESTION_PROMPT = `You are the "getting to know you" engine inside a family assistant. The user finds it hard to think of what to tell the app, so YOU carry that load: study everything already known about them, find the highest-value gap or the most-likely-stale fact, and ask ONE question.

Pick ONE of two kinds:
• "refresh" — verify that a specific EXISTING fact/goal is STILL TRUE. This is answered with three buttons — [Still true] / [It changed…] / [No longer] — so it MUST be phrased as a confirmable statement, not an open question.
   · Valid targets: an ONGOING, currently-true state that could plausibly have shifted since it was noted — a current work priority, an active arrangement (carpool, sitter), a temporary condition, a person's current phase or focus. Reference it exactly (target id + current text).
   · INVALID targets — never pick these: a CONCLUDED or past-dated event ("grounding ended July 2nd", "trip last month"), a settled historical record, a birthday/anniversary, or anything with a clear resolution already in the past. Those don't "go stale", they just recede — leave them alone.
   · Phrasing: a warm but yes/no-answerable check, e.g. "Is the Q3 board deck still your top work priority?" or "Is Thursday-with-grandma still the standing childcare arrangement?" NEVER an open "how's it going / how have they been doing" question — the buttons can't answer that.
• "learn" — new ground, OR an open check-in you can't reduce to a yes/no. Answered with a text box only. Highest-value unknowns, roughly in order: current work priorities & schedule shape; each key relationship and what "investing in it" looks like for them; what a good vs. bad day looks like; recurring weekly rhythm not on the calendar; what they're avoiding and why; each kid's current phase/needs; what they want more/less of. An open follow-up like "how has Maddie been doing since the grounding ended?" is a LEARN question, not a refresh.

Rules for the question itself:
- ONE question, conversational, specific, answerable in one or two sentences on a phone. Never a form, never multi-part ("and also...").
- If it can't be answered with [Still true]/[It changed]/[No longer], it MUST be kind "learn" — do not label an open question "refresh".
- Never ask anything already answered in the digest. Never repeat RECENTLY ASKED topics.
- Include a one-line "why" (how the answer will actually be used — e.g. "so I stop planning around stale work priorities").

Output ONLY JSON: {"question":{"text":"...","why":"...","kind":"learn"|"refresh","target":{"type":"memory"|"goal","id":"<exact id>","currentText":"..."} (refresh only, omit for learn)}}`

const INGEST_PROMPT = `You are the knowledge-distiller inside a family assistant. The user just answered a getting-to-know-you question. Convert their answer into the SMALLEST set of precise knowledge operations. You can see everything already known — never duplicate an existing fact; prefer updating/expiring over adding parallel versions.

Available ops (emit only what the answer justifies, usually 1-3):
- {"op":"add_memory","text":"...","category":"fact|preference|routine|health|logistics|relationship|other","subjectNames":["Name"] (optional),"expiresAt":"YYYY-MM-DD" (only for clearly time-bound facts)}
  · "text" must be a durable, third-person-useful statement ("Eric's top work priority is the Q3 board deck, due mid-August"), not a transcript.
- {"op":"update_memory","id":"<existing id>","text":"<corrected text>"} — when the answer changes an existing fact.
- {"op":"expire_memory","id":"<existing id>"} — when the answer says a fact is no longer true.
- {"op":"refresh_memory","id":"<existing id>"} — when the answer confirms an existing fact unchanged.
- {"op":"deactivate_goal","id":"<goal id>"} — a commitment they say no longer matters.
- {"op":"add_goal","text":"...","area":"health|relationships|kids|finances|home|personal|work-life|fun","cadence":"..." (optional),"why":"..." (optional)} — ONLY when they clearly state an ongoing intention.
- {"op":"update_profile","patch":{...}} — for facts that belong on their personal profile. Allowed keys ONLY: goals (string[]), biggestStruggle, energizers (string[]), drainers (string[]), startStrategies (string[]), avoiding (string[]), rhythm, fixedAnchors (string[]), householdRoles, careSchedule, planStyle ("minimal"|"balanced"|"packed"), protectRest (boolean), nonNegotiables (string[]), freeform. For array keys, return the FULL merged array (existing values plus/minus changes) — the patch replaces the field.

Also return "learned": one warm sentence, second person, confirming what you took away ("Got it — your work focus shifted to the hiring push; I'll drop the old launch priority.").

If the answer is a skip/non-answer, return {"ops":[],"learned":""}.
Output ONLY JSON: {"ops":[...],"learned":"..."}`

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }
  let ctx: InterviewInput
  try { ctx = (await request.json()) as InterviewInput } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const digest = buildDigest(ctx)
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    if (ctx.mode === 'question') {
      const msg = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system: [{ type: 'text', text: QUESTION_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
        messages: [{ role: 'user', content: digest }],
      }, { signal: request.signal })
      logUsage('interview-q', MODEL, msg.usage)
      const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
      const match = text.match(/\{[\s\S]*\}/)
      const parsed = match ? JSON.parse(match[0]) : {}
      const q = parsed.question
      if (!q?.text) return NextResponse.json({ error: 'No question generated — try again.' }, { status: 502 })
      return NextResponse.json({ question: q })
    }

    // ingest
    const answerBlock = `\n\nTHE QUESTION ASKED (${ctx.questionKind ?? 'learn'}): "${ctx.question ?? ''}"${
      ctx.target ? `\nIt was a refresh of ${ctx.target.type} id:${ctx.target.id} — current text: "${ctx.target.currentText}"` : ''
    }\n\nTHE USER'S ANSWER: "${(ctx.answer ?? '').slice(0, 1500)}"`
    const msg = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 900,
      system: [{ type: 'text', text: INGEST_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: digest + answerBlock }],
    }, { signal: request.signal })
    logUsage('interview-ingest', MODEL, msg.usage)
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : {}
    return NextResponse.json({
      ops: Array.isArray(parsed.ops) ? parsed.ops.slice(0, 6) : [],
      learned: typeof parsed.learned === 'string' ? parsed.learned : '',
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return NextResponse.json({ error: 'aborted' }, { status: 499 })
    const errMsg = e instanceof Error ? e.message : 'Interview engine failed'
    console.error('[interview] error', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
