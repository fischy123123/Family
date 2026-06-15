'use client'

import React from 'react'
import {
  CalendarDays,
  Bell,
  ShoppingCart,
  ListChecks,
  UtensilsCrossed,
  CheckCircle2,
  RefreshCw,
  Brain,
  Check,
  X,
  Loader2,
} from 'lucide-react'
import { format, parseISO, isValid } from 'date-fns'
import type { FamilyMember } from '@/lib/types'

export interface PendingAction {
  id: string
  tool: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>
  tempId?: string
}

export type ActionStatus = 'pending' | 'confirming' | 'done' | 'cancelled'

interface ActionView {
  icon: React.ElementType
  accent: string // tailwind text color
  bg: string // tailwind bg color
  label: string // small category label
  title: string
  details: { label: string; value: string }[]
}

function fmtDateTime(value: string | undefined, allDay?: boolean): string {
  if (!value) return ''
  const d = value.includes('T') ? parseISO(value) : parseISO(value + 'T00:00:00')
  if (!isValid(d)) return value
  return allDay || !value.includes('T')
    ? format(d, 'EEE, MMM d')
    : format(d, 'EEE, MMM d · h:mm a')
}

function nameFor(email: string | undefined, members: FamilyMember[]): string {
  if (!email) return ''
  const m = members.find((mm) => mm.email?.toLowerCase() === email.toLowerCase())
  return m ? `${m.emoji ? m.emoji + ' ' : ''}${m.name}` : email
}

function describe(action: PendingAction, members: FamilyMember[]): ActionView {
  const { tool, input } = action

  switch (tool) {
    case 'create_event':
    case 'create_google_event': {
      const details: { label: string; value: string }[] = [
        { label: 'When', value: fmtDateTime(input.start_datetime, input.is_all_day) },
      ]
      if (input.location) details.push({ label: 'Where', value: input.location })
      const who = nameFor(input.assignee_email, members)
      if (who) details.push({ label: 'For', value: who })
      return {
        icon: CalendarDays,
        accent: 'text-blue-600',
        bg: 'bg-blue-50',
        label: tool === 'create_google_event' ? 'New Google Calendar event' : 'New calendar event',
        title: input.title ?? 'Event',
        details,
      }
    }
    case 'create_reminder': {
      const details: { label: string; value: string }[] = []
      if (input.due_date) details.push({ label: 'Due', value: fmtDateTime(input.due_date) })
      if (input.priority && input.priority !== 'none') {
        details.push({ label: 'Priority', value: String(input.priority) })
      }
      const who = nameFor(input.assignee_email, members)
      if (who) details.push({ label: 'For', value: who })
      return {
        icon: Bell,
        accent: 'text-amber-600',
        bg: 'bg-amber-50',
        label: 'New reminder',
        title: input.title ?? 'Reminder',
        details,
      }
    }
    case 'create_chore': {
      const details: { label: string; value: string }[] = []
      const who = nameFor(input.assignee_email, members)
      if (who) details.push({ label: 'Assigned to', value: who })
      const interval = input.interval && input.interval > 1 ? `every ${input.interval} ` : ''
      if (input.frequency) details.push({ label: 'Repeats', value: `${interval}${input.frequency}` })
      return {
        icon: RefreshCw,
        accent: 'text-emerald-600',
        bg: 'bg-emerald-50',
        label: 'New chore',
        title: input.name ?? 'Chore',
        details,
      }
    }
    case 'create_shopping_list': {
      const details: { label: string; value: string }[] = []
      if (input.store) details.push({ label: 'Store', value: input.store })
      return {
        icon: ShoppingCart,
        accent: 'text-purple-600',
        bg: 'bg-purple-50',
        label: 'New shopping list',
        title: input.name ?? 'Shopping list',
        details,
      }
    }
    case 'add_shopping_items': {
      const items = (input.items ?? []) as Array<{ name: string; quantity?: number; unit?: string }>
      const names = items
        .map((i) => {
          const qty = i.quantity && i.quantity > 1 ? `${i.quantity}${i.unit ? ' ' + i.unit : ''} ` : ''
          return `${qty}${i.name}`
        })
        .join(', ')
      return {
        icon: ShoppingCart,
        accent: 'text-purple-600',
        bg: 'bg-purple-50',
        label: 'Add to shopping list',
        title: `${items.length} item${items.length === 1 ? '' : 's'}`,
        details: [{ label: 'Items', value: names }],
      }
    }
    case 'create_checklist': {
      return {
        icon: ListChecks,
        accent: 'text-blue-600',
        bg: 'bg-blue-50',
        label: 'New checklist',
        title: input.name ?? 'Checklist',
        details: [],
      }
    }
    case 'add_checklist_items': {
      const items = (input.items ?? []) as string[]
      return {
        icon: ListChecks,
        accent: 'text-blue-600',
        bg: 'bg-blue-50',
        label: 'Add to checklist',
        title: `${items.length} item${items.length === 1 ? '' : 's'}`,
        details: [{ label: 'Items', value: items.join(', ') }],
      }
    }
    case 'set_meal': {
      const details: { label: string; value: string }[] = []
      if (input.date) details.push({ label: 'Day', value: fmtDateTime(input.date) })
      const ing = (input.ingredients ?? []) as string[]
      if (ing.length) details.push({ label: 'Ingredients', value: ing.join(', ') })
      return {
        icon: UtensilsCrossed,
        accent: 'text-orange-600',
        bg: 'bg-orange-50',
        label: 'Plan a meal',
        title: input.meal_name ?? 'Meal',
        details,
      }
    }
    case 'complete_reminder': {
      return {
        icon: CheckCircle2,
        accent: 'text-emerald-600',
        bg: 'bg-emerald-50',
        label: 'Mark complete',
        title: 'Complete reminder',
        details: [],
      }
    }
    case 'complete_chore': {
      return {
        icon: CheckCircle2,
        accent: 'text-emerald-600',
        bg: 'bg-emerald-50',
        label: 'Mark complete',
        title: 'Complete chore',
        details: [],
      }
    }
    case 'remember': {
      const details: { label: string; value: string }[] = []
      const who = nameFor(input.subject_email, members)
      if (who) details.push({ label: 'About', value: who })
      if (input.category) details.push({ label: 'Type', value: String(input.category) })
      return {
        icon: Brain,
        accent: 'text-amber-600',
        bg: 'bg-amber-50',
        label: 'Remember this',
        title: input.text ?? 'New fact',
        details,
      }
    }
    default:
      return {
        icon: CheckCircle2,
        accent: 'text-slate-600',
        bg: 'bg-slate-50',
        label: 'Action',
        title: tool,
        details: [],
      }
  }
}

