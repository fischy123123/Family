'use client'

import { useMemo } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { Calendar, CheckSquare, ShoppingCart, Bell, Dumbbell, ChevronRight } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { QuickAddBar } from './QuickAddBar'
import { SuggestionsPanel } from './SuggestionsPanel'
import { NotificationPrompt } from './NotificationPrompt'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_COLORS } from '@/lib/types'
import type { FamilyReminder, Checklist, ShoppingList, Chore, CalendarEvent, FamilyMember } from '@/lib/types'
import { isOverdue, isToday, formatTime } from '@/lib/utils'
import { isChoreDueToday } from '@/lib/recurrence'

function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

export function DashboardPage() {
  const { user } = useAuth()
  const { data: allEvents } = useFirestore<CalendarEvent>('events')
  const { data: reminders } = useFirestore<FamilyReminder>('reminders')
  const { data: checklists } = useFirestore<Checklist>('checklists')
  const { data: shoppingLists } = useFirestore<ShoppingList>('shopping_lists')
  const { data: chores } = useFirestore<Chore>('chores')
  const { data: members } = useFirestore<FamilyMember>('members')

  const todayStr = format(new Date(), 'yyyy-MM-dd')

  const events = useMemo(
    () => allEvents
      .filter((e) => e.start.split('T')[0] === todayStr)
      .sort((a, b) => a.start.localeCompare(b.start)),
    [allEvents, todayStr]
  )

  const dueReminders = reminders.filter(
    (r) => !r.isCompleted && r.dueDate && (isToday(r.dueDate) || isOverdue(r.dueDate))
  )
  const todayChores = chores.filter(isChoreDueToday)
  const activeChecklists = checklists.filter((c) => c.items.some((i) => !i.isCompleted))
  const activeShopping = shoppingLists.filter((s) => s.items.some((i) => !i.isPurchased))

  const totalToday = events.length + dueReminders.length + todayChores.length
  const firstName = user?.displayName?.split(' ')[0] ?? ''

  function memberFor(email?: string) {
    return members.find((m) => m.email === email)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-5 animate-fade-in">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {greeting()}{firstName ? `, ${firstName}` : ''} 👋
        </h1>
        <p className="text-gray-500 text-sm mt-1">
          {format(new Date(), 'EEEE, MMMM d')}
          {totalToday > 0 && ` · ${totalToday} thing${totalToday === 1 ? '' : 's'} today`}
        </p>
      </div>

      <NotificationPrompt />

      {/* Quick Add — flagship AI feature */}
      <QuickAddBar />

      {/* Today's agenda */}
      <Card className="animate-slide-up">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar size={16} className="text-blue-500" />
            Today&apos;s Agenda
            {totalToday > 0 && <Badge>{totalToday}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {totalToday === 0 ? (
            <p className="text-sm text-gray-400 py-2">Nothing scheduled — enjoy the open day! 🌿</p>
          ) : (
            <div className="space-y-2.5">
              {events.map((e) => {
                const m = memberFor(e.ownerEmail)
                return (
                  <div key={e.id} className="flex items-start gap-3">
                    <div className="w-14 shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-500">
                        {e.isAllDay ? 'All day' : formatTime(e.start)}
                      </p>
                    </div>
                    <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: e.color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{e.title}</p>
                      {(e.location || m) && (
                        <p className="text-xs text-gray-400">
                          {m && <span>{m.emoji} {m.name}</span>}
                          {m && e.location && ' · '}
                          {e.location}
                        </p>
                      )}
                    </div>
                  </div>
                )
              })}

              {dueReminders.map((r) => (
                <div key={r.id} className="flex items-start gap-3">
                  <div className="w-14 shrink-0 text-right">
                    <p className="text-xs font-medium text-gray-400">Todo</p>
                  </div>
                  <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: PRIORITY_COLORS[r.priority] }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{r.title}</p>
                    {r.dueDate && isOverdue(r.dueDate) && (
                      <span className="text-xs text-red-500">⚠ Overdue</span>
                    )}
                  </div>
                </div>
              ))}

              {todayChores.map((c) => {
                const m = memberFor(c.assigneeEmail)
                return (
                  <div key={c.id} className="flex items-start gap-3">
                    <div className="w-14 shrink-0 text-right">
                      <p className="text-xs font-medium text-gray-400">Chore</p>
                    </div>
                    <div className="w-2 h-2 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: c.colorHex }} />
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900">{c.name}</p>
                      {m && <span className="text-xs text-gray-400">{m.emoji}</span>}
                      {c.streak > 0 && <span className="text-xs text-orange-500">🔥{c.streak}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Per-member snapshot */}
      {members.length > 0 && totalToday > 0 && (
        <Card className="animate-slide-up">
          <CardHeader>
            <CardTitle className="text-sm text-gray-700">Who&apos;s got what today</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              {members.map((m) => {
                const count =
                  events.filter((e) => e.ownerEmail === m.email).length +
                  dueReminders.filter((r) => r.assigneeEmail === m.email).length +
                  todayChores.filter((c) => c.assigneeEmail === m.email).length
                return (
                  <div key={m.id} className="flex items-center gap-2 p-2 rounded-lg bg-gray-50">
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-sm shrink-0"
                      style={{ backgroundColor: `${m.colorHex}25` }}
                    >
                      {m.emoji}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-gray-800 truncate">{m.name}</p>
                      <p className="text-[11px] text-gray-400">{count} item{count === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick links to lists/shopping */}
      <div className="grid grid-cols-2 gap-3">
        <Link href="/tasks?tab=reminders">
          <Card className="hover:border-blue-200 transition-colors h-full">
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
          <Card className="hover:border-blue-200 transition-colors h-full">
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

      {/* Active checklists */}
      {activeChecklists.length > 0 && (
        <Card className="animate-slide-up">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <CheckSquare size={16} className="text-green-500" />
              Active Checklists
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: c.colorHex }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Shopping */}
      {activeShopping.length > 0 && (
        <Card className="animate-slide-up">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShoppingCart size={16} className="text-purple-500" />
              Shopping
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
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
          </CardContent>
        </Card>
      )}

      {/* Gmail AI suggestions */}
      <SuggestionsPanel />
    </div>
  )
}
