'use client'

import { useState } from 'react'
import { Sparkles, ArrowUp } from 'lucide-react'
import { format } from 'date-fns'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { generateId } from '@/lib/utils'
import type {
  FamilyMember, CalendarEvent, FamilyReminder, Chore, Checklist, ShoppingList, RecurrenceRule,
} from '@/lib/types'

interface QuickAction {
  kind: 'event' | 'reminder' | 'chore' | 'shopping_item' | 'checklist_item'
  title?: string
  name?: string
  date?: string
  startTime?: string
  endTime?: string
  isAllDay?: boolean
  location?: string
  assigneeEmail?: string
  priority?: FamilyReminder['priority']
  notes?: string
  frequency?: RecurrenceRule['frequency']
  interval?: number
  quantity?: number
  category?: string
}

const EXAMPLES = [
  'Dentist for Mia next Tuesday at 3pm',
  'Remind me to pay rent on the 1st',
  'Add milk, eggs, and bread to shopping',
  'Take out trash every Monday',
]

export function QuickAddBar() {
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()

  const { data: members } = useFirestore<FamilyMember>('members')
  const events = useFirestore<CalendarEvent>('events')
  const reminders = useFirestore<FamilyReminder>('reminders')
  const chores = useFirestore<Chore>('chores')
  const checklists = useFirestore<Checklist>('checklists')
  const shoppingLists = useFirestore<ShoppingList>('shopping_lists')

  async function applyAction(a: QuickAction): Promise<string> {
    switch (a.kind) {
      case 'event': {
        const date = a.date ?? format(new Date(), 'yyyy-MM-dd')
        const allDay = a.isAllDay ?? !a.startTime
        const start = allDay ? date : `${date}T${a.startTime}:00`
        const end = allDay ? date : `${date}T${a.endTime ?? a.startTime}:00`
        const color = members.find((m) => m.email === a.assigneeEmail)?.colorHex ?? '#3B82F6'
        await events.create({
          id: generateId(),
          title: a.title ?? 'Untitled',
          start, end, isAllDay: allDay,
          ...(a.location ? { location: a.location } : {}),
          calendarId: 'primary',
          ownerEmail: a.assigneeEmail ?? '',
          color,
        })
        return `📅 Event: ${a.title}`
      }
      case 'reminder': {
        const r: FamilyReminder = {
          id: generateId(),
          title: a.title ?? 'Untitled',
          isCompleted: false,
          priority: a.priority ?? 'medium',
          notes: a.notes ?? '',
        }
        if (a.date) r.dueDate = `${a.date}T09:00:00`
        if (a.assigneeEmail) r.assigneeEmail = a.assigneeEmail
        await reminders.create(r)
        return `🔔 Reminder: ${a.title}`
      }
      case 'chore': {
        const recurrence: RecurrenceRule = {
          frequency: a.frequency ?? 'weekly',
          interval: a.interval ?? 1,
        }
        const color = members.find((m) => m.email === a.assigneeEmail)?.colorHex ?? '#22C55E'
        await chores.create({
          id: generateId(),
          name: a.name ?? a.title ?? 'Untitled',
          assigneeEmail: a.assigneeEmail ?? '',
          colorHex: color,
          recurrence,
          streak: 0,
        })
        return `🧹 Chore: ${a.name ?? a.title}`
      }
      case 'shopping_item': {
        const itemName = a.name ?? a.title ?? 'Item'
        const item = {
          id: generateId(),
          name: itemName,
          quantity: a.quantity ?? 1,
          unit: '',
          category: a.category ?? 'Other',
          isPurchased: false,
        }
        const existing = shoppingLists.data[0]
        if (existing) {
          await shoppingLists.update({ ...existing, items: [...existing.items, item] })
        } else {
          await shoppingLists.create({
            id: generateId(), name: 'Shopping List', colorHex: '#22C55E', items: [item],
          })
        }
        return `🛒 ${itemName}`
      }
      case 'checklist_item': {
        const itemTitle = a.title ?? a.name ?? 'Item'
        const item = { id: generateId(), title: itemTitle, isCompleted: false }
        const existing = checklists.data[0]
        if (existing) {
          await checklists.update({ ...existing, items: [...existing.items, item] })
        } else {
          await checklists.create({
            id: generateId(), name: 'To-Do', colorHex: '#3B82F6',
            items: [item], createdAt: new Date().toISOString(),
          })
        }
        return `✅ ${itemTitle}`
      }
      default:
        return ''
    }
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault()
    if (!text.trim() || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/ai/quick-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text.trim(),
          members: members.map((m) => ({ name: m.name, email: m.email })),
          today: format(new Date(), 'yyyy-MM-dd (EEEE)'),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'AI error')

      const actions: QuickAction[] = data.actions ?? []
      if (actions.length === 0) {
        toast('Couldn\'t find anything to add — try rephrasing.', 'info')
        return
      }

      const labels: string[] = []
      for (const a of actions) {
        labels.push(await applyAction(a))
      }
      setText('')
      toast(
        actions.length === 1 ? `Added ${labels[0]}` : `Added ${actions.length} items`,
        'success'
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Something went wrong'
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <Sparkles size={16} className="text-white/90" />
        <p className="text-sm font-medium text-white">Quick Add</p>
      </div>
      <form onSubmit={handleSubmit} className="relative">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type anything in plain English…"
          disabled={loading}
          className="w-full rounded-xl border-0 py-3 pl-4 pr-12 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-white/50 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={loading || !text.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {loading
            ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            : <ArrowUp size={16} />}
        </button>
      </form>
      <div className="flex flex-wrap gap-1.5 mt-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex}
            onClick={() => setText(ex)}
            disabled={loading}
            className="text-[11px] text-white/80 bg-white/10 hover:bg-white/20 rounded-full px-2.5 py-1 transition-colors"
          >
            {ex}
          </button>
        ))}
      </div>
    </div>
  )
}
