'use client'

import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import { X, Sparkles, Camera, Loader2, Check, Calendar, ShoppingCart, ListTodo, Brain, CornerUpRight, Plane, ChevronDown } from 'lucide-react'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { generateId } from '@/lib/utils'
import { resolveMemberRef } from '@/lib/members'
import type { FamilyMember, Task, CalendarEvent, SmartList, ExtractedOutcome, FamilyMemory, GroceryItem } from '@/lib/types'

interface GCalendar {
  id: string
  name: string
  primary: boolean
  backgroundColor?: string
}

interface CaptureContextValue {
  open: (opts?: { text?: string; autoAnalyze?: boolean }) => void
  isOpen: boolean
}

const CaptureContext = createContext<CaptureContextValue>({ open: () => {}, isOpen: false })
export const useCapture = () => useContext(CaptureContext)

const OUTCOME_META: Record<string, { icon: typeof Calendar; color: string; label: string }> = {
  task: { icon: ListTodo, color: '#3B82F6', label: 'Task' },
  event: { icon: Calendar, color: '#8B5CF6', label: 'Event' },
  shopping_item: { icon: ShoppingCart, color: '#22C55E', label: 'Shopping' },
  packing_item: { icon: Plane, color: '#14B8A6', label: 'Packing' },
  memory: { icon: Brain, color: '#F59E0B', label: 'Memory' },
  follow_up: { icon: CornerUpRight, color: '#EC4899', label: 'Follow-up' },
}

