import { NextRequest, NextResponse } from 'next/server'
import { askClaudeJSON } from '@/lib/ai'

interface MemberLite {
  name: string
  email: string
}

export async function POST(request: NextRequest) {
  try {
    const { text, members = [], today } = await request.json()
    if (!text || typeof text !== 'string') {
      return NextResponse.json({ error: 'No text provided' }, { status: 400 })
    }

    const memberList = (members as MemberLite[])
      .map((m) => `${m.name} <${m.email}>`)
      .join(', ') || 'none'

    const prompt = `You are a family organizer assistant. Convert the user's natural-language request into one or more structured actions.

Today's date is ${today}. Family members: ${memberList}.

The user said: "${text}"

Return ONLY a JSON array of action objects. Each action must have a "kind" field of one of:
- "event": { "kind":"event", "title", "date":"YYYY-MM-DD", "startTime":"HH:MM" (24h, optional), "endTime":"HH:MM" (optional), "isAllDay":boolean, "location":string (optional), "assigneeEmail":string (optional, match to a family member's email if a name is mentioned) }
- "reminder": { "kind":"reminder", "title", "date":"YYYY-MM-DD" (optional), "priority":"none"|"low"|"medium"|"high", "assigneeEmail":string (optional), "notes":string (optional) }
- "chore": { "kind":"chore", "name", "assigneeEmail":string (optional), "frequency":"daily"|"weekly"|"monthly", "interval":number }
- "shopping_item": { "kind":"shopping_item", "name", "quantity":number, "category": one of [Produce, Dairy, "Meat & Seafood", Bakery, Frozen, Pantry, Beverages, Household, "Personal Care", Other] }
- "checklist_item": { "kind":"checklist_item", "title" }

Rules:
- Interpret relative dates ("tomorrow", "next Tuesday", "this weekend") using today's date.
- If a person's name is mentioned, set assigneeEmail to the matching family member email.
- Default event duration is 1 hour if only a start time is given.
- If no time is given for an event, set isAllDay to true.
- A single request may contain multiple actions (e.g. "buy milk and eggs" = two shopping_items).
- Return [] if nothing actionable.

Return only the JSON array, no other text.`

    const actions = await askClaudeJSON<unknown[]>(prompt)
    return NextResponse.json({ actions })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'AI error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
