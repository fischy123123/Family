'use client'

import { useState, useCallback } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import type { DayPlan, FamilyGoal, Reflection, GoalScorecard } from '@/lib/types'

function emailKey(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

// Generates the goal scorecard from the user's standing goals + recent committed
// day plans (what they planned, completed, and missed). On-demand — one AI call.
export function useGoalScorecard() {
  const { user } = useAuth()
  const { data: goals } = useFirestore<FamilyGoal>('goals')
  const { data: reflections } = useFirestore<Reflection>('reflections')
  const { data: dayPlans } = useFirestore<DayPlan>('dayPlans')

  const [scorecard, setScorecard] = useState<GoalScorecard | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const activeGoals = goals.filter((g) => g.active)

  const generate = useCallback(async () => {
    if (!user?.email || activeGoals.length === 0) return
    setLoading(true); setError(null)
    try {
      const myKey = emailKey(user.email)
      // Last ~30 committed days of plans → a compact activity digest.
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
      const activity = dayPlans
        .filter((p) => p.id.startsWith(`${myKey}_`) && (p.status === 'active' || p.status === 'done'))
        .filter((p) => new Date(`${p.date}T00:00:00`).getTime() >= cutoff)
        .map((p) => ({
          date: p.date,
          items: p.items.map((it) => ({ title: it.title, category: it.category, kind: it.kind, done: !!it.done })),
        }))

      const res = await fetch('/api/ai/goal-scorecard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goals: activeGoals,
          reflections,
          activity,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Scorecard failed')
      setScorecard(data as GoalScorecard)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Scorecard failed')
    } finally {
      setLoading(false)
    }
  }, [user, activeGoals, reflections, dayPlans])

  return { goals: activeGoals, scorecard, loading, error, generate }
}
