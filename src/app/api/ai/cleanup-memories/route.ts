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
  supersededIds: string[]
  consolidatedText: string
  subjectIdentifier: string | null
}

export interface CleanupResult {
  toDelete: string[]     // fully redundant — delete with no replacement
  toMerge: MergeGroup[]  // multiple entries about the same fact → one consolidated entry
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
    .map((m) => `[id:${m.id}]${m.subjectEmail ? ` (tagged:${m.subjectEmail})` : ' (untagged)'} ${m.text}`)
    .join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: `You are deduplicating a family assistant's memory store. Your ONLY job is to find memories that are redundant or that belong together.

DELETE a memory when:
- It says the same thing as another memory (exact or near-exact duplicate)
- It is clearly superseded (e.g. an older version of a fact that has since been updated)
- It is a question fragment or incomplete thought with no durable information

MERGE memories when:
- Two or more entries are clearly about the same evolving situation (e.g. multiple updates about grounding, same event mentioned twice)
- Write a single clean sentence capturing the current state

Leave memories alone when they are genuinely distinct facts, even if they mention the same person.

For subjectIdentifier on merged memories: use the email if the member has one, their id if not, null if family-wide.
Return ONLY valid JSON. Only include memories that need action — omit anything you're leaving unchanged.`,
    messages: [
      {
        role: 'user',
        content: `Family members:\n${memberList}\n\nMemories:\n${memoryList}\n\nReturn this JSON:\n{\n  "toDelete": ["id_of_redundant_memory", ...],\n  "toMerge": [\n    {\n      "supersededIds": ["id1", "id2"],\n      "consolidatedText": "single clean sentence capturing current state",\n      "subjectIdentifier": "email or id or null"\n    }\n  ]\n}`,
      },
    ],
  })

  try {
    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ toDelete: [], toMerge: [], toTag: [] })

    const result = JSON.parse(match[0])
    return NextResponse.json({
      toDelete: Array.isArray(result.toDelete) ? result.toDelete : [],
      toMerge: Array.isArray(result.toMerge) ? result.toMerge : [],
    } satisfies CleanupResult)
  } catch {
    return NextResponse.json({ toDelete: [], toMerge: [] })
  }
}
