import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

// Extraction is structured pattern work and latency-sensitive (user is capturing
// something quickly) — Haiku is fast, cheap, and more than capable here.
const AI_MODEL = 'claude-haiku-4-5-20251001'

interface MemberLite {
  name: string
  email: string
  role?: string
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
  const existingEventTitles: string[] = body.existingEventTitles ?? []

  if (!rawText.trim() && !imageBase64) {
    return NextResponse.json({ error: 'No input provided' }, { status: 400 })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const memberList = members.length
    ? members.map((m) => `${m.name}${m.role ? ` — ${m.role}` : ''} (${m.email})`).join('\n')
    : 'none specified'

  const systemPrompt = `You are the Extraction Engine for FamilyOS, an AI family operating system.
Your job: read whatever the user captured (a note, screenshot, email, photo, voice transcript) and convert it into structured, actionable family outcomes.

Today is ${new Date(today).toString()}.

THIS FAMILY:
${memberList}

${existingEventTitles.length > 0 ? `ALREADY ON THE CALENDAR — do NOT re-extract these as event outcomes, and do NOT create tasks or follow-ups to "confirm" or "schedule" anything that already appears here:
${existingEventTitles.join('\n')}

` : ''}CRITICAL — name matching for voice transcripts:
Voice dictation frequently mis-transcribes family names phonetically (e.g. "Jessy" → "Jesse", "Aoife" → "Eva", "Niamh" → "Neve"). Whenever a name in the input sounds like one of the family members above, treat it as THAT member: correct the spelling to the real name in your titles/notes AND set assigneeEmail to their email. Possessives count too — "Jesse's cousin" means the cousin OF the family member Jessy, so the relevant person is Jessy. Only leave a name uncorrected if it clearly doesn't match anyone in the family.

Analyze the input and extract every actionable outcome. Each outcome has a "kind":
- "task": something someone needs to do
- "event": something happening at a specific date/time
- "shopping_item": something to buy
- "packing_item": something to pack for a trip
- "memory": a fact worth remembering about the family (relationships, preferences, important context)
- "follow_up": an open loop to track until resolved

For each outcome provide:
- kind
- title (concise, action-oriented, with corrected family names — e.g. "Sign Mia's permission slip")
- date (ISO 8601 if there's a clear date/time, else omit). Resolve relative dates ("next Tuesday", "tomorrow") against today.
- assigneeEmail (match to a family member's email — including phonetic matches — if clearly implied, else omit)
- notes (optional short context)

Also write a one-sentence "summary" of what was captured. If you corrected any names, mention it briefly in the summary (e.g. "Noted a haircut for Jessy (heard as 'Jesse')").

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
