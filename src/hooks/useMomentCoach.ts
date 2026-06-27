'use client'

import { useState, useCallback, useMemo } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyReminder,
  PersonalProfile, MomentEnergy, MomentMood, MomentGuidance,
} from '@/lib/types'

// Sanitize an email into a safe, stable Firestore doc id (one profile per person).
function emailKey(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
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

  const profile = profiles[0] ?? null
  const myKey = user?.email ? emailKey(user.email) : null
  const personalProfile = useMemo(
    () => (myKey ? personalProfiles.find((p) => p.id === myKey) ?? null : null),
    [personalProfiles, myKey],
  )

  const [guidance, setGuidance] = useState<MomentGuidance | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  // Run the coach for the current moment. energy/mood come from the 2-tap
  // check-in. Returns the guidance (also stored in state) or null on failure.
  const requestGuidance = useCallback(async (
    energy: MomentEnergy,
    mood?: MomentMood,
  ): Promise<MomentGuidance | null> => {
    setLoading(true)
    setError(null)
    try {
      const openTasks = allTasks.filter((t) => !t.isCompleted)
      const completedToday = allTasks
        .filter((t) => t.isCompleted && isToday(t.completedAt))
        .map((t) => t.title)

      const res = await fetch('/api/ai/coach-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members, events, tasks: openTasks, chores, plans, lists,
          profile, memories,
          personalProfile,
          energy, mood, completedToday,
          currentUserEmail: user?.email ?? undefined,
          currentUserName: user?.displayName ?? undefined,
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Coach failed')
      setGuidance(data as MomentGuidance)
      return data as MomentGuidance
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Coach failed')
      return null
    } finally {
      setLoading(false)
    }
  }, [members, events, allTasks, chores, plans, lists, profile, memories, personalProfile, user])

  const clearGuidance = useCallback(() => setGuidance(null), [])

  return {
    personalProfile,
    hasProfile: !!personalProfile,
    savePersonalProfile,
    guidance, loading, error,
    requestGuidance, clearGuidance,
  }
}
