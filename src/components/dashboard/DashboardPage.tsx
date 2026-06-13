'use client'

import { useMemo, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { format, addDays, startOfDay, parseISO } from 'date-fns'
import {
  Calendar,
  CheckSquare,
  ShoppingCart,
  Bell,
  Dumbbell,
  ChevronRight,
  AlertCircle,
  RefreshCw,
  MapPin,
  Clock,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { QuickAddBar } from './QuickAddBar'
import { SuggestionsPanel } from './SuggestionsPanel'
import { NotificationPrompt } from './NotificationPrompt'
import { ConnectGooglePrompt } from './ConnectGooglePrompt'
import { AgentChat } from './AgentChat'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_COLORS } from '@/lib/types'
import type { FamilyReminder, Checklist, ShoppingList, Chore, CalendarEvent, FamilyMember } from '@/lib/types'
import { isOverdue, isToday, formatTime } from '@/lib/utils'
import { isChoreDueToday } from '@/lib/recurrence'
import Link from 'next/link'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

function userInitials(name: string | null | undefined): string {
  if (!name) return '?'
  return name
    .split(' ')
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase()
}

/** Build a short 2-3 sentence briefing from local data */
function buildBriefing(params: {
  firstName: string
  todayEvents: CalendarEvent[]
  overdueReminders: FamilyReminder[]
  todayReminders: FamilyReminder[]
  todayChores: Chore[]
  members: FamilyMember[]
}): string {
  const { firstName, todayEvents, overdueReminders, todayReminders, todayChores, members } = params

  function memberName(email?: string) {
    const m = members.find((m) => m.email === email)
    return m?.name ?? email?.split('@')[0] ?? 'Someone'
  }

  const sentences: string[] = []

  // Sentence 1: opening
  if (todayEvents.length === 0 && todayReminders.length === 0 && todayChores.length === 0) {
    sentences.push(`${greeting()}${firstName ? `, ${firstName}` : ''}. Your schedule is clear today — enjoy the breathing room.`)
  } else {
    sentences.push(`${greeting()}${firstName ? `, ${firstName}` : ''}.`)

    if (todayEvents.length > 0) {
      const highlights = todayEvents.slice(0, 2).map((e) => {
        const who = memberName(e.ownerEmail)
        const time = e.isAllDay ? 'all day' : `at ${formatTime(e.start)}`
        return `${who}'s ${e.title} ${time}`
      })
      const rest = todayEvents.length > 2 ? ` and ${todayEvents.length - 2} more` : ''
      sentences.push(`Today: ${highlights.join(', ')}${rest}.`)
    }

    if (todayChores.length > 0) {
      const chore = todayChores[0]
      const who = memberName(chore.assigneeEmail)
      sentences.push(
        todayChores.length === 1
          ? `${who} has ${chore.name} on the chore list.`
          : `${todayChores.length} chores are due today, including ${chore.name}.`
      )
    }
  }

  if (overdueReminders.length > 0) {
    sentences.push(
      `${overdueReminders.length} reminder${overdueReminders.length === 1 ? ' is' : 's are'} overdue — worth a look.`
    )
  }

  return sentences.join(' ')
}

/** Group events into day buckets over the next N days */
function groupEventsByDay(events: CalendarEvent[], days = 7): Array<{ label: string; dateStr: string; events: CalendarEvent[] }> {
  const today = startOfDay(new Date())
  const buckets: Array<{ label: string; dateStr: string; events: CalendarEvent[] }> = []

  for (let i = 0; i < days; i++) {
    const day = addDays(today, i)
    const dateStr = format(day, 'yyyy-MM-dd')
    const dayEvents = events.filter((e) => e.start.split('T')[0] === dateStr)
    if (dayEvents.length === 0) continue
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : format(day, 'EEEE, MMM d')
    buckets.push({ label, dateStr, events: dayEvents.sort((a, b) => a.start.localeCompare(b.start)) })
  }
  return buckets
}

export function DashboardPage() {
  const { user } = useAuth()
  const router = useRouter()
  const { tokens, isConnected, getFreshTokens } = useGoogleTokens()

  const { data: firestoreEvents } = useFirestore<CalendarEvent>('events')
  const { data: reminders } = useFirestore<FamilyReminder>('reminders')
  const { data: checklists } = useFirestore<Checklist>('checklists')
  const { data: shoppingLists } = useFirestore<ShoppingList>('shopping_lists')
  const { data: chores } = useFirestore<Chore>('chores')
  const { data: members } = useFirestore<FamilyMember>('members')

  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const [briefingText, setBriefingText] = useState('')
  const [briefingLoading, setBriefingLoading] = useState(false)

  const todayStr = format(new Date(), 'yyyy-MM-dd')

  // Fetch Google Calendar events if connected
  useEffect(() => {
    if (!isConnected) return
    let cancelled = false

    async function fetchGoogleEvents() {
      const fresh = await getFreshTokens()
      if (!fresh || cancelled) return

      const timeMin = new Date().toISOString()
      const timeMax = addDays(new Date(), 7).toISOString()
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
        // Fall back to Firestore events silently
      }
    }

    fetchGoogleEvents()
    return () => { cancelled = true }
  }, [isConnected, tokens])

  // Choose event source: Google if connected, Firestore otherwise
  const allEvents = isConnected ? googleEvents : firestoreEvents

  // Today's items
  const todayEvents = useMemo(
    () => allEvents.filter((e) => e.start.split('T')[0] === todayStr).sort((a, b) => a.start.localeCompare(b.start)),
    [allEvents, todayStr]
  )
  const overdueReminders = reminders.filter((r) => !r.isCompleted && r.dueDate && isOverdue(r.dueDate))
  const todayReminders = reminders.filter((r) => !r.isCompleted && r.dueDate && isToday(r.dueDate))
  const todayChores = chores.filter(isChoreDueToday)
  const activeChecklists = checklists.filter((c) => c.items.some((i) => !i.isCompleted))
  const activeShopping = shoppingLists.filter((s) => s.items.some((i) => !i.isPurchased))

  // 7-day upcoming (excludes today for the Upcoming section)
  const upcomingBuckets = useMemo(() => groupEventsByDay(allEvents, 7), [allEvents])

  const firstName = user?.displayName?.split(' ')[0] ?? ''

  function memberFor(email?: string) {
    return members.find((m) => m.email === email)
  }

  // Build briefing text on mount / when data loads
  useEffect(() => {
    if (briefingText) return // don't regenerate unless asked
    const text = buildBriefing({ firstName, todayEvents, overdueReminders, todayReminders, todayChores, members })
    setBriefingText(text)
  }, [todayEvents.length, overdueReminders.length, todayChores.length, members.length])

  async function refreshBriefing() {
    setBriefingLoading(true)
    try {
      const res = await fetch('/api/ai/briefing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          todayEvents,
          overdueReminders,
          todayReminders,
          todayChores,
          members,
        }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.text) setBriefingText(data.text)
      } else {
        // Fallback to local generation
        setBriefingText(buildBriefing({ firstName, todayEvents, overdueReminders, todayReminders, todayChores, members }))
      }
    } catch {
      setBriefingText(buildBriefing({ firstName, todayEvents, overdueReminders, todayReminders, todayChores, members }))
    } finally {
      setBriefingLoading(false)
    }
  }

  function handleConnectGoogle() {
    router.push(`/api/auth/google?email=${encodeURIComponent(user?.email ?? '')}`)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {greeting()}{firstName ? `, ${firstName}` : ''} 👋
          </h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {format(new Date(), 'EEEE, MMMM d')}
          </p>
        </div>
        {user?.photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.photoURL}
            alt={user.displayName ?? 'Avatar'}
            className="w-9 h-9 rounded-full border-2 border-white shadow-sm"
          />
        ) : (
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-purple-500 flex items-center justify-center text-white text-xs font-semibold shadow-sm">
            {userInitials(user?.displayName)}
          </div>
        )}
      </div>

      <NotificationPrompt />

      {/* ── Connect Google prompt (if not connected) ── */}
      {!isConnected && <ConnectGooglePrompt onConnect={handleConnectGoogle} />}

      {/* ── Quick Add Bar ── */}
      <QuickAddBar />

      {/* ── Today's Briefing ── */}
      <Card className="border-0 shadow-sm bg-gradient-to-br from-blue-50 to-purple-50 animate-slide-up">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-sm">
            <div className="flex items-center gap-2 text-blue-700">
              <span className="text-base">✨</span>
              Today&apos;s Briefing
            </div>
            <button
              onClick={refreshBriefing}
              disabled={briefingLoading}
              title="Regenerate briefing"
              className="text-blue-400 hover:text-blue-600 disabled:opacity-40 transition-colors"
            >
              <RefreshCw size={13} className={briefingLoading ? 'animate-spin' : ''} />
            </button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-gray-700 leading-relaxed">
            {briefingText || 'Loading…'}
          </p>
        </CardContent>
      </Card>

      {/* ── Agent Chat ── */}
      <AgentChat />

      {/* ── Upcoming Events (next 7 days) ── */}
      {upcomingBuckets.length > 0 && (
        <Card className="animate-slide-up">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Calendar size={15} className="text-blue-500" />
              Upcoming Events
              {isConnected && (
                <span className="ml-auto text-[10px] font-normal text-green-600">Synced with Google</span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {upcomingBuckets.map(({ label, dateStr, events }) => (
                <div key={dateStr}>
                  <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">{label}</p>
                  <div className="space-y-2">
                    {events.map((e) => {
                      const m = memberFor(e.ownerEmail)
                      return (
                        <div key={e.id} className="flex items-start gap-3 group">
                          {/* Color stripe */}
                          <div
                            className="w-0.5 self-stretch rounded-full shrink-0"
                            style={{ backgroundColor: m?.colorHex ?? e.color ?? '#3B82F6' }}
                          />
                          <div className="flex-1 min-w-0 py-0.5">
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-sm font-medium text-gray-900 truncate">{e.title}</p>
                              {!e.isAllDay && (
                                <p className="text-xs text-gray-400 shrink-0 flex items-center gap-0.5">
                                  <Clock size={10} />
                                  {formatTime(e.start)}
                                </p>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {m && <span className="text-[11px] text-gray-400">{m.emoji} {m.name}</span>}
                              {e.location && (
                                <span className="text-[11px] text-gray-400 flex items-center gap-0.5">
                                  <MapPin size={9} />
                                  {e.location}
                                </span>
                              )}
                              {e.isAllDay && <span className="text-[11px] text-gray-400">All day</span>}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Active Alerts (overdue reminders) ── */}
      {overdueReminders.length > 0 && (
        <Card className="border-red-100 bg-red-50 animate-slide-up">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm text-red-700">
              <AlertCircle size={15} className="text-red-500" />
              Active Alerts
              <Badge className="bg-red-100 text-red-700 border-0">{overdueReminders.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {overdueReminders.map((r) => (
                <div key={r.id} className="flex items-start gap-3">
                  <div
                    className="w-2 h-2 rounded-full mt-1.5 shrink-0"
                    style={{ backgroundColor: PRIORITY_COLORS[r.priority] }}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-red-900">{r.title}</p>
                    {r.dueDate && (
                      <p className="text-xs text-red-500">
                        Due {format(parseISO(r.dueDate), 'MMM d')}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Family Snapshot ── */}
      {members.length > 0 && (
        <Card className="animate-slide-up">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-gray-700">Family Snapshot</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {members.map((m) => {
                const mEvents = allEvents.filter(
                  (e) => e.ownerEmail === m.email && e.start.split('T')[0] === todayStr
                )
                const mReminders = reminders.filter(
                  (r) => !r.isCompleted && r.assigneeEmail === m.email && r.dueDate && (isToday(r.dueDate) || isOverdue(r.dueDate))
                )
                const mChores = todayChores.filter((c) => c.assigneeEmail === m.email)
                const count = mEvents.length + mReminders.length + mChores.length
                const nextEvent = mEvents[0]

                return (
                  <div
                    key={m.id}
                    className="flex items-start gap-2.5 p-2.5 rounded-xl bg-gray-50 border border-gray-100"
                  >
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
                      style={{ backgroundColor: `${m.colorHex}25`, border: `2px solid ${m.colorHex}40` }}
                    >
                      {m.emoji}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-gray-800 truncate">{m.name}</p>
                      {count === 0 ? (
                        <p className="text-[11px] text-gray-400">Free today</p>
                      ) : (
                        <>
                          <p className="text-[11px] text-gray-500">{count} item{count === 1 ? '' : 's'} today</p>
                          {nextEvent && (
                            <p className="text-[11px] text-gray-400 truncate">
                              {nextEvent.isAllDay ? nextEvent.title : `${formatTime(nextEvent.start)} ${nextEvent.title}`}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Quick nav tiles ── */}
      <div className="grid grid-cols-2 gap-3">
        <Link href="/tasks?tab=reminders">
          <Card className="hover:border-blue-200 transition-colors h-full cursor-pointer">
            <CardContent className="pt-4 flex items-center justify-between">
              <div>
                <Bell size={18} className="text-orange-500 mb-1" />
                <p className="text-sm font-medium text-gray-900">Reminders</p>
                <p className="text-xs text-gray-400">{reminders.filter((r) => !r.isCompleted).length} open</p>
              </div>
              <ChevronRight size={16} className="text-gray-300" />
            </CardContent>
          </Card>
        </Link>
        <Link href="/tasks?tab=chores">
          <Card className="hover:border-blue-200 transition-colors h-full cursor-pointer">
            <CardContent className="pt-4 flex items-center justify-between">
              <div>
                <Dumbbell size={18} className="text-green-500 mb-1" />
                <p className="text-sm font-medium text-gray-900">Chores</p>
                <p className="text-xs text-gray-400">{todayChores.length} due today</p>
              </div>
              <ChevronRight size={16} className="text-gray-300" />
            </CardContent>
          </Card>
        </Link>
      </div>

      {/* ── Active Lists ── */}
      {(activeChecklists.length > 0 || activeShopping.length > 0) && (
        <Card className="animate-slide-up">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckSquare size={15} className="text-green-500" />
              Active Lists
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Checklists */}
              {activeChecklists.length > 0 && (
                <div className="space-y-3">
                  {activeChecklists.slice(0, 3).map((c) => {
                    const done = c.items.filter((i) => i.isCompleted).length
                    const total = c.items.length
                    const pct = total > 0 ? Math.round((done / total) * 100) : 0
                    return (
                      <div key={c.id}>
                        <div className="flex justify-between items-center mb-1">
                          <p className="text-sm font-medium text-gray-800">{c.name}</p>
                          <p className="text-xs text-gray-500">{done}/{total}</p>
                        </div>
                        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, backgroundColor: c.colorHex }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Shopping lists */}
              {activeShopping.length > 0 && (
                <>
                  {activeChecklists.length > 0 && <div className="border-t border-gray-100" />}
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                      <ShoppingCart size={11} className="text-purple-400" />
                      Shopping
                    </p>
                    {activeShopping.slice(0, 3).map((s) => {
                      const remaining = s.items.filter((i) => !i.isPurchased).length
                      return (
                        <div key={s.id} className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: s.colorHex }} />
                            <p className="text-sm text-gray-800">{s.name}</p>
                            {s.store && <p className="text-xs text-gray-400">· {s.store}</p>}
                          </div>
                          <Badge variant="secondary">{remaining} left</Badge>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Gmail AI suggestions ── */}
      <SuggestionsPanel />
    </div>
  )
}
