'use client'

export const dynamic = 'force-dynamic'

import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useCallback } from 'react'
import {
  ArrowLeft,
  Pencil,
  Sparkles,
  CheckSquare,
  Bell,
  MessageSquare,
  Heart,
  RefreshCw,
  Users,
  Repeat,
  Info,
  BookOpen,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { AppShell } from '@/components/layout/AppShell'
import { Button } from '@/components/ui/button'
import { generateId } from '@/lib/utils'
import type { FamilyMember, Task, Chore, FamilyMemory, FamilyProfile, CalendarEvent, FamilyReminder } from '@/lib/types'

// ── Types ──────────────────────────────────────────────────────

interface SupportSuggestion {
  title: string
  description: string
  actionType: 'task' | 'reminder' | 'copilot'
}

interface MemberBrief {
  isSelf: boolean
  narrative: string
  supports?: SupportSuggestion[]
  keyFacts?: string[]
  reflection?: string
}

// ── Page ───────────────────────────────────────────────────────

export default function MemberProfilePage() {
  const params = useParams()
  const memberId = params?.memberId as string | undefined
  const router = useRouter()
  const { user, loading: authLoading } = useAuth()

  const { data: members, loading: membersLoading } = useFirestore<FamilyMember>('members')
  const { data: rawTasks, loading: tasksLoading, create: createTask } = useFirestore<Task>('tasks')
  const { data: reminders, loading: remindersLoading } = useFirestore<FamilyReminder>('reminders')
  const { data: chores, loading: choresLoading } = useFirestore<Chore>('chores')
  const { data: memories, loading: memoriesLoading } = useFirestore<FamilyMemory>('memories')
  const { data: events } = useFirestore<CalendarEvent>('events')
  const { data: profiles } = useFirestore<FamilyProfile>('profile')

  // Merge reminders into tasks (same shape the attention engine uses) so
  // Copilot-created reminders appear in "What you're carrying".
  const tasks: Task[] = [
    ...rawTasks,
    ...reminders
      .filter((r) => !rawTasks.some((t) => t.id === r.id))
      .map((r): Task => ({
        id: r.id,
        title: r.title,
        notes: r.notes,
        isCompleted: r.isCompleted,
        completedAt: r.completedAt,
        dueDate: r.dueDate,
        assigneeId: r.assigneeId,
        assigneeEmail: r.assigneeEmail,
        priority: r.priority,
        recurrence: r.recurrence,
        source: 'ai' as const,
        createdAt: r.dueDate ?? new Date().toISOString(),
      })),
  ]

  const [brief, setBrief] = useState<MemberBrief | null>(null)
  const [briefLoading, setBriefLoading] = useState(false)
  const [briefError, setBriefError] = useState<string | null>(null)
  const [addedSupports, setAddedSupports] = useState<Set<number>>(new Set())

  const dataLoading = membersLoading || tasksLoading || choresLoading || memoriesLoading || remindersLoading

  useEffect(() => {
    if (!authLoading && !user) router.replace('/signin')
  }, [user, authLoading, router])

  const member = members.find((m) => m.id === memberId)
  const profile = profiles[0] ?? null

  const isViewingOwnProfile = member?.email?.toLowerCase() === user?.email?.toLowerCase()
  const memberTasks = tasks.filter((t) => {
    if (t.isCompleted) return false
    const explicitMatch = t.assigneeId === member?.id ||
      (t.assigneeEmail && member?.email && t.assigneeEmail.toLowerCase() === member.email.toLowerCase()) ||
      (member?.id && t.forIds?.includes(member.id))
    if (explicitMatch) return true
    // When viewing your own profile, also show tasks with no explicit assignee —
    // they're family tasks that fall to the signed-in user by default.
    if (isViewingOwnProfile && !t.assigneeId && !t.assigneeEmail) return true
    return false
  })

  const now = new Date()
  const in14Days = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
  const memberEvents = events.filter((e) => {
    const start = new Date(e.start)
    if (start < now || start > in14Days) return false
    if (e.ownerEmail && member?.email && e.ownerEmail.toLowerCase() === member.email.toLowerCase()) return true
    if (member?.id && e.forIds?.includes(member.id)) return true
    if (member?.id && e.assigneeId === member.id) return true
    if (member?.name && e.title.toLowerCase().includes(member.name.toLowerCase())) return true
    return false
  }).sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  const memberChores = chores.filter(
    (c) =>
      c.assigneeId === member?.id || c.assigneeEmail?.toLowerCase() === member?.email?.toLowerCase(),
  )

  const fetchBrief = useCallback(async () => {
    if (!member || !user) return
    setBriefLoading(true)
    setBriefError(null)
    try {
      const res = await fetch('/api/ai/member-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member,
          viewerEmail: user.email,
          tasks,
          chores,
          memories,
          events,
          profile,
          now: new Date().toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate brief')
      setBrief(data)
    } catch (e) {
      setBriefError(e instanceof Error ? e.message : 'Could not generate brief')
    } finally {
      setBriefLoading(false)
    }
  }, [member, user, tasks, chores, memories, events, profile])

  // Auto-fetch when data is ready
  useEffect(() => {
    if (!dataLoading && member && user && !brief && !briefLoading) {
      fetchBrief()
    }
  }, [dataLoading, member, user, brief, briefLoading, fetchBrief])

  async function handleSupportAction(support: SupportSuggestion, idx: number) {
    if (!user) return
    if (support.actionType === 'copilot') {
      try { sessionStorage.setItem('copilot-seed', `Help me support ${member?.name}: ${support.description}`) } catch { /* non-fatal */ }
      router.push('/')
      return
    }
    const task: Task = {
      id: generateId(),
      title: support.title,
      notes: support.description,
      isCompleted: false,
      priority: 'medium',
      source: 'ai',
      assigneeEmail: user.email ?? undefined,
      createdAt: new Date().toISOString(),
    }
    await createTask(task)
    setAddedSupports((prev) => new Set(prev).add(idx))
  }

  function openEdit() {
    try { sessionStorage.setItem('family-edit', memberId ?? '') } catch { /* non-fatal */ }
    router.push('/family')
  }

  const isSelf = brief?.isSelf ?? member?.email?.toLowerCase() === user?.email?.toLowerCase()

  if (authLoading || (membersLoading && !member)) {
    return (
      <AppShell>
        <div className="flex items-center justify-center min-h-[60vh]">
          <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      </AppShell>
    )
  }

  if (!member) {
    return (
      <AppShell>
        <div className="max-w-2xl mx-auto px-4 py-12 text-center">
          <p className="text-slate-500">Member not found.</p>
          <Button variant="outline" className="mt-4" onClick={() => router.push('/family')}>
            Back to Family
          </Button>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-5 animate-fade-in">
        {/* Nav */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => router.push('/family')}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors"
          >
            <ArrowLeft size={16} />
            Family
          </button>
          <Button variant="outline" size="sm" onClick={openEdit}>
            <Pencil size={14} className="mr-1.5" />
            Edit profile
          </Button>
        </div>

        {/* Hero header */}
        <div
          className="rounded-3xl p-6 flex items-center gap-5"
          style={{ backgroundColor: `${member.colorHex}18`, border: `1.5px solid ${member.colorHex}30` }}
        >
          <div
            className="h-20 w-20 rounded-full flex items-center justify-center text-4xl shrink-0 shadow-sm"
            style={{ backgroundColor: `${member.colorHex}30` }}
          >
            {member.emoji}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{member.name}</h1>
              {isSelf && (
                <span className="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-600 text-white">
                  YOU
                </span>
              )}
            </div>
            <p className="text-slate-500 capitalize mt-0.5">
              {member.species ?? member.role}
            </p>
            {member.summary && (
              <p className="text-sm text-slate-600 mt-1.5 italic">&ldquo;{member.summary}&rdquo;</p>
            )}
          </div>
        </div>

        {/* AI Narrative */}
        <NarrativeCard
          isSelf={isSelf}
          memberName={member.name}
          narrative={brief?.narrative ?? null}
          loading={briefLoading}
          error={briefError}
          onRefresh={fetchBrief}
        />

        {/* Support suggestions — other-member view only */}
        {!isSelf && (brief?.supports?.length ?? 0) > 0 && (
          <SupportCard
            memberName={member.name}
            supports={brief!.supports!}
            addedSupports={addedSupports}
            onAction={handleSupportAction}
          />
        )}

        {/* What they're carrying */}
        <CarryingCard
          isSelf={isSelf}
          memberName={member.name}
          tasks={memberTasks}
          chores={memberChores}
          events={memberEvents}
          color={member.colorHex}
        />

        {/* About — other view only */}
        {!isSelf && (brief?.keyFacts?.length ?? 0) > 0 && (
          <AboutCard
            memberName={member.name}
            keyFacts={brief!.keyFacts!}
            reflection={brief?.reflection}
            member={member}
          />
        )}

        {/* Footer nudge */}
        {!isSelf && (
          <p className="text-center text-xs text-slate-400 pb-4">
            Viewing {member.name}&apos;s profile ·{' '}
            <button
              onClick={() => router.push('/family')}
              className="underline hover:text-slate-600 transition-colors"
            >
              Back to Family
            </button>
          </p>
        )}
      </div>
    </AppShell>
  )
}

// ── Narrative card ─────────────────────────────────────────────

function NarrativeCard({
  isSelf,
  memberName,
  narrative,
  loading,
  error,
  onRefresh,
}: {
  isSelf: boolean
  memberName: string
  narrative: string | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  const heading = isSelf ? 'Your week at a glance' : `Where ${memberName} is right now`

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-gradient-to-br from-purple-100 to-blue-100 flex items-center justify-center">
            <Sparkles size={16} className="text-purple-600" />
          </div>
          <h2 className="font-bold text-slate-900 text-sm">{heading}</h2>
        </div>
        {!loading && (narrative || error) && (
          <button
            onClick={onRefresh}
            className="text-slate-400 hover:text-slate-600 transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw size={14} />
          </button>
        )}
      </div>

      {loading ? (
        <div className="space-y-2 animate-pulse">
          <div className="h-4 bg-slate-100 rounded-full w-full" />
          <div className="h-4 bg-slate-100 rounded-full w-5/6" />
          <div className="h-4 bg-slate-100 rounded-full w-4/6" />
        </div>
      ) : error ? (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">{error}</p>
          <Button size="sm" variant="outline" onClick={onRefresh}>
            Try again
          </Button>
        </div>
      ) : narrative ? (
        <p className="text-sm text-slate-700 leading-relaxed">{narrative}</p>
      ) : null}
    </div>
  )
}

// ── Support card ───────────────────────────────────────────────

const ACTION_META = {
  task: { icon: CheckSquare, label: 'Add to my tasks', color: 'text-blue-600 bg-blue-50 hover:bg-blue-100' },
  reminder: { icon: Bell, label: 'Remind me', color: 'text-amber-600 bg-amber-50 hover:bg-amber-100' },
  copilot: { icon: MessageSquare, label: 'Plan with AI', color: 'text-purple-600 bg-purple-50 hover:bg-purple-100' },
}

function SupportCard({
  memberName,
  supports,
  addedSupports,
  onAction,
}: {
  memberName: string
  supports: SupportSuggestion[]
  addedSupports: Set<number>
  onAction: (s: SupportSuggestion, idx: number) => void
}) {
  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="h-8 w-8 rounded-xl bg-pink-50 flex items-center justify-center">
          <Heart size={16} className="text-pink-500" />
        </div>
        <h2 className="font-bold text-slate-900 text-sm">How you can support {memberName}</h2>
      </div>

      <div className="space-y-3">
        {supports.map((s, idx) => {
          const meta = ACTION_META[s.actionType]
          const added = addedSupports.has(idx)
          return (
            <div
              key={idx}
              className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-slate-900">{s.title}</p>
                <p className="text-xs text-slate-500 mt-0.5 leading-snug">{s.description}</p>
              </div>
              <button
                onClick={() => !added && onAction(s, idx)}
                disabled={added}
                className={`shrink-0 flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                  added
                    ? 'bg-green-50 text-green-600 cursor-default'
                    : meta.color
                }`}
              >
                {added ? (
                  '✓ Done'
                ) : (
                  <>
                    <meta.icon size={13} />
                    {meta.label}
                  </>
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Carrying card ──────────────────────────────────────────────

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-red-500',
  medium: 'bg-amber-400',
  low: 'bg-green-400',
  none: 'bg-slate-200',
}

function CarryingCard({
  isSelf,
  memberName,
  tasks,
  chores,
  events,
  color,
}: {
  isSelf: boolean
  memberName: string
  tasks: Task[]
  chores: Chore[]
  events: CalendarEvent[]
  color: string
}) {
  const empty = tasks.length === 0 && chores.length === 0 && events.length === 0

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="h-8 w-8 rounded-xl bg-slate-50 flex items-center justify-center">
          <BookOpen size={16} className="text-slate-500" />
        </div>
        <h2 className="font-bold text-slate-900 text-sm">
          {isSelf ? "What you're carrying" : `What ${memberName} is carrying`}
        </h2>
      </div>

      {empty ? (
        <p className="text-sm text-slate-400">Nothing on the list right now — a good sign!</p>
      ) : (
        <div className="space-y-4">
          {tasks.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Tasks</p>
              <ul className="space-y-2">
                {tasks.slice(0, 8).map((t) => (
                  <li key={t.id} className="flex items-start gap-2.5">
                    <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${PRIORITY_DOT[t.priority] ?? 'bg-slate-200'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 leading-snug">{t.title}</p>
                      {t.dueDate && (
                        <p className="text-xs text-slate-400 mt-0.5">
                          Due {new Date(t.dueDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
                {tasks.length > 8 && (
                  <li className="text-xs text-slate-400 pl-4.5">+{tasks.length - 8} more</li>
                )}
              </ul>
            </div>
          )}

          {events.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Upcoming events</p>
              <ul className="space-y-2">
                {events.slice(0, 6).map((e) => (
                  <li key={e.id} className="flex items-start gap-2.5">
                    <span className="mt-1.5 h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: e.color || color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-slate-800 leading-snug truncate">{e.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {e.isAllDay
                          ? new Date(e.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                          : new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {chores.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Recurring chores</p>
              <ul className="space-y-2">
                {chores.map((c) => (
                  <li key={c.id} className="flex items-center gap-2.5">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: c.colorHex || color }}
                    />
                    <p className="text-sm text-slate-800 flex-1 truncate">{c.name}</p>
                    <span className="flex items-center gap-1 text-xs text-slate-400 shrink-0">
                      <Repeat size={11} />
                      {c.recurrence?.frequency ?? 'recurring'}
                      {c.streak > 1 && (
                        <span className="ml-1 text-orange-500 font-medium">🔥{c.streak}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── About card ─────────────────────────────────────────────────

function AboutCard({
  memberName,
  keyFacts,
  reflection,
  member,
}: {
  memberName: string
  keyFacts: string[]
  reflection?: string
  member: FamilyMember
}) {
  const hasProfile =
    (member.routines?.length ?? 0) > 0 ||
    (member.preferences?.length ?? 0) > 0 ||
    (member.importantInfo?.length ?? 0) > 0

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <div className="h-8 w-8 rounded-xl bg-amber-50 flex items-center justify-center">
          <Info size={16} className="text-amber-500" />
        </div>
        <h2 className="font-bold text-slate-900 text-sm">About {memberName}</h2>
      </div>

      <ul className="space-y-2 mb-4">
        {keyFacts.map((fact, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
            <p className="text-sm text-slate-700 leading-snug">{fact}</p>
          </li>
        ))}
      </ul>

      {reflection && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <p className="text-sm text-slate-500 italic leading-relaxed">{reflection}</p>
        </div>
      )}

      {hasProfile && (
        <div className="mt-3 pt-3 border-t border-slate-100">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <Users size={12} />
            <span>Full profile in</span>
            <button
              onClick={() => {
                try { sessionStorage.setItem('family-edit', member.id) } catch { /* non-fatal */ }
                window.location.href = '/family'
              }}
              className="underline hover:text-slate-600 transition-colors"
            >
              Family settings
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
