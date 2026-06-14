'use client'

import { useState } from 'react'
import { Plus, CheckCircle2, Calendar } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { CreatePlanForm } from './CreatePlanForm'
import { PlanDetail } from './PlanDetail'
import { Button } from '@/components/ui/button'
import { PLAN_KINDS } from '@/lib/types'
import type { Plan } from '@/lib/types'

type View = 'grid' | 'create' | 'detail'

function countdownLabel(targetDate: string): { text: string; tone: string } {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const target = new Date(targetDate)
  target.setHours(0, 0, 0, 0)
  const days = Math.round((target.getTime() - now.getTime()) / 86400000)
  if (days === 0) return { text: 'Today', tone: 'text-red-600' }
  if (days === 1) return { text: 'Tomorrow', tone: 'text-orange-600' }
  if (days < 0)
    return { text: `${Math.abs(days)}d ago`, tone: 'text-slate-400' }
  if (days < 30) return { text: `in ${days} days`, tone: 'text-blue-600' }
  const weeks = Math.round(days / 7)
  if (days < 90) return { text: `in ${weeks} weeks`, tone: 'text-slate-500' }
  const months = Math.round(days / 30)
  return { text: `in ${months} months`, tone: 'text-slate-500' }
}

function ReadinessRing({ value, color }: { value: number; color: string }) {
  const r = 18
  const c = 2 * Math.PI * r
  const offset = c - (value / 100) * c
  return (
    <div className="relative w-12 h-12 shrink-0">
      <svg className="w-12 h-12 -rotate-90" viewBox="0 0 44 44">
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke="#E2E8F0"
          strokeWidth="4"
        />
        <circle
          cx="22"
          cy="22"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          className="transition-all duration-500"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[11px] font-bold text-slate-700">
        {value}
      </span>
    </div>
  )
}

function PlanCard({ plan, onClick }: { plan: Plan; onClick: () => void }) {
  const kindMeta = PLAN_KINDS.find((k) => k.kind === plan.kind)
  const tasks = plan.tasks ?? []
  const openTasks = tasks.filter((t) => !t.isCompleted).length
  const cd = plan.targetDate ? countdownLabel(plan.targetDate) : null

  return (
    <button
      onClick={onClick}
      className="text-left bg-white rounded-2xl shadow-card border border-slate-100 p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg animate-slide-up"
    >
      <div className="flex items-start gap-3">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
          style={{ backgroundColor: `${plan.colorHex}1A` }}
        >
          {plan.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-bold text-slate-900 truncate">{plan.title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {kindMeta?.label ?? plan.kind}
          </p>
        </div>
        {typeof plan.readiness === 'number' && (
          <ReadinessRing value={plan.readiness} color={plan.colorHex} />
        )}
      </div>

      {plan.summary && (
        <p className="text-sm text-slate-500 mt-3 line-clamp-2">{plan.summary}</p>
      )}

      <div className="flex items-center gap-4 mt-4 text-xs">
        {cd && (
          <span className={`inline-flex items-center gap-1 font-medium ${cd.tone}`}>
            <Calendar size={13} />
            {cd.text}
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-slate-400">
          <CheckCircle2 size={13} />
          {openTasks === 0
            ? tasks.length > 0
              ? 'All done'
              : 'No tasks'
            : `${openTasks} open`}
        </span>
      </div>
    </button>
  )
}

export function PlansView() {
  const { data, loading } = useFirestore<Plan>('plans')
  const [view, setView] = useState<View>('grid')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  if (view === 'create') {
    return (
      <CreatePlanForm
        onDone={() => setView('grid')}
        onCreated={(plan) => {
          setSelectedId(plan.id)
          setView('detail')
        }}
      />
    )
  }

  if (view === 'detail' && selectedId) {
    const plan = data.find((p) => p.id === selectedId)
    if (plan) {
      return (
        <PlanDetail
          plan={plan}
          onBack={() => {
            setSelectedId(null)
            setView('grid')
          }}
        />
      )
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 animate-fade-in">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Plans</h1>
          <p className="text-slate-500 mt-1">
            Living workspaces for everything that takes preparation
          </p>
        </div>
        <button
          onClick={() => setView('create')}
          className="inline-flex items-center gap-2 rounded-xl px-5 py-3 text-sm font-medium text-white bg-gradient-to-r from-blue-600 to-purple-600 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md shrink-0"
        >
          <Plus size={18} /> New Plan
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-24">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : data.length === 0 ? (
        <div className="flex flex-col items-center text-center py-20 animate-scale-in">
          <div className="text-6xl mb-4">🗺️</div>
          <h2 className="text-xl font-bold text-slate-900">No plans yet</h2>
          <p className="text-slate-500 mt-2 max-w-sm">
            Trips, birthdays, holidays, home projects — turn any big undertaking
            into a calm, guided workspace.
          </p>
          <Button size="lg" className="mt-6" onClick={() => setView('create')}>
            <Plus size={18} className="mr-1.5" /> Create your first plan
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-children">
          {data.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              onClick={() => {
                setSelectedId(plan.id)
                setView('detail')
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
