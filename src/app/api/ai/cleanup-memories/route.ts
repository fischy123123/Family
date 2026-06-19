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

interface CleanupRequest {
  memories: FamilyMemory[]
  members: MemberRef[]
}

interface MergeGroup {
  supersededIds: string[]   // ids to delete
  consolidatedText: string  // single replacement memory
  subjectIdentifier: string | null
}

export interface CleanupResult {
  toDelete: string[]        // ids that are fully redundant — no replacement needed
  toMerge: MergeGroup[]     // groups of related memories collapsed into one
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const { memories, members }: CleanupRequest = await request.json()
  if (!memories?.length) return NextResponse.json({ toDelete: [], toMerge: [] })

  const memberList = members
    .map((m) => `- ${m.name} (${m.role})${m.email ? `, email: ${m.email}` : `, id: ${m.id}`}`)
    .join('\n')

  const memoryList = memories
    .map((m) => `[id:${m.id}] ${m.subjectEmail ? `(about: ${m.subjectEmail}) ` : ''}${m.text}`)
    .join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: `You are cleaning up a family assistant's memory store. Your job is to produce the smallest, most accurate set of memories by:
1. Deleting entries that are fully superseded by newer ones (e.g. an old date that has already passed and is no longer relevant)
2. Merging related entries about the same fact into one clean sentence (e.g. multiple updates to a grounding situation → one current status)
3. Leaving unrelated, still-accurate memories completely alone — do NOT merge unrelated facts

Be conservative: only merge when two or more entries are clearly about the same evolving fact. When in doubt, leave them separate.
For subjectIdentifier: return the member's email if they have one, their id if not, null if family-wide.
Return ONLY valid JSON — no explanation, no markdown.`,
    messages: [
      {
        role: 'user',
        content: `Family members:\n${memberList}\n\nCurrent memories:\n${memoryList}\n\nReturn this JSON:\n{\n  "toDelete": ["id_of_fully_redundant_memory", ...],\n  "toMerge": [\n    {\n      "supersededIds": ["id1", "id2"],\n      "consolidatedText": "single clean sentence capturing current state",\n      "subjectIdentifier": "email or id or null"\n    }\n  ]\n}\n\nOnly include entries that need action. Memories not mentioned are kept as-is.`,
      },
    ],
  })

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ toDelete: [], toMerge: [] })

    const result = JSON.parse(match[0])
    return NextResponse.json({
      toDelete: Array.isArray(result.toDelete) ? result.toDelete : [],
      toMerge: Array.isArray(result.toMerge) ? result.toMerge : [],
    } satisfies CleanupResult)
  } catch {
    return NextResponse.json({ toDelete: [], toMerge: [] })
  }
}
