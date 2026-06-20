'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { format, parseISO, isToday, isTomorrow } from 'date-fns'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin, { DateClickArg } from '@fullcalendar/interaction'
import type { EventClickArg } from '@fullcalendar/core'
import { Plus, Wifi, WifiOff, Sparkles, X, ChevronRight, RefreshCw, Check } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { MemberLegend } from './MemberLegend'
import { EventModal } from './EventModal'
import { EventDetailSheet } from './EventDetailSheet'
import type { CalendarEvent, FamilyMember } from '@/lib/types'

// ── Types ──────────────────────────────────────────────────────

interface EventSuggestion {
  eventId: string
  calendarId: string
  currentTitle: string
  suggestedTitle?: string
  currentNotes?: string
  suggestedNotes?: string
  currentLocation?: string
  suggestedLocation?: string
  reason: string
  isRecurring: boolean
  recurringEventId?: string
  confidence: 'high' | 'medium' | 'low'
}

// ── Main component ─────────────────────────────────────────────

export function FamilyCalendar() {
  const { user } = useAuth()
  const router = useRouter()
  const { tokens, isConnected, getFreshTokens } = useGoogleTokens()

  const {
    data: firestoreEvents,
    create: createFirestore,
    update: updateFirestore,
    remove: removeFirestore,
  } = useFirestore<CalendarEvent>('events')
  const { data: members } = useFirestore<FamilyMember>('members')

  const [view, setView] = useState<'agenda' | 'month'>('agenda')
  const [modalOpen, setModalOpen] = useState(false)
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null)
  const [selectedDate, setSelectedDate] = useState<string>()
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent>()
  const [syncing, setSyncing] = useState(false)
  const lastSyncRef = useRef<number>(0)

  // AI Enhancement state
  const [enhanceOpen, setEnhanceOpen] = useState(false)
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [suggestions, setSuggestions] = useState<EventSuggestion[]>([])
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  const [scopes, setScopes] = useState<Record<string, 'single' | 'series'>>({})
  const [applyingEnhancements, setApplyingEnhancements] = useState(false)

  // Member color lookup by email
  const memberByEmail = new Map(members.map((m) => [m.email?.toLowerCase() ?? '', m]))
  function eventColor(e: CalendarEvent): string {
    const member = e.ownerEmail ? memberByEmail.get(e.ownerEmail.toLowerCase()) : undefined
    return member?.colorHex ?? e.color ?? '#3B82F6'
  }

  // ── Manual Google Calendar re-sync ───────────────────────────
  // The dashboard already syncs on load (writes to Firestore). The calendar
  // page reads Firestore directly — no need to re-fetch from Google on every
  // visit. The refresh button lets the user pull fresh data on demand.

  const triggerSync = useCallback(async () => {
    if (syncing) return
    // Debounce: don't re-sync within 60 s of the last manual refresh
    if (Date.now() - lastSyncRef.current < 60_000) return
    setSyncing(true)
    lastSyncRef.current = Date.now()
    try {
      const idToken = await user?.getIdToken()
      if (!idToken) return
      await fetch('/api/calendar/sync', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      })
    } catch {
      // Silent — Firestore already has the last good data
    } finally {
      setSyncing(false)
    }
  }, [syncing, user])

  // Firestore already contains the Google-synced events (written by /api/calendar/sync
  // on dashboard load). Use those directly — no automatic re-fetch needed here.
  const events = firestoreEvents

  const fcEvents = events.map((e) => {
    const color = eventColor(e)
    return {
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.isAllDay,
      backgroundColor: color,
      borderColor: color,
      textColor: '#fff',
      extendedProps: e,
    }
  })

  // ── Calendar interaction handlers ─────────────────────────────

  const handleDateClick = useCallback((info: DateClickArg) => {
    setSelectedDate(info.dateStr)
    setSelectedEvent(undefined)
    setModalOpen(true)
  }, [])

  const handleEventClick = useCallback((info: EventClickArg) => {
    setDetailEvent(info.event.extendedProps as CalendarEvent)
  }, [])

  // ── Create / Update / Delete ──────────────────────────────────

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
            event: {
              ...ev,
              ownerEmail: user?.email ?? '',
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          }),
        })
        // Re-sync Firestore so the new event appears in the list
        await triggerSync()
        return
      }
    }
    await createFirestore({ ...ev, ownerEmail: user?.email ?? '', color: '#3B82F6' })
  }

  async function handleUpdate(updates: Partial<CalendarEvent>) {
    if (!selectedEvent) return
    if (isConnected) {
      const fresh = await getFreshTokens()
      if (fresh) {
        await fetch(`/api/calendar/events/${selectedEvent.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            calendarId: selectedEvent.calendarId,
            updates: {
              title: updates.title,
              start: updates.start,
              end: updates.end,
              isAllDay: updates.isAllDay,
              location: updates.location,
              notes: updates.notes,
              timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            },
          }),
        })
        // Optimistically update in Firestore so the UI reflects the change immediately
        await updateFirestore({ ...selectedEvent, ...updates })
        return
      }
    }
    await updateFirestore({ ...selectedEvent, ...updates })
  }

  async function handleDelete(event?: CalendarEvent) {
    const target = event ?? detailEvent ?? selectedEvent
    if (!target) return
    if (isConnected) {
      const fresh = await getFreshTokens()
      if (fresh) {
        await fetch(`/api/calendar/events/${target.id}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            calendarId: target.calendarId,
          }),
        })
        // Optimistically remove from Firestore so the UI reflects the change immediately
        await removeFirestore(target.id)
        return
      }
    }
    await removeFirestore(target.id)
  }

  // ── AI Enhancement ────────────────────────────────────────────

  async function loadSuggestions() {
    setEnhanceOpen(true)
    setLoadingSuggestions(true)
    setSuggestions([])
    setSkipped(new Set())
    setScopes({})
    try {
      const res = await fetch('/api/ai/enhance-events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: events.slice(0, 60), members }),
      })
      const data = await res.json()
      if (data.error) {
        console.error('[enhance-events]', data.error)
      }
      if (data.debug) {
        console.warn('[enhance-events] debug:', data.debug)
      }
      if (Array.isArray(data.suggestions)) {
        setSuggestions(data.suggestions)
        const defaultScopes: Record<string, 'single' | 'series'> = {}
        for (const s of data.suggestions as EventSuggestion[]) {
          if (s.isRecurring) defaultScopes[s.eventId] = 'single'
        }
        setScopes(defaultScopes)
      }
    } catch (e) {
      console.error('[enhance-events] fetch error:', e)
    } finally {
      setLoadingSuggestions(false)
    }
  }

  async function applyEnhancements() {
    const fresh = await getFreshTokens()
    if (!fresh) return
    setApplyingEnhancements(true)
    const accepted = suggestions.filter((s) => !skipped.has(s.eventId))
    for (const s of accepted) {
      const scope = scopes[s.eventId] ?? 'single'
      const eventId =
        scope === 'series' && s.recurringEventId ? s.recurringEventId : s.eventId
      const updates: Record<string, string> = {}
      if (s.suggestedTitle) updates.title = s.suggestedTitle
      if (s.suggestedNotes) updates.notes = s.suggestedNotes
      if (s.suggestedLocation) updates.location = s.suggestedLocation
      try {
        await fetch(`/api/calendar/events/${eventId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken: fresh.accessToken,
            refreshToken: fresh.refreshToken,
            calendarId: s.calendarId,
            updates,
          }),
        })
      } catch {
        // Skip failed updates silently
      }
    }
    await triggerSync()
    setApplyingEnhancements(false)
    setEnhanceOpen(false)
  }

  const acceptedCount = suggestions.filter((s) => !skipped.has(s.eventId)).length

  return (
    <div className="pb-8">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <h1 className="text-xl font-bold text-slate-900">Calendar</h1>
        <div className="flex items-center gap-2">
          {isConnected && (
            <button
              onClick={loadSuggestions}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-50 text-purple-600 text-xs font-semibold hover:bg-purple-100 transition-colors"
            >
              <Sparkles size={13} />
              AI Review
            </button>
          )}
          <button
            onClick={() => {
              setSelectedEvent(undefined)
              setSelectedDate(undefined)
              setModalOpen(true)
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors"
          >
            <Plus size={13} />
            Add
          </button>
        </div>
      </div>

      {/* ── Sync status ── */}
      <div className="px-4 mb-3">
        {isConnected ? (
          <div className="flex items-center gap-2 text-xs text-green-600">
            <Wifi size={12} />
            <span>Synced with Google Calendar</span>
            <button
              onClick={triggerSync}
              disabled={syncing}
              className="ml-auto flex items-center gap-1 text-slate-400 hover:text-slate-600 disabled:opacity-40 transition-colors"
              title="Refresh from Google Calendar"
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-amber-600">
              <WifiOff size={12} />
              <span>Local events only</span>
            </div>
            <button
              onClick={() =>
                router.push(`/api/auth/google?email=${encodeURIComponent(user?.email ?? '')}`)
              }
              className="text-xs text-blue-500 hover:text-blue-700 underline underline-offset-2 transition-colors"
            >
              Connect Google Calendar
            </button>
          </div>
        )}
      </div>

      {/* ── View toggle ── */}
      <div className="px-4 mb-4">
        <div className="flex rounded-xl bg-slate-100 p-1 gap-1">
          <button
            onClick={() => setView('agenda')}
            className={`flex-1 text-xs font-semibold py-2 px-4 rounded-lg transition-all ${
              view === 'agenda'
                ? 'bg-white shadow-sm text-slate-900'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Agenda
          </button>
          <button
            onClick={() => setView('month')}
            className={`flex-1 text-xs font-semibold py-2 px-4 rounded-lg transition-all ${
              view === 'month'
                ? 'bg-white shadow-sm text-slate-900'
                : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            Month
          </button>
        </div>
      </div>

      {/* ── Agenda or Month view ── */}
      {view === 'agenda' ? (
        <AgendaView
          events={events}
          members={members}
          eventColor={eventColor}
          onEventClick={setDetailEvent}
        />
      ) : (
        <div className="px-4">
          <MemberLegend members={members} />
          <div className="rounded-2xl overflow-hidden border border-slate-100 shadow-sm">
            <FullCalendar
              plugins={[dayGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={{ left: 'prev,next', center: 'title', right: 'today' }}
              events={fcEvents}
              dateClick={handleDateClick}
              eventClick={handleEventClick}
              height="auto"
              eventDisplay="block"
              dayMaxEventRows={3}
            />
          </div>
        </div>
      )}

      {/* ── Event detail sheet ── */}
      {detailEvent && (
        <EventDetailSheet
          event={detailEvent}
          members={members}
          onClose={() => setDetailEvent(null)}
          onEdit={() => {
            setSelectedEvent(detailEvent)
            setDetailEvent(null)
            setModalOpen(true)
          }}
          onDelete={async () => {
            await handleDelete(detailEvent)
            setDetailEvent(null)
          }}
          onUpdateForIds={async (forIds) => {
            await updateFirestore({ ...detailEvent, forIds })
            setDetailEvent({ ...detailEvent, forIds })
          }}
        />
      )}

      {/* ── Create / Edit modal ── */}
      <EventModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        initialDate={selectedDate}
        event={selectedEvent}
        members={members}
        onCreate={handleCreate}
        onUpdate={selectedEvent ? handleUpdate : undefined}
        onDelete={
          selectedEvent
            ? async () => {
                await handleDelete(selectedEvent)
                setModalOpen(false)
              }
            : undefined
        }
      />

      {/* ── AI Enhancement panel ── */}
      {enhanceOpen && (
        <AIEnhancePanel
          loading={loadingSuggestions}
          suggestions={suggestions}
          skipped={skipped}
          scopes={scopes}
          applying={applyingEnhancements}
          acceptedCount={acceptedCount}
          onToggleSkip={(id) =>
            setSkipped((prev) => {
              const next = new Set(prev)
              next.has(id) ? next.delete(id) : next.add(id)
              return next
            })
          }
          onScopeChange={(id, scope) => setScopes((prev) => ({ ...prev, [id]: scope }))}
          onApply={applyEnhancements}
          onClose={() => setEnhanceOpen(false)}
        />
      )}
    </div>
  )
}

// ── Agenda view ────────────────────────────────────────────────

function AgendaView({
  events,
  members,
  eventColor,
  onEventClick,
}: {
  events: CalendarEvent[]
  members: FamilyMember[]
  eventColor: (e: CalendarEvent) => string
  onEventClick: (e: CalendarEvent) => void
}) {
  const memberByEmail = new Map(members.map((m) => [m.email?.toLowerCase() ?? '', m]))

  const now = new Date()
  const upcoming = events
    .filter((e) => {
      const start = new Date(e.start)
      return start >= new Date(now.getFullYear(), now.getMonth(), now.getDate())
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  if (upcoming.length === 0) {
    return (
      <div className="px-4 py-16 text-center">
        <p className="text-slate-400 text-sm">No upcoming events</p>
      </div>
    )
  }

  // Group by calendar date
  const grouped = new Map<string, CalendarEvent[]>()
  for (const e of upcoming) {
    const dateKey = e.isAllDay
      ? e.start.split('T')[0]
      : new Date(e.start).toLocaleDateString('en-CA') // YYYY-MM-DD
    if (!grouped.has(dateKey)) grouped.set(dateKey, [])
    grouped.get(dateKey)!.push(e)
  }

  return (
    <div className="px-4 space-y-6">
      {Array.from(grouped.entries()).map(([dateKey, dayEvents]) => {
        const date = parseISO(dateKey + 'T00:00:00')
        let label: string
        if (isToday(date)) label = 'Today'
        else if (isTomorrow(date)) label = 'Tomorrow'
        else label = format(date, 'EEEE, MMM d')

        return (
          <div key={dateKey}>
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">
              {label}
            </p>
            <div className="space-y-2">
              {dayEvents.map((e) => {
                const color = eventColor(e)
                const member = e.ownerEmail
                  ? memberByEmail.get(e.ownerEmail.toLowerCase())
                  : undefined
                return (
                  <button
                    key={e.id}
                    onClick={() => onEventClick(e)}
                    className="w-full text-left flex items-stretch bg-white rounded-2xl shadow-sm border border-slate-50 overflow-hidden hover:shadow-md active:scale-[0.99] transition-all"
                  >
                    <div className="w-1 shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex items-center gap-3 px-3.5 py-3 flex-1 min-w-0">
                      <div className="w-14 shrink-0 text-center">
                        {e.isAllDay ? (
                          <span className="text-[10px] text-slate-400 font-medium uppercase">
                            All day
                          </span>
                        ) : (
                          <p className="text-sm font-semibold text-slate-700 leading-none">
                            {format(new Date(e.start), 'h:mm')}
                            <span className="text-[10px] font-normal ml-0.5 text-slate-400">
                              {format(new Date(e.start), 'a')}
                            </span>
                          </p>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-900 truncate">{e.title}</p>
                        {e.location && (
                          <p className="text-xs text-slate-400 truncate mt-0.5">{e.location}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {member && (
                          <span className="text-base leading-none" title={member.name}>
                            {member.emoji}
                          </span>
                        )}
                        {e.recurringEventId && (
                          <RefreshCw size={11} className="text-slate-300" />
                        )}
                        <ChevronRight size={14} className="text-slate-300" />
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── AI Enhancement panel ───────────────────────────────────────

function AIEnhancePanel({
  loading,
  suggestions,
  skipped,
  scopes,
  applying,
  acceptedCount,
  onToggleSkip,
  onScopeChange,
  onApply,
  onClose,
}: {
  loading: boolean
  suggestions: EventSuggestion[]
  skipped: Set<string>
  scopes: Record<string, 'single' | 'series'>
  applying: boolean
  acceptedCount: number
  onToggleSkip: (id: string) => void
  onScopeChange: (id: string, scope: 'single' | 'series') => void
  onApply: () => void
  onClose: () => void
}) {
  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-x-0 bottom-0 z-50 bg-white rounded-t-3xl shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 border-b border-slate-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-purple-100 flex items-center justify-center">
              <Sparkles size={17} className="text-purple-600" />
            </div>
            <div>
              <h2 className="font-bold text-slate-900">AI Calendar Review</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                {loading
                  ? 'Analyzing your events…'
                  : suggestions.length === 0
                  ? 'No improvements needed'
                  : `${suggestions.length} suggestion${suggestions.length !== 1 ? 's' : ''} found`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {loading ? (
            <div className="space-y-3 animate-pulse">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-28 bg-slate-100 rounded-2xl" />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <div className="text-center py-16">
              <div className="text-4xl mb-3">✨</div>
              <p className="font-semibold text-slate-700">Your events look great!</p>
              <p className="text-sm text-slate-400 mt-1">No improvements needed right now.</p>
            </div>
          ) : (
            suggestions.map((s) => {
              const isSkipped = skipped.has(s.eventId)
              const currentScope = scopes[s.eventId] ?? 'single'
              return (
                <div
                  key={s.eventId}
                  className={`rounded-2xl border p-4 transition-all ${
                    isSkipped
                      ? 'opacity-40 bg-slate-50 border-slate-100'
                      : 'bg-white border-slate-100 shadow-sm'
                  }`}
                >
                  {/* Row: event title + Accept/Skip toggle */}
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <p className="text-xs text-slate-500 leading-snug">{s.currentTitle}</p>
                    <button
                      onClick={() => onToggleSkip(s.eventId)}
                      className={`shrink-0 flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${
                        isSkipped
                          ? 'bg-slate-200 text-slate-500 hover:bg-slate-300'
                          : 'bg-green-50 text-green-600 hover:bg-green-100'
                      }`}
                    >
                      {isSkipped ? (
                        'Skip'
                      ) : (
                        <>
                          <Check size={11} /> Accept
                        </>
                      )}
                    </button>
                  </div>

                  {/* Suggested changes */}
                  {s.suggestedTitle && (
                    <div className="mb-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                        Title
                      </p>
                      <p className="text-sm font-semibold text-blue-700">{s.suggestedTitle}</p>
                    </div>
                  )}
                  {s.suggestedLocation && (
                    <div className="mb-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                        Location
                      </p>
                      <p className="text-sm text-slate-700">{s.suggestedLocation}</p>
                    </div>
                  )}
                  {s.suggestedNotes && (
                    <div className="mb-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">
                        Notes
                      </p>
                      <p className="text-xs text-slate-700 leading-relaxed">{s.suggestedNotes}</p>
                    </div>
                  )}

                  <p className="text-xs text-slate-400 italic">{s.reason}</p>

                  {/* Scope picker for recurring events */}
                  {s.isRecurring && !isSkipped && (
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <p className="text-[11px] font-semibold text-slate-500 mb-2 flex items-center gap-1.5">
                        <RefreshCw size={11} /> Recurring — apply to:
                      </p>
                      <div className="flex gap-2">
                        {(['single', 'series'] as const).map((scope) => (
                          <button
                            key={scope}
                            onClick={() => onScopeChange(s.eventId, scope)}
                            className={`flex-1 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                              currentScope === scope
                                ? 'bg-purple-600 text-white border-purple-600'
                                : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
                            }`}
                          >
                            {scope === 'single' ? 'This occurrence' : 'All in series'}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Footer */}
        {!loading && suggestions.length > 0 && (
          <div className="px-4 py-4 border-t border-slate-100 shrink-0">
            <button
              onClick={onApply}
              disabled={applying || acceptedCount === 0}
              className="w-full py-3.5 rounded-2xl bg-purple-600 text-white text-sm font-bold hover:bg-purple-700 disabled:opacity-40 transition-colors"
            >
              {applying
                ? 'Applying changes…'
                : acceptedCount === 0
                ? 'No changes selected'
                : `Apply ${acceptedCount} change${acceptedCount !== 1 ? 's' : ''} to Google Calendar`}
            </button>
          </div>
        )}
      </div>
    </>
  )
}
