'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  RefreshCw, AlertTriangle, Lightbulb, Clock, ChevronRight,
  Calendar as CalIcon, Sparkles, Check, HelpCircle, X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { useCapture } from '@/contexts/CaptureContext'
import { useFamily } from '@/contexts/FamilyContext'
import { ConnectGooglePrompt } from '@/components/dashboard/ConnectGooglePrompt'
import { BUCKET_META } from '@/lib/types'
import type {
  FamilyMember, CalendarEvent, Task, Chore, Plan, SmartList,
  AttentionReport, AttentionItem, AttentionBucket,
} from '@/lib/types'

type CalendarClarification = {
  id: string
  eventId: string
  eventTitle: string
  eventDate: string
  question: string
  hint: string
}

const BUCKET_ORDER: AttentionBucket[] = ['now', 'next', 'later', 'upcoming']

export function CommandCenter() {
  const router = useRouter()
  const { user } = useAuth()
  const { open: openCapture } = useCapture()
  const { isConnected, getFreshTokens } = useGoogleTokens()
  const { familyId } = useFamily()

  const { data: members } = useFirestore<FamilyMember>('members')
  const { data: localEvents } = useFirestore<CalendarEvent>('events')
  const { data: tasks, update: updateTask } = useFirestore<Task>('tasks')
  const { data: chores } = useFirestore<Chore>('chores')
  const { data: plans } = useFirestore<Plan>('plans')
  const { data: lists } = useFirestore<SmartList>('lists')

  const [report, setReport] = useState<AttentionReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [googleEvents, setGoogleEvents] = useState<CalendarEvent[]>([])
  const lastRun = useRef<number>(0)
  const [clarifications, setClarifications] = useState<CalendarClarification[]>([])
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [clarificationsSubmitted, setClarificationsSubmitted] = useState(false)
  const clarificationsFetched = useRef(false)

  // Fetch Google Calendar events when connected
  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!isConnected) { setGoogleEvents([]); return }
      const fresh = await getFreshTokens()
      if (!fresh || cancelled) return
      const timeMin = new Date().toISOString()
      const timeMax = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      try {
        const res = await fetch(
          `/api/calendar/events?accessToken=${encodeURIComponent(fresh.accessToken)}&refreshToken=${encodeURIComponent(fresh.refreshToken)}&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
        )
        const data = await res.json()
        if (!cancelled && res.ok) {
          const loadedEvents: CalendarEvent[] = (data.events ?? []).map((e: CalendarEvent) => ({
            ...e,
            ownerEmail: e.ownerEmail || user?.email || '',
          }))
          setGoogleEvents(loadedEvents)

          // Fetch calendar clarifications once per session
          if (loadedEvents.length > 0 && !clarificationsFetched.current) {
            clarificationsFetched.current = true
            try {
              const ctxRes = await fetch('/api/ai/calendar-context', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: loadedEvents, members, now: new Date().toISOString() }),
              })
              const ctxData = await ctxRes.json()
              if (!cancelled && ctxRes.ok && ctxData.clarifications?.length > 0) {
                setClarifications(ctxData.clarifications)
              }
            } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected])

  const events = isConnected ? googleEvents : localEvents

  const runEngine = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/ai/attention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          members, events, tasks, chores, plans, lists,
          now: new Date().toISOString(),
        }),
      })
      const data = await res.json()
      if (res.ok) setReport(data)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }, [members, events, tasks, chores, plans, lists])

  // Auto-run once data is loaded (and re-run at most every 60s)
  useEffect(() => {
    const now = Date.now()
    if (members.length === 0 && events.length === 0 && tasks.length === 0) return
    if (now - lastRun.current < 60000 && report) return
    lastRun.current = now
    runEngine()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members.length, events.length, tasks.length, googleEvents.length])

  async function completeTaskFromItem(item: AttentionItem) {
    if (item.sourceType !== 'task' || !item.sourceId) return
    const t = tasks.find((x) => x.id === item.sourceId)
    if (t) await updateTask({ ...t, isCompleted: true, completedAt: new Date().toISOString() })
  }

  const firstName = user?.displayName?.split(' ')[0] ?? 'there'
  const todayEvents = events
    .filter((e) => new Date(e.start).toDateString() === new Date().toDateString())
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

  const itemsByBucket = (b: AttentionBucket) => (report?.items ?? []).filter((i) => i.bucket === b)

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-slate-400">
            {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
          <h1 className="text-2xl sm:text-3xl font-bold text-slate-900 tracking-tight">
            Good {greeting()}, {firstName}
          </h1>
        </div>
        <button
          onClick={runEngine}
          disabled={loading}
          className="mt-1 p-2.5 rounded-xl bg-white border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shadow-card"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {!isConnected && <ConnectGooglePrompt onConnect={() => router.push(`/api/auth/google?email=${user?.email ?? ''}`)} />}

      {/* AI greeting / briefing line */}
      {report?.greeting && (
        <div className="rounded-2xl p-5 bg-gradient-to-br from-blue-600 to-purple-700 text-white shadow-elevated animate-scale-in">
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
            <p className="text-[15px] leading-relaxed font-medium">{report.greeting}</p>
          </div>
        </div>
      )}

      {/* Calendar Intelligence — clarification requests */}
      {clarifications.length > 0 && !clarificationsSubmitted && (
        <section className="rounded-2xl p-5 bg-amber-50 border border-amber-200 animate-slide-up">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <HelpCircle size={16} className="text-amber-600" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-amber-900">Help me understand your calendar</h3>
              <p className="text-xs text-amber-700 mt-0.5">A few events could use more context so I can give better guidance.</p>
            </div>
            <button
              onClick={() => setClarificationsSubmitted(true)}
              className="ml-auto text-amber-400 hover:text-amber-600"
              aria-label="Dismiss"
            >
              <X size={16} />
            </button>
          </div>
          <div className="space-y-3">
            {clarifications.map((c) => (
              <div key={c.id} className="bg-white rounded-xl p-3 border border-amber-100">
                <p className="text-xs font-medium text-slate-700 mb-1">
                  📅 {c.eventTitle} · {new Date(c.eventDate).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                </p>
                <p className="text-xs text-slate-500 mb-2">{c.question}</p>
                <input
                  placeholder={c.hint}
                  value={clarificationAnswers[c.id] ?? ''}
                  onChange={(e) => setClarificationAnswers((prev) => ({ ...prev, [c.id]: e.target.value }))}
                  className="w-full text-xs rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-blue-300 bg-slate-50"
                />
              </div>
            ))}
          </div>
          <button
            onClick={async () => {
              if (familyId) {
                const { doc, setDoc } = await import('firebase/firestore')
                const { db } = await import('@/lib/firebase')
                await Promise.all(
                  clarifications
                    .filter((c) => clarificationAnswers[c.id]?.trim())
                    .map((c) =>
                      setDoc(doc(db, 'families', familyId, 'eventContext', c.eventId), {
                        eventTitle: c.eventTitle,
                        context: clarificationAnswers[c.id],
                        savedAt: new Date().toISOString(),
                      })
                    )
                )
              }
              setClarificationsSubmitted(true)
              runEngine()
            }}
            className="w-full mt-3 py-2 rounded-xl text-xs font-semibold text-amber-900 bg-amber-100 hover:bg-amber-200 transition-colors"
          >
            Save context &amp; refresh
          </button>
        </section>
      )}

      {/* Loading skeleton */}
      {loading && !report && (
        <div className="space-y-3">
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
          <div className="skeleton h-24 w-full" />
        </div>
      )}

      {/* NEXT UP */}
      {report && (report.items?.length ?? 0) > 0 && (
        <section>
          <SectionLabel icon={Clock} color="#0f172a">Next Up</SectionLabel>
          <div className="space-y-4">
            {BUCKET_ORDER.map((bucket) => {
              const items = itemsByBucket(bucket)
              if (items.length === 0) return null
              const meta = BUCKET_META[bucket]
              return (
                <div key={bucket}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                    <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: meta.color }}>
                      {meta.label}
                    </span>
                  </div>
                  <div className="space-y-2 stagger-children">
                    {items.map((item) => (
                      <AttentionCard
                        key={item.id}
                        item={item}
                        accent={meta.color}
                        member={members.find((m) => m.email === item.assigneeEmail)}
                        onComplete={() => completeTaskFromItem(item)}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* POTENTIAL PROBLEMS */}
      {report && (report.problems?.length ?? 0) > 0 && (
        <section>
          <SectionLabel icon={AlertTriangle} color="#dc2626">Potential Problems</SectionLabel>
          <div className="space-y-2 stagger-children">
            {report.problems.map((p) => (
              <div
                key={p.id}
                className="rounded-2xl p-4 bg-white shadow-card animate-slide-up"
                style={{ borderLeft: `3px solid ${p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#f97316' : '#eab308'}` }}
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-slate-900">{p.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{p.detail}</p>
                    {p.suggestedAction && (
                      <p className="text-xs text-blue-600 mt-1.5 font-medium">→ {p.suggestedAction}</p>
                    )}
                  </div>
                  <span
                    className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full shrink-0"
                    style={{
                      background: p.severity === 'high' ? '#fee2e2' : p.severity === 'medium' ? '#ffedd5' : '#fef9c3',
                      color: p.severity === 'high' ? '#dc2626' : p.severity === 'medium' ? '#ea580c' : '#a16207',
                    }}
                  >
                    {p.severity}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* COPILOT RECOMMENDATIONS */}
      {report && (report.recommendations?.length ?? 0) > 0 && (
        <section>
          <SectionLabel icon={Lightbulb} color="#7c3aed">Copilot Recommendations</SectionLabel>
          <div className="space-y-2 stagger-children">
            {report.recommendations.map((r) => (
              <div key={r.id} className="rounded-2xl p-4 bg-white shadow-card animate-slide-up flex items-start gap-3">
                <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                  <Lightbulb size={15} className="text-purple-500" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-900">{r.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{r.rationale}</p>
                </div>
                {r.actionLabel && (
                  <button
                    onClick={openCapture}
                    className="text-xs font-medium text-purple-600 hover:text-purple-700 shrink-0 mt-0.5"
                  >
                    {r.actionLabel}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* TODAY */}
      <section>
        <SectionLabel icon={CalIcon} color="#0f172a">Today</SectionLabel>
        {todayEvents.length === 0 ? (
          <div className="rounded-2xl p-6 bg-white shadow-card text-center">
            <p className="text-sm text-slate-400">Nothing scheduled today.</p>
            <button onClick={openCapture} className="text-xs text-blue-600 font-medium mt-1">Capture something →</button>
          </div>
        ) : (
          <div className="rounded-2xl bg-white shadow-card divide-y divide-slate-50 overflow-hidden">
            {todayEvents.map((e) => (
              <div key={e.id} className="flex items-center gap-3 p-4">
                <div className="text-center w-12 shrink-0">
                  {e.isAllDay ? (
                    <span className="text-[10px] text-slate-400 font-medium uppercase">All day</span>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-slate-700">
                        {new Date(e.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(' ', '')}
                      </p>
                    </>
                  )}
                </div>
                <span className="w-1 self-stretch rounded-full" style={{ background: e.color || '#3B82F6' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-900 truncate">{e.title}</p>
                  {e.location && <p className="text-xs text-slate-400 truncate">{e.location}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Empty-state nudge */}
      {report && (report.items?.length ?? 0) === 0 && (report.problems?.length ?? 0) === 0 && (
        <div className="rounded-2xl p-8 bg-white shadow-card text-center">
          <div className="text-4xl mb-3">🌤️</div>
          <p className="text-sm font-medium text-slate-700">You&apos;re all clear.</p>
          <p className="text-xs text-slate-400 mt-1">Nothing needs your attention right now.</p>
        </div>
      )}
    </div>
  )
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 18) return 'afternoon'
  return 'evening'
}

function SectionLabel({ icon: Icon, color, children }: { icon: typeof Clock; color: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon size={16} style={{ color }} />
      <h2 className="text-base font-bold text-slate-900">{children}</h2>
    </div>
  )
}

function AttentionCard({
  item, accent, member, onComplete,
}: {
  item: AttentionItem
  accent: string
  member?: FamilyMember
  onComplete: () => void
}) {
  const [done, setDone] = useState(false)
  const startStr = item.startBy
    ? new Date(item.startBy).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  return (
    <div
      className="rounded-2xl p-4 bg-white shadow-card animate-slide-up flex items-start gap-3 transition-opacity"
      style={{ borderLeft: `3px solid ${accent}`, opacity: done ? 0.5 : 1 }}
    >
      {item.sourceType === 'task' && (
        <button
          onClick={() => { setDone(true); onComplete() }}
          className="mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors"
          style={{ borderColor: done ? '#22c55e' : '#cbd5e1', background: done ? '#22c55e' : 'transparent' }}
        >
          {done && <Check size={12} className="text-white" />}
        </button>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-900">{item.title}</p>
        <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.reason}</p>
        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
          {startStr && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: `${accent}15`, color: accent }}>
              <Clock size={10} /> Start by {startStr}
            </span>
          )}
          {member && (
            <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
              <span className="w-4 h-4 rounded-full flex items-center justify-center text-[9px]" style={{ background: `${member.colorHex}25` }}>
                {member.emoji}
              </span>
              {member.name}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
