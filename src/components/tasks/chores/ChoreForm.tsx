'use client'

import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { CHORE_COLORS } from '@/lib/types'
import type { Chore, FamilyMember, RecurrenceRule } from '@/lib/types'
import { generateId } from '@/lib/utils'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface ChoreFormProps {
  open: boolean
  onClose: () => void
  chore?: Chore
  members: FamilyMember[]
  onSave: (c: Chore) => Promise<void>
  onDelete?: () => Promise<void>
}

export function ChoreForm({ open, onClose, chore, members, onSave, onDelete }: ChoreFormProps) {
  const [name, setName] = useState(chore?.name ?? '')
  const [assigneeEmail, setAssigneeEmail] = useState(chore?.assigneeEmail ?? '')
  const [colorHex, setColorHex] = useState(chore?.colorHex ?? CHORE_COLORS[0])
  const [freq, setFreq] = useState<RecurrenceRule['frequency']>(chore?.recurrence?.frequency ?? 'weekly')
  const [interval, setInterval] = useState(chore?.recurrence?.interval ?? 1)
  const [days, setDays] = useState<number[]>(chore?.recurrence?.daysOfWeek ?? [])
  const [saving, setSaving] = useState(false)

  function toggleDay(d: number) {
    setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const recurrence: RecurrenceRule = {
      frequency: freq,
      interval,
      ...(freq === 'weekly' && days.length > 0 ? { daysOfWeek: days } : {}),
    }
    const choreData: Chore = {
      id: chore?.id ?? generateId(),
      name, assigneeEmail, colorHex, recurrence,
      streak: chore?.streak ?? 0,
    }
    if (chore?.lastCompletedDate) choreData.lastCompletedDate = chore.lastCompletedDate
    try {
      await onSave(choreData)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={chore ? 'Edit Chore' : 'New Chore'}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input placeholder="Chore name" value={name} onChange={(e) => setName(e.target.value)} required />

        {members.length > 0 && (
          <Select value={assigneeEmail} onChange={(e) => setAssigneeEmail(e.target.value)}>
            <option value="">Unassigned</option>
            {members.map((m) => <option key={m.id} value={m.email}>{m.name}</option>)}
          </Select>
        )}

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Color</p>
          <div className="flex flex-wrap gap-2">
            {CHORE_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColorHex(c)}
                className={`w-6 h-6 rounded-full border-2 ${colorHex === c ? 'border-gray-800' : 'border-transparent'}`}
                style={{ backgroundColor: c }} />
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs text-gray-500 mb-1.5">Repeat</p>
          <Select value={freq} onChange={(e) => setFreq(e.target.value as RecurrenceRule['frequency'])}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>

          {freq !== 'daily' && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-gray-500">Every</span>
              <Input type="number" min={1} max={12} value={interval}
                onChange={(e) => setInterval(parseInt(e.target.value, 10))} className="w-16" />
              <span className="text-xs text-gray-500">{freq === 'weekly' ? 'week(s)' : 'month(s)'}</span>
            </div>
          )}

          {freq === 'weekly' && (
            <div className="mt-2 flex gap-1">
              {DAYS.map((d, i) => (
                <button key={d} type="button" onClick={() => toggleDay(i)}
                  className={`w-8 h-8 rounded-full text-xs font-medium border transition-colors ${
                    days.includes(i) ? 'bg-blue-500 text-white border-blue-500' : 'border-gray-200 text-gray-600'
                  }`}>
                  {d[0]}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex gap-2 pt-2">
          {chore && onDelete && (
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