export function CaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [text, setText] = useState('')
  const [imageData, setImageData] = useState<{ base64: string; mediaType: string; preview: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState('')
  const [outcomes, setOutcomes] = useState<ExtractedOutcome[]>([])
  const [applied, setApplied] = useState<Set<number>>(new Set())
  // Calendar picker: null = not yet loaded; [] = not connected
  const [calendars, setCalendars] = useState<GCalendar[] | null>(null)
  // Per-outcome selected calendar id (default: primary)
  const [calendarSelections, setCalendarSelections] = useState<Record<number, string>>({})
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: members } = useFirestore<FamilyMember>('members')
  const { create: createTask } = useFirestore<Task>('tasks')
  const { data: existingEvents, create: createEvent } = useFirestore<CalendarEvent>('events')
  const { data: lists, update: updateList, create: createList } = useFirestore<SmartList>('lists')
  const { create: createMemory } = useFirestore<FamilyMemory>('memories')
  const { create: createGroceryItem } = useFirestore<GroceryItem>('groceryItems')
  const { toast } = useToast()
  const { isConnected, getFreshTokens } = useGoogleTokens()

  // Fetch writable Google Calendars once when connected and the panel opens.
  // Cached in state so reopening the panel within the same session is instant.
  useEffect(() => {
    if (!isOpen || !isConnected || calendars !== null) return
    ;(async () => {
      try {
        const tokens = await getFreshTokens()
        if (!tokens) return
        const res = await fetch(
          `/api/calendar/calendars?accessToken=${encodeURIComponent(tokens.accessToken)}&refreshToken=${encodeURIComponent(tokens.refreshToken)}`
        )
        const data = await res.json()
        if (res.ok && Array.isArray(data.calendars)) {
          setCalendars(data.calendars)
          // Default each event outcome to the primary calendar
          const primary = data.calendars.find((c: GCalendar) => c.primary)?.id ?? data.calendars[0]?.id
          if (primary) {
            setCalendarSelections((prev) => {
              const next = { ...prev }
              outcomes.forEach((o, i) => {
                if (o.kind === 'event' && !next[i]) next[i] = primary
              })
              return next
            })
          }
        }
      } catch { /* non-fatal — user can still add to Firestore */ }
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, isConnected])

  // Fuzzy dedup: drop event outcomes whose title is substantially contained in an existing event.
  function dedupeEvents(outcomes: ExtractedOutcome[]): ExtractedOutcome[] {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()
    const existing = existingEvents.map((e) => norm(e.title))
    return outcomes.filter((o) => {
      if (o.kind !== 'event') return true
      const t = norm(o.title)
      return !existing.some((e) => e.includes(t) || t.includes(e))
    })
  }

  const calendarEventList = existingEvents
    .slice()
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
    .slice(0, 60)
    .map((e) => `- ${e.title} (${new Date(e.start).toLocaleDateString()})`)

  const open = useCallback((opts?: { text?: string; autoAnalyze?: boolean }) => {
    const prefill = opts?.text ?? ''
    setIsOpen(true)
    setText(prefill)
    setImageData(null)
    setSummary('')
    setOutcomes([])
    setApplied(new Set())
    setCalendarSelections({})

    // If pre-filled text is provided and autoAnalyze is requested, immediately
    // call the extraction API so the user sees results right away.
    if (prefill && opts?.autoAnalyze) {
      setLoading(true)
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      fetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: prefill,
          members: members.map((m) => ({ name: m.name, email: m.email, role: m.role })),
          today: new Date().toISOString(),
          timezone: tz,
          existingEventTitles: calendarEventList,
        }),
      })
        .then((r) => r.json())
        .then((data: { summary?: string; outcomes?: ExtractedOutcome[]; error?: string }) => {
          if (data.error) throw new Error(data.error)
          setSummary(data.summary ?? '')
          setOutcomes(dedupeEvents(data.outcomes ?? []))
        })
        .catch(() => { /* user can still type and manually analyze */ })
        .finally(() => setLoading(false))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, existingEvents])

  function close() {
    setIsOpen(false)
  }

  async function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      setImageData({ base64, mediaType: file.type, preview: result })
    }
    reader.readAsDataURL(file)
  }

  async function process() {
    if (!text.trim() && !imageData) return
    setLoading(true)
    setOutcomes([])
    setSummary('')
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const res = await fetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: text,
          imageBase64: imageData?.base64,
          imageMediaType: imageData?.mediaType,
          members: members.map((m) => ({ name: m.name, email: m.email, role: m.role })),
          today: new Date().toISOString(),
          timezone: tz,
          existingEventTitles: calendarEventList,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
      const newOutcomes: ExtractedOutcome[] = dedupeEvents(data.outcomes ?? [])
      setSummary(data.summary ?? '')
      setOutcomes(newOutcomes)
      if (newOutcomes.length === 0) {
        toast('Nothing actionable found', 'info')
      }
      // Pre-select the primary calendar for any event outcomes
      if (newOutcomes.some((o) => o.kind === 'event') && calendars?.length) {
        const primary = calendars.find((c) => c.primary)?.id ?? calendars[0]?.id
        if (primary) {
          setCalendarSelections((prev) => {
            const next = { ...prev }
            newOutcomes.forEach((o, i) => { if (o.kind === 'event' && !next[i]) next[i] = primary })
            return next
          })
        }
      }
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Extraction failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function applyOutcome(o: ExtractedOutcome, idx: number) {
    // Resolve the AI's assignee (name or email) to a real member so assignment
    // works for emailless children/pets too.
    const assignedMember = resolveMemberRef(members, o.assignee ?? o.assigneeEmail)
    const assigneeId = assignedMember?.id
    const assigneeEmail = assignedMember?.email || o.assigneeEmail || undefined
    try {
      if (o.kind === 'task' || o.kind === 'follow_up') {
        await createTask({
          id: generateId(),
          title: o.title,
          notes: o.notes ?? '',
          isCompleted: false,
          dueDate: o.date,
          assigneeId,
          assigneeEmail,
          priority: o.kind === 'follow_up' ? 'medium' : 'none',
          source: 'capture',
          createdAt: new Date().toISOString(),
        } as Task)
      } else if (o.kind === 'event') {
        const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone
        const start = o.date ?? new Date().toISOString()
        const end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
        const selectedCalendarId = calendarSelections[idx] ?? 'primary'

        if (isConnected) {
          // Add directly to Google Calendar so it syncs across all the user's devices.
          const tokens = await getFreshTokens()
          if (tokens) {
            await fetch('/api/calendar/events', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                event: {
                  title: o.title,
                  start,
                  end,
                  isAllDay: false,
                  notes: o.notes ?? '',
                  calendarId: selectedCalendarId,
                  timezone: userTz,
                },
              }),
            })
            // Also write to Firestore so the family sees it immediately without
            // waiting for the next calendar sync.
            await createEvent({
              id: generateId(),
              title: o.title,
              start,
              end,
              isAllDay: false,
              notes: o.notes ?? '',
              calendarId: selectedCalendarId,
              ownerEmail: assigneeEmail ?? '',
              color: '#8B5CF6',
              source: 'google',
            } as CalendarEvent)
            return
          }
        }
        // Fallback: save to Firestore only
        await createEvent({
          id: generateId(),
          title: o.title,
          start,
          end,
          isAllDay: false,
          notes: o.notes ?? '',
          calendarId: selectedCalendarId,
          ownerEmail: o.assigneeEmail ?? '',
          color: '#8B5CF6',
        } as CalendarEvent)
      } else if (o.kind === 'shopping_item' || o.kind === 'packing_item') {
        if (o.kind === 'shopping_item') {
          // Add directly to the groceryItems subcollection used by GroceryView
          await createGroceryItem({
            id: generateId(),
            name: o.title,
            category: 'other',
            frequency: 'sometimes',
            status: 'need',
            notes: o.notes,
            addedBy: assigneeEmail,
            createdAt: new Date().toISOString(),
          } as GroceryItem)
        } else {
          // packing_item — add to legacy SmartList
          const kind = 'packing'
          let target = lists.find((l) => l.kind === kind)
          if (!target) {
            target = await createList({
              id: generateId(),
              name: 'Packing',
              kind,
              emoji: '🧳',
              colorHex: '#14B8A6',
              createdAt: new Date().toISOString(),
              items: [],
            } as SmartList)
          }
          await updateList({
            ...target,
            items: [...target.items, { id: generateId(), name: o.title, isComplete: false, notes: o.notes }],
          })
        }
      } else if (o.kind === 'memory') {
        // Durable family knowledge — stored at the family level so the
        // assistant reasons through it in every briefing.
        await createMemory({
          id: generateId(),
          text: o.notes ? `${o.title} — ${o.notes}` : o.title,
          subjectEmail: assigneeEmail,
          source: 'capture',
          createdAt: new Date().toISOString(),
        } as FamilyMemory)
      }
      setApplied((prev) => new Set(prev).add(idx))
      toast('Added', 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Could not add', 'error')
    }
  }

  async function applyAll() {
    for (let i = 0; i < outcomes.length; i++) {
      if (!applied.has(i)) await applyOutcome(outcomes[i], i)
    }
  }

  return (
    <CaptureContext.Provider value={{ open, isOpen }}>
      {children}
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={close} />
          <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-float animate-slide-up max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Sparkles size={16} className="text-white" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">Capture</h2>
                  <p className="text-xs text-slate-400">Drop anything — AI sorts it out</p>
                </div>
              </div>
              <button onClick={close} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>

            {/* Body — scrollable; no action buttons so keyboard can't bury them */}
            <div className="flex-1 overflow-auto p-5 space-y-4">
              {imageData && (
                <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageData.preview} alt="capture" className="max-h-40 rounded-xl border border-slate-200" />
                  <button onClick={() => setImageData(null)} className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center">
                    <X size={12} />
                  </button>
                </div>
              )}

              <div className="relative">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Speak or type… e.g. 'Soccer signup due Friday, bring snacks for 12 kids'"
                  rows={3}
                  className="w-full input-premium px-4 py-3 pr-14 text-sm text-slate-800 resize-none"
                />
              </div>

              {/* Outcomes */}
              {summary && (
                <div className="pt-1">
                  <p className="text-xs text-slate-400 mb-3 italic">{summary}</p>
                  <div className="space-y-2">
                    {outcomes.map((o, i) => {
                      const meta = OUTCOME_META[o.kind] ?? OUTCOME_META.task
                      const Icon = meta.icon
                      const isApplied = applied.has(i)
                      const isEventKind = o.kind === 'event'
                      const selectedCalId = calendarSelections[i]
                      const selectedCal = calendars?.find((c) => c.id === selectedCalId)
                      return (
                        <div
                          key={i}
                          className="rounded-xl border border-slate-100 bg-white shadow-card overflow-hidden"
                          style={{ borderLeftWidth: 3, borderLeftColor: meta.color }}
                        >
                          <div className="flex items-center gap-3 p-3">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${meta.color}18` }}>
                              <Icon size={15} style={{ color: meta.color }} />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-slate-800 truncate">{o.title}</p>
                              <p className="text-xs text-slate-400">
                                {meta.label}
                                {o.date ? ` · ${new Date(o.date).toLocaleDateString()}` : ''}
                                {(() => {
                                  const am = resolveMemberRef(members, o.assignee ?? o.assigneeEmail)
                                  const label = am?.name ?? o.assignee ?? o.assigneeEmail
                                  return label ? ` · ${label}` : ''
                                })()}
                              </p>
                            </div>
                            <button
                              onClick={() => applyOutcome(o, i)}
                              disabled={isApplied}
                              className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                              style={
                                isApplied
                                  ? { background: '#dcfce7', color: '#16a34a' }
                                  : { background: meta.color, color: 'white' }
                              }
                            >
                              {isApplied ? <Check size={14} /> : 'Add'}
                            </button>
                          </div>
                          {/* Calendar picker — only for event outcomes when Google is connected */}
                          {isEventKind && isConnected && calendars && calendars.length > 1 && !isApplied && (
                            <div className="px-3 pb-3 -mt-1">
                              <div className="relative">
                                <select
                                  value={selectedCalId ?? ''}
                                  onChange={(e) => setCalendarSelections((prev) => ({ ...prev, [i]: e.target.value }))}
                                  className="w-full text-xs pl-2.5 pr-7 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-600 appearance-none focus:outline-none focus:border-blue-300"
                                >
                                  {calendars.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {c.name}{c.primary ? ' (default)' : ''}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                              </div>
                              {selectedCal && (
                                <p className="text-[10px] text-slate-400 mt-1">
                                  Adding to <span className="font-medium">{selectedCal.name}</span>
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                  {outcomes.length > 1 && applied.size < outcomes.length && (
                    <button
                      onClick={applyAll}
                      className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 transition-colors"
                    >
                      Add all {outcomes.length}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Sticky footer — stays above the keyboard on mobile */}
            <div className="shrink-0 border-t border-slate-100 px-5 py-3 flex gap-2">
              <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} className="hidden" />
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
              >
                <Camera size={15} />
                <span className="hidden sm:inline">Photo</span>
              </button>
              <button
                onClick={process}
                disabled={loading || (!text.trim() && !imageData)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:opacity-40 transition-all"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {loading ? 'Analyzing…' : 'Analyze'}
              </button>
            </div>
          </div>
        </div>
      )}
    </CaptureContext.Provider>
  )
}
