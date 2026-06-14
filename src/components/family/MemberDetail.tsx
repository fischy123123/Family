'use client'

import { useState } from 'react'
import {
  ArrowLeft,
  Pencil,
  Clock,
  Heart,
  Info,
  Sparkles,
  Milestone,
  Plus,
  Trash2,
  X,
  Cake,
} from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { MemberForm } from './MemberForm'
import { generateId, formatDate } from '@/lib/utils'
import type {
  FamilyMember,
  RoutineEntry,
  PreferenceEntry,
  InfoEntry,
  MemoryEntry,
  TimelineMilestone,
} from '@/lib/types'

interface MemberDetailProps {
  member: FamilyMember
  isCurrentUser?: boolean
  onBack: () => void
}

const INFO_CATEGORY_STYLES: Record<InfoEntry['category'], string> = {
  medical: 'bg-red-100 text-red-700',
  education: 'bg-blue-100 text-blue-700',
  logistics: 'bg-amber-100 text-amber-700',
  personal: 'bg-purple-100 text-purple-700',
  other: 'bg-slate-100 text-slate-600',
}

const INFO_CATEGORIES: InfoEntry['category'][] = [
  'medical',
  'education',
  'logistics',
  'personal',
  'other',
]

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  const day = 86_400_000
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`
  return formatDate(iso)
}

export function MemberDetail({ member, isCurrentUser, onBack }: MemberDetailProps) {
  const { update } = useFirestore<FamilyMember>('members')
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)

  // Write a partial change to the member doc, stripping undefined optionals.
  async function save(changes: Partial<FamilyMember>) {
    const next: FamilyMember = { ...member, ...changes }
    if (!next.summary) delete next.summary
    if (!next.birthday) delete next.birthday
    try {
      await update(next)
    } catch {
      toast('Could not save changes', 'error')
    }
  }

  if (editing) {
    return <MemberForm member={member} onDone={() => setEditing(false)} />
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors mb-5"
      >
        <ArrowLeft size={16} />
        Back to Family
      </button>

      {/* Member header */}
      <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 mb-5 flex items-center gap-5 animate-scale-in">
        <div className="relative shrink-0">
          <div
            className="h-20 w-20 rounded-full flex items-center justify-center text-4xl"
            style={{ backgroundColor: `${member.colorHex}40` }}
          >
            {member.emoji}
          </div>
          {isCurrentUser && (
            <span className="absolute -top-1 -right-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-600 text-white leading-none shadow">
              YOU
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 truncate">{member.name}</h1>
          <p className="text-slate-500 capitalize">
            {member.species ? `${member.species}` : member.role}
          </p>
          {member.birthday && (
            <p className="text-sm text-slate-400 mt-1 flex items-center gap-1.5">
              <Cake size={14} />
              {formatDate(member.birthday)}
            </p>
          )}
        </div>
        <Button variant="outline" onClick={() => setEditing(true)} className="shrink-0">
          <Pencil size={15} className="mr-1.5" />
          Edit
        </Button>
      </div>

      <div className="space-y-5">
        <OverviewSection member={member} onSave={save} />
        <RoutinesSection member={member} onSave={save} />
        <PreferencesSection member={member} onSave={save} />
        <InfoSection member={member} onSave={save} />
        <MemoriesSection member={member} onSave={save} />
        <TimelineSection member={member} onSave={save} />
      </div>
    </div>
  )
}

type SaveFn = (changes: Partial<FamilyMember>) => Promise<void>

// ── Reusable section shell ──────────────────────────────────

function Section({
  icon,
  title,
  count,
  action,
  children,
}: {
  icon: React.ReactNode
  title: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 animate-slide-up">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-slate-50 flex items-center justify-center text-slate-500">
            {icon}
          </div>
          <h2 className="font-bold text-slate-900">
            {title}
            {typeof count === 'number' && count > 0 && (
              <span className="text-slate-400 font-medium"> · {count}</span>
            )}
          </h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

function AddButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors"
    >
      {open ? <X size={15} /> : <Plus size={15} />}
      {open ? 'Cancel' : 'Add'}
    </button>
  )
}

function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-slate-300 hover:text-red-500 transition-colors shrink-0 p-1"
      aria-label="Delete"
    >
      <Trash2 size={15} />
    </button>
  )
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-sm text-slate-400">{text}</p>
}

// ── Overview ────────────────────────────────────────────────

function OverviewSection({ member, onSave }: { member: FamilyMember; onSave: SaveFn }) {
  const [summary, setSummary] = useState(member.summary ?? '')
  const [birthday, setBirthday] = useState(member.birthday ?? '')
  const [saving, setSaving] = useState(false)
  const { toast } = useToast()

  const dirty = summary !== (member.summary ?? '') || birthday !== (member.birthday ?? '')

  async function handleSave() {
    setSaving(true)
    await onSave({ summary: summary.trim(), birthday })
    setSaving(false)
    toast('Overview saved', 'success')
  }

  return (
    <Section icon={<Sparkles size={18} />} title="Overview">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Summary</label>
          <Textarea
            rows={3}
            placeholder="A one-liner about this person…"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Birthday</label>
          <Input type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
        </div>
        {dirty && (
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500"
          >
            {saving ? 'Saving…' : 'Save overview'}
          </Button>
        )}
      </div>
    </Section>
  )
}

// ── Routines ────────────────────────────────────────────────

function RoutinesSection({ member, onSave }: { member: FamilyMember; onSave: SaveFn }) {
  const routines = member.routines ?? []
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [schedule, setSchedule] = useState('')
  const { toast } = useToast()

  async function add() {
    if (!title.trim() || !schedule.trim()) {
      toast('Add a title and schedule', 'error')
      return
    }
    const entry: RoutineEntry = { id: generateId(), title: title.trim(), schedule: schedule.trim() }
    await onSave({ routines: [...routines, entry] })
    setTitle('')
    setSchedule('')
    setOpen(false)
  }

  async function remove(id: string) {
    await onSave({ routines: routines.filter((r) => r.id !== id) })
  }

  return (
    <Section
      icon={<Clock size={18} />}
      title="Routines"
      count={routines.length}
      action={<AddButton open={open} onToggle={() => setOpen((v) => !v)} />}
    >
      {open && (
        <div className="mb-4 p-4 rounded-xl bg-slate-50 space-y-3 animate-scale-in">
          <Input placeholder="Title (e.g. School pickup)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input placeholder="Schedule (e.g. Weekdays 3:30pm)" value={schedule} onChange={(e) => setSchedule(e.target.value)} />
          <Button size="sm" onClick={add} className="bg-gradient-to-r from-blue-600 to-purple-600">
            <Plus size={14} className="mr-1" /> Add routine
          </Button>
        </div>
      )}
      {routines.length === 0 && !open ? (
        <EmptyHint text="No routines yet." />
      ) : (
        <ul className="space-y-2">
          {routines.map((r) => (
            <li key={r.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate">{r.title}</p>
                <p className="text-sm text-slate-500 truncate">{r.schedule}</p>
              </div>
              <DeleteButton onClick={() => remove(r.id)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// ── Preferences ─────────────────────────────────────────────

function PreferencesSection({ member, onSave }: { member: FamilyMember; onSave: SaveFn }) {
  const preferences = member.preferences ?? []
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState('')
  const [text, setText] = useState('')
  const { toast } = useToast()

  async function add() {
    if (!category.trim() || !text.trim()) {
      toast('Add a category and detail', 'error')
      return
    }
    const entry: PreferenceEntry = { id: generateId(), category: category.trim(), text: text.trim() }
    await onSave({ preferences: [...preferences, entry] })
    setCategory('')
    setText('')
    setOpen(false)
  }

  async function remove(id: string) {
    await onSave({ preferences: preferences.filter((p) => p.id !== id) })
  }

  return (
    <Section
      icon={<Heart size={18} />}
      title="Preferences"
      count={preferences.length}
      action={<AddButton open={open} onToggle={() => setOpen((v) => !v)} />}
    >
      {open && (
        <div className="mb-4 p-4 rounded-xl bg-slate-50 space-y-3 animate-scale-in">
          <Input placeholder="Category (e.g. Food, Activities)" value={category} onChange={(e) => setCategory(e.target.value)} />
          <Input placeholder="Detail (e.g. Loves pasta, hates olives)" value={text} onChange={(e) => setText(e.target.value)} />
          <Button size="sm" onClick={add} className="bg-gradient-to-r from-blue-600 to-purple-600">
            <Plus size={14} className="mr-1" /> Add preference
          </Button>
        </div>
      )}
      {preferences.length === 0 && !open ? (
        <EmptyHint text="No preferences yet." />
      ) : (
        <ul className="space-y-2">
          {preferences.map((p) => (
            <li key={p.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100">
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-purple-100 text-purple-700 shrink-0">
                {p.category}
              </span>
              <p className="flex-1 min-w-0 text-sm text-slate-700 truncate">{p.text}</p>
              <DeleteButton onClick={() => remove(p.id)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// ── Important Information ────────────────────────────────────

function InfoSection({ member, onSave }: { member: FamilyMember; onSave: SaveFn }) {
  const info = member.importantInfo ?? []
  const [open, setOpen] = useState(false)
  const [category, setCategory] = useState<InfoEntry['category']>('medical')
  const [label, setLabel] = useState('')
  const [value, setValue] = useState('')
  const { toast } = useToast()

  async function add() {
    if (!label.trim() || !value.trim()) {
      toast('Add a label and value', 'error')
      return
    }
    const entry: InfoEntry = { id: generateId(), category, label: label.trim(), value: value.trim() }
    await onSave({ importantInfo: [...info, entry] })
    setLabel('')
    setValue('')
    setOpen(false)
  }

  async function remove(id: string) {
    await onSave({ importantInfo: info.filter((i) => i.id !== id) })
  }

  return (
    <Section
      icon={<Info size={18} />}
      title="Important Information"
      count={info.length}
      action={<AddButton open={open} onToggle={() => setOpen((v) => !v)} />}
    >
      {open && (
        <div className="mb-4 p-4 rounded-xl bg-slate-50 space-y-3 animate-scale-in">
          <Select value={category} onChange={(e) => setCategory(e.target.value as InfoEntry['category'])}>
            {INFO_CATEGORIES.map((c) => (
              <option key={c} value={c} className="capitalize">
                {c.charAt(0).toUpperCase() + c.slice(1)}
              </option>
            ))}
          </Select>
          <Input placeholder="Label (e.g. Allergies)" value={label} onChange={(e) => setLabel(e.target.value)} />
          <Input placeholder="Value (e.g. Peanuts, penicillin)" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button size="sm" onClick={add} className="bg-gradient-to-r from-blue-600 to-purple-600">
            <Plus size={14} className="mr-1" /> Add info
          </Button>
        </div>
      )}
      {info.length === 0 && !open ? (
        <EmptyHint text="No important information yet." />
      ) : (
        <ul className="space-y-2">
          {info.map((i) => (
            <li key={i.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize shrink-0 ${INFO_CATEGORY_STYLES[i.category]}`}
              >
                {i.category}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-700 truncate">
                  <span className="font-medium text-slate-900">{i.label}:</span> {i.value}
                </p>
              </div>
              <DeleteButton onClick={() => remove(i.id)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// ── Memories ────────────────────────────────────────────────

function MemoriesSection({ member, onSave }: { member: FamilyMember; onSave: SaveFn }) {
  const memories = member.memories ?? []
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const { toast } = useToast()

  async function add() {
    if (!text.trim()) {
      toast('Write a memory first', 'error')
      return
    }
    const entry: MemoryEntry = { id: generateId(), text: text.trim(), createdAt: new Date().toISOString() }
    await onSave({ memories: [...memories, entry] })
    setText('')
    setOpen(false)
  }

  async function remove(id: string) {
    await onSave({ memories: memories.filter((m) => m.id !== id) })
  }

  const sorted = [...memories].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <Section
      icon={<Sparkles size={18} />}
      title="Memories"
      count={memories.length}
      action={<AddButton open={open} onToggle={() => setOpen((v) => !v)} />}
    >
      {open && (
        <div className="mb-4 p-4 rounded-xl bg-slate-50 space-y-3 animate-scale-in">
          <Textarea
            rows={3}
            placeholder="Capture a moment…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button size="sm" onClick={add} className="bg-gradient-to-r from-blue-600 to-purple-600">
            <Plus size={14} className="mr-1" /> Add memory
          </Button>
        </div>
      )}
      {memories.length === 0 && !open ? (
        <EmptyHint text="No memories yet." />
      ) : (
        <ul className="space-y-2">
          {sorted.map((m) => (
            <li key={m.id} className="flex items-start gap-3 p-3 rounded-xl border border-slate-100">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-700 whitespace-pre-wrap break-words">{m.text}</p>
                <p className="text-xs text-slate-400 mt-1">{relativeDate(m.createdAt)}</p>
              </div>
              <DeleteButton onClick={() => remove(m.id)} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  )
}

// ── Timeline ────────────────────────────────────────────────

function TimelineSection({ member, onSave }: { member: FamilyMember; onSave: SaveFn }) {
  const timeline = member.timeline ?? []
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const { toast } = useToast()

  async function add() {
    if (!title.trim() || !date) {
      toast('Add a title and date', 'error')
      return
    }
    const entry: TimelineMilestone = { id: generateId(), title: title.trim(), date }
    await onSave({ timeline: [...timeline, entry] })
    setTitle('')
    setDate('')
    setOpen(false)
  }

  async function remove(id: string) {
    await onSave({ timeline: timeline.filter((t) => t.id !== id) })
  }

  const sorted = [...timeline].sort((a, b) => a.date.localeCompare(b.date))

  return (
    <Section
      icon={<Milestone size={18} />}
      title="Timeline"
      count={timeline.length}
      action={<AddButton open={open} onToggle={() => setOpen((v) => !v)} />}
    >
      {open && (
        <div className="mb-4 p-4 rounded-xl bg-slate-50 space-y-3 animate-scale-in">
          <Input placeholder="Milestone (e.g. Started kindergarten)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button size="sm" onClick={add} className="bg-gradient-to-r from-blue-600 to-purple-600">
            <Plus size={14} className="mr-1" /> Add milestone
          </Button>
        </div>
      )}
      {timeline.length === 0 && !open ? (
        <EmptyHint text="No milestones yet." />
      ) : (
        <ol className="relative ml-2">
          {sorted.map((t, idx) => (
            <li key={t.id} className="relative flex gap-4 pb-5 last:pb-0 group">
              {/* connector line */}
              {idx !== sorted.length - 1 && (
                <span className="absolute left-[5px] top-3 bottom-0 w-px bg-slate-200" aria-hidden />
              )}
              <span
                className="mt-1.5 h-2.5 w-2.5 rounded-full shrink-0 ring-4 ring-white"
                style={{ backgroundColor: member.colorHex }}
                aria-hidden
              />
              <div className="flex-1 min-w-0 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 break-words">{t.title}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{formatDate(t.date)}</p>
                </div>
                <DeleteButton onClick={() => remove(t.id)} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  )
}
