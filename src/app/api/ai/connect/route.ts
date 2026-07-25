import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { buildFamilyContextParts, type FamilyContextInput } from '@/lib/familyContext'
import { logUsage } from '@/lib/ai'
import { CONNECT_MODEL, CONNECT_MAX_TOKENS, CONNECT_SYSTEM_PROMPT } from '@/lib/connectPrompt'
import type { Connection, ConnectionMove } from '@/lib/types'

// The Connections Engine — the app's primary reasoning surface. One call, one
// job: read every source together and return cross-source insights the user
// could not get from any single view, each with its evidence and a first move.

type ConnectInput = FamilyContextInput & {
  goals?: { text: string; area?: string; cadence?: string; why?: string }[]
  suppressedTitles?: string[]
  maxItems?: number
}

function coerceMoves(raw: unknown): ConnectionMove[] {
  if (!Array.isArray(raw)) return []
  const out: ConnectionMove[] = []
  for (const m of raw.slice(0, 3)) {
    if (!m || typeof m !== 'object') continue
    const r = m as Record<string, unknown>
    const label = typeof r.label === 'string' ? r.label.trim() : ''
    if (!label) continue
    out.push({
      label,
      ...(typeof r.detail === 'string' && r.detail.trim() ? { detail: r.detail.trim() } : {}),
      kind: r.kind === 'task' ? 'task' : 'plan',
      ...(typeof r.when === 'string' && r.when.trim() ? { when: r.when.trim() } : {}),
      ...(typeof r.minutes === 'number' && r.minutes > 0 ? { minutes: Math.round(r.minutes) } : {}),
    })
  }
  return out
}

function coerceConnections(raw: unknown, cap: number): Connection[] {
  if (!Array.isArray(raw)) return []
  const out: Connection[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.trim() : ''
    const insight = typeof r.insight === 'string' ? r.insight.trim() : ''
    if (!title || !insight) continue
    const dots = Array.isArray(r.dots)
      ? r.dots.filter((d): d is string => typeof d === 'string' && d.trim().length > 0).map((d) => d.trim()).slice(0, 4)
      : []
    // The whole promise of this engine is cross-source synthesis. An "insight"
    // that cites fewer than two sources is a restatement — drop it rather than
    // let it dilute the surface.
    if (dots.length < 2) continue
    const moves = coerceMoves(r.moves)
    if (moves.length === 0) continue
    out.push({
      id: `conn-${out.length}-${title.slice(0, 24).replace(/\W+/g, '-').toLowerCase()}`,
      title,
      insight,
      dots,
      ...(typeof r.why === 'string' && r.why.trim() ? { why: r.why.trim() } : {}),
      moves,
      priority: typeof r.priority === 'number' ? r.priority : 50,
      horizon: r.horizon === 'today' || r.horizon === 'this-month' ? r.horizon : 'this-week',
    })
    if (out.length >= cap) break
  }
  return out.sort((a, b) => (b.priority ?? 50) - (a.priority ?? 50))
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  let ctx: ConnectInput
  try { ctx = (await request.json()) as ConnectInput } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { timeHeader, dataBlock } = buildFamilyContextParts(ctx)
  const cap = Math.min(Math.max(ctx.maxItems ?? 5, 1), 6)

  // Goals aren't part of the shared family context block, but "intent vs.
  // reality" is one of the richest seams this engine mines — so pass them in.
  const goalsBlock = ctx.goals?.length
    ? `\n\nSTATED GOALS & STANDING COMMITMENTS (the user's own words — the primary lens for "does their life actually reflect this?"):\n${ctx.goals
        .map((g) => `- [${g.area ?? 'general'}] ${g.text}${g.cadence ? ` (${g.cadence})` : ''}${g.why ? ` — because ${g.why}` : ''}`)
        .join('\n')}`
    : ''

  const suppressed = ctx.suppressedTitles ?? []
  const suppressionBlock = suppressed.length
    ? `\n\nALREADY DISMISSED (do NOT resurface these or anything semantically equivalent):\n${suppressed.map((t) => `- ${t}`).join('\n')}`
    : ''

  const tail = `${timeHeader}${goalsBlock}${suppressionBlock}\n\nReturn at most ${cap} connections. Apply the hard contract strictly — every one must join 2+ independent sources and be invisible from any single view. Output the JSON object and nothing else.`

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    const msg = await anthropic.messages.create({
      model: CONNECT_MODEL,
      max_tokens: CONNECT_MAX_TOKENS,
      system: [{ type: 'text', text: CONNECT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{
        role: 'user',
        content: [
          // Stable prefix: the family data block. Cached so repeat sweeps within
          // the hour re-read it at 10% cost.
          { type: 'text', text: `EVERYTHING KNOWN:\n\n${dataBlock}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
          // Volatile tail: time, goals, dismissals, cap.
          { type: 'text', text: tail },
        ],
      }],
    }, { signal: request.signal })

    logUsage('connect', CONNECT_MODEL, msg.usage)

    const text = msg.content[0]?.type === 'text' ? msg.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : {}
    const connections = coerceConnections(parsed.connections, cap)

    return NextResponse.json({ connections, generatedAt: new Date().toISOString() })
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      return NextResponse.json({ error: 'aborted' }, { status: 499 })
    }
    const errMsg = e instanceof Error ? e.message : 'Connections engine failed'
    console.error('[connect] error', errMsg)
    return NextResponse.json({ error: errMsg }, { status: 500 })
  }
}
