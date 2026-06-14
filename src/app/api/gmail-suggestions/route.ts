import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(request: NextRequest) {
  const { accessToken } = await request.json()

  if (!accessToken) {
    return NextResponse.json({ error: 'No access token provided' }, { status: 401 })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  // Fetch recent emails from Gmail (last 14 days)
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=40&q=newer_than:14d',
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )

  if (!listRes.ok) {
    return NextResponse.json({ error: 'Gmail API error — token may have expired' }, { status: 400 })
  }

  const listData = await listRes.json()
  const messages: { id: string }[] = listData.messages ?? []

  if (messages.length === 0) {
    return NextResponse.json({ suggestions: [] })
  }

  // Fetch subject + snippet for each message
  const emails = await Promise.all(
    messages.slice(0, 40).map(async ({ id }) => {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      const data = await res.json()
      const subject = data.payload?.headers?.find((h: { name: string }) => h.name === 'Subject')?.value ?? '(no subject)'
      return { subject, snippet: data.snippet ?? '' }
    })
  )

  // Ask Claude to extract family-relevant suggestions
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are a helpful family assistant. Review these recent email subjects and snippets.
Extract anything a family should track, across these categories:

- appointments: doctor, dentist, school meetings, therapist, specialist visits
- deliveries: Amazon, UPS, FedEx, USPS — extract expected delivery date from snippet
- travel: flight confirmations, hotel bookings, rental cars — extract dates and confirmation numbers
- school: newsletters with term dates, picture day, permission slips, school events
- reservations: restaurants, activities, tickets, classes — extract date and time
- bills: due dates for utilities, subscriptions, credit cards, rent
- follow-ups: anything with a clear deadline or action needed by a specific date

Ignore: generic marketing/promotions, spam, newsletters without specific dates or actions, anything that isn't actionable.

Return ONLY a valid JSON array — no markdown, no explanation, no code fences:
[{
  "type": "event" | "reminder" | "delivery" | "travel" | "school",
  "title": "concise title",
  "date": "YYYY-MM-DD or null",
  "notes": "optional short note with key details",
  "confidence": 0.0-1.0,
  "sourceEmailSubject": "exact subject line",
  "details": {
    "confirmationNumber": "only if present",
    "deliveryWindow": "only for deliveries",
    "location": "only if relevant"
  }
}]

Rules:
- Only include the "details" fields that are relevant for that item (omit empty/null fields within details)
- If details has no relevant fields, omit the details key entirely
- Map bills and follow-ups to type "reminder", reservations to "event", school items to "school"
- Confidence: 0.9+ for explicit dates/confirmed bookings, 0.6-0.8 for inferred, below 0.6 skip it
- If nothing relevant found, return []

Emails:
${emails.map((e) => `Subject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n---\n')}`
    }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  const match = text.match(/\[[\s\S]*\]/)
  const suggestions = match ? JSON.parse(match[0]) : []

  return NextResponse.json({ suggestions })
}
