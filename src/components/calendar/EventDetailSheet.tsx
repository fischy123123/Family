'use client'

import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { X, MapPin, FileText, Calendar, RefreshCw } from 'lucide-react'
import type { CalendarEvent, FamilyMember } from '@/lib/types'

interface EventDetailSheetProps {
  event: CalendarEvent | null
  members: FamilyMember[]
  onClose: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
}

function formatEventTime(event: CalendarEvent): string {
  if (event.isAllDay) {
    try {
      const date = parseISO(event.start)
      return format(date, 'EEEE, MMM d · All day')
    } catch {
      return 'All day'
    }
  }
  try {
    const start = parseISO(event.start)
    const end = parseISO(event.end)
    const datePart = format(start, 'EEEE, MMM d')
    const startTime = format(start, 'h:mm a')
    const endTime = format(end, 'h:mm a')
    return `${datePart} · ${startTime} – ${endTime}`
  } catch {
    return event.start
  }
}

export function EventDetailSheet({ event, members, onClose, onEdit, onDelete }: EventDetailSheetProps) {
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (!event) return null

  const memberByEmail = new Map(members.map((m) => [m.email?.toLowerCase() ?? '', m]))
  const member = event.ownerEmail ? memberByEmail.get(event.ownerEmail.toLowerCase()) : undefined
  const color = member?.colorHex ?? event.color ?? '#3B82F6'

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setDeleting(true)
    try {
      await onDelete()
      onClose()
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  const timeString = formatEventTime(event)
  const calendarLabel = event.calendarName || event.ownerEmail || 'Calendar'

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Bottom sheet */}
      <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl bg-white shadow-2xl max-h-[85vh] flex flex-col">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>

        {/* Close button */}
        <div className="flex items-center justify-end px-4 pb-1">
          <button
            onClick={onClose}
            className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 pb-4">
          {/* Colored left-border card */}
          <div
            className="rounded-2xl p-4 mb-4"
            style={{ borderLeft: `4px solid ${color}`, backgroundColor: `${color}12` }}
          >
            <h2 className="text-xl font-bold text-slate-900 leading-snug">{event.title}</h2>

            {/* Recurring badge */}
            {event.recurringEventId && (
              <span className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-slate-500 bg-slate-100 rounded-full px-2.5 py-0.5">
                <RefreshCw size={11} />
                Recurring series
              </span>
            )}
          </div>

          {/* Details list */}
          <div className="space-y-3">
            {/* Date / Time */}
            <div className="flex items-start gap-3">
              <Calendar size={16} className="mt-0.5 shrink-0 text-slate-400" />
              <span className="text-sm text-slate-700">{timeString}</span>
            </div>

            {/* Calendar / owner */}
            <div className="flex items-start gap-3">
              <div
                className="w-4 h-4 mt-0.5 shrink-0 rounded-full"
                style={{ backgroundColor: color }}
              />
              <div className="text-sm text-slate-700">
                {member ? (
                  <span>
                    {member.emoji} {member.name}
                    {calendarLabel !== member.name && (
                      <span className="text-slate-400 ml-1">· {calendarLabel}</span>
                    )}
                  </span>
                ) : (
                  <span>{calendarLabel}</span>
                )}
              </div>
            </div>

            {/* Location */}
            {event.location && (
              <div className="flex items-start gap-3">
                <MapPin size={16} className="mt-0.5 shrink-0 text-slate-400" />
                <span className="text-sm text-slate-700">{event.location}</span>
              </div>
            )}

            {/* Notes / description */}
            {event.notes && (
              <div className="flex items-start gap-3">
                <FileText size={16} className="mt-0.5 shrink-0 text-slate-400" />
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{event.notes}</p>
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3 px-5 py-4 border-t border-slate-100">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${
              confirmDelete
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            } disabled:opacity-50`}
          >
            {deleting ? 'Deleting…' : confirmDelete ? 'Tap again to confirm' : 'Delete'}
          </button>
          <button
            onClick={onEdit}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors"
          >
            Edit
          </button>
        </div>
      </div>
    </>
  )
}
