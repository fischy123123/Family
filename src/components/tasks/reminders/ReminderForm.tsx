'use client'

import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { FamilyReminder, FamilyMember, RecurrenceRule } from '@/lib/types'
import { generateId } from '@/lib/utils'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface ReminderFormProps {
  open: boolean
  onClose: () => void
  reminder?: FamilyReminder
  members: FamilyMember[]
  onSave: (r: FamilyReminder) => Promise<void>
  onDelete?: () => Promise<void>
}

export function ReminderForm({ open, onClose, reminder, members, onSave, onDelete }: ReminderFormProps) {
  const [title, setTitle] = useState(reminder?.title ?? '')
  const [dueDate, setDueDate] = useState(reminder?.dueDate?.split('T')[0] ?? '')
  const [priority, setPriority] = useState<FamilyReminder['priority']>(reminder?.priority ?? 'none')
  const [notes, setNotes] = useState(reminder?.notes ?? '')
  const [assigneeEmail, setAssigneeEmail] = useState(reminder?.assigneeEmail ?? '')
  const [recurrFreq, setRecurrFreq] = useState<RecurrenceRule['frequency'] | 'none'>(
    reminder?.recurrence?.frequency ?? 'none'
  )
  const [recurrInterval, setRecurrInterval] = useState(reminder?.recurrence?.interval ?? 1)
  const [recurrDays, setRecurrDays] = useState<number[]>(reminder?.recurrence?.daysOfWeek ?? [])
  const [saving, setSaving] = useState(false)

  function toggleDay(d: number) {
    setRecurrDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const recurrence: RecurrenceRule | undefined =
      recurrFreq !== 'none'
        ? {
            frequency: recurrFreq,
            interval: recurrInterval,
            ...(recurrFreq === 'weekly' && recurrDays.length > 0 ? { daysOfWeek: recurrDays } : {}),
          }
        : undefined
    const reminderData: FamilyReminder = {
      id: reminder?.id ?? generateId(),
      title,
      isCompleted: reminder?.isCompleted ?? false,
      priority,
      notes,
    }
    if (dueDate) reminderData.dueDate = `${dueDate}T09:00:00`
    if (assigneeEmail) reminderData.assigneeEmail = assigneeEmail
    if (recurrence) reminderData.recurrence = recurrence
    try {
      await onSave(reminderData)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={reminder ? 'Edit Reminder' : 'New Reminder'}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input placeholder="Reminder title" value={title} onChange={(e) => setTitle(e.target.value)} required />

        <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />

        <Select value={priority} onChange={(e) => setPriority(e.target.value as FamilyReminder['priority'])}>
          <option value="none">No priority</option>
          <option value="low">Low priority</option>
          <option value="medium">Medium priority</option>
          <option value="high">High priority</option>
        </Select>

        {members.length > 0 && (
          <Select value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => (
              <option key={m.id} value={m.email}>{m.name}</option>
            ))}
          </Select>
        )}

        {/* Recurrence */}
        <div>
          <p className="text-xs text-gray-500 mb-1.5">Repeat</p>
          <Select value={recurrFreq} onChange={(e) => setRecurrFreq(e.target.value as RecurrenceRule['frequency'] | 'none')}>
            <option value="none">Does not repeat</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>

          {recurrFreq !== 'none' && recurrFreq !== 'daily' && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-gray-500">Every</span>
              <Input
                type="number" min={1} max={12} value={recurrInterval}
                onChange={(e) => setRecurrInterval(parseInt(e.target.value, 10))}
                className="w-16"
              />
              <span className="text-xs text-gray-500">{recurrFreq === 'weekly' ? 'week(s)' : 'month(s)'}</span>
            </div>
          )}

          {recurrFreq === 'weekly' && (
            <div className="mt-2 flex gap-1">
              {DAYS.map((d, i) => (
                <button
                  key={d} type="button"
                  onClick={() => toggleDay(i)}
                  className={`w-8 h-8 rounded-full text-xs font-medium border transition-colors ${
                    recurrDays.includes(i)
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {d[0]}
                </button>
              ))}
            </div>
          )}
        </div>

        <Textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />

        <div className="flex gap-2 pt-2">
          {reminder && onDelete && (
            <Button type="button" variant="destructive" size="sm"
              onClick={async () => { await onDelete(); onClose() }}>Delete</Button>
          )}
          <div className="flex-1" />
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  )
}
