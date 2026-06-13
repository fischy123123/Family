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

  // Fetch recent emails from Gmail (last 7 days)
  const listRes = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=25&q=newer_than:7d',
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
    messages.slice(0, 20).map(async ({ id }) => {
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
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a helpful family assistant. Review these recent email subjects and snippets.
Extract events, appointments, deadlines, tasks, or reminders a family should track.
Focus on: doctor/dentist appointments, school events, deliveries, bills due, reservations, sports practices, etc.
Ignore newsletters, promotions, and anything not action-relevant.

Return ONLY a valid JSON array — no markdown, no explanation:
[{"type":"event"|"reminder","title":"...","date":"YYYY-MM-DD or null","notes":"optional short note","confidence":0.0-1.0,"sourceEmailSubject":"..."}]

If nothing relevant found, return [].

Emails:
${emails.map((e) => `Subject: ${e.subject}\nSnippet: ${e.snippet}`).join('\n---\n')}`
    }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  const match = text.match(/\[[\s\S]*\]/)
  const suggestions = match ? JSON.parse(match[0]) : []

  return NextResponse.json({ suggestions })
}
