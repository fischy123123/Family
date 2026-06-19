import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { FamilyMemory } from '@/lib/types'
import { memorySubjects } from '@/lib/types'

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
  subjectIdentifiers: string[]   // who the merged memory concerns (empty = family-wide)
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
    .map((m) => {
      const subs = memorySubjects(m)
      const tag = subs.length ? ` (tagged:${subs.join(',')})` : ' (untagged)'
      return `[id:${m.id}]${tag} ${m.text}`
    })
    .join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
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

For "subjects" on merged memories: an array of the names of everyone the merged memory concerns (empty array if family-wide). A memory can concern multiple people.
Return ONLY valid JSON. Only include memories that need action — omit anything you're leaving unchanged.`,
    messages: [
      {
        role: 'user',
        content: `Family members:\n${memberList}\n\nMemories:\n${memoryList}\n\nReturn this JSON:\n{\n  "toDelete": ["id_of_redundant_memory", ...],\n  "toMerge": [\n    {\n      "supersededIds": ["id1", "id2"],\n      "consolidatedText": "single clean sentence capturing current state",\n      "subjects": ["Name1", "Name2"]\n    }\n  ]\n}`,
      },
    ],
  })

    const text = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ toDelete: [], toMerge: [] })

    const result = JSON.parse(match[0])

    // Resolve a list of names/emails/ids to canonical email-or-id identifiers,
    // dropping anything that matches no member.
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

    const toMerge: MergeGroup[] = Array.isArray(result.toMerge)
      ? result.toMerge.map((g: { supersededIds?: unknown; consolidatedText: string; subjects?: unknown }) => ({
          supersededIds: Array.isArray(g.supersededIds) ? g.supersededIds : [],
          consolidatedText: g.consolidatedText,
          subjectIdentifiers: resolveIds(g.subjects),
        }))
      : []

    return NextResponse.json({
      toDelete: Array.isArray(result.toDelete) ? result.toDelete : [],
      toMerge,
    } satisfies CleanupResult)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'cleanup error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
