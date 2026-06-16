'use client'

import { useState } from 'react'
import { Plus, CheckCircle2, Circle } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { ReminderForm } from './ReminderForm'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PRIORITY_COLORS } from '@/lib/types'
import type { FamilyReminder, FamilyMember } from '@/lib/types'
import { isOverdue, formatDate } from '@/lib/utils'
import { getReminderDueDate, recurrenceLabel } from '@/lib/recurrence'
import { resolveAssignee } from '@/lib/members'

const PRIORITY_ORDER: FamilyReminder['priority'][] = ['high', 'medium', 'low', 'none']

function groupByPriority(reminders: FamilyReminder[]) {
  const groups: Record<string, FamilyReminder[]> = {}
  for (const p of PRIORITY_ORDER) groups[p] = []
  for (const r of reminders) {
    if (!r.isCompleted) groups[r.priority].push(r)
  }
  return groups
}

export function RemindersView() {
  const { data: reminders, create, update, remove } = useFirestore<FamilyReminder>('reminders')
  const { data: members } = useFirestore<FamilyMember>('members')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<FamilyReminder>()
  const [showCompleted, setShowCompleted] = useState(false)

  const active = reminders.filter((r) => !r.isCompleted)
  const completed = reminders.filter((r) => r.isCompleted)
  const groups = groupByPriority(active)

  async function toggleComplete(r: FamilyReminder) {
    await update({ ...r, isCompleted: !r.isCompleted, completedAt: !r.isCompleted ? new Date().toISOString() : undefined })
  }

  const priorityLabels: Record<FamilyReminder['priority'], string> = {
    high: '🔴 High Priority',
    medium: '🟠 Medium Priority',
    low: '🟢 Low Priority',
    none: 'No Priority',
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Reminders</h1>
        <Button size="sm" onClick={() => { setEditing(undefined); setFormOpen(true) }}>
          <Plus size={16} className="mr-1" /> Add
        </Button>
      </div>

      {PRIORITY_ORDER.map((priority) => {
        const group = groups[priority]
        if (group.length === 0) return null
        return (
          <div key={priority} className="mb-6">
            <h2 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
              {priorityLabels[priority]}
            </h2>
            <div className="space-y-1">
              {group.map((r) => {
                const due = getReminderDueDate(r)
                const overdue = due && isOverdue(due.toISOString())
                return (
                  <div
                    key={r.id}
                    className="flex items-start gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm"
                  >
                    <button onClick={() => toggleComplete(r)} className="mt-0.5 shrink-0 text-gray-300 hover:text-green-500 transition-colors">
                      <Circle size={18} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900">{r.title}</p>
                      {due && (
                        <p className={`text-xs ${overdue ? 'text-red-500' : 'text-gray-400'}`}>
                          {overdue ? '⚠ Overdue · ' : ''}{formatDate(due.toISOString())}
                        </p>
                      )}
                      {r.recurrence && (
                        <p className="text-xs text-blue-500">{recurrenceLabel(r.recurrence)}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {(r.assigneeId || r.assigneeEmail) && (
                        <span className="text-xs text-gray-400">
                          {resolveAssignee(members, r)?.name ?? r.assigneeEmail?.split('@')[0] ?? ''}
                        </span>
                      )}
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: PRIORITY_COLORS[r.priority] }} />
                      <Button size="sm" variant="ghost" onClick={() => { setEditing(r); setFormOpen(true) }}>
                        Edit
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {active.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <CheckCircle2 size={40} className="mx-auto mb-2 opacity-30" />
          <p className="text-sm">All caught up! No pending reminders.</p>
        </div>
      )}

      {completed.length > 0 && (
        <div>
          <button
            className="text-xs text-gray-400 hover:text-gray-600 mb-2"
            onClick={() => setShowCompleted(!showCompleted)}
          >
            {showCompleted ? '▲' : '▼'} {completed.length} completed
          </button>
          {showCompleted && (
            <div className="space-y-1 opacity-50">
              {completed.map((r) => (
                <div key={r.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100">
                  <button onClick={() => toggleComplete(r)} className="shrink-0 text-green-500">
                    <CheckCircle2 size={18} />
                  </button>
                  <p className="text-sm line-through text-gray-500 flex-1">{r.title}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <ReminderForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        reminder={editing}
        members={members}
        onSave={async (r) => { editing ? await update(r) : await create(r) }}
        onDelete={editing ? async () => await remove(editing.id) : undefined}
      />
    </div>
  )
}
