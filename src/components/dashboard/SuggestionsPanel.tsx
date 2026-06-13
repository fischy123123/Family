'use client'

import { useState } from 'react'
import { Sparkles, Plus, X, RefreshCw } from 'lucide-react'
import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth'
import { auth } from '@/lib/firebase'
import { useFirestore } from '@/hooks/useFirestore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { generateId } from '@/lib/utils'
import type { CalendarEvent, FamilyReminder } from '@/lib/types'

interface Suggestion {
  type: 'event' | 'reminder'
  title: string
  date: string | null
  notes?: string
  confidence: number
  sourceEmailSubject: string
}

const GMAIL_TOKEN_KEY = 'fcc_gmail_token'
const GMAIL_EXPIRY_KEY = 'fcc_gmail_expiry'

async function getGmailToken(): Promise<string> {
  const cached = localStorage.getItem(GMAIL_TOKEN_KEY)
  const expiry = localStorage.getItem(GMAIL_EXPIRY_KEY)
  if (cached && expiry && Date.now() < parseInt(expiry)) return cached

  const provider = new GoogleAuthProvider()
  provider.addScope('https://www.googleapis.com/auth/gmail.readonly')
  const result = await signInWithPopup(auth, provider)
  const credential = GoogleAuthProvider.credentialFromResult(result)
  const token = credential?.accessToken
  if (!token) throw new Error('Could not get Gmail access token')

  localStorage.setItem(GMAIL_TOKEN_KEY, token)
  localStorage.setItem(GMAIL_EXPIRY_KEY, String(Date.now() + 50 * 60 * 1000))
  return token
}

export function SuggestionsPanel() {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [dismissed, setDismissed] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hasChecked, setHasChecked] = useState(false)

  const { create: createEvent } = useFirestore<CalendarEvent>('events')
  const { create: createReminder } = useFirestore<FamilyReminder>('reminders')

  async function fetchSuggestions() {
    setLoading(true)
    setError('')
    try {
      const accessToken = await getGmailToken()
      const res = await fetch('/api/gmail-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'API error')
      setSuggestions(data.suggestions ?? [])
      setDismissed([])
      setHasChecked(true)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Something went wrong'
      setError(msg)
      // Clear cached token on error so next attempt gets a fresh one
      localStorage.removeItem(GMAIL_TOKEN_KEY)
      localStorage.removeItem(GMAIL_EXPIRY_KEY)
    } finally {
      setLoading(false)
    }
  }

  async function addSuggestion(s: Suggestion, i: number) {
    if (s.type === 'event') {
      const date = s.date ?? new Date().toISOString().split('T')[0]
      await createEvent({
        id: generateId(),
        title: s.title,
        start: `${date}T09:00:00`,
        end: `${date}T10:00:00`,
        isAllDay: false,
        notes: s.notes,
        calendarId: 'primary',
        ownerEmail: '',
        color: '#3B82F6',
      })
    } else {
      const reminder: FamilyReminder = {
        id: generateId(),
        title: s.title,
        isCompleted: false,
        priority: 'medium',
        notes: s.notes ?? '',
      }
      if (s.date) reminder.dueDate = `${s.date}T09:00:00`
      await createReminder(reminder)
    }
    setDismissed((prev) => [...prev, i])
  }

  const visible = suggestions.filter((_, i) => !dismissed.includes(i))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles size={16} className="text-purple-500" />
          Gmail Suggestions
          {visible.length > 0 && <Badge variant="secondary">{visible.length}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!hasChecked && !loading && (
          <div className="text-center py-2">
            <p className="text-xs text-gray-400 mb-3">
              Scan your recent emails for appointments, deadlines, and tasks.
            </p>
            <button
              onClick={fetchSuggestions}
              className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-xl hover:bg-purple-700 transition-colors"
            >
              <Sparkles size={14} />
              Check Gmail
            </button>
          </div>
        )}

        {loading && (
          <div className="flex items-center gap-2 text-sm text-gray-500 py-2">
            <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
            Scanning emails with AI…
          </div>
        )}

        {error && (
          <div className="text-red-500 text-xs py-2">
            {error}
            <button onClick={fetchSuggestions} className="ml-2 underline">Try again</button>
          </div>
        )}

        {hasChecked && !loading && visible.length === 0 && !error && (
          <div className="text-sm text-gray-400 py-2 flex items-center justify-between">
            <span>No new suggestions found in recent emails.</span>
            <button onClick={fetchSuggestions} className="text-purple-500 hover:text-purple-700">
              <RefreshCw size={14} />
            </button>
          </div>
        )}

        {visible.length > 0 && (
          <div className="space-y-2">
            {suggestions.map((s, i) => {
              if (dismissed.includes(i)) return null
              return (
                <div key={i} className="flex items-start gap-3 p-3 bg-purple-50 rounded-xl border border-purple-100">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Badge variant="secondary" className="text-xs capitalize">{s.type}</Badge>
                      {s.date && <span className="text-xs text-gray-500">{s.date}</span>}
                    </div>
                    <p className="text-sm font-medium text-gray-900">{s.title}</p>
                    {s.notes && <p className="text-xs text-gray-500 mt-0.5">{s.notes}</p>}
                    <p className="text-xs text-gray-400 mt-1 truncate">📧 {s.sourceEmailSubject}</p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <button
                      onClick={() => addSuggestion(s, i)}
                      className="p-1.5 rounded-lg bg-purple-600 text-white hover:bg-purple-700"
                      title={`Add as ${s.type}`}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      onClick={() => setDismissed((prev) => [...prev, i])}
                      className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"
                      title="Dismiss"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )
            })}
            <div className="flex justify-end pt-1">
              <button onClick={fetchSuggestions} className="text-xs text-purple-500 hover:text-purple-700 flex items-center gap-1">
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
