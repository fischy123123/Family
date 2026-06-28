'use client'

import { useState, useCallback, useMemo } from 'react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { generateId } from '@/lib/utils'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  FamilyProfile, FamilyMemory, FamilyReminder,
  PersonalProfile, MomentEnergy, DayPlan, DayPlanItem, DayPlanStructure,
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

// A YYYY-MM-DD a given number of days from today (local).
export function dateStrOffset(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Human label for a YYYY-MM-DD (parsed as local midnight to avoid UTC shift).
function labelFor(dateStr: string): string {
  try {
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  } catch { return dateStr }
}

// Put a plan's items into true chronological order so anchors (calendar events)
// land in their real time slot instead of being bunched at the top. Timed items
// sort by their time; an untimed move inherits the time of the nearest timed
// item before it (so it follows that anchor) — or the next one if none precede —
// and ties break by the model's original order. Stable + deterministic. Exported
// so the UI can also sort at render time (covers plans saved before this logic).
export function sortByTime(items: DayPlanItem[]): DayPlanItem[] {
  const ms = items.map((it) => (it.startTime ? new Date(it.startTime).getTime() : NaN))
  const eff = ms.slice()
  // Forward-fill: an untimed item takes the previous known time.
  let last = NaN
  for (let i = 0; i < eff.length; i++) {
    if (!Number.isNaN(ms[i])) last = ms[i]
    else if (!Number.isNaN(last)) eff[i] = last
  }
  // Back-fill any leading untimed items from the next known time.
  let next = NaN
  for (let i = eff.length - 1; i >= 0; i--) {
    if (!Number.isNaN(ms[i])) next = ms[i]
    else if (Number.isNaN(eff[i]) && !Number.isNaN(next)) eff[i] = next
  }
  return items
    .map((it, i) => ({ it, i, t: Number.isNaN(eff[i]) ? Infinity : eff[i] }))
    .sort((a, b) => (a.t !== b.t ? a.t - b.t : a.i - b.i))
    .map((x) => x.it)
}

// The Command Center scans Gmail and caches the resulting signals under this
// per-family key. We read that cache so the planner sees the same email signals
// (deliveries, confirmations, appointment emails) the briefing already uses —
// without running its own scan. Degrades to [] when nothing's been scanned yet.
type CachedSignal = {
  title: string; date?: string | null; notes?: string
  sourceEmailSubject?: string; messageId?: string; forNames?: string[]
}
function readCachedInbox(familyId: string | null): CachedSignal[] {
  if (!familyId || typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(`fam-gmail-${familyId}`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    const inner = parsed && typeof parsed === 'object' && 'v' in parsed ? parsed.v : parsed
    const signals: CachedSignal[] = Array.isArray(inner) ? inner : (inner?.signals ?? [])
    return signals
      .filter((s) => s && s.title)
      .map((s) => ({
        title: s.title, date: s.date ?? undefined, notes: s.notes,
        sourceEmailSubject: s.sourceEmailSubject, messageId: s.messageId, forNames: s.forNames,
      }))
  } catch {
    return []
  }
}

// The Day Planner hook. Owns today's plan document (one per person per day):
// draft it with the AI, refine by chat, edit by tap, finalize, track to done,
// and replan the rest of the day when it slips. The plan persists in Firestore
// throughout, so it survives reloads and is the same on every device.
export function useDayPlan() {
  const { user } = useAuth()
  const { familyId } = useFamily()

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
  // Standing commitments + recent reflections — the "who we want to be" layer
  // the planner should translate into concrete moves for today.
  const { data: goals } = useFirestore<FamilyGoal>('goals')
  const { data: reflections } = useFirestore<Reflection>('reflections')
  const {
    data: dayPlans, create: createPlan, update: updatePlan, remove: removePlan,
  } = useFirestore<DayPlan>('dayPlans')

  const profile = profiles[0] ?? null
  const myKey = user?.email ? emailKey(user.email) : null
  // Which day is being planned. Defaults to today; can move to any future day.
  const [selectedDate, setSelectedDate] = useState(todayStr())
  const date = selectedDate
  const isToday = selectedDate === todayStr()
  const targetDateLabel = labelFor(selectedDate)
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

  // Anchors are calendar events — their time is owned by the calendar, NOT the
  // model. The model regularly re-emits an anchor's startTime wrong (re-timing
  // it or mangling the timezone), so after every engine response we force each
  // anchor's startTime back to its real CalendarEvent.start, matched by id (or
  // title as a fallback). This makes calendar times authoritative and immovable.
  const fixAnchorTimes = useCallback((list: DayPlanItem[]): DayPlanItem[] => {
    return list.map((it) => {
      if (it.kind !== 'anchor') return it
      const ev = (it.sourceId ? events.find((e) => e.id === it.sourceId) : undefined)
        ?? events.find((e) => e.title.trim().toLowerCase() === it.title.trim().toLowerCase())
      return ev?.start ? { ...it, startTime: ev.start } : it
    })
  }, [events])

  // Shared context payload for the planning engine.
  const baseBody = useCallback(() => ({
    members, events, tasks: allTasks.filter((t) => !t.isCompleted), chores, plans, lists,
    profile, memories, personalProfile,
    goals: goals.filter((g) => g.active),
    reflections,
    inbox: readCachedInbox(familyId),
    currentUserEmail: user?.email ?? undefined,
    currentUserName: user?.displayName ?? undefined,
    now: new Date().toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Which day to plan, and whether it's today (vs. a future day).
    targetDate: selectedDate,
    targetDateLabel,
    isToday,
  }), [members, events, allTasks, chores, plans, lists, profile, memories, personalProfile, goals, reflections, familyId, user, selectedDate, targetDateLabel, isToday])

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

  // Draft a fresh plan from the kickoff check-in. Energy is optional (for future
  // days, "how you'll feel" is a guess, so it's not required). Structure controls
  // how prescriptive the plan is (flexible vs. time-blocked) and is saved on it.
  const draftPlan = useCallback(async (
    energy?: MomentEnergy,
    intention?: string,
    structure: DayPlanStructure = 'flexible',
  ) => {
    setWorking(true); setError(null)
    try {
      const data = await callEngine({ ...baseBody(), mode: 'draft', energy, intention: intention?.trim() || undefined, structure })
      if (!data) return
      const items = sortByTime(fixAnchorTimes(data.items.map((it) => ({ ...it, id: generateId() }))))
      await savePlan(items, { status: 'draft', headline: data.headline, energy, intention: intention?.trim() || undefined, structure })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planner failed')
    } finally { setWorking(false) }
  }, [baseBody, savePlan, fixAnchorTimes])

  // Refine the current plan from a chat/feedback instruction.
  //  • No focusTitle (the global feedback box) = a SURGICAL edit: every existing
  //    item keeps its original time; only genuinely new items get a fresh one.
  //  • focusTitle set (per-card "reschedule this") = the model MAY re-time that
  //    item and shift its neighbors to make room; other items' model times are
  //    accepted so the day can reorganize around the change.
  // Either way, completed items are preserved verbatim and anchors snap back to
  // their real calendar times.
  const refinePlan = useCallback(async (message: string, focusTitle?: string): Promise<string | null> => {
    if (!todayPlan) return null
    setWorking(true); setError(null)
    try {
      const data = await callEngine({ ...baseBody(), mode: 'refine', currentItems: todayPlan.items, message, focusTitle, energy: todayPlan.energy, structure: todayPlan.structure })
      if (!data) return null
      const done = todayPlan.items.filter((i) => i.done)
      const doneTitles = new Set(done.map((i) => i.title.toLowerCase()))
      const reschedule = !!focusTitle
      const origByTitle = new Map(todayPlan.items.map((o) => [o.title.trim().toLowerCase(), o]))
      const fresh = data.items
        .filter((i) => !doneTitles.has(i.title.toLowerCase()))
        .map((it) => {
          // Surgical edit: pin existing items to their original times. Reschedule:
          // accept the model's times so it can reorganize around the change.
          if (reschedule) return { ...it, id: generateId() }
          const orig = origByTitle.get(it.title.trim().toLowerCase())
          return { ...it, id: generateId(), startTime: orig?.startTime ?? it.startTime }
        })
      const items = sortByTime(fixAnchorTimes([...done, ...fresh]))
      await savePlan(items, { headline: data.headline || todayPlan.headline })
      return data.reply ?? 'Updated.'
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planner failed')
      return null
    } finally { setWorking(false) }
  }, [baseBody, savePlan, todayPlan, fixAnchorTimes])

  // Replan only the remaining (not-done) part of the day around the current
  // time. Completed items are preserved; the rest is rebuilt.
  const replanRest = useCallback(async (message?: string): Promise<string | null> => {
    if (!todayPlan) return null
    setWorking(true); setError(null)
    try {
      const data = await callEngine({ ...baseBody(), mode: 'replan', currentItems: todayPlan.items, message, energy: todayPlan.energy, structure: todayPlan.structure })
      if (!data) return null
      const done = todayPlan.items.filter((i) => i.done)
      const doneTitles = new Set(done.map((i) => i.title.toLowerCase()))
      const fresh = data.items
        .filter((i) => !i.done && !doneTitles.has(i.title.toLowerCase()))
        .map((it) => ({ ...it, id: generateId() }))
      await savePlan(sortByTime(fixAnchorTimes([...done, ...fresh])), { status: 'active', headline: data.headline || todayPlan.headline })
      return data.reply ?? 'Replanned the rest of your day.'
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Planner failed')
      return null
    } finally { setWorking(false) }
  }, [baseBody, savePlan, todayPlan, fixAnchorTimes])

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

  // Persist an explicit item order/content (used by manual reordering, which
  // computes the swap with full display context — swapping times for timed
  // items or order for untimed ones).
  const applyItems = useCallback(async (items: DayPlanItem[]) => {
    if (!todayPlan) return
    await updatePlan({ ...todayPlan, items, updatedAt: new Date().toISOString() })
  }, [todayPlan, updatePlan])

  // Throw the plan away and start over.
  const discardPlan = useCallback(async () => {
    if (planId) await removePlan(planId)
  }, [planId, removePlan])

  // Save (or create) the signed-in person's profile — the "about me & my days"
  // editor writes through this. Same per-person doc the Moment Coach reads.
  const savePersonalProfile = useCallback(async (patch: Partial<PersonalProfile>) => {
    if (!user?.email || !myKey) return
    const next: PersonalProfile = {
      ...(personalProfile ?? { id: myKey, email: user.email }),
      ...patch, id: myKey, email: user.email, updatedAt: new Date().toISOString(),
    }
    if (personalProfile) await updateProfile(next)
    else await createProfile(next)
  }, [user, myKey, personalProfile, createProfile, updateProfile])

  return {
    plan: todayPlan,
    selectedDate, setSelectedDate, isToday, targetDateLabel,
    personalProfile,
    hasProfile: !!personalProfile,
    working, error,
    draftPlan, refinePlan, replanRest, finalizePlan,
    toggleItem, removeItem, addItem, applyItems, discardPlan,
    savePersonalProfile,
  }
}
