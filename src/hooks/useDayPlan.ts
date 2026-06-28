'use client'

import { useState, useCallback, useMemo } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { generateId } from '@/lib/utils'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyReminder,
  PersonalProfile, MomentEnergy, DayPlan, DayPlanItem,
  FamilyGoal, Reflection,
} from '@/lib/types'

function emailKey(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

// Local YYYY-MM-DD (the user's day, not UTC).
function todayStr(): string {
  const d = new Date()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// The Day Planner hook. Owns today's plan document (one per person per day):
// draft it with the AI, refine by chat, edit by tap, finalize, track to done,
// and replan the rest of the day when it slips. The plan persists in Firestore
// throughout, so it survives reloads and is the same on every device.
export function useDayPlan() {
  const { user } = useAuth()

  const { data: members } = useFirestore<FamilyMember>('members')
  const { data: events } = useFirestore<CalendarEvent>('events')
  const { data: tasks } = useFirestore<Task>('tasks')
  const { data: reminders } = useFirestore<FamilyReminder>('reminders')
  const { data: chores } = useFirestore<Chore>('chores')
  const { data: plans } = useFirestore<Plan>('plans')
  const { data: lists } = useFirestore<SmartList>('lists')
  const { data: memories } = useFirestore<FamilyMemory>('memories')
  const { data: profiles } = useFirestore<FamilyProfile>('profile')
  const { data: personalProfiles } = useFirestore<PersonalProfile>('personalProfiles')
  // Standing commitments + recent reflections — the "who we want to be" layer
  // the planner should translate into concrete moves for today.
  const { data: goals } = useFirestore<FamilyGoal>('goals')
  const { data: reflections } = useFirestore<Reflection>('reflections')
  const {
    data: dayPlans, create: createPlan, update: updatePlan, remove: removePlan,
  } = useFirestore<DayPlan>('dayPlans')

  const profile = profiles[0] ?? null
  const myKey = user?.email ? emailKey(user.email) : null
  const date = todayStr()
  const planId = myKey ? `${myKey}_${date}` : null
  const personalProfile = useMemo(
    () => (myKey ? personalProfiles.find((p) => p.id === myKey) ?? null : null),
    [personalProfiles, myKey],
  )
  const todayPlan = useMemo(
    () => (planId ? dayPlans.find((p) => p.id === planId) ?? null : null),
    [dayPlans, planId],
  )

  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const allTasks: Task[] = useMemo(() => [
    ...tasks,
    ...reminders
      .filter((r) => !tasks.some((t) => t.id === r.id))
      .map((r) => ({
        id: r.id, title: r.title, notes: r.notes, isCompleted: r.isCompleted,
        completedAt: r.completedAt, dueDate: r.dueDate, assigneeEmail: r.assigneeEmail,
        priority: r.priority, recurrence: r.recurrence, source: 'ai' as const,
        createdAt: r.dueDate ?? new Date().toISOString(),
      })),
  ], [tasks, reminders])

  // Shared context payload for the planning engine.
  const baseBody = useCallback(() => ({
    members, events, tasks: allTasks.filter((t) => !t.isCompleted), chores, plans, lists,
    profile, memories, personalProfile,
    goals: goals.filter((g) => g.active),
    reflections,
    currentUserEmail: user?.email ?? undefined,
    currentUserName: user?.displayName ?? undefined,
    now: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }), [members, events, allTasks, chores, plans, lists, profile, memories, personalProfile, goals, reflections, user])

  // Persist a set of items (with a headline) as today's plan doc, preserving
  // status. Items get stable ids so later toggles/edits address the right one.
  const savePlan = useCallback(async (
    items: DayPlanItem[],
    extra: Partial<DayPlan> = {},
  ) => {
    if (!planId || !user?.email) return
    const withIds = items.map((it) => ({ ...it, id: it.id || generateId() }))
    if (todayPlan) {
      await updatePlan({ ...todayPlan, ...extra, items: withIds, updatedAt: new Date().toISOString() })
    } else {
      await createPlan({
        id: planId, email: user.email, date, status: 'draft',
        items: withIds, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...extra,
      } as DayPlan)
    }
  }, [planId, user, todayPlan, updatePlan, createPlan, date])

  async function callEngine(body: unknown): Promise<{ headline?: string; reply?: string; items: DayPlanItem[] } | null> {
    const res = await fetch('/api/ai/plan-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Planner failed')
    return data
  }

  // Draft a fresh plan from the kickoff check-in.
  const draftPlan = useCallback(async (energy: MomentEnergy, intention?: string) => {
    setWorking(true); setError(null)
    try {
      const data = await callEngine({ ...baseBody(), mode: 'draft', energy, intention: intention?.trim() || undefined })
      if (!data) return
      const items = data.items.map((it) => ({ ...it, id: generateId() }))
      await savePlan(items, { status: 'draft', headline: data.headline, energy, intention: intention?.trim() || undefined })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planner failed')
    } finally { setWorking(false) }
  }, [baseBody, savePlan])

  // Refine the current draft from a chat instruction. Returns the AI's reply.
  const refinePlan = useCallback(async (message: string): Promise<string | null> => {
    if (!todayPlan) return null
    setWorking(true); setError(null)
    try {
      const data = await callEngine({ ...baseBody(), mode: 'refine', currentItems: todayPlan.items, message, energy: todayPlan.energy })
      if (!data) return null
      const items = data.items.map((it) => ({ ...it, id: generateId() }))
      await savePlan(items, { headline: data.headline || todayPlan.headline })
      return data.reply ?? 'Updated.'
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planner failed')
      return null
    } finally { setWorking(false) }
  }, [baseBody, savePlan, todayPlan])

  // Replan only the remaining (not-done) part of the day around the current
  // time. Completed items are preserved; the rest is rebuilt.
  const replanRest = useCallback(async (message?: string): Promise<string | null> => {
    if (!todayPlan) return null
    setWorking(true); setError(null)
    try {
      const data = await callEngine({ ...baseBody(), mode: 'replan', currentItems: todayPlan.items, message, energy: todayPlan.energy })
      if (!data) return null
      const done = todayPlan.items.filter((i) => i.done)
      const doneTitles = new Set(done.map((i) => i.title.toLowerCase()))
      const fresh = data.items
        .filter((i) => !i.done && !doneTitles.has(i.title.toLowerCase()))
        .map((it) => ({ ...it, id: generateId() }))
      await savePlan([...done, ...fresh], { status: 'active', headline: data.headline || todayPlan.headline })
      return data.reply ?? 'Replanned the rest of your day.'
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planner failed')
      return null
    } finally { setWorking(false) }
  }, [baseBody, savePlan, todayPlan])

  // Lock the draft in as the active plan for the day.
  const finalizePlan = useCallback(async () => {
    if (!todayPlan) return
    await updatePlan({ ...todayPlan, status: 'active', finalizedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  }, [todayPlan, updatePlan])

  // Track to completion: flip an item's done state. When all moves are done,
  // the plan flips to 'done'.
  const toggleItem = useCallback(async (itemId: string) => {
    if (!todayPlan) return
    const items = todayPlan.items.map((it) =>
      it.id === itemId ? { ...it, done: !it.done, doneAt: !it.done ? new Date().toISOString() : undefined } : it,
    )
    const allDone = items.every((it) => it.done)
    await updatePlan({ ...todayPlan, items, status: allDone ? 'done' : (todayPlan.status === 'draft' ? 'draft' : 'active'), updatedAt: new Date().toISOString() })
  }, [todayPlan, updatePlan])

  // Manual tap edits (draft stage): remove, add, reorder.
  const removeItem = useCallback(async (itemId: string) => {
    if (!todayPlan) return
    await updatePlan({ ...todayPlan, items: todayPlan.items.filter((it) => it.id !== itemId), updatedAt: new Date().toISOString() })
  }, [todayPlan, updatePlan])

  const addItem = useCallback(async (title: string) => {
    if (!todayPlan || !title.trim()) return
    const item: DayPlanItem = { id: generateId(), title: title.trim(), kind: 'move', done: false }
    await updatePlan({ ...todayPlan, items: [...todayPlan.items, item], updatedAt: new Date().toISOString() })
  }, [todayPlan, updatePlan])

  const moveItem = useCallback(async (itemId: string, dir: -1 | 1) => {
    if (!todayPlan) return
    const items = [...todayPlan.items]
    const i = items.findIndex((it) => it.id === itemId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= items.length) return
    ;[items[i], items[j]] = [items[j], items[i]]
    await updatePlan({ ...todayPlan, items, updatedAt: new Date().toISOString() })
  }, [todayPlan, updatePlan])

  // Throw the plan away and start over.
  const discardPlan = useCallback(async () => {
    if (planId) await removePlan(planId)
  }, [planId, removePlan])

  return {
    todayPlan,
    hasProfile: !!personalProfile,
    working, error,
    draftPlan, refinePlan, replanRest, finalizePlan,
    toggleItem, removeItem, addItem, moveItem, discardPlan,
  }
}
