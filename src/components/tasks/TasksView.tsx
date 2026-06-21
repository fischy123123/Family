'use client'

import { useState, useRef, useEffect } from 'react'
import { Plus, CheckCircle2, Circle, Trash2, Pencil, X, Check, Repeat, UserPlus, Users } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useFamily } from '@/contexts/FamilyContext'
import { generateId } from '@/lib/utils'
import type { Task, FamilyReminder, Chore, FamilyMember } from '@/lib/types'
import { isChoreDueToday, recurrenceLabel } from '@/lib/recurrence'
import { resolveAssignee } from '@/lib/members'
import { AssigneePicker, ForPicker } from '@/components/ui/AssigneePicker'
import { ChoreForm } from './chores/ChoreForm'

// Build the canonical assignment fields from a chosen member id. We store the
// id (canonical) and keep the email in sync for systems that still read it
// (calendar owner colors, AI context, legacy data).
function assignFields(members: FamilyMember[], memberId?: string): { assigneeId?: string; assigneeEmail?: string } {
  if (!memberId) return { assigneeId: undefined, assigneeEmail: undefined }
  const m = members.find((x) => x.id === memberId)
  return { assigneeId: memberId, assigneeEmail: m?.email || undefined }
}

type Priority = Task['priority']
const PRIORITY_ORDER: Priority[] = ['high', 'medium', 'low', 'none']
const PRIORITY_COLOR: Record<Priority, string> = {
  high: '#dc2626',
  medium: '#f97316',
  low: '#22c55e',
  none: '#cbd5e1',
}
const PRIORITY_LABEL: Record<Priority, string> = {
  high: '🔴 High',
  medium: '🟠 Medium',
  low: '🟢 Low',
  none: 'No priority',
}

interface ListItem {
  id: string
  title: string
  notes?: string
  priority: Priority
  dueDate?: string
  assigneeId?: string
  assigneeEmail?: string
  forIds?: string[]
  isCompleted: boolean
  source: 'task' | 'reminder'
  raw: Task | FamilyReminder
}

function toListItem(t: Task): ListItem {
  return { id: t.id, title: t.title, notes: t.notes, priority: t.priority, dueDate: t.dueDate, assigneeId: t.assigneeId, assigneeEmail: t.assigneeEmail, forIds: t.forIds, isCompleted: t.isCompleted, source: 'task', raw: t }
}
function reminderToListItem(r: FamilyReminder): ListItem {
  return { id: r.id, title: r.title, notes: r.notes, priority: r.priority, dueDate: r.dueDate, assigneeId: r.assigneeId, assigneeEmail: r.assigneeEmail, isCompleted: r.isCompleted, source: 'reminder', raw: r }
}

function sortItems(items: ListItem[]): ListItem[] {
  return [...items].sort((a, b) => {
    const pi = (p: Priority) => PRIORITY_ORDER.indexOf(p)
    if (pi(a.priority) !== pi(b.priority)) return pi(a.priority) - pi(b.priority)
    if (a.dueDate && b.dueDate) return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
    if (a.dueDate) return -1
    if (b.dueDate) return 1
    return 0
  })
}

