'use client'

import { format } from 'date-fns'
import { Calendar, CheckSquare, ShoppingCart, Bell } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_COLORS } from '@/lib/types'
import type { FamilyReminder, Checklist, ShoppingList, Chore, CalendarEvent } from '@/lib/types'
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

  const todayStr = format(new Date(), 'yyyy-MM-dd')
  const events = allEvents.filter((e) => {
    const start = e.start.split('T')[0]
    return start === todayStr
  })

  const dueReminders = reminders.filter(
    (r) => !r.isCompleted && r.dueDate && (isToday(r.dueDate) || isOverdue(r.dueDate))
  )
  const todayChores = chores.filter(isChoreDueToday)
  const activeChecklists = checklists.filter((c) => c.items.some((i) => !i.isCompleted))

  const firstName = user?.displayName?.split(' ')[0] ?? ''

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">
          {greeting()}{firstName ? `, ${firstName}` : ''} 👋
        </h1>
        <p className="text-gray-500 text-sm mt-1">{format(new Date(), 'EEEE, MMMM d')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Calendar size={16} className="text-blue-500" />
            Today&apos;s Events
            {events.length > 0 && <Badge>{events.length}</Badge>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="text-sm text-gray-400">No events today — enjoy the free day!</p>
          ) : (
            <div className="space-y-2">
              {events.map((e) => (
                <div key={e.id} className="flex items-start gap-3">
                  <div
                    className="w-2.5 h-2.5 rounded-full mt-1.5 shrink-0"
                    style={{ backgroundColor: e.color }}
                  />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{e.title}</p>
                    {!e.isAllDay && (
                      <p className="text-xs text-gray-500">
                        {formatTime(e.start)} — {formatTime(e.end)}
                      </p>
                    )}
                    {e.location && <p className="text-xs text-gray-400">{e.location}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {(dueReminders.length > 0 || todayChores.length > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Bell size={16} className="text-orange-500" />
              Needs Attention
              <Badge variant="destructive">{dueReminders.length + todayChores.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {dueReminders.map((r) => (
                <div key={r.id} className="flex items-center gap-3">
                  <div
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: PRIORITY_COLORS[r.priority] }}
                  />
                  <p className="text-sm text-gray-800 flex-1">{r.title}</p>
                  {r.dueDate && isOverdue(r.dueDate) && (
                    <Badge variant="destructive" className="text-xs">Overdue</Badge>
                  )}
                </div>
              ))}
              {todayChores.map((c) => (
                <div key={c.id} className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.colorHex }} />
                  <p className="text-sm text-gray-800 flex-1">🧹 {c.name}</p>
                  {c.streak > 0 && <span className="text-xs text-orange-500">🔥{c.streak}</span>}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {activeChecklists.length > 0 && (
        <Card>
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
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${pct}%`, backgroundColor: c.colorHex }}
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {shoppingLists.some((s) => s.items.some((i) => !i.isPurchased)) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <ShoppingCart size={16} className="text-purple-500" />
              Shopping
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {shoppingLists
                .filter((s) => s.items.some((i) => !i.isPurchased))
                .slice(0, 3)
                .map((s) => {
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
    </div>
  )
}
