'use client'

import { useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Compass, Sparkles, RefreshCw, Plus, Trash2, Target, X, Check, PenLine, Send,
  ChevronDown, ChevronUp, Wand2, Bot, Loader2,
} from 'lucide-react'
import { InsightCardWithThread } from './InsightCardWithThread'
import { Markdown } from '@/components/ui/Markdown'
import { useCoaching } from '@/hooks/useCoaching'
import { useFirestore } from '@/hooks/useFirestore'
import { useCapture } from '@/contexts/CaptureContext'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useGoogleTokens } from '@/hooks/useGoogleTokens'
import { generateId } from '@/lib/utils'
import { LIFE_AREAS } from '@/lib/types'
import type { LifeArea, CoachingInsight, FamilyMemory } from '@/lib/types'

function startOfWeekISO(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

export function CoachView() {
  const router = useRouter()
  const { open: openCapture } = useCapture()
  const { user } = useAuth()
  const { familyId } = useFamily()
  const { getFreshTokens } = useGoogleTokens()
  const { create: createMemory } = useFirestore<FamilyMemory>('memories')
  const {
    goals, reflections, insights, summary, generating, error,
    generate, dismissInsight, acknowledgeInsight,
    addGoal, removeGoal, addReflection,
  } = useCoaching()

  const [showGoalForm, setShowGoalForm] = useState(false)
  const [showReflection, setShowReflection] = useState(false)
  const [goalsExpanded, setGoalsExpanded] = useState(false)
  const [showRefine, setShowRefine] = useState(false)
  const [refineThread, setRefineThread] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [refineInput, setRefineInput] = useState('')
  const [refineLoading, setRefineLoading] = useState(false)
  const [quickNote, setQuickNote] = useState('')
  const [noteSaved, setNoteSaved] = useState(false)
  const noteRef = useRef<HTMLInputElement>(null)
  const refineInputRef = useRef<HTMLTextAreaElement>(null)
  const refineScrollRef = useRef<HTMLDivElement>(null)

  const week = startOfWeekISO()
  const activeInsights = insights
    .filter((i) => !i.dismissed)
    .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  const reflectedThisWeek = reflections.some((r) => r.weekOf === week)

  async function saveQuickNote() {
    const note = quickNote.trim()
    if (!note) return
    await createMemory({
      id: generateId(),
      text: `Coach context: ${note}`,
      category: 'other',
      source: 'ai',
      createdAt: new Date().toISOString(),
    })
    setQuickNote('')
    setNoteSaved(true)
    setTimeout(() => setNoteSaved(false), 4000)
  }

  function handleAction(insight: CoachingInsight) {
    if (insight.actionType === 'capture' && insight.suggestedAction) {
      openCapture({ text: `${insight.title}. ${insight.suggestedAction}`, autoAnalyze: true })
    } else if (insight.actionType === 'goal') {
      setShowGoalForm(true)
    }
  }

  async function openRefine() {
    if (showRefine) { setShowRefine(false); return }
    const goalList = goals.map((g) => {
      const area = LIFE_AREAS.find((a) => a.area === g.area)
      return `• ${area?.emoji ?? '🎯'} ${g.text}${g.cadence ? ` (${g.cadence})` : ''}${g.why ? ` — ${g.why}` : ''}`
    }).join('\n')
    const opener = goals.length === 0
      ? `You haven't set any standing commitments yet. Tell me what you'd most like to protect or improve as a family, and I'll help you shape it into a clear commitment.`
      : `Here are your current standing commitments:\n\n${goalList}\n\nI can help you refine these — making them more specific, removing ones that no longer resonate, adjusting the cadence, or filling in important gaps. What would you like to work on?`
    setRefineThread([{ role: 'assistant', content: opener }])
    setShowRefine(true)
    setGoalsExpanded(true)
    setTimeout(() => refineInputRef.current?.focus(), 80)
  }

  async function sendRefineMessage() {
    const content = refineInput.trim()
    if (!content || refineLoading || !familyId || !user?.email) return

    const userMsg = { role: 'user' as const, content }
    setRefineThread((prev) => [...prev, userMsg])
    setRefineInput('')
    setRefineLoading(true)

    try {
      const freshTokens = await getFreshTokens()
      const googleTokens = freshTokens
        ? { accessToken: freshTokens.accessToken, refreshToken: freshTokens.refreshToken }
        : null

      const goalList = goals.map((g) => {
        const area = LIFE_AREAS.find((a) => a.area === g.area)
        return `• ${area?.emoji ?? '🎯'} [${g.area}] ${g.text}${g.cadence ? ` (${g.cadence})` : ''}${g.why ? ` — why: ${g.why}` : ''}`
      }).join('\n') || '(no commitments set yet)'

      const seed = [
        `You are helping a family refine their standing commitments — the intentions they want their life coach to hold them accountable to.`,
        ``,
        `Current commitments:\n${goalList}`,
        ``,
        `Guidelines:`,
        `- Be a thoughtful coach, not a task manager. Ask what matters most, not just what's measurable.`,
        `- If a commitment is vague, suggest a specific, concrete version. Show your work: write the revised text.`,
        `- If there seem to be gaps, name them and ask. Don't suggest everything at once.`,
        `- Keep each response to 3-5 sentences max. One key point per turn.`,
        `- When suggesting a new or revised commitment, format it clearly so the user can just copy it in.`,
      ].join('\n')

      const history = [
        { role: 'user' as const, content: seed },
        ...refineThread.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content },
      ]

      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history,
          familyId,
          userEmail: user.email,
          googleTokens,
          context: { today: new Date().toISOString() },
        }),
      })

      if (!res.ok || !res.body) throw new Error('Request failed')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let streamingStarted = false
      let reply = ''

      type SSEEvent = { type: 'token'; token: string } | { type: 'done'; reply: string } | { type: 'error'; error: string }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event: SSEEvent
          try { event = JSON.parse(line.slice(6)) } catch { continue }
          if (event.type === 'token') {
            if (!streamingStarted) {
              streamingStarted = true
              setRefineThread((prev) => [...prev, { role: 'assistant', content: event.token }])
            } else {
              setRefineThread((prev) => {
                const msgs = [...prev]
                const last = msgs[msgs.length - 1]
                if (last?.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: last.content + event.token }
                return msgs
              })
            }
          } else if (event.type === 'done') {
            reply = event.reply || ''
          } else if (event.type === 'error') {
            throw new Error(event.error)
          }
        }
      }

      setRefineThread((prev) => {
        const msgs = [...prev]
        const last = msgs[msgs.length - 1]
        if (last?.role === 'assistant') {
          msgs[msgs.length - 1] = { ...last, content: reply || last.content || 'Got it.' }
        } else {
          msgs.push({ role: 'assistant', content: reply || 'Got it.' })
        }
        return msgs
      })

      setTimeout(() => {
        if (refineScrollRef.current) refineScrollRef.current.scrollTop = refineScrollRef.current.scrollHeight
        refineInputRef.current?.focus()
      }, 50)
    } catch {
      setRefineThread((prev) => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Try again.' }])
    } finally {
      setRefineLoading(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shadow-card">
            <Compass size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Family Coach</h1>
            <p className="text-sm text-slate-400">How are we really doing?</p>
          </div>
        </div>
        <button
          onClick={() => generate()}
          disabled={generating}
          className="mt-1 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-slate-200 text-sm text-slate-600 hover:text-rose-500 hover:border-rose-200 transition-colors shadow-card disabled:opacity-50"
        >
          <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
          {generating ? 'Reflecting…' : 'Check in'}
        </button>
      </div>

      {error && (
        <div className="rounded-xl p-3 bg-red-50 border border-red-200 text-sm text-red-600">{error}</div>
      )}

      {/* Weekly headline */}
      {summary && (
        <div className="rounded-2xl p-5 bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-elevated animate-scale-in">
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
            <p className="text-[15px] leading-relaxed font-medium flex-1">{summary.summary}</p>
          </div>
        </div>
      )}

      {/* Quick note to coach */}
      <div className="rounded-2xl bg-white shadow-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3">
          <input
            ref={noteRef}
            value={quickNote}
            onChange={e => setQuickNote(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveQuickNote() }}
            placeholder="Tell the coach something real-time…"
            className="flex-1 text-sm text-slate-700 placeholder:text-slate-400 bg-transparent focus:outline-none"
          />
          <button
            onClick={saveQuickNote}
            disabled={!quickNote.trim()}
            className="p-1.5 rounded-lg disabled:opacity-30 text-rose-500 hover:bg-rose-50 transition-colors"
          >
            <Send size={14} />
          </button>
        </div>
        {noteSaved && (
          <div className="px-4 pb-3 flex items-center gap-3">
            <p className="text-xs text-green-600 font-medium">✓ Saved — will factor into next check-in</p>
            <button
              onClick={() => { setNoteSaved(false); generate() }}
              disabled={generating}
              className="text-xs text-rose-500 font-semibold hover:underline disabled:opacity-40"
            >
              Refresh now
            </button>
          </div>
        )}
      </div>

      {/* Insights */}
      {activeInsights.length > 0 ? (
        <div className="space-y-2 stagger-children">
          {activeInsights.map((i) => (
            <InsightCardWithThread
              key={i.id}
              insight={i}
              onDismiss={() => dismissInsight(i)}
              onAcknowledge={() => acknowledgeInsight(i)}
              onAction={handleAction}
            />
          ))}
        </div>
      ) : !generating && (
        <div className="rounded-2xl p-6 bg-white shadow-card text-center">
          <div className="text-3xl mb-2">🧭</div>
          <p className="text-sm font-medium text-slate-700">No check-in yet</p>
          <p className="text-xs text-slate-400 mt-1">
            {goals.length === 0
              ? 'Set a goal or two below, then tap "Check in".'
              : 'Tap "Check in" for a reflection on how things are going.'}
          </p>
        </div>
      )}

      {/* Standing commitments */}
      <section>
        {/* Header row */}
        <div className="flex items-center justify-between mb-1">
          <button
            onClick={() => setGoalsExpanded((v) => !v)}
            className="flex items-center gap-2 text-left group"
          >
            <Target size={16} className="text-slate-700 shrink-0" />
            <h2 className="text-base font-bold text-slate-900 group-hover:text-rose-600 transition-colors">
              Standing Commitments
            </h2>
            {goals.length > 0 && (
              <span className="text-xs font-medium text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">
                {goals.length}
              </span>
            )}
            {goalsExpanded
              ? <ChevronUp size={14} className="text-slate-400" />
              : <ChevronDown size={14} className="text-slate-400" />}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={openRefine}
              className={`inline-flex items-center gap-1 text-xs font-semibold transition-colors ${
                showRefine ? 'text-rose-600' : 'text-slate-500 hover:text-rose-500'
              }`}
            >
              <Wand2 size={13} /> Refine
            </button>
            <button
              onClick={() => { setGoalsExpanded(true); setShowGoalForm((v) => !v) }}
              className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700"
            >
              <Plus size={14} /> Add
            </button>
          </div>
        </div>

        {/* Collapsed summary */}
        {!goalsExpanded && (
          <div className="mt-2">
            {goals.length === 0 ? (
              <p className="text-xs text-slate-400 py-1">
                No commitments yet.{' '}
                <button onClick={() => { setGoalsExpanded(true); setShowGoalForm(true) }} className="underline hover:text-rose-500 transition-colors">Add one</button>
                {' '}or{' '}
                <button onClick={openRefine} className="underline hover:text-rose-500 transition-colors">let AI help</button>.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {goals.map((g) => {
                  const area = LIFE_AREAS.find((a) => a.area === g.area)
                  return (
                    <span
                      key={g.id}
                      className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border"
                      style={{ background: `${area?.color ?? '#94a3b8'}12`, borderColor: `${area?.color ?? '#94a3b8'}30`, color: '#475569' }}
                    >
                      {area?.emoji ?? '🎯'} {g.text.length > 32 ? g.text.slice(0, 32) + '…' : g.text}
                    </span>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Expanded content */}
        {goalsExpanded && (
          <div className="mt-3 space-y-3 animate-slide-up">
            <p className="text-xs text-slate-500 -mt-1">
              What you want to protect or improve as a family. The coach holds you gently accountable to these.
            </p>

            {showGoalForm && (
              <GoalForm
                onCancel={() => setShowGoalForm(false)}
                onSave={async (g) => { await addGoal(g); setShowGoalForm(false) }}
              />
            )}

            {goals.length > 0 ? (
              <div className="space-y-2">
                {goals.map((g) => {
                  const area = LIFE_AREAS.find((a) => a.area === g.area)
                  return (
                    <div key={g.id} className="rounded-xl p-3 bg-white shadow-card flex items-start gap-3" style={{ borderLeft: `3px solid ${area?.color ?? '#94a3b8'}` }}>
                      <span className="text-base mt-0.5">{area?.emoji ?? '🎯'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900">{g.text}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {area?.label}{g.cadence ? ` · ${g.cadence}` : ''}{g.why ? ` · ${g.why}` : ''}
                        </p>
                      </div>
                      <button
                        onClick={() => removeGoal(g.id)}
                        className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors shrink-0"
                        title="Remove"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : !showGoalForm && (
              <div className="rounded-xl p-4 bg-slate-50 border border-slate-200 text-center">
                <p className="text-xs text-slate-500">No commitments yet. Add one or use AI to help you define them.</p>
              </div>
            )}

            {/* AI refine panel */}
            {showRefine && (
              <div className="rounded-2xl bg-white shadow-card border border-slate-100 overflow-hidden animate-slide-up">
                <div className="flex items-center justify-between px-4 pt-3 pb-1">
                  <div className="flex items-center gap-2">
                    <Wand2 size={13} className="text-rose-500" />
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Refine with AI</p>
                  </div>
                  <button
                    onClick={() => setShowRefine(false)}
                    className="p-1 rounded-lg text-slate-300 hover:text-slate-500 transition-colors"
                  >
                    <X size={13} />
                  </button>
                </div>

                <div ref={refineScrollRef} className="px-4 pb-2 space-y-3 max-h-80 overflow-y-auto">
                  {refineThread.map((msg, i) =>
                    msg.role === 'user' ? (
                      <div key={i} className="flex justify-end">
                        <div className="bg-blue-600 text-white text-sm rounded-xl rounded-tr-sm px-3 py-2 max-w-[88%] leading-relaxed">
                          {msg.content}
                        </div>
                      </div>
                    ) : (
                      <div key={i} className="flex items-start gap-2">
                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0 mt-1">
                          <Bot size={11} className="text-white" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="bg-slate-50 rounded-xl rounded-tl-sm px-3 py-2.5">
                            <Markdown content={msg.content} />
                          </div>
                        </div>
                      </div>
                    )
                  )}
                  {refineLoading && (
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0">
                        <Loader2 size={11} className="text-white animate-spin" />
                      </div>
                      <div className="text-xs text-slate-400 italic">thinking…</div>
                    </div>
                  )}
                </div>

                <div className="flex items-end gap-2 px-3 py-3 border-t border-slate-100">
                  <textarea
                    ref={refineInputRef}
                    value={refineInput}
                    onChange={(e) => setRefineInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRefineMessage() }
                    }}
                    placeholder="Tell me what to refine…"
                    rows={2}
                    className="flex-1 text-sm resize-none rounded-xl px-3 py-2 border border-slate-200 focus:outline-none focus:border-rose-300 bg-slate-50 leading-relaxed"
                  />
                  <button
                    onClick={sendRefineMessage}
                    disabled={!refineInput.trim() || refineLoading}
                    className="w-8 h-8 rounded-xl bg-gradient-to-br from-rose-500 to-amber-500 flex items-center justify-center shrink-0 disabled:opacity-40 transition-opacity"
                  >
                    <Send size={13} className="text-white" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Weekly reflection */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <PenLine size={16} className="text-slate-700" />
            <h2 className="text-base font-bold text-slate-900">Weekly Reflection</h2>
          </div>
          {!reflectedThisWeek && (
            <button
              onClick={() => setShowReflection((v) => !v)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-rose-600 hover:text-rose-700"
            >
              <Plus size={14} /> Reflect
            </button>
          )}
        </div>

        {reflectedThisWeek && !showReflection && (
          <div className="rounded-xl p-3 bg-green-50 border border-green-200 flex items-center gap-2 mb-2">
            <Check size={15} className="text-green-600 shrink-0" />
            <p className="text-xs text-green-700">You&apos;ve reflected this week. The coach is factoring it in.</p>
          </div>
        )}

        {showReflection && (
          <ReflectionForm
            onCancel={() => setShowReflection(false)}
            onSave={async (r) => { await addReflection(r); setShowReflection(false) }}
          />
        )}

        {reflections.length > 0 && (
          <div className="space-y-2 mt-2">
            {reflections
              .slice()
              .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
              .slice(0, 4)
              .map((r) => (
                <div key={r.id} className="rounded-xl p-3 bg-white shadow-card">
                  <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-1.5">
                    Week of {new Date(r.weekOf).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </p>
                  <div className="space-y-1">
                    {r.wentWell && <p className="text-xs text-slate-600"><span className="text-green-600 font-medium">Went well:</span> {r.wentWell}</p>}
                    {r.wasHard && <p className="text-xs text-slate-600"><span className="text-amber-600 font-medium">Was hard:</span> {r.wasHard}</p>}
                    {r.wouldChange && <p className="text-xs text-slate-600"><span className="text-blue-600 font-medium">Would change:</span> {r.wouldChange}</p>}
                    {r.gratitude && <p className="text-xs text-slate-600"><span className="text-rose-600 font-medium">Grateful for:</span> {r.gratitude}</p>}
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

      <button
        onClick={() => router.push('/command')}
        className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors"
      >
        Back to Command Center
      </button>
    </div>
  )
}

function GoalForm({
  onCancel, onSave,
}: {
  onCancel: () => void
  onSave: (g: { text: string; area: LifeArea; cadence?: string; why?: string; active: boolean }) => void
}) {
  const [text, setText] = useState('')
  const [area, setArea] = useState<LifeArea>('relationships')
  const [cadence, setCadence] = useState('')
  const [why, setWhy] = useState('')

  return (
    <div className="rounded-xl p-4 bg-white shadow-card mb-3 space-y-3 animate-slide-up">
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Family dinner at least 4 nights a week"
          className="flex-1 text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-rose-300 bg-slate-50"
          autoFocus
        />
      </div>
      <div>
        <p className="text-xs font-medium text-slate-500 mb-1.5">Life area</p>
        <div className="flex flex-wrap gap-1.5">
          {LIFE_AREAS.map((a) => (
            <button
              key={a.area}
              onClick={() => setArea(a.area)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs border transition-all"
              style={{
                background: area === a.area ? `${a.color}20` : 'white',
                borderColor: area === a.area ? a.color : '#e2e8f0',
                color: area === a.area ? '#0f172a' : '#64748b',
                fontWeight: area === a.area ? 600 : 400,
              }}
            >
              {a.emoji} {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input
          value={cadence}
          onChange={(e) => setCadence(e.target.value)}
          placeholder="Cadence (e.g. weekly)"
          className="text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-rose-300 bg-slate-50"
        />
        <input
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          placeholder="Why it matters (optional)"
          className="text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-rose-300 bg-slate-50"
        />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 transition-colors">
          Cancel
        </button>
        <button
          onClick={() => text.trim() && onSave({ text: text.trim(), area, cadence: cadence.trim() || undefined, why: why.trim() || undefined, active: true })}
          disabled={!text.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-rose-500 hover:bg-rose-600 disabled:opacity-40 transition-colors"
        >
          Save commitment
        </button>
      </div>
    </div>
  )
}

function ReflectionForm({
  onCancel, onSave,
}: {
  onCancel: () => void
  onSave: (r: { weekOf: string; wentWell?: string; wasHard?: string; wouldChange?: string; gratitude?: string }) => void
}) {
  const [wentWell, setWentWell] = useState('')
  const [wasHard, setWasHard] = useState('')
  const [wouldChange, setWouldChange] = useState('')
  const [gratitude, setGratitude] = useState('')

  const fields: { label: string; value: string; set: (v: string) => void; placeholder: string }[] = [
    { label: 'What went well?', value: wentWell, set: setWentWell, placeholder: 'A good moment, a win, something that worked…' },
    { label: 'What was hard?', value: wasHard, set: setWasHard, placeholder: 'A struggle, a stressor, something that drained you…' },
    { label: 'What would you change?', value: wouldChange, set: setWouldChange, placeholder: 'One thing to do differently next week…' },
    { label: 'Grateful for?', value: gratitude, set: setGratitude, placeholder: 'Something or someone you appreciated…' },
  ]

  return (
    <div className="rounded-xl p-4 bg-white shadow-card space-y-3 animate-slide-up">
      {fields.map((f) => (
        <div key={f.label}>
          <p className="text-xs font-medium text-slate-500 mb-1">{f.label}</p>
          <div className="flex items-start gap-2">
            <textarea
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              placeholder={f.placeholder}
              rows={2}
              className="flex-1 text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-rose-300 bg-slate-50 resize-none"
            />
          </div>
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 hover:bg-slate-100 transition-colors">
          <X size={14} />
        </button>
        <button
          onClick={() => {
            const d = new Date()
            d.setDate(d.getDate() - d.getDay())
            d.setHours(0, 0, 0, 0)
            onSave({
              weekOf: d.toISOString(),
              wentWell: wentWell.trim() || undefined,
              wasHard: wasHard.trim() || undefined,
              wouldChange: wouldChange.trim() || undefined,
              gratitude: gratitude.trim() || undefined,
            })
          }}
          disabled={!wentWell.trim() && !wasHard.trim() && !wouldChange.trim() && !gratitude.trim()}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-rose-500 hover:bg-rose-600 disabled:opacity-40 transition-colors"
        >
          Save reflection
        </button>
      </div>
    </div>
  )
}
