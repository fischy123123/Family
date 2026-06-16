'use client'

import { useState } from 'react'
import { Plus, CheckCircle2, Circle, Trash2, Flag } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useFamily } from '@/contexts/FamilyContext'
import { generateId } from '@/lib/utils'
import type { Task, FamilyReminder, FamilyMember } from '@/lib/types'

type Priority = Task['priority']
const PRIORITY_ORDER: Priority[] = ['high', 'medium', 'low', 'none']
const PRIORITY_COLOR: Record<Priority, string> = {
  high: '#dc2626',
  medium: '#f97316',
  low: '#22c55e',
  none: '#cbd5e1',
}
const PRIORITY_LABEL: Record<Priority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'No priority',
}

// Unified item type shown in the list
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
  const { data: members } = useFirestore<FamilyMember>('members')

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
  const done = allItems.filter((i) => i.isCompleted)

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
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">Tasks</h1>
        <p className="text-sm text-slate-400 mt-0.5">{open.length} open · {done.length} done</p>
      </div>

      {/* Quick-add form */}
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
          <option value="none">— Priority</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <button
          type="submit"
          disabled={!addTitle.trim() || adding}
          className="px-3 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium disabled:opacity-40 transition-opacity"
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
            <TaskRow key={item.id} item={item} members={members} onToggle={() => toggle(item)} onRemove={() => remove(item)} />
          ))}
        </div>
      )}

      {/* Completed */}
      {done.length > 0 && (
        <div className="mt-6">
          <button
            onClick={() => setShowCompleted((v) => !v)}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
          >
            {showCompleted ? '▲' : '▼'} {done.length} completed
          </button>
          {showCompleted && (
            <div className="mt-2 space-y-1 opacity-50">
              {done.map((item) => (
                <TaskRow key={item.id} item={item} members={members} onToggle={() => toggle(item)} onRemove={() => remove(item)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TaskRow({ item, members, onToggle, onRemove }: {
  item: ListItem
  members: FamilyMember[]
  onToggle: () => void
  onRemove: () => void
}) {
  const dueStr = item.dueDate
    ? new Date(item.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null
  const overdue = item.dueDate && !item.isCompleted && new Date(item.dueDate) < new Date()

  return (
    <div className="flex items-start gap-3 p-3.5 bg-white rounded-2xl shadow-card border border-slate-50 group">
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
        {item.notes && !item.isCompleted && (
          <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{item.notes}</p>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {item.priority !== 'none' && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium" style={{ color: PRIORITY_COLOR[item.priority] }}>
              <Flag size={10} fill="currentColor" />
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
      <button
        onClick={onRemove}
        className="p-1.5 rounded-lg text-slate-200 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
        title="Delete"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}
