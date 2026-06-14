'use client'

import { useMemo, useState } from 'react'
import {
  ArrowLeft,
  Sparkles,
  Trash2,
  Plus,
  Pencil,
  Check,
  AlertTriangle,
  Lightbulb,
  ExternalLink,
  Calendar,
} from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PLAN_KINDS } from '@/lib/types'
import type {
  Plan,
  PlanMilestone,
  PlanTask,
  PlanShoppingItem,
  PlanDocument,
  FamilyMember,
} from '@/lib/types'
import { generateId } from '@/lib/utils'

interface Props {
  plan: Plan
  onBack: () => void
}

function countdown(targetDate: string): string {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const target = new Date(targetDate)
  target.setHours(0, 0, 0, 0)
  const days = Math.round((target.getTime() - now.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days < 0) return `${Math.abs(days)} days ago`
  return `in ${days} days`
}

function fmtDate(d: string): string {
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function SectionCard({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 animate-slide-up">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-slate-900">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  )
}

export function PlanDetail({ plan: initialPlan, onBack }: Props) {
  const { data, update, remove } = useFirestore<Plan>('plans')
  const members = useFirestore<FamilyMember>('members')
  const { toast } = useToast()

  // Always read the live version from Firestore data.
  const plan = data.find((p) => p.id === initialPlan.id) ?? initialPlan
  const kindMeta = PLAN_KINDS.find((k) => k.kind === plan.kind)

  const milestones = plan.milestones ?? []
  const tasks = plan.tasks ?? []
  const shopping = plan.shopping ?? []
  const documents = plan.documents ?? []
  const participants = plan.participants ?? []
  const risks = plan.risks ?? []
  const insights = plan.insights ?? []

  const sortedMilestones = useMemo(
    () =>
      [...milestones].sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
      ),
    [milestones]
  )

  const doneTasks = tasks.filter((t) => t.isCompleted).length

  const [assessing, setAssessing] = useState(false)
  const [editingSummary, setEditingSummary] = useState(false)
  const [summaryDraft, setSummaryDraft] = useState(plan.summary ?? '')

  const [newMilestone, setNewMilestone] = useState('')
  const [newMilestoneDate, setNewMilestoneDate] = useState('')
  const [newTask, setNewTask] = useState('')
  const [newShopping, setNewShopping] = useState('')
  const [newDocLabel, setNewDocLabel] = useState('')
  const [newDocUrl, setNewDocUrl] = useState('')

  async function patch(fields: Partial<Plan>) {
    await update({ ...plan, ...fields })
  }

  async function saveSummary() {
    await patch({ summary: summaryDraft.trim() })
    setEditingSummary(false)
    toast('Saved', 'success')
  }

  async function reassess() {
    setAssessing(true)
    try {
      const res = await fetch('/api/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'assess',
          title: plan.title,
          kind: plan.kind,
          targetDate: plan.targetDate,
          tasks,
          shopping,
          milestones,
          today: new Date().toISOString().slice(0, 10),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Assessment failed')
      await patch({
        readiness: json.readiness ?? 0,
        readinessSummary: json.readinessSummary ?? '',
        risks: json.risks ?? [],
        insights: json.insights ?? [],
      })
      toast('Readiness updated', 'success')
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not assess', 'error')
    } finally {
      setAssessing(false)
    }
  }

  async function deletePlan() {
    if (!confirm('Delete this plan? This cannot be undone.')) return
    await remove(plan.id)
    toast('Plan deleted', 'success')
    onBack()
  }

  // ── Milestones ──
  async function addMilestone() {
    if (!newMilestone.trim() || !newMilestoneDate) return
    const item: PlanMilestone = {
      id: generateId(),
      title: newMilestone.trim(),
      date: newMilestoneDate,
      isComplete: false,
    }
    await patch({ milestones: [...milestones, item] })
    setNewMilestone('')
    setNewMilestoneDate('')
  }
  async function toggleMilestone(id: string) {
    await patch({
      milestones: milestones.map((m) =>
        m.id === id ? { ...m, isComplete: !m.isComplete } : m
      ),
    })
  }
  async function removeMilestone(id: string) {
    await patch({ milestones: milestones.filter((m) => m.id !== id) })
  }

  // ── Tasks ──
  async function addTask() {
    if (!newTask.trim()) return
    const item: PlanTask = {
      id: generateId(),
      title: newTask.trim(),
      isCompleted: false,
    }
    await patch({ tasks: [...tasks, item] })
    setNewTask('')
  }
  async function toggleTask(id: string) {
    await patch({
      tasks: tasks.map((t) =>
        t.id === id ? { ...t, isCompleted: !t.isCompleted } : t
      ),
    })
  }
  async function removeTask(id: string) {
    await patch({ tasks: tasks.filter((t) => t.id !== id) })
  }

  // ── Shopping ──
  async function addShopping() {
    if (!newShopping.trim()) return
    const item: PlanShoppingItem = {
      id: generateId(),
      name: newShopping.trim(),
      isPurchased: false,
    }
    await patch({ shopping: [...shopping, item] })
    setNewShopping('')
  }
  async function toggleShopping(id: string) {
    await patch({
      shopping: shopping.map((s) =>
        s.id === id ? { ...s, isPurchased: !s.isPurchased } : s
      ),
    })
  }
  async function removeShopping(id: string) {
    await patch({ shopping: shopping.filter((s) => s.id !== id) })
  }

  // ── Documents ──
  async function addDocument() {
    if (!newDocLabel.trim()) return
    const item: PlanDocument = {
      id: generateId(),
      label: newDocLabel.trim(),
    }
    if (newDocUrl.trim()) item.url = newDocUrl.trim()
    await patch({ documents: [...documents, item] })
    setNewDocLabel('')
    setNewDocUrl('')
  }
  async function removeDocument(id: string) {
    await patch({ documents: documents.filter((d) => d.id !== id) })
  }

  // ── Participants ──
  async function toggleParticipant(email: string) {
    const next = participants.includes(email)
      ? participants.filter((e) => e !== email)
      : [...participants, email]
    await patch({ participants: next })
  }

  const readiness = plan.readiness ?? 0
  const ringColor =
    readiness >= 75 ? '#22C55E' : readiness >= 40 ? '#F59E0B' : '#EF4444'

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 animate-fade-in space-y-5">
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors"
      >
        <ArrowLeft size={16} /> Back to plans
      </button>

      {/* Header */}
      <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 animate-slide-up">
        <div className="flex items-start gap-4">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-4xl shrink-0"
            style={{ backgroundColor: `${plan.colorHex}1A` }}
          >
            {plan.emoji}
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{plan.title}</h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-sm text-slate-500">
              <span>{kindMeta?.label ?? plan.kind}</span>
              {plan.targetDate && (
                <span className="inline-flex items-center gap-1">
                  <Calendar size={14} />
                  {fmtDate(plan.targetDate)} · {countdown(plan.targetDate)}
                </span>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={deletePlan} title="Delete">
            <Trash2 size={18} className="text-slate-400" />
          </Button>
        </div>
      </div>

      {/* Overview */}
      <SectionCard
        title="Overview"
        action={
          !editingSummary && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSummaryDraft(plan.summary ?? '')
                setEditingSummary(true)
              }}
            >
              <Pencil size={14} className="mr-1" /> Edit
            </Button>
          )
        }
      >
        {editingSummary ? (
          <div className="space-y-3">
            <Textarea
              rows={3}
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              placeholder="What's this plan about?"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveSummary}>
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditingSummary(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : plan.summary ? (
          <p className="text-slate-600 leading-relaxed">{plan.summary}</p>
        ) : (
          <p className="text-slate-400 italic">No summary yet.</p>
        )}
      </SectionCard>

      {/* Readiness */}
      <SectionCard
        title="Readiness"
        action={
          <button
            onClick={reassess}
            disabled={assessing}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-white bg-gradient-to-r from-blue-600 to-purple-600 transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50"
          >
            <Sparkles size={14} />
            {assessing ? 'Assessing…' : 'Re-assess with AI'}
          </button>
        }
      >
        {typeof plan.readiness === 'number' ? (
          <div className="flex items-center gap-5">
            <div className="relative w-20 h-20 shrink-0">
              <svg className="w-20 h-20 -rotate-90" viewBox="0 0 72 72">
                <circle
                  cx="36"
                  cy="36"
                  r="30"
                  fill="none"
                  stroke="#E2E8F0"
                  strokeWidth="7"
                />
                <circle
                  cx="36"
                  cy="36"
                  r="30"
                  fill="none"
                  stroke={ringColor}
                  strokeWidth="7"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 30}
                  strokeDashoffset={
                    2 * Math.PI * 30 - (readiness / 100) * 2 * Math.PI * 30
                  }
                  className="transition-all duration-700"
                />
              </svg>
              <span className="absolute inset-0 flex items-center justify-center text-xl font-bold text-slate-800">
                {readiness}
              </span>
            </div>
            <p className="text-slate-600 leading-relaxed flex-1">
              {plan.readinessSummary || 'Assessment complete.'}
            </p>
          </div>
        ) : (
          <p className="text-slate-400">
            Run an AI assessment to see how ready this plan is.
          </p>
        )}
      </SectionCard>

      {/* Risks */}
      {risks.length > 0 && (
        <SectionCard title="Risks">
          <ul className="space-y-2.5">
            {risks.map((r, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-xl bg-red-50 border border-red-100 px-4 py-3"
              >
                <AlertTriangle
                  size={16}
                  className="text-red-500 mt-0.5 shrink-0"
                />
                <span className="text-sm text-red-900">{r}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Insights */}
      {insights.length > 0 && (
        <SectionCard title="Insights">
          <ul className="space-y-2.5">
            {insights.map((ins, i) => (
              <li
                key={i}
                className="flex items-start gap-3 rounded-xl bg-purple-50 border border-purple-100 px-4 py-3"
              >
                <Lightbulb
                  size={16}
                  className="text-purple-500 mt-0.5 shrink-0"
                />
                <span className="text-sm text-purple-900">{ins}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      {/* Milestones */}
      <SectionCard title="Milestones">
        {sortedMilestones.length > 0 ? (
          <ol className="relative border-l-2 border-slate-100 ml-2 space-y-4 mb-5">
            {sortedMilestones.map((m) => (
              <li key={m.id} className="ml-5 relative">
                <button
                  onClick={() => toggleMilestone(m.id)}
                  className={`absolute -left-[27px] top-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                    m.isComplete
                      ? 'bg-green-500 border-green-500'
                      : 'bg-white border-slate-300 hover:border-blue-400'
                  }`}
                >
                  {m.isComplete && <Check size={10} className="text-white" />}
                </button>
                <div className="flex items-start justify-between gap-2 group">
                  <div>
                    <p
                      className={`text-sm font-medium ${
                        m.isComplete
                          ? 'text-slate-400 line-through'
                          : 'text-slate-800'
                      }`}
                    >
                      {m.title}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {fmtDate(m.date)}
                    </p>
                  </div>
                  <button
                    onClick={() => removeMilestone(m.id)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-300 hover:text-red-400 transition-all"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-slate-400 mb-4">No milestones yet.</p>
        )}
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="New milestone"
            value={newMilestone}
            onChange={(e) => setNewMilestone(e.target.value)}
            className="flex-1"
          />
          <Input
            type="date"
            value={newMilestoneDate}
            onChange={(e) => setNewMilestoneDate(e.target.value)}
            className="sm:w-44"
          />
          <Button onClick={addMilestone} disabled={!newMilestone.trim() || !newMilestoneDate}>
            <Plus size={16} />
          </Button>
        </div>
      </SectionCard>

      {/* Tasks */}
      <SectionCard
        title="Tasks"
        action={
          tasks.length > 0 && (
            <span className="text-sm text-slate-400">
              {doneTasks}/{tasks.length} done
            </span>
          )
        }
      >
        {tasks.length > 0 && (
          <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-gradient-to-r from-blue-600 to-purple-600 rounded-full transition-all duration-500"
              style={{
                width: `${tasks.length ? (doneTasks / tasks.length) * 100 : 0}%`,
              }}
            />
          </div>
        )}
        <ul className="space-y-1.5 mb-4">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="flex items-center gap-3 group rounded-lg px-1 py-1"
            >
              <button
                onClick={() => toggleTask(t.id)}
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                  t.isCompleted
                    ? 'bg-green-500 border-green-500'
                    : 'bg-white border-slate-300 hover:border-blue-400'
                }`}
              >
                {t.isCompleted && <Check size={12} className="text-white" />}
              </button>
              <span
                className={`flex-1 text-sm ${
                  t.isCompleted
                    ? 'text-slate-400 line-through'
                    : 'text-slate-700'
                }`}
              >
                {t.title}
              </span>
              <button
                onClick={() => removeTask(t.id)}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-300 hover:text-red-400 transition-all"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
          {tasks.length === 0 && (
            <p className="text-slate-400">No tasks yet.</p>
          )}
        </ul>
        <div className="flex gap-2">
          <Input
            placeholder="Add a task"
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addTask()}
            className="flex-1"
          />
          <Button onClick={addTask} disabled={!newTask.trim()}>
            <Plus size={16} />
          </Button>
        </div>
      </SectionCard>

      {/* Shopping */}
      <SectionCard title="Shopping">
        <ul className="space-y-1.5 mb-4">
          {shopping.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-3 group rounded-lg px-1 py-1"
            >
              <button
                onClick={() => toggleShopping(s.id)}
                className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                  s.isPurchased
                    ? 'bg-green-500 border-green-500'
                    : 'bg-white border-slate-300 hover:border-blue-400'
                }`}
              >
                {s.isPurchased && <Check size={12} className="text-white" />}
              </button>
              <span
                className={`flex-1 text-sm ${
                  s.isPurchased
                    ? 'text-slate-400 line-through'
                    : 'text-slate-700'
                }`}
              >
                {s.name}
                {typeof s.quantity === 'number' && (
                  <span className="text-slate-400"> × {s.quantity}</span>
                )}
              </span>
              <button
                onClick={() => removeShopping(s.id)}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-300 hover:text-red-400 transition-all"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
          {shopping.length === 0 && (
            <p className="text-slate-400">Nothing to buy yet.</p>
          )}
        </ul>
        <div className="flex gap-2">
          <Input
            placeholder="Add an item"
            value={newShopping}
            onChange={(e) => setNewShopping(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addShopping()}
            className="flex-1"
          />
          <Button onClick={addShopping} disabled={!newShopping.trim()}>
            <Plus size={16} />
          </Button>
        </div>
      </SectionCard>

      {/* Documents */}
      <SectionCard title="Documents">
        <ul className="space-y-1.5 mb-4">
          {documents.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-3 group rounded-lg px-3 py-2 bg-slate-50"
            >
              <span className="flex-1 text-sm text-slate-700">{d.label}</span>
              {d.url && (
                <a
                  href={d.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  Open <ExternalLink size={12} />
                </a>
              )}
              <button
                onClick={() => removeDocument(d.id)}
                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg text-slate-300 hover:text-red-400 transition-all"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
          {documents.length === 0 && (
            <p className="text-slate-400">No documents linked.</p>
          )}
        </ul>
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            placeholder="Label"
            value={newDocLabel}
            onChange={(e) => setNewDocLabel(e.target.value)}
            className="flex-1"
          />
          <Input
            placeholder="URL (optional)"
            value={newDocUrl}
            onChange={(e) => setNewDocUrl(e.target.value)}
            className="flex-1"
          />
          <Button onClick={addDocument} disabled={!newDocLabel.trim()}>
            <Plus size={16} />
          </Button>
        </div>
      </SectionCard>

      {/* Participants */}
      <SectionCard title="Participants">
        {members.data.length === 0 ? (
          <p className="text-slate-400">No family members yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {members.data.map((m) => {
              const active = participants.includes(m.email)
              return (
                <button
                  key={m.id}
                  onClick={() => toggleParticipant(m.email)}
                  className={`inline-flex items-center gap-2 rounded-full pl-1 pr-3 py-1 border-2 transition-all ${
                    active
                      ? 'border-transparent text-white'
                      : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                  }`}
                  style={
                    active ? { backgroundColor: m.colorHex } : undefined
                  }
                >
                  <span
                    className="w-7 h-7 rounded-full flex items-center justify-center text-sm"
                    style={{
                      backgroundColor: active
                        ? 'rgba(255,255,255,0.25)'
                        : `${m.colorHex}1A`,
                    }}
                  >
                    {m.emoji}
                  </span>
                  <span className="text-sm font-medium">{m.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </SectionCard>
    </div>
  )
}
