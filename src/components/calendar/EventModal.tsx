'use client'

import { useState } from 'react'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { CalendarEvent, FamilyMember } from '@/lib/types'
import { ForPicker } from '@/components/ui/AssigneePicker'

interface EventModalProps {
  open: boolean
  onClose: () => void
  initialDate?: string
  event?: CalendarEvent
  members?: FamilyMember[]
  onCreate: (event: Omit<CalendarEvent, 'id' | 'ownerEmail' | 'color'>) => Promise<void>
  onUpdate?: (updates: Partial<CalendarEvent>) => Promise<void>
  onDelete?: () => Promise<void>
}

export function EventModal({ open, onClose, initialDate, event, members, onCreate, onUpdate, onDelete }: EventModalProps) {
  const defaultDate = initialDate ?? new Date().toISOString().split('T')[0]
  const [title, setTitle] = useState(event?.title ?? '')
  const [date, setDate] = useState(event?.start.split('T')[0] ?? defaultDate)
  const [startTime, setStartTime] = useState(event?.start.split('T')[1]?.slice(0, 5) ?? '09:00')
  const [endTime, setEndTime] = useState(event?.end.split('T')[1]?.slice(0, 5) ?? '10:00')
  const [isAllDay, setIsAllDay] = useState(event?.isAllDay ?? false)
  const [location, setLocation] = useState(event?.location ?? '')
  const [notes, setNotes] = useState(event?.notes ?? '')
  const [forIds, setForIds] = useState<string[]>(event?.forIds ?? [])
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)

    const start = isAllDay ? date : `${date}T${startTime}:00`
    const end = isAllDay ? date : `${date}T${endTime}:00`

    try {
      if (event && onUpdate) {
        await onUpdate({ title, start, end, isAllDay, location, notes, forIds })
      } else {
        await onCreate({ title, start, end, isAllDay, location, notes, forIds, calendarId: 'primary' })
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={event ? 'Edit Event' : 'New Event'}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input
          placeholder="Event title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          autoFocus
        />

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="allday"
            checked={isAllDay}
            onChange={(e) => setIsAllDay(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="allday" className="text-sm text-gray-700">All day</label>
        </div>

        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />

        {!isAllDay && (
          <div className="flex gap-2">
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            <span className="flex items-center text-gray-500 text-sm">to</span>
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        )}

        <Input
          placeholder="Location (optional)"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <Textarea
          placeholder="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />

        {members && members.length > 0 && (
          <ForPicker
            members={members}
            value={forIds}
            onChange={setForIds}
            label="Who is this for?"
          />
        )}

        <div className="flex gap-2 pt-2">
          {event && onDelete && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={async () => { await onDelete(); onClose() }}
            >
              Delete
            </Button>
          )}
          <div className="flex-1" />
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
        </div>
      </form>
    </Dialog>
  )
}