function ActionCard({ action, members }: { action: PendingAction; members: FamilyMember[] }) {
  const v = describe(action, members)
  const Icon = v.icon
  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-white border border-slate-100">
      <div className={`w-9 h-9 rounded-xl ${v.bg} flex items-center justify-center shrink-0`}>
        <Icon size={17} className={v.accent} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{v.label}</p>
        <p className="text-sm font-semibold text-slate-900 leading-tight">{v.title}</p>
        {v.details.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {v.details.map((d, i) => (
              <p key={i} className="text-[13px] text-slate-500 leading-snug">
                <span className="text-slate-400">{d.label}:</span> {d.value}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function ProposedActions({
  actions,
  members,
  status,
  onConfirm,
  onCancel,
}: {
  actions: PendingAction[]
  members: FamilyMember[]
  status: ActionStatus
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!actions.length) return null

  return (
    <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50/80 p-3 shadow-card">
      <div className="flex items-center gap-2 px-1 pb-2">
        <span className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
          {status === 'done' ? 'Confirmed' : status === 'cancelled' ? 'Cancelled' : 'Ready to confirm'}
        </span>
        <span className="text-[11px] text-slate-400">
          {actions.length} change{actions.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="space-y-2">
        {actions.map((a) => (
          <ActionCard key={a.id} action={a} members={members} />
        ))}
      </div>

      {status === 'pending' || status === 'confirming' ? (
        <div className="flex gap-2 mt-3">
          <button
            onClick={onCancel}
            disabled={status === 'confirming'}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-medium text-slate-600 border border-slate-200 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
          >
            <X size={15} /> Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={status === 'confirming'}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-br from-blue-600 to-purple-600 hover:opacity-90 transition-all disabled:opacity-60"
          >
            {status === 'confirming' ? (
              <>
                <Loader2 size={15} className="animate-spin" /> Applying…
              </>
            ) : (
              <>
                <Check size={15} /> Confirm &amp; Apply
              </>
            )}
          </button>
        </div>
      ) : status === 'done' ? (
        <div className="flex items-center justify-center gap-1.5 mt-3 py-2 text-sm font-medium text-emerald-600">
          <CheckCircle2 size={16} /> All set — changes applied
        </div>
      ) : (
        <div className="flex items-center justify-center gap-1.5 mt-3 py-2 text-sm font-medium text-slate-400">
          <X size={16} /> No changes made
        </div>
      )}
    </div>
  )
}
