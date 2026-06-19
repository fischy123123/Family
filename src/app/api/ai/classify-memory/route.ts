import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const MODEL = 'claude-sonnet-4-6'

interface MemberRef {
  id: string
  name: string
  email?: string
  role: string
}

interface ClassifyRequest {
  text: string
  members: MemberRef[]
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const { text, members }: ClassifyRequest = await request.json()
  if (!text || !members?.length) {
    return NextResponse.json({ subjectIdentifiers: [] })
  }

  const memberList = members
    .map((m) => `- ${m.name} (${m.role})${m.email ? `, email: ${m.email}` : `, id: ${m.id}`}`)
    .join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 150,
      system: `You classify family memories to identify which family member(s) they are about.
Return ONLY a JSON object with one field: "subjects" — an array of the names of every family member the memory concerns.

Rules:
- Classify based on who the memory is ABOUT, not who is narrating it. "I ordered a gift for Jessy's pinning" is about Jessy.
- A memory can concern MULTIPLE people. "Drop the kids Liam and Maddie at school" concerns both Liam and Maddie. "Maddie is at camp, Liam is home with Jessy" concerns Maddie, Liam, and Jessy.
- A memory mentioning a person's name, appointment, milestone, or situation belongs to that person.
- "Assignment · X: it concerns Liam, Maddie; Eric is responsible" → concerns Liam, Maddie, AND Eric.
- "Re coaching insight about [Person]'s [thing]" → that person.
- Return an EMPTY array [] for genuinely household-level facts (e.g. "trash goes out Tuesday", "the family has 3 cars") with no specific person.
- Use exact member names from the list.`,
      messages: [
        {
          role: 'user',
          content: `Family members:\n${memberList}\n\nMemory to classify:\n"${text}"\n\nReturn JSON: {"subjects": ["Name1", "Name2", ...]}  (empty array if family-wide)`,
        },
      ],
    })

    const responseText = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = responseText.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ subjectIdentifiers: [] })

    const result = JSON.parse(match[0])
    const rawList: unknown[] = Array.isArray(result.subjects) ? result.subjects : []

    // Resolve each name/email/id the model returned to the canonical identifier
    // we store (email if the member has one, else id). Drop anything unmatched.
    const ids = new Set<string>()
    for (const raw of rawList) {
      if (typeof raw !== 'string') continue
      const v = raw.trim().toLowerCase()
      if (!v || ['null', 'none'].includes(v)) continue
      const member = members.find(
        (m) =>
          m.email?.toLowerCase() === v ||
          m.id.toLowerCase() === v ||
          m.name.toLowerCase() === v
      )
      if (member) ids.add(member.email || member.id)
    }

    return NextResponse.json({ subjectIdentifiers: Array.from(ids) })
  } catch (e) {
    // Surface real API errors as 500 so the caller can distinguish a failure
    // from a legitimate "no specific person" result.
    const msg = e instanceof Error ? e.message : 'classify error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
