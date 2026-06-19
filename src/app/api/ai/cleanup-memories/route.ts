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

interface TagUpdate {
  id: string
  subjectIdentifier: string  // email or member id
}

export interface CleanupResult {
  toDelete: string[]     // fully redundant — delete with no replacement
  toMerge: MergeGroup[]  // multiple entries about the same fact → one consolidated entry
  toTag: TagUpdate[]     // untagged memories that belong to a specific member
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const { memories, members }: CleanupRequest = await request.json()
  if (!memories?.length) return NextResponse.json({ toDelete: [], toMerge: [], toTag: [] })

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
    system: `You are auditing a family assistant's memory store. Do three things:

1. TAG untagged memories: for any memory marked "(untagged)" that is clearly about one specific family member, identify that member
2. DELETE fully redundant memories: entries that are stale, superseded, or already captured elsewhere
3. MERGE related entries: when two or more memories are multiple versions of the same evolving fact, collapse them into one clean sentence

Tagging rules:
- Tag based on who the memory is ABOUT, not who is narrating it. "I ordered a memory jar for Jessy's pinning" is about Jessy, not the narrator.
- Memories mentioning a specific person's name, event, appointment, or milestone belong to that person.
- "Assignment · X: it concerns Y; Y is responsible" → tag to Y (the person it concerns).
- "Re coaching insight about [Person]'s [thing]" → tag to that person.
- Only use null (family-wide) for genuinely household-level facts like "trash goes out Tuesday" that don't belong to any one person.

Merge rules:
- Only merge when entries are clearly about the same evolving fact. Leave unrelated memories alone.
- Two entries about the same event/situation from different angles should be merged into one complete sentence.

For subjectIdentifier: use email if the member has one, their id if not, null for family-wide facts.
A memory being merged/deleted should NOT also appear in toTag.
Return ONLY valid JSON.`,
    messages: [
      {
        role: 'user',
        content: `Family members:\n${memberList}\n\nMemories:\n${memoryList}\n\nReturn this JSON (only include entries that need action):\n{\n  "toTag": [\n    { "id": "...", "subjectIdentifier": "email or member id" }\n  ],\n  "toDelete": ["id", ...],\n  "toMerge": [\n    {\n      "supersededIds": ["id1", "id2"],\n      "consolidatedText": "single clean sentence",\n      "subjectIdentifier": "email or id or null"\n    }\n  ]\n}`,
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
      toTag: Array.isArray(result.toTag) ? result.toTag : [],
    } satisfies CleanupResult)
  } catch {
    return NextResponse.json({ toDelete: [], toMerge: [], toTag: [] })
  }
}
