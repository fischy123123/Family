import Anthropic from '@anthropic-ai/sdk'
import type { AISuggestion, EmailSnippet } from './types'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

function extractJSON(text: string): string {
  const match = text.match(/\[[\s\S]*\]/)
  return match ? match[0] : '[]'
}

export async function analyzeEmailsForSuggestions(
  emails: EmailSnippet[]
): Promise<AISuggestion[]> {
  if (emails.length === 0) return []

  const emailText = emails
    .slice(0, 25)
    .map((e) => `Subject: ${e.subject}\nDate: ${e.date}\nSnippet: ${e.snippet}`)
    .join('\n---\n')

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: `You are a family assistant helping organize a household. Review these email subjects and snippets from the past week.

Identify ONLY emails that suggest a specific action the family should track:
- Upcoming appointments, events, or deadlines
- Tasks or chores that need doing
- Reminders for things coming up

For each relevant email, return a suggestion. Skip newsletters, promotions, and vague emails.

Return ONLY a JSON array (no other text) with this shape:
[{
  "type": "event" | "reminder" | "chore",
  "title": "brief action title",
  "date": "YYYY-MM-DD or null",
  "notes": "one-line context or null",
  "confidence": 0.0 to 1.0,
  "sourceEmailSubject": "exact subject from email"
}]

Today's date: ${new Date().toISOString().split('T')[0]}

Emails:
${emailText}`,
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'

  try {
    const parsed = JSON.parse(extractJSON(text))
    return Array.isArray(parsed) ? (parsed as AISuggestion[]) : []
  } catch {
    return []
  }
}

export async function suggestMeals(context?: string): Promise<string[]> {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `Suggest 7 family dinner meals for this week. Return ONLY a JSON array of meal name strings.
Example: ["Spaghetti Bolognese", "Chicken Tacos", ...]
${context ? `Family context: ${context}` : ''}`,
      },
    ],
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : '[]'
  try {
    const match = text.match(/\[[\s\S]*\]/)
    const parsed = JSON.parse(match ? match[0] : '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
