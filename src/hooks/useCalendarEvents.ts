import useSWR, { mutate } from 'swr'
import type { CalendarEvent } from '@/lib/types'

const fetcher = (url: string) => fetch(url).then((r) => r.json())

export function useCalendarEvents(timeMin?: string, timeMax?: string) {
  const params = new URLSearchParams()
  if (timeMin) params.set('timeMin', timeMin)
  if (timeMax) params.set('timeMax', timeMax)
  const key = `/api/calendar/events?${params}`

  const { data, error, isLoading } = useSWR<CalendarEvent[]>(key, fetcher)

  async function create(event: Omit<CalendarEvent, 'id' | 'ownerEmail' | 'color'>) {
    const res = await fetch('/api/calendar/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    await mutate(key)
    return res.json()
  }

  async function update(id: string, calendarId: string, updates: Partial<CalendarEvent>) {
    await fetch(`/api/calendar/events/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ calendarId, ...updates }),
    })
    await mutate(key)
  }

  async function remove(id: string, calendarId: string) {
    await fetch(`/api/calendar/events/${id}?calendarId=${calendarId}`, { method: 'DELETE' })
    await mutate(key)
  }

  return { events: data ?? [], error, isLoading, create, update, remove }
}
