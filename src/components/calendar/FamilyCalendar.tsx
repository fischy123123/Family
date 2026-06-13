'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { addDays } from 'date-fns'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import timeGridPlugin from '@fullcalendar/timegrid'
import interactionPlugin, { DateClickArg } from '@fullcalendar/interaction'
import type { EventClickArg } from '@fullcalendar/core'
import { Plus, Wifi, WifiOff } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { MemberLegend } from './MemberLegend'
import { EventModal } from './EventModal'
import { Button } from '@/components/ui/button'
import type { CalendarEvent, FamilyMember } from '@/lib/types'

export function FamilyCalendar() {
  const { user } = useAuth()
  const router = useRouter()
  const { tokens, isConnected, getFreshTokens } = useGoogleTokens()

  const { data: firestoreEvents, create: createFirestore, update: updateFirestore, remove: removeFirestore } =
    useFirestore<CalendarEvent>('events')
  const { data: members } = useFirestore<FamilyMember>('members')

  const [modalOpen, setModalOpen] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string>()
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent>()
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])

  // ── Fetch Google Calendar events ──
  useEffect(() => {
    if (!isConnected) return
    let cancelled = false

    async function fetchEvents() {
      const fresh = await getFreshTokens()
      if (!fresh || cancelled) return

      const timeMin = new Date().toISOString()
      const timeMax = addDays(new Date(), 60).toISOString()
      const params = new URLSearchParams({
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        timeMin,
        timeMax,
      })

      try {
        const res = await fetch(`/api/calendar/events?${params}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        if (!cancelled && Array.isArray(data.events)) {
          setGoogleEvents(data.events as CalendarEvent[])
        }
      } catch {
        // Silently fall back to Firestore events
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [isConnected, tokens])

  // Use Google events when connected, otherwise Firestore
  const events = isConnected ? googleEvents : firestoreEvents

  const fcEvents = events.map((e) => ({
    id: e.id,
    title: e.title,
    start: e.start,
    end: e.end,
    allDay: e.isAllDay,
    backgroundColor: e.color ?? '#3B82F6',
    borderColor: e.color ?? '#3B82F6',
    textColor: '#fff',
    extendedProps: e,
  }))

  const handleDateClick = useCallback((info: DateClickArg) => {
    setSelectedDate(info.dateStr)
    setSelectedEvent(undefined)
    setModalOpen(true)
  }, [])

  const handleEventClick = useCallback((info: EventClickArg) => {
    setSelectedEvent(info.event.extendedProps as CalendarEvent)
    setSelectedDate(undefined)
    setModalOpen(true)
  }, [])

  // ── Create event: Google or Firestore ──
  async function handleCreate(ev: Omit<CalendarEvent, 'id' | 'ownerEmail' | 'color'>) {
    if (isConnected) {
      const fresh = await getFreshTokens()
      if (fresh) {
        await fetch('/api/calendar/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            event: { ...ev, ownerEmail: user?.email ?? '' },
          }),
        })
        // Re-fetch events
        const timeMin = new Date().toISOString()
        const timeMax = addDays(new Date(), 60).toISOString()
        const params = new URLSearchParams({
          accessToken: fresh.accessToken,
          refreshToken: fresh.refreshToken,
          timeMin,
          timeMax,
        })
        const res = await fetch(`/api/calendar/events?${params}`)
        if (res.ok) {
          const data = await res.json()
          if (Array.isArray(data.events)) setGoogleEvents(data.events as CalendarEvent[])
        }
        return
      }
    }
    // Fallback to Firestore
    await createFirestore({ ...ev, ownerEmail: user?.email ?? '', color: '#3B82F6' })
  }

  // ── Update event ──
  async function handleUpdate(updates: Partial<CalendarEvent>) {
    if (!selectedEvent) return
    if (isConnected) {
      const fresh = await getFreshTokens()
      if (fresh) {
        await fetch('/api/calendar/events', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            event: { ...selectedEvent, ...updates },
          }),
        })
        setGoogleEvents((prev) =>
          prev.map((e) => (e.id === selectedEvent.id ? { ...e, ...updates } : e))
        )
        return
      }
    }
    await updateFirestore({ ...selectedEvent, ...updates })
  }

  // ── Delete event ──
  async function handleDelete() {
    if (!selectedEvent) return
    if (isConnected) {
      const fresh = await getFreshTokens()
      if (fresh) {
        await fetch(`/api/calendar/events?eventId=${selectedEvent.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
          }),
        })
        setGoogleEvents((prev) => prev.filter((e) => e.id !== selectedEvent.id))
        return
      }
    }
    await removeFirestore(selectedEvent.id)
  }

  function handleConnectGoogle() {
    router.push(`/api/auth/google?email=${encodeURIComponent(user?.email ?? '')}`)
  }

  return (
    <div className="p-4">
      {/* ── Calendar header ── */}
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold text-gray-900">Calendar</h1>
        <Button
          size="sm"
          onClick={() => {
            setSelectedEvent(undefined)
            setSelectedDate(undefined)
            setModalOpen(true)
          }}
        >
          <Plus size={16} className="mr-1" /> Add Event
        </Button>
      </div>

      {/* ── Sync status banner ── */}
      {isConnected ? (
        <div className="flex items-center gap-1.5 mb-3 text-xs text-green-600">
          <Wifi size={12} />
          <span>Synced with Google Calendar</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 mb-3">
          <div className="flex items-center gap-1.5 text-xs text-amber-600">
            <WifiOff size={12} />
            <span>Showing local events only</span>
          </div>
          <button
            onClick={handleConnectGoogle}
            className="text-xs text-blue-500 hover:text-blue-700 underline underline-offset-2 transition-colors"
          >
            Connect Google Calendar
          </button>
        </div>
      )}

      <MemberLegend members={members} />

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        <FullCalendar
          plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
          initialView="dayGridMonth"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,timeGridWeek',
          }}
          events={fcEvents}
          dateClick={handleDateClick}
          eventClick={handleEventClick}
          height="auto"
          eventDisplay="block"
          dayMaxEventRows={3}
        />
      </div>

      <EventModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initialDate={selectedDate}
        event={selectedEvent}
        onCreate={handleCreate}
        onUpdate={selectedEvent ? handleUpdate : undefined}
        onDelete={selectedEvent ? handleDelete : undefined}
      />
    </div>
  )
}
