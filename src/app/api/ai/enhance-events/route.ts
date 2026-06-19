import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { CalendarEvent, FamilyMember } from '@/lib/types'

interface EventSuggestion {
  eventId: string
  calendarId: string
  currentTitle: string
  suggestedTitle?: string
  currentNotes?: string
  suggestedNotes?: string
  currentLocation?: string
  suggestedLocation?: string
  reason: string
  isRecurring: boolean
  recurringEventId?: string
  confidence: 'high' | 'medium' | 'low'
}

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  let body: { events: CalendarEvent[]; members?: FamilyMember[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { events, members = [] } = body
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ suggestions: [] })
  }

  // Use a simple numeric index as the prompt ID to avoid Claude mangling
  // long Google Calendar event ID strings. We map back to real IDs server-side.
  const indexToEvent = new Map<number, CalendarEvent>()
  const eventList = events
    .slice(0, 60)
    .map((e, i) => {
      indexToEvent.set(i, e)
      const lines = [
        `[${i}] ${e.title || '(no title)'}`,
        `  date: ${e.start}`,
        `  recurring: ${!!e.recurringEventId}`,
        e.location ? `  location: ${e.location}` : '  location: (none)',
        e.notes ? `  notes: ${e.notes}` : '  notes: (none)',
        e.ownerEmail ? `  owner: ${e.ownerEmail}` : null,
      ]
      return lines.filter(Boolean).join('\n')
    })
    .join('\n\n')

  // Build family context block so Claude knows who these people are
  const memberContext = members.length > 0
    ? members.map((m) =>
        `- ${m.name}${m.role ? ` (${m.role})` : ''}${m.email ? ` <${m.email}>` : ''}`
      ).join('\n')
    : '(no family members provided)'

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const systemPrompt = `You are a sharp family calendar assistant reviewing a real family's upcoming events. Your job is to find EVERY event that could be improved, then suggest specific, actionable improvements.

FAMILY MEMBERS:
${memberContext}

Use this family context to make suggestions specific to their lives. If you see "Soccer" and there's a child in the family, reference that child. If you see "Dr. appointment", suggest they add the doctor's name, address, what to bring.

For EACH event, evaluate:
1. **Title clarity** — is it specific enough? "Appointment" is useless. "Dentist – cleaning, Dr. Smith" is useful.
2. **Notes** — most events should have notes. What to bring? Who to call? Parking? Prep needed? What's the appointment for?
3. **Location** — if missing and inferable from the title or notes, suggest it.

IMPORTANT RULES:
- Suggest improvements for MOST events. An event with a good title but no notes is still worth enriching.
- Be specific to this family. Don't give generic advice — tailor notes to what they likely need.
- For recurring events (recurring: true), write notes that are always useful, not date-specific.
- Do NOT skip an event just because the title seems clear. No notes = always suggest notes.
- Only skip an event if it already has: (a) a specific descriptive title, (b) useful notes, AND (c) a location or location is clearly irrelevant.

Return ONLY a raw JSON array. No markdown fences, no commentary. Each element:
{
  "idx": <the number from [N] in the event list>,
  "suggestedTitle": "<improved title — omit key if title is already descriptive>",
  "suggestedNotes": "<useful notes — include for almost every event>",
  "suggestedLocation": "<location — omit if already set or truly unknowable>",
  "reason": "<one sentence explaining what you added and why>",
  "confidence": "high" | "medium" | "low"
}

Aim for at least 50% of events having suggestions. If all events already have thorough titles, notes AND locations, return [].`

  let rawText = ''
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Review these ${indexToEvent.size} upcoming calendar events and suggest improvements:\n\n${eventList}`,
        },
      ],
    })

    rawText = message.content[0]?.type === 'text' ? message.content[0].text : ''
    console.log(`[enhance-events] stop_reason=${message.stop_reason} raw_length=${rawText.length} preview=${rawText.slice(0, 200)}`)
    if (message.stop_reason === 'max_tokens') {
      console.error('[enhance-events] hit max_tokens — response truncated, JSON will be invalid')
      return NextResponse.json({ error: 'Response too large — try again with fewer events', suggestions: [] }, { status: 500 })
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'AI call failed'
    console.error('[enhance-events] AI error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }

  if (!rawText) {
    return NextResponse.json({ suggestions: [], debug: 'empty AI response' })
  }

  // Strip markdown fences if Claude wrapped the array anyway
  const stripped = rawText.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim()
  const match = stripped.match(/\[[\s\S]*\]/)
  if (!match) {
    console.warn('[enhance-events] no JSON array found in response:', rawText.slice(0, 400))
    return NextResponse.json({ suggestions: [], debug: 'no JSON array in response' })
  }

  let rawSuggestions: Array<{
    idx: number
    suggestedTitle?: string
    suggestedNotes?: string
    suggestedLocation?: string
    reason: string
    confidence?: 'high' | 'medium' | 'low'
  }> = []

  try {
    rawSuggestions = JSON.parse(match[0])
  } catch (e) {
    console.warn('[enhance-events] JSON parse failed:', e)
    return NextResponse.json({ suggestions: [], debug: 'JSON parse failed' })
  }

  console.log(`[enhance-events] raw suggestions count: ${rawSuggestions.length}`)

  const suggestions: EventSuggestion[] = []

  for (const raw of rawSuggestions) {
    const event = indexToEvent.get(raw.idx)
    if (!event) {
      console.warn(`[enhance-events] no event for idx=${raw.idx}`)
      continue
    }

    const hasChange =
      (raw.suggestedTitle !== undefined && raw.suggestedTitle !== event.title) ||
      (raw.suggestedNotes !== undefined && raw.suggestedNotes !== (event.notes ?? '')) ||
      (raw.suggestedLocation !== undefined && raw.suggestedLocation !== (event.location ?? ''))

    if (!hasChange) continue

    const suggestion: EventSuggestion = {
      eventId: event.id,
      calendarId: event.calendarId,
      currentTitle: event.title,
      reason: raw.reason ?? '',
      isRecurring: !!event.recurringEventId,
      confidence: raw.confidence ?? 'medium',
    }
    if (raw.suggestedTitle && raw.suggestedTitle !== event.title) {
      suggestion.suggestedTitle = raw.suggestedTitle
    }
    if (raw.suggestedNotes && raw.suggestedNotes !== (event.notes ?? '')) {
      suggestion.currentNotes = event.notes
      suggestion.suggestedNotes = raw.suggestedNotes
    }
    if (raw.suggestedLocation && raw.suggestedLocation !== (event.location ?? '')) {
      suggestion.currentLocation = event.location
      suggestion.suggestedLocation = raw.suggestedLocation
    }
    if (event.recurringEventId) {
      suggestion.recurringEventId = event.recurringEventId
    }

    suggestions.push(suggestion)
  }

  console.log(`[enhance-events] final suggestions: ${suggestions.length}`)
  return NextResponse.json({ suggestions })
}