export function TasksView() {
  const { familyId } = useFamily()
  const { data: tasks, create: createTask, update: updateTask, remove: removeTask } = useFirestore<Task>('tasks')
  const { data: reminders, update: updateReminder, remove: removeReminder } = useFirestore<FamilyReminder>('reminders')
  const { data: chores, create: createChore, update: updateChore, remove: removeChore } = useFirestore<Chore>('chores')
  const { data: members } = useFirestore<FamilyMember>('members')

  const [showCompleted, setShowCompleted] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addPriority, setAddPriority] = useState<Priority>('none')
  const [addAssignee, setAddAssignee] = useState<string | undefined>(undefined)
  const [adding, setAdding] = useState(false)

  const allItems: ListItem[] = [
    ...tasks.map(toListItem),
    ...reminders
      .filter((r) => !tasks.some((t) => t.id === r.id))
      .map(reminderToListItem),
  ]

  const open = sortItems(allItems.filter((i) => !i.isCompleted))
  const done = sortItems(allItems.filter((i) => i.isCompleted))

  async function toggle(item: ListItem) {
    const now = new Date().toISOString()
    if (item.source === 'task') {
      const t = item.raw as Task
      await updateTask({ ...t, isCompleted: !t.isCompleted, completedAt: !t.isCompleted ? now : undefined })
    } else {
      const r = item.raw as FamilyReminder
      await updateReminder({ ...r, isCompleted: !r.isCompleted, completedAt: !r.isCompleted ? now : undefined })
    }
  }

  async function save(item: ListItem, patch: EditPatch) {
    const trimmed = patch.title.trim()
    if (!trimmed) return
    const af = assignFields(members, patch.assigneeId)
    const forIds = patch.forIds?.length ? patch.forIds : undefined
    if (item.source === 'task') {
      const t = item.raw as Task
      await updateTask({ ...t, title: trimmed, notes: patch.notes || undefined, priority: patch.priority, dueDate: patch.dueDate || undefined, ...af, forIds })
    } else {
      const r = item.raw as FamilyReminder
      await updateReminder({ ...r, title: trimmed, notes: patch.notes || undefined, priority: patch.priority, dueDate: patch.dueDate || undefined, ...af })
    }
  }

  // Quick (one-tap) reassignment from the row, without entering full edit.
  async function quickAssign(item: ListItem, memberId?: string) {
    const af = assignFields(members, memberId)
    if (item.source === 'task') {
      await updateTask({ ...(item.raw as Task), ...af })
    } else {
      await updateReminder({ ...(item.raw as FamilyReminder), ...af })
    }
  }

  // Quick "for" update directly from the card — tasks only (reminders don't have forIds).
  async function quickFor(item: ListItem, forIds: string[]) {
    if (item.source !== 'task') return
    const newForIds = forIds.length ? forIds : undefined
    await updateTask({ ...(item.raw as Task), forIds: newForIds })
  }

  async function remove(item: ListItem) {
    if (item.source === 'task') await removeTask(item.id)
    else await removeReminder(item.id)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const title = addTitle.trim()
    if (!title || !familyId) return
    setAdding(true)
    await createTask({
      id: generateId(),
      title,
      isCompleted: false,
      priority: addPriority,
      ...assignFields(members, addAssignee),
      source: 'manual',
      createdAt: new Date().toISOString(),
    } as Task)
    setAddTitle('')
    setAddPriority('none')
    setAddAssignee(undefined)
    setAdding(false)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">To Do</h1>
        <p className="text-sm text-slate-400 mt-0.5">{open.length} open · {done.length} done</p>
      </div>

      {/* Quick-add */}
      <form onSubmit={handleAdd} className="mb-6 space-y-2">
        <div className="flex gap-2">
          <input
            value={addTitle}
            onChange={(e) => setAddTitle(e.target.value)}
            placeholder="Add a task…"
            className="flex-1 text-sm rounded-xl px-3 py-2.5 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white"
          />
          <button
            type="submit"
            disabled={!addTitle.trim() || adding}
            className="px-3 py-2.5 rounded-xl bg-blue-600 text-white disabled:opacity-40 transition-opacity"
          >
            <Plus size={16} />
          </button>
        </div>
        <div className="flex gap-2">
          <select
            value={addPriority}
            onChange={(e) => setAddPriority(e.target.value as Priority)}
            className="text-xs rounded-xl px-2 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white text-slate-600"
          >
            <option value="none">Priority</option>
            <option value="high">🔴 High</option>
            <option value="medium">🟠 Medium</option>
            <option value="low">🟢 Low</option>
          </select>
        </div>
        {members.length > 0 && (
          <AssigneePicker members={members} value={addAssignee} onChange={setAddAssignee} label="Assign to" />
        )}
      </form>

      {/* Open tasks */}
      {open.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle2 size={40} className="mx-auto mb-3 text-slate-200" />
          <p className="text-sm font-medium text-slate-500">All clear — nothing open.</p>
          <p className="text-xs text-slate-400 mt-1">Add a task above or save items from the Home screen.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {open.map((item) => (
            <TaskRow
              key={item.id}
              item={item}
              members={members}
              onToggle={() => toggle(item)}
              onSave={(patch) => save(item, patch)}
              onRemove={() => remove(item)}
              onQuickAssign={(id) => quickAssign(item, id)}
              onQuickFor={(ids) => quickFor(item, ids)}
            />
          ))}
        </div>
      )}

      {/* Completed */}
      {done.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowCompleted((v) => !v)}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors mb-2"
          >
            {showCompleted ? '▲' : '▼'} {done.length} completed
          </button>
          {showCompleted && (
            <div className="space-y-2">
              {done.map((item) => (
                <TaskRow
                  key={item.id}
                  item={item}
                  members={members}
                  onToggle={() => toggle(item)}
                  onSave={(patch) => save(item, patch)}
                  onRemove={() => remove(item)}
                  onQuickAssign={(id) => quickAssign(item, id)}
                  onQuickFor={(ids) => quickFor(item, ids)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Recurring chores — distinct from one-off tasks (streaks + recurrence) */}
      <ChoresSection
        chores={chores}
        members={members}
        onCreate={createChore}
        onUpdate={updateChore}
        onDelete={removeChore}
      />
    </div>
  )
}

function ChoresSection({ chores, members, onCreate, onUpdate, onDelete }: {
  chores: Chore[]
  members: FamilyMember[]
  onCreate: (c: Chore) => Promise<unknown>
  onUpdate: (c: Chore) => Promise<unknown>
  onDelete: (id: string) => Promise<unknown>
}) {
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Chore>()

  const today = new Date().toISOString().split('T')[0]

  function choreMember(chore: Chore) {
    return resolveAssignee(members, chore)
  }
  function memberName(chore: Chore) {
    const m = choreMember(chore)
    return m?.name ?? (chore.assigneeEmail ? chore.assigneeEmail.split('@')[0] : 'Anyone')
  }
  function memberEmoji(chore: Chore) {
    return choreMember(chore)?.emoji ?? '👤'
  }

  async function markDone(chore: Chore) {
    const newStreak = chore.lastCompletedDate === today ? chore.streak : chore.streak + 1
    await onUpdate({ ...chore, lastCompletedDate: today, streak: newStreak })
  }

  // Show due-today chores first, then the rest.
  const sorted = [...chores].sort((a, b) => {
    const ad = isChoreDueToday(a) ? 0 : 1
    const bd = isChoreDueToday(b) ? 0 : 1
    return ad - bd
  })

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Repeat size={15} className="text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-700">Chores</h2>
          <span className="text-xs text-slate-400">{chores.length}</span>
        </div>
        <button
          onClick={() => { setEditing(undefined); setFormOpen(true) }}
          className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors"
        >
          <Plus size={14} /> Add chore
        </button>
      </div>

      {chores.length === 0 ? (
        <div className="text-center py-8 rounded-2xl bg-slate-50 border border-slate-100">
          <Repeat size={28} className="mx-auto mb-2 text-slate-200" />
          <p className="text-xs text-slate-400">Add recurring chores for family members</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((chore) => {
            const doneToday = chore.lastCompletedDate === today
            const dueToday = isChoreDueToday(chore)
            return (
              <div
                key={chore.id}
                className="flex items-center gap-3 p-3.5 bg-white rounded-2xl shadow-card border border-slate-50"
                style={{ borderLeft: `3px solid ${chore.colorHex}` }}
              >
                <div className="text-xl shrink-0">{memberEmoji(chore)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-slate-900">{chore.name}</p>
                    {chore.streak > 0 && (
                      <span className="text-[11px] text-orange-500 font-medium">🔥{chore.streak}</span>
                    )}
                    {dueToday && !doneToday && (
                      <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600">Due today</span>
                    )}
                    {doneToday && (
                      <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded-full bg-green-50 text-green-600">Done today</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {memberName(chore)} · {recurrenceLabel(chore.recurrence)}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {!doneToday && (
                    <button
                      onClick={() => markDone(chore)}
                      className="flex items-center gap-1 text-xs text-green-600 font-medium px-2 py-1.5 rounded-lg hover:bg-green-50 transition-colors"
                      title="Mark done"
                    >
                      <CheckCircle2 size={15} /> Done
                    </button>
                  )}
                  <button
                    onClick={() => { setEditing(chore); setFormOpen(true) }}
                    className="p-1.5 rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-50 transition-colors"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ChoreForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        chore={editing}
        members={members}
        onSave={async (c) => { editing ? await onUpdate(c) : await onCreate(c) }}
        onDelete={editing ? async () => { await onDelete(editing.id) } : undefined}
      />
    </div>
  )
}

type EditPatch = { title: string; notes: string; priority: Priority; dueDate: string; assigneeId?: string; forIds?: string[] }

function TaskRow({ item, members, onToggle, onSave, onRemove, onQuickAssign, onQuickFor }: {
  item: ListItem
  members: FamilyMember[]
  onToggle: () => void
  onSave: (patch: EditPatch) => Promise<void>
  onRemove: () => void
  onQuickAssign: (memberId?: string) => void
  onQuickFor: (forIds: string[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditPatch>({ title: '', notes: '', priority: 'none', dueDate: '', assigneeId: undefined, forIds: [] })
  const [saving, setSaving] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [forOpen, setForOpen] = useState(false)
  const [forDraft, setForDraft] = useState<string[]>([])
  const titleRef = useRef<HTMLInputElement>(null)

  const dueStr = item.dueDate
    ? new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  const overdue = item.dueDate && !item.isCompleted && new Date(item.dueDate) < new Date()
  const assignee = resolveAssignee(members, item)

  function startEdit() {
    setDraft({
      title: item.title,
      notes: item.notes ?? '',
      priority: item.priority,
      dueDate: item.dueDate ? item.dueDate.split('T')[0] : '',
      assigneeId: assignee?.id,
      forIds: item.forIds ?? [],
    })
    setEditing(true)
  }

  useEffect(() => {
    if (editing) setTimeout(() => titleRef.current?.focus(), 30)
  }, [editing])

  async function handleSave() {
    if (!draft.title.trim()) return
    setSaving(true)
    await onSave(draft)
    setSaving(false)
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="rounded-2xl bg-white shadow-card border border-blue-100 p-4 space-y-3">
        <input
          ref={titleRef}
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); if (e.key === 'Escape') setEditing(false) }}
          className="w-full text-sm font-medium rounded-xl px-3 py-2 border border-slate-200 focus:outline-none focus:border-blue-300"
          placeholder="Task title"
        />
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          rows={2}
          className="w-full text-xs rounded-xl px-3 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 resize-none text-slate-600 placeholder:text-slate-400"
          placeholder="Notes (optional)"
        />
        <div className="flex gap-2">
          <select
            value={draft.priority}
            onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value as Priority }))}
            className="flex-1 text-xs rounded-xl px-2 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white text-slate-600"
          >
            <option value="none">No priority</option>
            <option value="high">🔴 High</option>
            <option value="medium">🟠 Medium</option>
            <option value="low">🟢 Low</option>
          </select>
          <input
            type="date"
            value={draft.dueDate}
            onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))}
            className="flex-1 text-xs rounded-xl px-2 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white text-slate-600"
          />
        </div>
        {members.length > 0 && (
          <AssigneePicker
            members={members}
            value={draft.assigneeId}
            onChange={(id) => setDraft((d) => ({ ...d, assigneeId: id }))}
            label="Assign to (responsible)"
          />
        )}
        {members.length > 0 && (
          <ForPicker
            members={members}
            value={draft.forIds ?? []}
            onChange={(ids) => setDraft((d) => ({ ...d, forIds: ids }))}
            label="For (about)"
          />
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={handleSave}
            disabled={!draft.title.trim() || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-semibold disabled:opacity-40 transition-opacity"
          >
            <Check size={13} /> Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 text-slate-600 text-xs font-semibold hover:bg-slate-200 transition-colors"
          >
            <X size={13} /> Cancel
          </button>
          <button
            onClick={() => { setEditing(false); onRemove() }}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-red-500 bg-red-50 hover:bg-red-100 text-xs font-semibold transition-colors"
          >
            <Trash2 size={13} /> Delete
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className={`flex items-start gap-3 p-3.5 bg-white rounded-2xl shadow-card border border-slate-50 ${item.isCompleted ? 'opacity-60' : ''}`}>
      <button
        onClick={onToggle}
        className="mt-0.5 shrink-0 transition-colors"
        style={{ color: item.isCompleted ? '#22c55e' : '#cbd5e1' }}
      >
        {item.isCompleted ? <CheckCircle2 size={19} /> : <Circle size={19} />}
      </button>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${item.isCompleted ? 'line-through text-slate-400' : 'text-slate-900'}`}>
          {item.title}
        </p>
        {item.notes && (
          <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{item.notes}</p>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {item.priority !== 'none' && (
            <span className="text-[11px] font-medium" style={{ color: PRIORITY_COLOR[item.priority] }}>
              {PRIORITY_LABEL[item.priority]}
            </span>
          )}
          {dueStr && (
            <span className={`text-[11px] font-medium ${overdue ? 'text-red-500' : 'text-slate-400'}`}>
              {overdue ? '⚠ ' : ''}{dueStr}
            </span>
          )}
          {/* Quick-assign: tap the assignee (or "Assign") to reassign in one tap */}
          <button
            onClick={() => { setAssignOpen((v) => !v); setForOpen(false) }}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-slate-700 transition-colors"
          >
            {assignee ? (
              <>
                <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]" style={{ background: `${assignee.colorHex}25` }}>
                  {assignee.emoji}
                </span>
                {assignee.name}
              </>
            ) : item.assigneeEmail ? (
              <span className="text-slate-400">{item.assigneeEmail.split('@')[0]}</span>
            ) : (
              <span className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-700">
                <UserPlus size={11} /> Assign
              </span>
            )}
          </button>
          {/* "For" — who the task is about (tasks only) */}
          {item.source === 'task' && (
            <button
              onClick={() => { setForDraft(item.forIds ?? []); setForOpen((v) => !v); setAssignOpen(false) }}
              className="inline-flex items-center gap-1 text-[11px] font-medium transition-colors"
            >
              {(item.forIds?.length ?? 0) > 0 ? (() => {
                const forMembers = members.filter((m) => item.forIds!.includes(m.id))
                return forMembers.length > 0 ? (
                  <span className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700">
                    <span className="text-slate-400">for</span>
                    {forMembers.map((m) => (
                      <span key={m.id} className="inline-flex items-center gap-0.5 font-medium text-slate-600">
                        <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]" style={{ background: `${m.colorHex}25` }}>
                          {m.emoji}
                        </span>
                        {m.name}
                      </span>
                    ))}
                  </span>
                ) : null
              })() : (
                <span className="inline-flex items-center gap-1 text-slate-400 hover:text-blue-600">
                  <Users size={11} /> For
                </span>
              )}
            </button>
          )}
        </div>
        {assignOpen && (
          <div className="mt-2">
            <AssigneePicker
              members={members}
              value={assignee?.id}
              onChange={(id) => { onQuickAssign(id); setAssignOpen(false) }}
              label=""
            />
          </div>
        )}
        {forOpen && item.source === 'task' && (
          <div className="mt-2">
            <p className="text-[11px] font-medium text-slate-500 mb-1.5">For (who is this about?)</p>
            <ForPicker
              members={members}
              value={forDraft}
              onChange={setForDraft}
              label=""
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => { onQuickFor(forDraft); setForOpen(false) }}
                className="text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1.5 rounded-lg transition-colors"
              >
                Done
              </button>
              <button
                onClick={() => setForOpen(false)}
                className="text-[11px] font-medium text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        <button
          onClick={startEdit}
          className="p-1.5 rounded-lg text-slate-300 hover:text-slate-600 hover:bg-slate-50 transition-colors"
          title="Edit"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={onRemove}
          className="p-1.5 rounded-lg text-slate-300 hover:text-red-400 hover:bg-red-50 transition-colors"
          title="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}
