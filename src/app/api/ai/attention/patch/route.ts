import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { logUsage, estimateCost } from '@/lib/ai'
import { ATTENTION_MODEL } from '@/lib/attentionPrompt'
import { resolveTimezone } from '@/lib/time'
import type { AttentionItem, FamilyMember } from '@/lib/types'

// Targeted card-patch endpoint. Called after a user chats with a briefing card —
// updates only the affected card(s) based on the new context, without
// regenerating the entire briefing. Much cheaper and faster than a full run:
// ~500 input tokens (cached system prompt), ~200 output tokens.
const PATCH_SYSTEM_PROMPT = `You are a precision update engine for a family briefing. Your job is surgical: given a set of attention cards and a conversation that added new context, update ONLY what actually changed.

RULES:
- Only modify cards whose content is genuinely affected by the conversation.
- If a card is resolved/cancelled/no longer relevant, put its id in removedIds.
- If a card's title, reason, bucket, dueAt, or startBy changed based on the new context, return an updated version with the SAME id.
- Leave unchanged cards out of updatedCards entirely.
- Only update the greeting if the conversation resolves or significantly changes the most important thing it mentioned.
- If nothing changed, return empty arrays and no greeting.
- Never invent new cards — only update or remove existing ones.
- Keep changes minimal and specific. Do not rewrite what wasn't affected.

Return ONLY this JSON (no markdown, no commentary):
{
  "updatedCards": [{ ...full AttentionItem fields with same id }],
  "removedIds": ["id1", "id2"],
  "greeting": "updated greeting string, or omit if unchanged"
}`

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const {
    cards,
    conversation,
    greeting,
    members,
    now,
    timezone,
  }: {
    cards: AttentionItem[]
    conversation: { role: 'user' | 'assistant'; content: string }[]
    greeting: string
    members: FamilyMember[]
    now: string
    timezone?: string
  } = await request.json()

  if (!cards?.length || !conversation?.length) {
    return NextResponse.json({ updatedCards: [], removedIds: [] })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const tz = resolveTimezone(timezone)
  const nowFmt = new Date(now).toLocaleString('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  })

  const membersStr = members.map((m) => `${m.name} (${m.email ?? m.id})`).join(', ')

  const cardsStr = cards.map((c) => JSON.stringify({
    id: c.id, bucket: c.bucket, title: c.title, reason: c.reason,
    dueAt: c.dueAt, startBy: c.startBy, groupKey: c.groupKey, groupTitle: c.groupTitle,
    sourceType: c.sourceType, sourceId: c.sourceId, priority: c.priority,
    assigneeEmail: c.assigneeEmail, forEmails: c.forEmails,
  })).join('\n')

  const convStr = conversation.map((m) =>
    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`
  ).join('\n\n')

  const userPrompt =
    `Current time: ${nowFmt}\n` +
    `Family members: ${membersStr}\n\n` +
    `CURRENT CARDS:\n${cardsStr}\n\n` +
    `CURRENT GREETING:\n${greeting}\n\n` +
    `CONVERSATION THAT ADDED NEW CONTEXT:\n${convStr}\n\n` +
    `Based only on what this conversation revealed, update the cards that changed.`

  const start = Date.now()

  try {
    const response = await anthropic.messages.create({
      model: ATTENTION_MODEL,
      max_tokens: 1000,
      system: [
        { type: 'text', text: PATCH_SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userPrompt }],
    })

    logUsage('attention-patch', ATTENTION_MODEL, response.usage)
    const uMap = response.usage as unknown as Record<string, number>
    console.log(`[patch] wall=${Date.now() - start}ms cost=${estimateCost(ATTENTION_MODEL, uMap)}`)

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ updatedCards: [], removedIds: [] })

    const parsed = JSON.parse(match[0]) as {
      updatedCards?: AttentionItem[]
      removedIds?: string[]
      greeting?: string
    }

    return NextResponse.json({
      updatedCards: parsed.updatedCards ?? [],
      removedIds: parsed.removedIds ?? [],
      greeting: parsed.greeting,
    })
  } catch (e) {
    console.error('[patch] failed:', e)
    return NextResponse.json({ updatedCards: [], removedIds: [] })
  }
}
