'use client'

import { useState, useCallback } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { generateId } from '@/lib/utils'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyReminder,
  FamilyGoal, Reflection, CoachingInsight,
} from '@/lib/types'

interface CoachSummaryDoc {
  id: string
  summary: string
  weekOf: string
  generatedAt: string
}

// Central hook for the life-coaching layer. Reads goals, reflections, insights
// and the latest summary from Firestore, and can run the coaching engine on
// demand (gathering full family context, including past calendar history).
export function useCoaching() {
  const { user } = useAuth()
  const { isConnected, getFreshTokens } = useGoogleTokens()

  const { data: members } = useFirestore<FamilyMember>('members')
  const { data: events } = useFirestore<CalendarEvent>('events')
  const { data: tasks } = useFirestore<Task>('tasks')
  const { data: reminders } = useFirestore<FamilyReminder>('reminders')
  const { data: chores } = useFirestore<Chore>('chores')
  const { data: plans } = useFirestore<Plan>('plans')
  const { data: lists } = useFirestore<SmartList>('lists')
  const { data: memories } = useFirestore<FamilyMemory>('memories')
  const { data: profiles } = useFirestore<FamilyProfile>('profile')

  const {
    data: goals, create: createGoal, update: updateGoalDoc, remove: removeGoalDoc,
  } = useFirestore<FamilyGoal>('goals')
  const {
    data: reflections, create: createReflection,
  } = useFirestore<Reflection>('reflections')
  const {
    data: insights, create: createInsight, update: updateInsight, remove: removeInsight,
  } = useFirestore<CoachingInsight>('insights')
  const {
    data: summaryDocs, create: createSummary, update: updateSummary,
  } = useFirestore<CoachSummaryDoc>('coachSummary')

  const profile = profiles[0] ?? null
  const summary = summaryDocs.find((s) => s.id === 'latest') ?? null

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Merge legacy reminders into the task stream so the coach sees everything.
  const allTasks: Task[] = [
    ...tasks,
    ...reminders
      .filter((r) => !tasks.some((t) => t.id === r.id))
      .map((r) => ({
        id: r.id, title: r.title, notes: r.notes, isCompleted: r.isCompleted,
        completedAt: r.completedAt, dueDate: r.dueDate, assigneeEmail: r.assigneeEmail,
        priority: r.priority, recurrence: r.recurrence, source: 'ai' as const,
        createdAt: r.dueDate ?? new Date().toISOString(),
      })),
  ]

  const generate = useCallback(async () => {
    setGenerating(true)
    setError(null)
    try {
      // Pull ~45 days of past calendar history for pattern detection, if connected.
      let pastEvents: CalendarEvent[] = events
      if (isConnected) {
        const fresh = await getFreshTokens()
        if (fresh) {
          const timeMin = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString()
          const timeMax = new Date().toISOString()
          try {
            const res = await fetch(
              `/api/calendar/events?accessToken=${encodeURIComponent(fresh.accessToken)}&refreshToken=${encodeURIComponent(fresh.refreshToken)}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
            )
            const data = await res.json()
            if (res.ok && Array.isArray(data.events)) {
              pastEvents = [...events, ...(data.events as CalendarEvent[])]
            }
          } catch { /* fall back to whatever events we have */ }
        }
      }

      const res = await fetch('/api/ai/coach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members, events, tasks: allTasks.filter((t) => !t.isCompleted),
          chores, plans, lists, profile, memories,
          goals, reflections,
          recentInsights: insights,
          pastEvents,
          completedTasks: allTasks.filter((t) => t.isCompleted),
          currentUserEmail: user?.email ?? undefined,
          currentUserName: user?.displayName ?? undefined,
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Coaching failed')

      // Persist the fresh insights, replacing this week's previous batch so the
      // view doesn't accumulate duplicates from repeated manual runs.
      const newInsights = (data.insights ?? []) as CoachingInsight[]
      const thisWeek = newInsights[0]?.weekOf
      if (thisWeek) {
        await Promise.all(
          insights
            .filter((i) => i.weekOf === thisWeek)
            .map((i) => removeInsight(i.id)),
        )
      }
      await Promise.all(
        newInsights.map((it) => createInsight(it as CoachingInsight))
      )

      // Save the summary headline.
      if (data.summary) {
        const payload = {
          summary: data.summary as string,
          weekOf: thisWeek ?? new Date().toISOString(),
          generatedAt: data.generatedAt ?? new Date().toISOString(),
        }
        if (summary) {
          await updateSummary({ id: 'latest', ...payload })
        } else {
          await createSummary({ id: 'latest', ...payload } as CoachSummaryDoc)
        }
      }
      return newInsights
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Coaching failed')
      return []
    } finally {
      setGenerating(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, events, tasks, reminders, chores, plans, lists, profile, memories, goals, reflections, insights, isConnected, user])

  const dismissInsight = useCallback((i: CoachingInsight) => {
    return updateInsight({ ...i, dismissed: true })
  }, [updateInsight])

  const acknowledgeInsight = useCallback((i: CoachingInsight) => {
    return updateInsight({ ...i, acknowledged: true })
  }, [updateInsight])

  const addGoal = useCallback((g: Omit<FamilyGoal, 'id' | 'createdAt'>) => {
    return createGoal({
      ...g, id: generateId(), createdAt: new Date().toISOString(),
    } as FamilyGoal)
  }, [createGoal])

  const addReflection = useCallback((r: Omit<Reflection, 'id' | 'createdAt' | 'authorEmail'>) => {
    return createReflection({
      ...r, id: generateId(), authorEmail: user?.email ?? undefined,
      createdAt: new Date().toISOString(),
    } as Reflection)
  }, [createReflection, user])

  return {
    goals, reflections, insights, summary,
    generating, error,
    generate, dismissInsight, acknowledgeInsight,
    addGoal, updateGoal: updateGoalDoc, removeGoal: removeGoalDoc,
    addReflection,
  }
}
