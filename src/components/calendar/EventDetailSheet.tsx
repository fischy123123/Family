'use client'

import { useState } from 'react'
import { format, parseISO } from 'date-fns'
import { X, MapPin, FileText, Calendar, RefreshCw, Users, UserCheck } from 'lucide-react'
import type { CalendarEvent, FamilyMember } from '@/lib/types'
import { ForPicker, AssigneePicker } from '@/components/ui/AssigneePicker'
import { memberById } from '@/lib/members'

type AssignmentUpdate = { forIds?: string[]; assigneeId?: string | null }

interface EventDetailSheetProps {
  event: CalendarEvent | null
  members: FamilyMember[]
  onClose: () => void
  onEdit: () => void
  onDelete: () => Promise<void>
  onUpdateAssignment?: (updates: AssignmentUpdate) => Promise<void>
  isRecurring?: boolean
}

function formatEventTime(event: CalendarEvent): string {
  if (event.isAllDay) {
    try { return format(parseISO(event.start), 'EEEE, MMM d · All day') }
    catch { return 'All day' }
  }
  try {
    const start = parseISO(event.start)
    const end = parseISO(event.end)
    return `${format(start, 'EEEE, MMM d')} · ${format(start, 'h:mm a')} – ${format(end, 'h:mm a')}`
  } catch { return event.start }
}

export function EventDetailSheet({
  event, members, onClose, onEdit, onDelete, onUpdateAssignment,
}: EventDetailSheetProps) {
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editingAssignment, setEditingAssignment] = useState(false)
  const [saving, setSaving] = useState(false)

  if (!event) return null

  const memberByEmail = new Map(members.map((m) => [m.email?.toLowerCase() ?? '', m]))
  const owner = event.ownerEmail ? memberByEmail.get(event.ownerEmail.toLowerCase()) : undefined
  const color = owner?.colorHex ?? event.color ?? '#3B82F6'
  const timeString = formatEventTime(event)
  const calendarLabel = event.calendarName || event.ownerEmail || 'Calendar'

  const forMembers = (event.forIds ?? []).map((id) => memberById(members, id)).filter(Boolean) as FamilyMember[]
  const assigneeMember = event.assigneeId ? memberById(members, event.assigneeId) : undefined

  async function saveUpdate(updates: AssignmentUpdate) {
    if (!onUpdateAssignment) return
    setSaving(true)
    try { await onUpdateAssignment(updates) }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    if (!confirmDelete) { setConfirmDelete(true); return }
    setDeleting(true)
    try { await onDelete(); onClose() }
    finally { setDeleting(false); setConfirmDelete(false) }
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl bg-white shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex justify-center pt-3 pb-1">
          <div className="w-10 h-1 rounded-full bg-slate-200" />
        </div>
        <div className="flex items-center justify-end px-4 pb-1">
          <button onClick={onClose} className="p-1.5 rounded-full text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-4">
          <div className="rounded-2xl p-4 mb-4" style={{ borderLeft: `4px solid ${color}`, backgroundColor: `${color}12` }}>
            <h2 className="text-xl font-bold text-slate-900 leading-snug">{event.title}</h2>
            {event.recurringEventId && (
              <span className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-slate-500 bg-slate-100 rounded-full px-2.5 py-0.5">
                <RefreshCw size={11} />
                Recurring — changes apply to all occurrences
              </span>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Calendar size={16} className="mt-0.5 shrink-0 text-slate-400" />
              <span className="text-sm text-slate-700">{timeString}</span>
            </div>

            <div className="flex items-start gap-3">
              <div className="w-4 h-4 mt-0.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
              <div className="text-sm text-slate-700">
                {owner ? (
                  <span>
                    {owner.emoji} {owner.name}
                    {calendarLabel !== owner.name && <span className="text-slate-400 ml-1">· {calendarLabel}</span>}
                  </span>
                ) : <span>{calendarLabel}</span>}
              </div>
            </div>

            {/* Assignment section */}
            {onUpdateAssignment && (
              <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 space-y-3">
                {editingAssignment ? (
                  <>
                    <ForPicker
                      members={members}
                      value={event.forIds ?? []}
                      onChange={(ids) => saveUpdate({ forIds: ids })}
                      label="Who is this for?"
                    />
                    <AssigneePicker
                      members={members}
                      value={event.assigneeId}
                      onChange={(id) => saveUpdate({ assigneeId: id ?? null })}
                      includePets={false}
                      label="Who is responsible?"
                    />
                    <button
                      onClick={() => setEditingAssignment(false)}
                      className="text-xs text-blue-600 font-medium hover:text-blue-800"
                    >
                      {saving ? 'Saving…' : 'Done'}
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setEditingAssignment(true)}
                    className="w-full text-left space-y-1"
                  >
                    <div className="flex items-center gap-2">
                      <Users size={13} className="text-slate-400 shrink-0" />
                      {forMembers.length > 0 ? (
                        <span className="text-sm text-slate-700">{forMembers.map((m) => `${m.emoji} ${m.name}`).join(', ')}</span>
                      ) : (
                        <span className="text-sm text-slate-400">Who is this for? Tap to set</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <UserCheck size={13} className="text-slate-400 shrink-0" />
                      {assigneeMember ? (
                        <span className="text-sm text-slate-700">{assigneeMember.emoji} {assigneeMember.name} responsible</span>
                      ) : (
                        <span className="text-sm text-slate-400">Who is responsible? Tap to set</span>
                      )}
                    </div>
                  </button>
                )}
              </div>
            )}

            {event.location && (
              <div className="flex items-start gap-3">
                <MapPin size={16} className="mt-0.5 shrink-0 text-slate-400" />
                <span className="text-sm text-slate-700">{event.location}</span>
              </div>
            )}

            {event.notes && (
              <div className="flex items-start gap-3">
                <FileText size={16} className="mt-0.5 shrink-0 text-slate-400" />
                <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{event.notes}</p>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3 px-5 py-4 border-t border-slate-100">
          <button
            onClick={handleDelete}
            disabled={deleting}
            className={`flex-1 py-2.5 rounded-xl text-sm font-medium transition-colors ${confirmDelete ? 'bg-red-500 text-white hover:bg-red-600' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} disabled:opacity-50`}
          >
            {deleting ? 'Deleting…' : confirmDelete ? 'Tap again to confirm' : 'Delete'}
          </button>
          <button onClick={onEdit} className="flex-1 py-2.5 rounded-xl text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 transition-colors">
            Edit
          </button>
        </div>
      </div>
    </>
  )
}
