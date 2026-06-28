'use client'

import { useState, useCallback, useMemo, useRef } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { generateId } from '@/lib/utils'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyReminder,
  PersonalProfile, MomentEnergy, MomentMood, MomentGuidance, MomentCheckIn, DayPlan,
} from '@/lib/types'

// Sanitize an email into a safe, stable Firestore doc id (one profile per person).
function emailKey(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
}

// Local YYYY-MM-DD (the user's day, not UTC) — matches the Day Planner's key.
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function isToday(iso?: string): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate()
}

// The Moment Coach hook. Owns the signed-in person's PersonalProfile (read +
// save) and runs the in-the-moment coaching engine on demand, gathering the
// same family context the attention engine uses plus the current check-in.
export function useMomentCoach() {
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
  const {
    data: personalProfiles, create: createProfile, update: updateProfile,
  } = useFirestore<PersonalProfile>('personalProfiles')
  const {
    data: checkins, create: createCheckin, update: updateCheckin,
  } = useFirestore<MomentCheckIn>('momentCheckins')
  const { data: dayPlans } = useFirestore<DayPlan>('dayPlans')

  const profile = profiles[0] ?? null
  const myKey = user?.email ? emailKey(user.email) : null
  const myEmail = user?.email?.toLowerCase() ?? null
  // Today's plan, if one exists — the backbone the moment-coach reasons against.
  const todayPlan = useMemo(
    () => (myKey ? dayPlans.find((p) => p.id === `${myKey}_${todayStr()}`) ?? null : null),
    [dayPlans, myKey],
  )
  const personalProfile = useMemo(
    () => (myKey ? personalProfiles.find((p) => p.id === myKey) ?? null : null),
    [personalProfiles, myKey],
  )

  // This person's check-in log, newest first — the trending data.
  const myCheckins = useMemo(
    () => checkins
      .filter((c) => !c.email || c.email.toLowerCase() === myEmail)
      .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()),
    [checkins, myEmail],
  )

  const [guidance, setGuidance] = useState<MomentGuidance | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The id of the check-in logged for the current guidance, so "I did it" /
  // "moved past it" can record the outcome against the right entry.
  const lastCheckinId = useRef<string | null>(null)

  // Merge legacy reminders into the task stream so the coach sees everything,
  // mirroring how the attention engine and life coach build their task list.
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

  // Persist (or update) the signed-in person's profile. Accepts a partial so the
  // quick setup and later refinements can both write through it.
  const savePersonalProfile = useCallback(async (patch: Partial<PersonalProfile>) => {
    if (!user?.email || !myKey) return
    const next: PersonalProfile = {
      ...(personalProfile ?? { id: myKey, email: user.email }),
      ...patch,
      id: myKey,
      email: user.email,
      updatedAt: new Date().toISOString(),
    }
    if (personalProfile) {
      await updateProfile(next)
    } else {
      await createProfile(next)
    }
  }, [user?.email, myKey, personalProfile, createProfile, updateProfile])

  // Run the coach for the current moment. energy/mood/situation come from the
  // check-in. Logs the check-in (trending data) and feeds recent ones back as
  // trend context. Returns the guidance (also stored in state) or null.
  const requestGuidance = useCallback(async (
    energy: MomentEnergy,
    mood?: MomentMood,
    situation?: string,
  ): Promise<MomentGuidance | null> => {
    setLoading(true)
    setError(null)

    // Persist the check-in immediately — it's the user's input and worth keeping
    // even if the AI call fails. Fire-and-forget so it never blocks guidance.
    const checkinId = generateId()
    lastCheckinId.current = checkinId
    const cleanSituation = situation?.trim() || undefined
    if (user?.email) {
      createCheckin({
        id: checkinId,
        email: user.email,
        ts: new Date().toISOString(),
        energy,
        mood,
        situation: cleanSituation,
      } as MomentCheckIn).catch(() => { /* non-fatal */ })
    }

    try {
      const openTasks = allTasks.filter((t) => !t.isCompleted)
      const completedToday = allTasks
        .filter((t) => t.isCompleted && isToday(t.completedAt))
        .map((t) => t.title)
      // Pass the recent log (excluding the just-created entry) as trend context.
      const recentCheckins = myCheckins.slice(0, 12)

      const res = await fetch('/api/ai/coach-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members, events, tasks: openTasks, chores, plans, lists,
          profile, memories,
          personalProfile,
          energy, mood, situation: cleanSituation, completedToday, recentCheckins,
          dayPlan: todayPlan ? { headline: todayPlan.headline, status: todayPlan.status, items: todayPlan.items } : undefined,
          currentUserEmail: user?.email ?? undefined,
          currentUserName: user?.displayName ?? undefined,
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Coach failed')
      // Record which move was suggested against the check-in, for follow-through.
      if (user?.email && data?.primary?.title) {
        updateCheckin({
          id: checkinId, email: user.email, ts: new Date().toISOString(),
          energy, mood, situation: cleanSituation, primaryTitle: data.primary.title,
        } as MomentCheckIn).catch(() => { /* non-fatal */ })
      }
      setGuidance(data as MomentGuidance)
      return data as MomentGuidance
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Coach failed')
      return null
    } finally {
      setLoading(false)
    }
  }, [members, events, allTasks, chores, plans, lists, profile, memories, personalProfile, myCheckins, todayPlan, createCheckin, updateCheckin, user])

  // Record what happened with the last suggestion, against its check-in entry.
  const recordOutcome = useCallback((outcome: 'did_it' | 'dismissed') => {
    const id = lastCheckinId.current
    if (!id) return
    const existing = checkins.find((c) => c.id === id)
    if (!existing) return
    updateCheckin({ ...existing, outcome }).catch(() => { /* non-fatal */ })
  }, [checkins, updateCheckin])

  const clearGuidance = useCallback(() => setGuidance(null), [])

  return {
    personalProfile,
    hasProfile: !!personalProfile,
    savePersonalProfile,
    checkins: myCheckins,
    guidance, loading, error,
    requestGuidance, recordOutcome, clearGuidance,
  }
}
