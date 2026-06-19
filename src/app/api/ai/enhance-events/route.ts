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

  const systemPrompt = `You are a family calendar assistant. Your job is to ENRICH calendar events with useful context that helps the family prepare. You should suggest improvements for MOST events — not just obviously broken ones.

For EVERY event, ask yourself:
1. Is the title specific enough? ("Appointment" is bad. "Dentist – annual cleaning" is good.)
2. Are notes missing that would help? Most events benefit from notes: what to bring, who to call, parking, prep needed, what the appointment is for.
3. Is the location missing but inferable from the title or existing notes?

Be PROACTIVE. Your default should be to enrich, not to skip. Only skip an event if it already has a specific title, useful notes, and a location (or location is genuinely not applicable). A well-titled event with no notes is still worth enriching.

Examples of good enrichments:
- "Soccer" → notes: "Bring cleats, shin guards, and water bottle. Check weather for field conditions."
- "Dr. Johnson" → notes: "Annual checkup. Bring insurance card and list of current medications."
- "Piano" → notes: "Practice this week's pieces beforehand. Bring sheet music folder."
- "Dentist" → add location if you can infer the dental practice, or notes: "Bring insurance card. Arrive 10 min early for forms."
- "School pickup" → notes: "Maddie gets out at 3:15 from the main entrance."

Return a JSON array (and nothing else — no markdown, no commentary) where each element has this shape:
{
  "eventId": "<copy the exact event id — do not modify it>",
  "calendarId": "<copy the exact calendarId>",
  "suggestedTitle": "<improved title — omit this key if the current title is already specific>",
  "suggestedNotes": "<useful notes to add or improve — include this for MOST events unless notes are already thorough>",
  "suggestedLocation": "<location if missing and inferable — omit if already set or truly unknown>",
  "reason": "<1 sentence: what you're adding and why it helps>",
  "confidence": "high" | "medium" | "low"
}

Return a non-empty array unless every single event already has a specific title, thorough notes, AND a location. Err on the side of suggesting more, not less.`

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
