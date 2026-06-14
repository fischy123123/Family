'use client'

import { useState } from 'react'
import { ArrowLeft, Sparkles, Plus } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { PLAN_KINDS } from '@/lib/types'
import type {
  Plan,
  PlanKind,
  PlanMilestone,
  PlanTask,
  PlanShoppingItem,
  FamilyMember,
} from '@/lib/types'
import { generateId } from '@/lib/utils'

const KIND_COLORS: Record<PlanKind, string> = {
  trip: '#3B82F6',
  vacation: '#14B8A6',
  'school-year': '#F59E0B',
  holiday: '#EF4444',
  birthday: '#EC4899',
  'home-project': '#F97316',
  event: '#8B5CF6',
  other: '#6366F1',
}

interface Props {
  onDone: () => void
  onCreated: (plan: Plan) => void
}

export function CreatePlanForm({ onDone, onCreated }: Props) {
  const { create } = useFirestore<Plan>('plans')
  const members = useFirestore<FamilyMember>('members')
  const { toast } = useToast()

  const [title, setTitle] = useState('')
  const [kind, setKind] = useState<PlanKind>('trip')
  const [targetDate, setTargetDate] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState<'ai' | 'empty' | null>(null)

  const meta = PLAN_KINDS.find((k) => k.kind === kind) ?? PLAN_KINDS[0]
  const colorHex = KIND_COLORS[kind] ?? '#6366F1'

  function baseplan(): Omit<Plan, 'id'> {
    const plan: Omit<Plan, 'id'> = {
      title: title.trim(),
      kind,
      emoji: meta.emoji,
      colorHex,
      createdAt: new Date().toISOString(),
      participants: members.data.map((m) => m.email).filter(Boolean),
      milestones: [],
      tasks: [],
      shopping: [],
      documents: [],
    }
    if (targetDate) plan.targetDate = targetDate
    if (notes.trim()) plan.summary = notes.trim()
    return plan
  }

  async function createEmpty() {
    if (!title.trim()) {
      toast('Give your plan a title first', 'error')
      return
    }
    setBusy('empty')
    try {
      const plan = await create({ id: generateId(), ...baseplan() })
      toast('Plan created', 'success')
      onCreated(plan)
    } catch {
      toast('Could not create plan', 'error')
    } finally {
      setBusy(null)
    }
  }

  async function generateWithAI() {
    if (!title.trim()) {
      toast('Give your plan a title first', 'error')
      return
    }
    setBusy('ai')
    try {
      const res = await fetch('/api/ai/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'create',
          title: title.trim(),
          kind,
          targetDate: targetDate || undefined,
          notes: notes.trim() || undefined,
          members: members.data.map((m) => ({ name: m.name, email: m.email })),
          today: new Date().toISOString().slice(0, 10),
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'AI failed')

      const milestones: PlanMilestone[] = (json.milestones ?? []).map(
        (m: { title?: string; date?: string }) => {
          const item: PlanMilestone = {
            id: generateId(),
            title: m.title ?? 'Milestone',
            date: m.date ?? new Date().toISOString().slice(0, 10),
            isComplete: false,
          }
          return item
        }
      )
      const tasks: PlanTask[] = (json.tasks ?? []).map(
        (t: { title?: string }) => {
          const item: PlanTask = {
            id: generateId(),
            title: t.title ?? 'Task',
            isCompleted: false,
          }
          return item
        }
      )
      const shopping: PlanShoppingItem[] = (json.shopping ?? []).map(
        (s: { name?: string; quantity?: number }) => {
          const item: PlanShoppingItem = {
            id: generateId(),
            name: s.name ?? 'Item',
            isPurchased: false,
          }
          if (typeof s.quantity === 'number') item.quantity = s.quantity
          return item
        }
      )

      const base = baseplan()
      if (json.summary && !base.summary) base.summary = json.summary

      const plan = await create({
        id: generateId(),
        ...base,
        milestones,
        tasks,
        shopping,
      })
      toast('Plan generated with AI', 'success')
      onCreated(plan)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not generate plan', 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 animate-fade-in">
      <button
        onClick={onDone}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-5 transition-colors"
      >
        <ArrowLeft size={16} /> Back to plans
      </button>

      <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 animate-slide-up">
        <div className="flex items-center gap-3 mb-6">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center text-3xl shrink-0"
            style={{ backgroundColor: `${colorHex}1A` }}
          >
            {meta.emoji}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">New Plan</h1>
            <p className="text-sm text-slate-500">
              Set the basics — then let AI build the workspace.
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Title
            </label>
            <Input
              placeholder="e.g. Summer trip to Italy"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Kind
              </label>
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as PlanKind)}
              >
                {PLAN_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.emoji} {k.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Target date <span className="text-slate-400">(optional)</span>
              </label>
              <Input
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Notes <span className="text-slate-400">(optional)</span>
            </label>
            <Textarea
              rows={3}
              placeholder="Anything the AI should know — budget, who's coming, preferences…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 pt-6">
          <button
            onClick={generateWithAI}
            disabled={busy !== null}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-base font-medium text-white bg-gradient-to-r from-blue-600 to-purple-600 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 disabled:pointer-events-none"
          >
            <Sparkles size={18} />
            {busy === 'ai' ? 'Generating…' : 'Generate plan with AI'}
          </button>
          <Button
            variant="outline"
            size="lg"
            onClick={createEmpty}
            disabled={busy !== null}
          >
            <Plus size={18} className="mr-1.5" />
            {busy === 'empty' ? 'Creating…' : 'Create empty plan'}
          </Button>
        </div>
      </div>
    </div>
  )
}
