import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import type { CalendarEvent, FamilyMember } from '@/lib/types'
import { logUsage } from '@/lib/ai'
import { resolveTimezone } from '@/lib/time'

// Generating clarifying questions about ambiguous events is light classification
// work that runs in the background — Haiku handles it fast and cheap.
const AI_MODEL = 'claude-haiku-4-5-20251001'

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  const { events, members, now, knownEventIds, timezone }: {
    events: CalendarEvent[]
    members: FamilyMember[]
    now: string
    knownEventIds?: string[]
    timezone?: string
  } = await request.json()

  // Don't re-ask about events the family has already explained.
  const known = new Set(knownEventIds ?? [])
  const pending = (events ?? []).filter((e) => !known.has(e.id))

  if (pending.length === 0) {
    return NextResponse.json({ clarifications: [] })
  }

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const systemPrompt = `You are analyzing a family's Google Calendar events. Identify events whose title or context is ambiguous — unclear who it's for, what it's about, or what preparation is needed. Return ONLY a JSON array (no markdown) of clarification requests. Limit to 5 max.`

  const memberNames = members.map((m) => m.name).join(', ')
  const tz = resolveTimezone(timezone)
  const eventLines = pending
    .map((e) => {
      const date = new Date(e.start).toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        timeZone: tz,
      })
      const time = e.isAllDay
        ? 'all day'
        : new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
      return `- ID: ${e.id} | Title: "${e.title}" | Date: ${date} at ${time}${e.location ? ` | Location: ${e.location}` : ''}`
    })
    .join('\n')

  const userMessage = `Family members: ${memberNames || 'unknown'}
Current time: ${now}

Upcoming calendar events:
${eventLines}

Return a JSON array where each element has this shape:
{
  "eventId": "<event id from above>",
  "eventTitle": "<event title>",
  "eventDate": "<ISO date string>",
  "question": "<clarifying question to ask the family>",
  "hint": "<placeholder hint, e.g. Client meeting, school meeting, doctor visit...>"
}

Only include events that are genuinely ambiguous. Skip events with clear titles like "Emma's soccer practice", "Dentist appointment", "Thanksgiving dinner", etc. Focus on vague titles like single names, "Meeting", "Call", "Appointment", or acronyms. Return an empty array [] if no events are ambiguous.`

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    })

    logUsage('calendar-context', AI_MODEL, response.usage)

    const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
    const match = text.match(/\[[\s\S]*\]/)
    const parsed: Array<Record<string, string>> = match ? JSON.parse(match[0]) : []

    const clarifications = parsed.slice(0, 5).map((item, i) => ({
      id: `clarification-${i}`,
      eventId: item.eventId ?? '',
      eventTitle: item.eventTitle ?? '',
      eventDate: item.eventDate ?? '',
      question: item.question ?? '',
      hint: item.hint ?? '',
    }))

    return NextResponse.json({ clarifications })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Calendar context analysis failed'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
