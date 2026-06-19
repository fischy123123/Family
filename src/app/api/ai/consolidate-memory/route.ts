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
  subjectIdentifiers: string[]      // emails or member ids; empty = family-wide
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
1. Which family member(s) it's about — "subjects" is an array of names (empty if family-wide). A memory can concern multiple people.
2. Whether it updates, extends, or supersedes any existing memories — or is genuinely new
3. The best single memory text to store (consolidating old + new context when relevant)

Attribution rules:
- Attribute based on who the memory is ABOUT, not who is narrating. "I ordered a gift for Jessy's pinning" → Jessy.
- A memory can concern multiple people. "Drop Liam and Maddie at school" → Liam, Maddie.
- A memory mentioning a person's name, appointment, or milestone belongs to that person.
- Return an empty array for genuinely household-level facts (e.g. "trash goes out Tuesday", "the family has 3 cars").

Consolidation rules:
- Only supersede memories that are clearly about the same fact and are now outdated or contradicted
- When merging, write a concise single sentence capturing the full current state
- Never supersede unrelated memories
- If the new memory is genuinely new/unrelated: action = "new", supersededIds = []
- Return ONLY valid JSON`,
      messages: [
        {
          role: 'user',
          content: `Family members:\n${memberList}\n\nNew memory: "${newText}"\n\nExisting memories:\n${existingList}\n\nReturn this JSON (no markdown):\n{\n  "subjects": ["Name1", "Name2"],\n  "action": "new" | "replace",\n  "supersededIds": ["id1", ...],\n  "finalText": "..."\n}`,
        },
      ],
    })

    const resolveIds = (raw: unknown): string[] => {
      if (!Array.isArray(raw)) return []
      const ids = new Set<string>()
      for (const r of raw) {
        if (typeof r !== 'string' || !r.trim()) continue
        const v = r.trim().toLowerCase()
        if (['null', 'none'].includes(v)) continue
        const m = members.find(
          (mem) =>
            mem.email?.toLowerCase() === v ||
            mem.id.toLowerCase() === v ||
            mem.name.toLowerCase() === v
        )
        if (m) ids.add(m.email || m.id)
      }
      return Array.from(ids)
    }

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) {
      // Fallback: save as-is, no consolidation
      return NextResponse.json({
        subjectIdentifiers: [],
        action: 'new',
        supersededIds: [],
        finalText: newText,
      } satisfies ConsolidateResult)
    }

    const result = JSON.parse(match[0])
    return NextResponse.json({
      subjectIdentifiers: resolveIds(result.subjects),
      action: result.action === 'replace' ? 'replace' : 'new',
      supersededIds: Array.isArray(result.supersededIds) ? result.supersededIds : [],
      finalText: result.finalText ?? newText,
    } satisfies ConsolidateResult)
  } catch {
    return NextResponse.json({
      subjectIdentifiers: [],
      action: 'new',
      supersededIds: [],
      finalText: newText,
    } satisfies ConsolidateResult)
  }
}
