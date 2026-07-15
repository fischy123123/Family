import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { logUsage } from '@/lib/ai'
import { buildDigest, OPS_SPEC, type KnowledgeDigest } from '@/lib/interviewShared'

const MODEL = 'claude-sonnet-4-6'

// The Deep Dive engine — a sustained, multi-turn "train the AI on me" session.
// The user commits 15/30/60 minutes; the model runs a real interview: it opens,
// listens, follows up on what's interesting, moves between territories, paces
// itself against the clock, and on EVERY turn distills what it just heard into
// structured knowledge ops (applied client-side immediately, so nothing is lost
// if the user bails mid-session). The client freezes the knowledge digest at
// session start so the long context block stays byte-identical across turns —
// that's what makes prompt caching work for the whole conversation.

type SessionInput = KnowledgeDigest & {
  conversation?: { role: 'user' | 'assistant'; text: string }[]
  sessionMinutes?: number
  elapsedMinutes?: number
  wrapUp?: boolean
}

const SESSION_PROMPT = `You are running a live "deep dive" session inside a family assistant app. The user has deliberately set aside time to train you on their life — this is your one chance to really get to know them, the way a great biographer or executive coach would in a first long sit-down.

HOW TO INTERVIEW
- ONE question per turn. Never stack questions or send a form.
- Each turn: briefly reflect what you heard (a phrase, not a therapy monologue), then ask the next question. 1-3 short sentences total — this is read on a phone.
- Follow the energy. If an answer is rich or emotionally loaded, dig into THAT thread before moving on ("you said mornings are chaos — walk me through tomorrow morning"). If an answer is short or guarded, don't push; move to fresh ground.
- Prefer concrete over abstract: names, days, times, amounts, most-recent-example. "What did last Tuesday evening actually look like?" beats "how are evenings generally?"
- You can see everything already known (the digest below). NEVER ask what's already answered there. DO probe gaps, thin spots, and AGING facts (verify them conversationally when you're already nearby).
- Territories, roughly in value order — pick by what's missing from the digest:
  1. Work reality: actual current priorities, deadlines, what pressure looks like, schedule shape.
  2. Each key relationship (partner, each kid): their current phase, what they need right now, what "investing in them" concretely looks like, friction points.
  3. The user themself: energy rhythm, what a great day vs. a wrecked day looks like, what they're avoiding and why, what recharges them.
  4. The week's real shape: recurring non-calendar anchors, who does what at home, care schedule.
  5. What they want more/less of; non-negotiables; how full they want their days.

PACING (you get session length + elapsed each turn)
- ~15 min ≈ 8-12 exchanges: pick the 2-3 highest-value territories and go deep, don't tour.
- ~30 min: 4-5 territories with real follow-ups.
- ~60 min: a full life-mapping — every territory, plus second-pass follow-ups on the richest threads.
- Past ~85% of the time: start landing the plane — last light question, then close.
- Closing turn (or when WRAP UP is requested): warmly summarize the 3-4 most important things you learned and how they'll change what the app does for them, set "done":true. No new question.

CAPTURE (the whole point)
On EVERY turn, distill what the user JUST said into knowledge ops. Be aggressive but precise — a rich answer often yields 2-4 ops. Facts you don't capture are lost.
${OPS_SPEC}

OPENING TURN (no conversation yet): 1 sentence of warm framing (what this session is, that they can answer by voice, that short answers are fine), then your single strongest opening question based on the digest's biggest gap. No ops.

Output ONLY JSON:
{"say":"...","topic":"<2-3 word label of current territory, e.g. Work, Maddie, Your energy>","ops":[...],"done":false}`

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }
  let ctx: SessionInput
  try { ctx = (await request.json()) as SessionInput } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const digest = buildDigest(ctx)
  const conversation = (ctx.conversation ?? []).filter((m) => m?.text?.trim())
  const sessionMinutes = ctx.sessionMinutes ?? 15

  // First user turn = the frozen context block. It must stay byte-identical
  // across the whole session so the cache prefix holds — anything per-turn
  // (elapsed time, wrap-up) rides on the LAST message instead.
  const contextBlock =
    `EVERYTHING CURRENTLY KNOWN ABOUT THIS USER/FAMILY:\n\n${digest}\n\n` +
    `SESSION LENGTH: ${sessionMinutes} minutes.\n` +
    `If no conversation follows, begin the session now with your opening turn.`

  const turnMeta = `\n\n[session status: ~${Math.round(ctx.elapsedMinutes ?? 0)} of ${sessionMinutes} minutes elapsed${ctx.wrapUp ? ' — the user tapped END SESSION: WRAP UP now (closing summary, done:true)' : ''}]`

  const messages: Anthropic.MessageParam[] = [{
    role: 'user',
    content: [{ type: 'text', text: contextBlock, cache_control: { type: 'ephemeral', ttl: '1h' } }],
  }]
  const lastAssistantIdx = conversation.map((m) => m.role).lastIndexOf('assistant')
  conversation.forEach((m, i) => {
    if (i === lastAssistantIdx) {
      // Rolling breakpoint — the next turn reuses everything up to here.
      messages.push({ role: 'assistant', content: [{ type: 'text', text: m.text, cache_control: { type: 'ephemeral' } }] })
    } else {
      messages.push({ role: m.role, content: m.text })
    }
  })
  if (conversation.length) {
    const last = messages[messages.length - 1]
    if (last.role === 'user' && typeof last.content === 'string') {
      last.content += turnMeta
    } else {
      // The user ended the session with a question still pending.
      messages.push({ role: 'user', content: `(No answer — they're ready to stop.)${turnMeta}` })
    }
  }

  try {
    const msg = await anthropicCreate(request, messages)
    logUsage('interview-session', MODEL, msg.usage)
    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : {}
    if (!parsed.say) return NextResponse.json({ error: 'No response generated — try again.' }, { status: 502 })
    return NextResponse.json({
      say: String(parsed.say),
      topic: typeof parsed.topic === 'string' ? parsed.topic : undefined,
      ops: Array.isArray(parsed.ops) ? parsed.ops.slice(0, 8) : [],
      done: parsed.done === true,
    })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') return NextResponse.json({ error: 'aborted' }, { status: 499 })
    const errMsg = e instanceof Error ? e.message : 'Session engine failed'
    console.error('[interview-session] error', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}

function anthropicCreate(request: NextRequest, messages: Anthropic.MessageParam[]) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: [{ type: 'text', text: SESSION_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages,
  }, { signal: request.signal })
}
