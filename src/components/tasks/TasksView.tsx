'use client'

import { useState, useRef, useEffect } from 'react'
import { Plus, CheckCircle2, Circle, Trash2, Flag, Pencil, X, Check } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useFamily } from '@/contexts/FamilyContext'
import { generateId } from '@/lib/utils'
import type { Task, FamilyReminder } from '@/lib/types'

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
  isCompleted: boolean
  source: 'task' | 'reminder'
  raw: Task | FamilyReminder
}

function toListItem(t: Task): ListItem {
  return { id: t.id, title: t.title, notes: t.notes, priority: t.priority, dueDate: t.dueDate, isCompleted: t.isCompleted, source: 'task', raw: t }
}
function reminderToListItem(r: FamilyReminder): ListItem {
  return { id: r.id, title: r.title, notes: r.notes, priority: r.priority, dueDate: r.dueDate, isCompleted: r.isCompleted, source: 'reminder', raw: r }
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

  const [showCompleted, setShowCompleted] = useState(false)
  const [addTitle, setAddTitle] = useState('')
  const [addPriority, setAddPriority] = useState<Priority>('none')
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

  async function save(item: ListItem, patch: { title: string; notes: string; priority: Priority; dueDate: string }) {
    const trimmed = patch.title.trim()
    if (!trimmed) return
    if (item.source === 'task') {
      const t = item.raw as Task
      await updateTask({ ...t, title: trimmed, notes: patch.notes || undefined, priority: patch.priority, dueDate: patch.dueDate || undefined })
    } else {
      const r = item.raw as FamilyReminder
      await updateReminder({ ...r, title: trimmed, notes: patch.notes || undefined, priority: patch.priority, dueDate: patch.dueDate || undefined })
    }
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
      source: 'manual',
      createdAt: new Date().toISOString(),
    } as Task)
    setAddTitle('')
    setAddPriority('none')
    setAdding(false)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Tasks</h1>
        <p className="text-sm text-slate-400 mt-0.5">{open.length} open · {done.length} done</p>
      </div>

      {/* Quick-add */}
      <form onSubmit={handleAdd} className="flex gap-2 mb-6">
        <input
          value={addTitle}
          onChange={(e) => setAddTitle(e.target.value)}
          placeholder="Add a task…"
          className="flex-1 text-sm rounded-xl px-3 py-2.5 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white"
        />
        <select
          value={addPriority}
          onChange={(e) => setAddPriority(e.target.value as Priority)}
          className="text-xs rounded-xl px-2 py-2.5 border border-slate-200 focus:outline-none focus:border-blue-300 bg-white text-slate-600"
        >
          <option value="none">Priority</option>
          <option value="high">🔴 High</option>
          <option value="medium">🟠 Medium</option>
          <option value="low">🟢 Low</option>
        </select>
        <button
          type="submit"
          disabled={!addTitle.trim() || adding}
          className="px-3 py-2.5 rounded-xl bg-blue-600 text-white disabled:opacity-40 transition-opacity"
        >
          <Plus size={16} />
        </button>
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
              onToggle={() => toggle(item)}
              onSave={(patch) => save(item, patch)}
              onRemove={() => remove(item)}
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
                  onToggle={() => toggle(item)}
                  onSave={(patch) => save(item, patch)}
                  onRemove={() => remove(item)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type EditPatch = { title: string; notes: string; priority: Priority; dueDate: string }

function TaskRow({ item, onToggle, onSave, onRemove }: {
  item: ListItem
  onToggle: () => void
  onSave: (patch: EditPatch) => Promise<void>
  onRemove: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<EditPatch>({ title: '', notes: '', priority: 'none', dueDate: '' })
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  const dueStr = item.dueDate
    ? new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  const overdue = item.dueDate && !item.isCompleted && new Date(item.dueDate) < new Date()

  function startEdit() {
    setDraft({
      title: item.title,
      notes: item.notes ?? '',
      priority: item.priority,
      dueDate: item.dueDate ? item.dueDate.split('T')[0] : '',
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
        </div>
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
