import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { FamilyMemory } from '@/lib/types'

const MODEL = 'claude-sonnet-4-6'

interface MemberRef {
  id: string
  name: string
  email?: string
  role: string
}

interface ConsolidateRequest {
  newText: string
  existingMemories: FamilyMemory[]
  members: MemberRef[]
}

export interface ConsolidateResult {
  subjectIdentifier: string | null  // email or member id; null = family-wide
  action: 'new' | 'replace'
  supersededIds: string[]           // existing memory ids to delete
  finalText: string                 // the memory text to actually save
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const { newText, existingMemories, members }: ConsolidateRequest = await request.json()
  if (!newText) return NextResponse.json({ error: 'newText required' }, { status: 400 })

  const memberList = members
    .map((m) => `- ${m.name} (${m.role})${m.email ? `, email: ${m.email}` : `, id: ${m.id}`}`)
    .join('\n')

  const existingList = existingMemories.length
    ? existingMemories
        .map((m) => `[id:${m.id}] ${m.text}`)
        .join('\n')
    : '(none)'

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: `You maintain a clean, non-redundant memory store for a family AI assistant.
When new information arrives, determine:
1. Which family member it's about (return their email if they have one, their id if not, or null if it's family-wide)
2. Whether it updates, extends, or supersedes any existing memories — or is genuinely new
3. The best single memory text to store (consolidating old + new context when relevant)

Rules:
- Only supersede memories that are clearly about the same fact and are now outdated or contradicted
- When merging, write a concise single sentence capturing the full current state
- Never supersede unrelated memories
- If the new memory is genuinely new/unrelated: action = "new", supersededIds = []
- Return ONLY valid JSON`,
      messages: [
        {
          role: 'user',
          content: `Family members:\n${memberList}\n\nNew memory: "${newText}"\n\nExisting memories:\n${existingList}\n\nReturn this JSON (no markdown):\n{\n  "subjectIdentifier": "<email or id or null>",\n  "action": "new" | "replace",\n  "supersededIds": ["id1", ...],\n  "finalText": "..."\n}`,
        },
      ],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      // Fallback: save as-is, no consolidation
      return NextResponse.json({
        subjectIdentifier: null,
        action: 'new',
        supersededIds: [],
        finalText: newText,
      } satisfies ConsolidateResult)
    }

    const result = JSON.parse(match[0])
    return NextResponse.json({
      subjectIdentifier: result.subjectIdentifier ?? null,
      action: result.action === 'replace' ? 'replace' : 'new',
      supersededIds: Array.isArray(result.supersededIds) ? result.supersededIds : [],
      finalText: result.finalText ?? newText,
    } satisfies ConsolidateResult)
  } catch {
    return NextResponse.json({
      subjectIdentifier: null,
      action: 'new',
      supersededIds: [],
      finalText: newText,
    } satisfies ConsolidateResult)
  }
}
