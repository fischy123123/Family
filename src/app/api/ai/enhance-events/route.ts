import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { CalendarEvent } from '@/lib/types'

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

  let body: { events: CalendarEvent[]; accessToken?: string; refreshToken?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { events } = body
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ suggestions: [] })
  }

  // Build a compact representation of events for the prompt
  const eventList = events
    .map((e, i) => {
      const lines = [
        `Event ${i + 1}:`,
        `  id: ${e.id}`,
        `  calendarId: ${e.calendarId}`,
        `  title: ${e.title || '(no title)'}`,
        `  start: ${e.start}`,
        `  isRecurring: ${!!e.recurringEventId}`,
        e.recurringEventId ? `  recurringEventId: ${e.recurringEventId}` : null,
        e.location ? `  location: ${e.location}` : null,
        e.notes ? `  notes: ${e.notes}` : null,
      ]
      return lines.filter(Boolean).join('\n')
    })
    .join('\n\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const systemPrompt = `You are a family calendar assistant. Analyze these calendar events and suggest improvements to make them clearer and more useful. Focus on:
- Adding specificity to vague titles (e.g. "Appointment" → "Dr. Smith Dentist Checkup")
- Adding useful notes (doctor name, address, what to bring, parking info)
- Fixing capitalization and formatting issues
- Suggesting a location when it can be reasonably inferred from the title/notes
- Only suggest changes where you can meaningfully improve clarity

Return a JSON array (and nothing else — no markdown, no commentary) where each element has this shape:
{
  "eventId": "<the event id>",
  "calendarId": "<the calendarId>",
  "suggestedTitle": "<new title — omit this key entirely if the title is already good>",
  "suggestedNotes": "<new or improved notes — omit this key entirely if notes are already good or there's nothing to add>",
  "suggestedLocation": "<suggested location — omit this key entirely if location is already set or cannot be meaningfully inferred>",
  "reason": "<short plain-English explanation of why you're suggesting this change, 1-2 sentences>",
  "confidence": "high" | "medium" | "low"
}

Only include events where you have at least one genuine improvement to suggest. If an event is already well-described, skip it entirely. Return an empty array [] if no improvements are possible.`

  let rawText = ''
  try {
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here are the upcoming calendar events to review:\n\n${eventList}`,
        },
      ],
    })

    rawText = message.content[0]?.type === 'text' ? message.content[0].text : '[]'
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'AI call failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Extract JSON array from response (Claude may wrap it in markdown)
  const match = rawText.match(/\[[\s\S]*\]/)
  if (!match) {
    return NextResponse.json({ suggestions: [] })
  }

  let rawSuggestions: Array<{
    eventId: string
    calendarId: string
    suggestedTitle?: string
    suggestedNotes?: string
    suggestedLocation?: string
    reason: string
    confidence?: 'high' | 'medium' | 'low'
  }> = []

  try {
    rawSuggestions = JSON.parse(match[0])
  } catch {
    return NextResponse.json({ suggestions: [] })
  }

  // Enrich suggestions with current values and filter to only those with real changes
  const eventMap = new Map(events.map((e) => [e.id, e]))
  const suggestions: EventSuggestion[] = []

  for (const raw of rawSuggestions) {
    if (!raw.eventId) continue
    const event = eventMap.get(raw.eventId)
    if (!event) continue

    const hasChange =
      (raw.suggestedTitle !== undefined && raw.suggestedTitle !== event.title) ||
      (raw.suggestedNotes !== undefined && raw.suggestedNotes !== event.notes) ||
      (raw.suggestedLocation !== undefined && raw.suggestedLocation !== event.location)

    if (!hasChange) continue

    const suggestion: EventSuggestion = {
      eventId: raw.eventId,
      calendarId: raw.calendarId ?? event.calendarId,
      currentTitle: event.title,
      reason: raw.reason ?? '',
      isRecurring: !!event.recurringEventId,
      confidence: raw.confidence ?? 'medium',
    }
    if (raw.suggestedTitle !== undefined && raw.suggestedTitle !== event.title) {
      suggestion.suggestedTitle = raw.suggestedTitle
    }
    if (raw.suggestedNotes !== undefined && raw.suggestedNotes !== event.notes) {
      suggestion.currentNotes = event.notes
      suggestion.suggestedNotes = raw.suggestedNotes
    }
    if (raw.suggestedLocation !== undefined && raw.suggestedLocation !== event.location) {
      suggestion.currentLocation = event.location
      suggestion.suggestedLocation = raw.suggestedLocation
    }
    if (event.recurringEventId) {
      suggestion.recurringEventId = event.recurringEventId
    }

    suggestions.push(suggestion)
  }

  return NextResponse.json({ suggestions })
}
