import { useState } from 'react'
import type { AISuggestion } from '@/lib/types'

export function useGmailSuggestions() {
  const [suggestions, setSuggestions] = useState<AISuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchSuggestions() {
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/gmail-suggestions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'suggestions' }),
      })
      const data = await res.json()
      setSuggestions(data.suggestions ?? [])
    } catch (e) {
      setError('Failed to fetch suggestions')
    } finally {
      setIsLoading(false)
    }
  }

  function dismiss(index: number) {
    setSuggestions((prev) => prev.filter((_, i) => i !== index))
  }

  return { suggestions, isLoading, error, fetchSuggestions, dismiss }
}
