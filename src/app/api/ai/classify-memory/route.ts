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
    return NextResponse.json({ subjectIdentifier: null })
  }

  const memberList = members
    .map((m) => `- ${m.name} (${m.role})${m.email ? `, email: ${m.email}` : `, id: ${m.id}`}`)
    .join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 100,
      system: `You classify family memories to identify which specific family member they are about.
Return ONLY a JSON object with one field: "subjectIdentifier".

Rules:
- Classify based on who the memory is ABOUT, not who is narrating it. "I ordered a gift for Jessy's pinning" is about Jessy.
- A memory mentioning one person's name, appointment, milestone, or situation belongs to that person.
- "Assignment · X: it concerns Y" → classify as Y.
- "Re coaching insight about [Person]'s [thing]" → classify as that person.
- Only return null for genuinely household-level facts (e.g. "trash goes out Tuesday") with no single owner.
- If clearly about ONE person: return their email if they have one, or their id if they don't.`,
      messages: [
        {
          role: 'user',
          content: `Family members:\n${memberList}\n\nMemory to classify:\n"${text}"\n\nReturn JSON: {"subjectIdentifier": "<email or id or null>"}`,
        },
      ],
    })

    const responseText = response.content[0].type === 'text' ? response.content[0].text : ''
    const match = responseText.match(/\{[\s\S]*\}/)
    if (!match) return NextResponse.json({ subjectIdentifier: null })

    const result = JSON.parse(match[0])
    return NextResponse.json({ subjectIdentifier: result.subjectIdentifier ?? null })
  } catch {
    return NextResponse.json({ subjectIdentifier: null })
  }
}
