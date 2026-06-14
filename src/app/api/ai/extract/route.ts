import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const AI_MODEL = 'claude-sonnet-4-6'

interface MemberLite {
  name: string
  email: string
}

// The Extraction Engine: converts any unstructured input into structured outcomes.
export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const body = await request.json()
  const rawText: string = body.rawText ?? ''
  const imageBase64: string | undefined = body.imageBase64
  const imageMediaType: string | undefined = body.imageMediaType
  const members: MemberLite[] = body.members ?? []
  const today: string = body.today ?? new Date().toISOString()

  if (!rawText.trim() && !imageBase64) {
    return NextResponse.json({ error: 'No input provided' }, { status: 400 })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const memberList = members.length
    ? members.map((m) => `${m.name} (${m.email})`).join(', ')
    : 'none specified'

  const systemPrompt = `You are the Extraction Engine for FamilyOS, an AI family operating system.
Your job: read whatever the user captured (a note, screenshot, email, photo, voice transcript) and convert it into structured, actionable family outcomes.

Today is ${new Date(today).toString()}.
Family members: ${memberList}.

Analyze the input and extract every actionable outcome. Each outcome has a "kind":
- "task": something someone needs to do
- "event": something happening at a specific date/time
- "shopping_item": something to buy
- "packing_item": something to pack for a trip
- "memory": a fact worth remembering about the family
- "follow_up": an open loop to track until resolved

For each outcome provide:
- kind
- title (concise, action-oriented — e.g. "Sign Mia's permission slip")
- date (ISO 8601 if there's a clear date/time, else omit). Resolve relative dates ("next Tuesday", "tomorrow") against today.
- assigneeEmail (match to a family member's email if clearly implied, else omit)
- notes (optional short context)

Also write a one-sentence "summary" of what was captured.

Respond ONLY with valid JSON, no markdown:
{"summary":"...","outcomes":[{"kind":"...","title":"...","date":"...","assigneeEmail":"...","notes":"..."}]}

If nothing actionable is found, return {"summary":"...","outcomes":[]}.`

  const content: Anthropic.MessageParam['content'] = []
  if (imageBase64 && imageMediaType) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: imageMediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
        data: imageBase64,
      },
    })
  }
  content.push({
    type: 'text',
    text: rawText.trim() || 'Extract actionable family outcomes from the attached image.',
  })

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content }],
    })

    const text = response.content[0].type === 'text' ? response.content[0].text : '{}'
    const match = text.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) : { summary: '', outcomes: [] }

    return NextResponse.json({
      summary: parsed.summary ?? '',
      outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Extraction failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
