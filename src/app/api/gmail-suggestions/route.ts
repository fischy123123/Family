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

  // Fetch subject + snippet for each message (keep the id for deep-linking back to Gmail)
  const emails = await Promise.all(
    messages.slice(0, 40).map(async ({ id }) => {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      const data = await res.json()
      const subject = data.payload?.headers?.find((h: { name: string }) => h.name === 'Subject')?.value ?? '(no subject)'
      return { id, subject, snippet: data.snippet ?? '' }
    })
  )

  // Ask Claude to extract family-relevant suggestions
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await anthropic.messages.create({
    // Email extraction is high-volume structured work — Haiku is fast and cheap.
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are a family assistant. Your job is to find things a FAMILY needs to track in their shared life.

INCLUDE (only these categories):
- Medical / health: doctor, dentist, therapist, specialist appointments, prescription pickups, test results
- School: events, permission slips, picture day, term dates, teacher meetings, school newsletters with real dates
- Deliveries: Amazon, UPS, FedEx, USPS packages — extract expected delivery date
- Travel: flight confirmations, hotel bookings, car rentals — extract dates and confirmation numbers
- Family activities: restaurants, events, tickets, kids' activities, classes with a specific date/time
- Bills with an imminent due date: utilities, insurance, credit cards, rent (only if due within 2 weeks)
- Important personal follow-ups with a clear deadline that affects the family

EXCLUDE EVERYTHING ELSE — be ruthless:
- Anything work/professional: Vercel, GitHub, CI/CD, deployment notifications, code review, JIRA, Slack, enterprise SaaS
- Security/auth emails: "verify your email", "sign in attempt", "2-factor", "unusual activity", password resets
- Developer tools and services: any hosting, logging, monitoring, analytics, cloud platform notification
- General marketing, promotions, sales, newsletters without a specific family action
- Social media notifications
- Receipts for past purchases (only future deliveries count)
- Any automated system notification without a concrete family-relevant date or action
- Work meetings, work conferences, professional events (only personal/family events count)

THE TEST: would a stay-at-home parent with no work context find this useful for running the family? If no, exclude it.

Return ONLY a valid JSON array — no markdown, no explanation, no code fences:
[{
  "type": "event" | "reminder" | "delivery" | "travel" | "school",
  "title": "concise title (do not include work/tech jargon)",
  "date": "YYYY-MM-DD or null",
  "notes": "optional short note with key details",
  "confidence": 0.0-1.0,
  "sourceEmailSubject": "exact subject line",
  "messageId": "the ID from the [msgid:ID] prefix of the source email",
  "details": {
    "confirmationNumber": "only if present",
    "deliveryWindow": "only for deliveries",
    "location": "only if relevant"
  }
}]

Rules:
- Only include the "details" fields that are relevant (omit empty/null fields within details)
- If details has no relevant fields, omit the details key entirely
- Map bills and personal follow-ups to type "reminder", reservations to "event", school items to "school"
- Confidence: 0.9+ for explicit dates/confirmed bookings, 0.7-0.8 for inferred, below 0.7 skip it
- When in doubt, leave it out. 3 high-quality signals beat 10 noisy ones.
- Each email is prefixed with [msgid:ID] — include that ID verbatim in the "messageId" field of your output
- If nothing passes the filter, return []

Emails:
${emails.map((e) => `[msgid:${e.id}] Subject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n---\n')}`
    }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  const match = text.match(/\[[\s\S]*\]/)
  const raw: Array<{ date?: string | null; confidence?: number; [key: string]: unknown }> = match ? JSON.parse(match[0]) : []

  // Drop suggestions with dates that have already passed — stale appointment
  // reminders are noise and cause the attention engine to misidentify past
  // appointments as upcoming problems.
  const today = new Date().toISOString().split('T')[0]
  const suggestions = raw.filter((s) => {
    if (!s.date) return true            // no date = timeless signal, keep it
    return s.date >= today              // only keep future or today's dates
  })

  return NextResponse.json({ suggestions })
}
