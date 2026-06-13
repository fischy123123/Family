import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@/lib/auth'
import { fetchRecentEmails } from '@/lib/google/gmail'
import { analyzeEmailsForSuggestions, suggestMeals } from '@/lib/claude'

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.accessToken) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const mode = body.mode ?? 'suggestions'

  if (mode === 'meals') {
    const meals = await suggestMeals(body.context)
    return NextResponse.json({ meals })
  }

  const emails = await fetchRecentEmails(session.accessToken, 7, 30)
  const suggestions = await analyzeEmailsForSuggestions(emails)
  return NextResponse.json({ suggestions })
}
