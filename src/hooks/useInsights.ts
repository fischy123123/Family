'use client'

import { useMemo } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { dateStrOffset } from '@/hooks/useDayPlan'
import type {
  DayPlan, MomentCheckIn, FamilyGoal, MomentEnergy, MomentMood, DayPlanItem,
} from '@/lib/types'

function emailKey(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

export interface DayStat {
  date: string          // YYYY-MM-DD
  total: number
  done: number
  pct: number           // 0-100
  hasPlan: boolean
}

export interface CategoryStat {
  key: string           // category or 'anchor'/'other'
  total: number
  done: number
}

export interface InsightsData {
  hasHistory: boolean
  // headline numbers
  streak: number                // consecutive recent days with a committed plan
  plansCount: number            // committed plans on record
  itemsDone: number
  itemsTotal: number
  completionPct: number         // overall, 0-100
  // last 14 days, oldest → newest
  recentDays: DayStat[]
  // completion split by item category
  byCategory: CategoryStat[]
  // wellbeing, from the last 30 days of check-ins
  checkinCount: number
  energyMix: Record<MomentEnergy, number>
  moodMix: Record<MomentMood, number>
  followThroughPct: number | null  // did_it / (did_it + dismissed), null if no data
  // standing commitments
  goals: FamilyGoal[]
}

const EMPTY_ENERGY: Record<MomentEnergy, number> = { wired: 0, okay: 0, drained: 0 }
const EMPTY_MOOD: Record<MomentMood, number> = { good: 0, meh: 0, low: 0, anxious: 0 }

function itemCategory(it: DayPlanItem): string {
  if (it.category) return it.category
  return it.kind === 'anchor' ? 'anchor' : 'other'
}

// Aggregates the signed-in person's planning history into stats for the
// Insights screen. Pure client-side reduction over the data already synced by
// the Firestore listeners — no extra fetch.
export function useInsights(): InsightsData {
  const { user } = useAuth()
  const { data: dayPlans } = useFirestore<DayPlan>('dayPlans')
  const { data: checkins } = useFirestore<MomentCheckIn>('momentCheckins')
  const { data: goals } = useFirestore<FamilyGoal>('goals')

  const myKey = user?.email ? emailKey(user.email) : null
  const myEmail = user?.email?.toLowerCase() ?? null

  return useMemo<InsightsData>(() => {
    // Committed plans only (a draft was never locked in).
    const committed = (myKey ? dayPlans.filter((p) => p.id.startsWith(`${myKey}_`)) : [])
      .filter((p) => p.status === 'active' || p.status === 'done')
    const byDate = new Map<string, DayPlan>()
    for (const p of committed) byDate.set(p.date, p)

    // Streak: consecutive days up to today (or yesterday, if today isn't planned).
    let streak = 0
    let i = byDate.has(dateStrOffset(0)) ? 0 : 1
    for (; ; i++) {
      if (byDate.has(dateStrOffset(-i))) streak++
      else break
    }

    // Last 14 days, oldest → newest.
    const recentDays: DayStat[] = []
    for (let d = 13; d >= 0; d--) {
      const date = dateStrOffset(-d)
      const plan = byDate.get(date)
      const total = plan?.items.length ?? 0
      const done = plan?.items.filter((it) => it.done).length ?? 0
      recentDays.push({ date, total, done, pct: total ? Math.round((done / total) * 100) : 0, hasPlan: !!plan })
    }

    // Totals + category split across all committed plans.
    let itemsDone = 0
    let itemsTotal = 0
    const catMap = new Map<string, CategoryStat>()
    for (const p of committed) {
      for (const it of p.items) {
        itemsTotal++
        if (it.done) itemsDone++
        const key = itemCategory(it)
        const c = catMap.get(key) ?? { key, total: 0, done: 0 }
        c.total++
        if (it.done) c.done++
        catMap.set(key, c)
      }
    }
    const byCategory = Array.from(catMap.values()).sort((a, b) => b.total - a.total)

    // Wellbeing from the last 30 days of check-ins.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    const myCheckins = checkins.filter(
      (c) => (!c.email || c.email.toLowerCase() === myEmail) && new Date(c.ts).getTime() >= cutoff,
    )
    const energyMix = { ...EMPTY_ENERGY }
    const moodMix = { ...EMPTY_MOOD }
    let didIt = 0
    let dismissed = 0
    for (const c of myCheckins) {
      if (c.energy && c.energy in energyMix) energyMix[c.energy]++
      if (c.mood && c.mood in moodMix) moodMix[c.mood]++
      if (c.outcome === 'did_it') didIt++
      else if (c.outcome === 'dismissed') dismissed++
    }
    const followThroughPct = didIt + dismissed > 0 ? Math.round((didIt / (didIt + dismissed)) * 100) : null

    return {
      hasHistory: committed.length > 0,
      streak,
      plansCount: committed.length,
      itemsDone,
      itemsTotal,
      completionPct: itemsTotal ? Math.round((itemsDone / itemsTotal) * 100) : 0,
      recentDays,
      byCategory,
      checkinCount: myCheckins.length,
      energyMix,
      moodMix,
      followThroughPct,
      goals: goals.filter((g) => g.active),
    }
  }, [dayPlans, checkins, goals, myKey, myEmail])
}
