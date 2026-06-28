'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  CalendarDays, Sparkles, ArrowRight, Loader2, Check, X, Clock,
  ChevronLeft, ChevronRight, Plus, Send, RefreshCw, Lock, Pin, LifeBuoy, Trash2, SlidersHorizontal, TrendingUp,
} from 'lucide-react'
import { useDayPlan, dateStrOffset, sortByTime } from '@/hooks/useDayPlan'
import { AboutMeForm } from './AboutMeForm'
import { MOMENT_ENERGY_META, MOMENT_KIND_META } from '@/lib/types'
import type { MomentEnergy, DayPlanItem, DayPlanStructure } from '@/lib/types'

const ENERGY_ORDER: MomentEnergy[] = ['wired', 'okay', 'drained']

function fmtTime(iso?: string): string {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}

// Effective time (ms) for each item in a time-sorted list: timed items use
// their time; an untimed move inherits the nearest preceding timed item's time
// (matching the stored sort), or the next one if none precede. Untimed-only
// lists come back as Infinity.
function effectiveTimes(items: DayPlanItem[]): number[] {
  const ms = items.map((it) => (it.startTime ? new Date(it.startTime).getTime() : NaN))
  const eff = ms.slice()
  let last = NaN
  for (let i = 0; i < eff.length; i++) {
    if (!Number.isNaN(ms[i])) last = ms[i]
    else if (!Number.isNaN(last)) eff[i] = last
  }
  let next = NaN
  for (let i = eff.length - 1; i >= 0; i--) {
    if (!Number.isNaN(ms[i])) next = ms[i]
    else if (Number.isNaN(eff[i]) && !Number.isNaN(next)) eff[i] = next
  }
  return eff.map((v) => (Number.isNaN(v) ? Infinity : v))
}

// Shift a YYYY-MM-DD by n days (parsed as local midnight to avoid UTC drift).
function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`)
  d.setDate(d.getDate() + days)
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export function DayPlanner() {
  const router = useRouter()
  const {
    plan, selectedDate, setSelectedDate, isToday, targetDateLabel,
    personalProfile, working, error,
    draftPlan, refinePlan, replanRest, finalizePlan,
    toggleItem, removeItem, addItem, discardPlan,
    savePersonalProfile,
  } = useDayPlan()

  const [energy, setEnergy] = useState<MomentEnergy | null>(null)
  const [intention, setIntention] = useState('')
  const [chat, setChat] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [addText, setAddText] = useState('')
  const [feedback, setFeedback] = useState('')
  const [editingProfile, setEditingProfile] = useState(false)
  // How prescriptive to draft. Defaults to the saved profile preference until
  // the user picks for this plan.
  const [structureChoice, setStructureChoice] = useState<DayPlanStructure | null>(null)
  const structure: DayPlanStructure = structureChoice ?? personalProfile?.planStructure ?? 'flexible'
  // Two-step confirm so a locked-in plan can't be wiped with one stray tap.
  const [confirmingClear, setConfirmingClear] = useState(false)

  // Live clock for the "now" marker — ticks each minute so the line drifts down
  // the timeline through the day.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const status = plan?.status
  const today0 = dateStrOffset(0)
  const relLabel = selectedDate === today0 ? 'Today' : selectedDate === dateStrOffset(1) ? 'Tomorrow' : null
  const weekday = targetDateLabel.split(',')[0]
  const title = relLabel ? `${relLabel}’s plan` : `${weekday}’s plan`
  const canGoPrev = selectedDate > today0          // no planning the past
  const canGoNext = selectedDate < dateStrOffset(14)  // up to two weeks out

  async function sendRefine() {
    const msg = chat.trim()
    if (!msg) return
    setChat('')
    const r = await refinePlan(msg)
    setReply(r)
  }

  async function doReplan() {
    setReply(null)
    const r = await replanRest()
    setReply(r)
  }

  // On-the-fly feedback on a locked-in plan — a SURGICAL edit. It changes only
  // what you ask, leaves every other item (and its time) alone, never moves
  // anchors, and never touches what's already done. For a bigger reset, the
  // separate "Re-plan the rest" button rebuilds the remaining day.
  async function sendFeedback() {
    const msg = feedback.trim()
    if (!msg || working) return
    setFeedback('')
    setReply(null)
    const r = await refinePlan(msg)
    setReply(r)
  }

  function nudge() {
    try { window.dispatchEvent(new CustomEvent('open-moment-coach')) } catch { /* no-op */ }
  }

  // ── Header ────────────────────────────────────────────────────────────────
  const header = (
    <div className="mb-4">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shrink-0">
          <CalendarDays size={18} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-slate-900 tracking-tight leading-tight">{title}</h2>
          <p className="text-xs text-slate-400 truncate">{targetDateLabel}</p>
        </div>
        <button
          onClick={() => router.push('/insights')}
          aria-label="Your progress"
          className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors shrink-0"
        >
          <TrendingUp size={17} />
        </button>
        <button
          onClick={() => setEditingProfile(true)}
          aria-label="About me & my days"
          className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition-colors shrink-0"
        >
          <SlidersHorizontal size={17} />
        </button>
      </div>
      {/* Day stepper — plan today or any day up to two weeks out. */}
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={() => canGoPrev && setSelectedDate(shiftDate(selectedDate, -1))}
          disabled={!canGoPrev}
          aria-label="Previous day"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 bg-slate-100 hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-slate-100 transition-colors"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="flex-1 text-center text-xs font-semibold text-slate-500">
          {relLabel ?? weekday}
        </div>
        <button
          onClick={() => canGoNext && setSelectedDate(shiftDate(selectedDate, 1))}
          disabled={!canGoNext}
          aria-label="Next day"
          className="w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 bg-slate-100 hover:bg-slate-200 disabled:opacity-30 disabled:hover:bg-slate-100 transition-colors"
        >
          <ChevronRight size={16} />
        </button>
        {!isToday && (
          <button
            onClick={() => setSelectedDate(today0)}
            className="px-2.5 h-8 rounded-lg text-xs font-semibold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 transition-colors"
          >
            Today
          </button>
        )}
      </div>
    </div>
  )

  // ── Profile editor (about me & my days) ─────────────────────────────────────
  if (editingProfile) {
    return (
      <section className="rounded-2xl p-5 bg-white shadow-card">
        <div className="flex items-center gap-2.5 mb-4">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shrink-0">
            <SlidersHorizontal size={18} className="text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold text-slate-900 tracking-tight leading-tight">About me &amp; my days</h2>
            <p className="text-xs text-slate-400">So your plans actually fit you</p>
          </div>
          <button
            onClick={() => setEditingProfile(false)}
            aria-label="Close"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>
        <AboutMeForm
          existing={personalProfile}
          onSave={async (patch) => { await savePersonalProfile(patch); setEditingProfile(false) }}
          onCancel={() => setEditingProfile(false)}
        />
      </section>
    )
  }

  // ── Kickoff (no plan yet) ───────────────────────────────────────────────────
  if (!plan) {
    return (
      <section className="rounded-2xl p-5 bg-white shadow-card">
        {header}
        {working ? (
          <div className="py-8 flex flex-col items-center gap-3">
            <Loader2 size={22} className="animate-spin text-indigo-500" />
            <p className="text-sm text-slate-500">Drafting your day…</p>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-slate-500 leading-relaxed">
              {isToday
                ? 'Tell me where you’re at and I’ll draft a realistic plan for today. You can tweak it before locking it in.'
                : `Let’s plan ${relLabel ? relLabel.toLowerCase() : weekday}. I’ll draft a realistic day from what’s on the calendar and what matters — tweak it before locking it in.`}
            </p>
            {!personalProfile?.rhythm && !personalProfile?.householdRoles && (
              <button
                onClick={() => setEditingProfile(true)}
                className="w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 bg-indigo-50 text-indigo-700 text-xs font-semibold hover:bg-indigo-100 transition-colors"
              >
                <span className="flex items-center gap-1.5"><SlidersHorizontal size={14} /> Tell me about you &amp; your days — plans fit way better</span>
                <ArrowRight size={14} />
              </button>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                {isToday ? 'Energy today' : <>Expected energy <span className="font-normal normal-case text-slate-300">· optional</span></>}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {ENERGY_ORDER.map((e) => {
                  const meta = MOMENT_ENERGY_META[e]
                  const active = energy === e
                  return (
                    <button
                      key={e}
                      onClick={() => setEnergy(e)}
                      className={`rounded-xl py-2.5 flex flex-col items-center gap-1 transition-all border ${
                        active ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                      }`}
                    >
                      <span className="text-lg leading-none">{meta.emoji}</span>
                      <span className="text-xs font-semibold">{meta.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                What&apos;s on your mind for {relLabel ? relLabel.toLowerCase() : weekday}? <span className="font-normal normal-case text-slate-300">· optional</span>
              </p>
              <textarea
                value={intention}
                onChange={(e) => setIntention(e.target.value)}
                rows={2}
                placeholder={isToday ? "What you want to get done, what you're dreading, anything special about today…" : 'What you want this day to include, anything to prep for, anything special…'}
                className="w-full text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50 resize-none leading-relaxed"
              />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Style</p>
              <div className="grid grid-cols-2 gap-2">
                <StyleChoice
                  active={structure === 'flexible'}
                  onClick={() => setStructureChoice('flexible')}
                  label="Flexible"
                  hint="anchors + a loose to-do flow"
                />
                <StyleChoice
                  active={structure === 'structured'}
                  onClick={() => setStructureChoice('structured')}
                  label="Structured"
                  hint="timed, step-by-step schedule"
                />
              </div>
            </div>
            {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              onClick={() => draftPlan(energy ?? undefined, intention, structure)}
              disabled={working || (isToday && !energy)}
              className="w-full py-3 rounded-xl bg-indigo-600 text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] transition-transform"
            >
              Draft {relLabel ? relLabel.toLowerCase() : weekday} <ArrowRight size={16} />
            </button>
          </div>
        )}
      </section>
    )
  }

  const items = plan.items
  const doneCount = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0
  const isDraft = status === 'draft'
  const isDone = status === 'done'
  // Always present items in chronological order at render time — robust even for
  // plans saved before the sort logic, or after a manual edit.
  const ordered = sortByTime(items)
  // The "now" line only makes sense on today's committed (not draft) plan, once
  // at least one item is timed.
  const showNow = isToday && !isDraft && ordered.some((it) => it.startTime)
  // Split around the now line: anything DONE or already past sits above the
  // line (behind you); only not-done, still-ahead items sit below it. So a task
  // you complete jumps above the line even if it was scheduled for later.
  const eff = effectiveTimes(ordered)
  const aboveNow: DayPlanItem[] = []
  const belowNow: DayPlanItem[] = []
  ordered.forEach((it, i) => {
    if (!showNow || it.done || eff[i] <= now) aboveNow.push(it)
    else belowNow.push(it)
  })

  return (
    <section className="rounded-2xl p-5 bg-white shadow-card">
      {header}

      {plan.headline && (
        <p className="text-sm text-slate-600 leading-relaxed mb-3 -mt-1">{plan.headline}</p>
      )}

      {/* "Tuned to you" — surfaces which of your settings shaped this plan, so
          it's visible they're being used. Tap to adjust them. */}
      {(() => {
        const p = personalProfile
        if (!p) return null
        const chips: string[] = []
        if (p.planStyle) chips.push(`${p.planStyle} days`)
        if (p.planStructure) chips.push(p.planStructure)
        if (p.protectRest) chips.push('protects rest')
        if (p.rhythm) chips.push('your rhythm')
        if (p.householdRoles || p.careSchedule) chips.push('your household')
        if (p.fixedAnchors?.length) chips.push('your anchors')
        if (p.nonNegotiables?.length) chips.push(`${p.nonNegotiables.length} rule${p.nonNegotiables.length > 1 ? 's' : ''}`)
        if (!chips.length) return null
        return (
          <button
            onClick={() => setEditingProfile(true)}
            className="flex flex-wrap items-center gap-1.5 mb-4 text-left"
            title="Adjust your settings"
          >
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Tuned to you</span>
            {chips.map((c) => (
              <span key={c} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">{c}</span>
            ))}
            <SlidersHorizontal size={11} className="text-slate-300" />
          </button>
        )
      })()}

      {/* Progress (active/done) */}
      {!isDraft && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-slate-500">{doneCount} of {items.length} done</span>
            {isDone && <span className="text-xs font-bold text-green-600">All done 🎉</span>}
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div className="h-full bg-gradient-to-r from-indigo-500 to-blue-500 transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {/* Items — chronological. Done / past items sit above the live "now" line;
          only what's still ahead sits below it. */}
      <div className="space-y-2">
        {(() => {
          const renderRow = (it: DayPlanItem) => (
            <ItemRow
              key={it.id}
              item={it}
              isDraft={isDraft}
              busy={working}
              onToggle={() => toggleItem(it.id)}
              onRemove={() => removeItem(it.id)}
              onReschedule={!isDraft && !it.done ? async (msg) => { setReply(null); const r = await refinePlan(msg, it.title); setReply(r) } : undefined}
            />
          )
          return (
            <>
              {aboveNow.map(renderRow)}
              {showNow && <NowLine now={now} />}
              {belowNow.map(renderRow)}
            </>
          )
        })()}
      </div>

      {/* Draft controls: add, chat-refine, finalize */}
      {isDraft && (
        <div className="mt-4 space-y-3">
          {/* Flip how prescriptive the plan is — regenerates from the same inputs. */}
          <button
            onClick={() => draftPlan(plan.energy ?? undefined, plan.intention, plan.structure === 'structured' ? 'flexible' : 'structured')}
            disabled={working}
            className="w-full flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 bg-slate-100 text-slate-600 text-xs font-semibold hover:bg-slate-200 disabled:opacity-50 transition-colors"
          >
            {working ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {plan.structure === 'structured' ? 'Switch to a flexible plan' : 'Make it a timed, step-by-step plan'}
          </button>
          <div className="flex items-center gap-2">
            <input
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && addText.trim()) { addItem(addText); setAddText('') } }}
              placeholder="Add something yourself…"
              className="flex-1 text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50"
            />
            <button
              onClick={() => { if (addText.trim()) { addItem(addText); setAddText('') } }}
              disabled={!addText.trim()}
              className="p-2 rounded-lg bg-slate-100 text-slate-600 hover:bg-slate-200 disabled:opacity-40 transition-colors"
            >
              <Plus size={16} />
            </button>
          </div>

          {reply && (
            <div className="flex items-start gap-2 rounded-lg bg-indigo-50 px-3 py-2">
              <Sparkles size={13} className="text-indigo-500 mt-0.5 shrink-0" />
              <p className="text-xs text-indigo-900 leading-relaxed">{reply}</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              value={chat}
              onChange={(e) => setChat(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendRefine() }}
              placeholder="Ask me to change it — “lighter morning”, “fit the gym in”…"
              className="flex-1 text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50"
              disabled={working}
            />
            <button
              onClick={sendRefine}
              disabled={!chat.trim() || working}
              className="p-2 rounded-lg bg-indigo-100 text-indigo-600 hover:bg-indigo-200 disabled:opacity-40 transition-colors"
            >
              {working ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>

          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={discardPlan}
              className="px-3 py-2.5 rounded-xl text-xs font-medium text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            >
              Start over
            </button>
            <button
              onClick={finalizePlan}
              disabled={working || items.length === 0}
              className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] transition-transform"
            >
              <Lock size={15} /> Lock in today&apos;s plan
            </button>
          </div>
        </div>
      )}

      {/* Active/done controls: nudge, replan, start over */}
      {!isDraft && (
        <div className="mt-5 space-y-2">
          {reply && (
            <div className="flex items-start gap-2 rounded-lg bg-indigo-50 px-3 py-2">
              <Sparkles size={13} className="text-indigo-500 mt-0.5 shrink-0" />
              <p className="text-xs text-indigo-900 leading-relaxed">{reply}</p>
            </div>
          )}
          {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

          {/* On-the-fly feedback — adjust the plan after it's locked in. Only
              the remaining/not-done items change; what you've finished stays. */}
          {!isDone && (
            <div className="flex items-center gap-2">
              <input
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendFeedback() }}
                placeholder="Tweak it — “add: put clothes away”, “move the gym later”…"
                disabled={working}
                className="flex-1 text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50"
              />
              <button
                onClick={sendFeedback}
                disabled={!feedback.trim() || working}
                className="p-2 rounded-lg bg-indigo-100 text-indigo-600 hover:bg-indigo-200 disabled:opacity-40 transition-colors"
              >
                {working ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </div>
          )}

          {/* "Get a nudge" and "re-plan the rest" are about the day in progress,
              so they only apply to today. Future days just show the checklist. */}
          {!isDone && isToday && (
            <div className="flex items-center gap-2">
              <button
                onClick={nudge}
                className="flex-1 py-2.5 rounded-xl bg-violet-50 text-violet-700 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-violet-100 transition-colors"
              >
                <LifeBuoy size={14} /> Stuck? Get a nudge
              </button>
              <button
                onClick={doReplan}
                disabled={working}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 text-slate-700 font-semibold text-xs flex items-center justify-center gap-1.5 hover:bg-slate-200 disabled:opacity-50 transition-colors"
              >
                {working ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Re-plan the rest
              </button>
            </div>
          )}
          {confirmingClear ? (
            <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
              <span className="flex-1 text-xs font-medium text-red-700">Delete the whole plan?</span>
              <button
                onClick={() => setConfirmingClear(false)}
                className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { setConfirmingClear(false); discardPlan() }}
                className="px-2.5 py-1.5 rounded-lg text-xs font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingClear(true)}
              className="w-full py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center gap-1.5"
            >
              <Trash2 size={12} /> Clear this plan
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function NowLine({ now }: { now: number }) {
  const time = new Date(now).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="flex items-center gap-2 py-0.5" aria-label={`Current time ${time}`}>
      <span className="text-[10px] font-bold uppercase tracking-wider text-rose-500 shrink-0">Now</span>
      <span className="w-1.5 h-1.5 rounded-full bg-rose-500 shrink-0" />
      <span className="flex-1 h-px bg-rose-300" />
      <span className="text-[10px] font-semibold text-rose-500 tabular-nums shrink-0">{time}</span>
    </div>
  )
}

function StyleChoice({ active, onClick, label, hint }: { active: boolean; onClick: () => void; label: string; hint: string }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl py-2 px-2.5 flex flex-col items-start gap-0.5 border text-left transition-all ${
        active ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <span className={`text-xs font-bold ${active ? 'text-indigo-700' : 'text-slate-700'}`}>{label}</span>
      <span className="text-[10px] text-slate-400 leading-tight">{hint}</span>
    </button>
  )
}

function ItemRow({
  item, isDraft, busy, onToggle, onRemove, onReschedule,
}: {
  item: DayPlanItem
  isDraft: boolean
  busy?: boolean
  onToggle: () => void
  onRemove: () => void
  onReschedule?: (message: string) => void | Promise<void>
}) {
  const isAnchor = item.kind === 'anchor'
  const cat = item.category ? MOMENT_KIND_META[item.category] : null
  const time = fmtTime(item.startTime)
  const [fbOpen, setFbOpen] = useState(false)
  const [fbText, setFbText] = useState('')

  async function submitFeedback() {
    const m = fbText.trim()
    if (!m || busy) return
    setFbText('')
    setFbOpen(false)
    await onReschedule?.(m)
  }

  return (
    <div className={`rounded-xl border p-3 flex items-start gap-3 transition-colors ${
      item.done ? 'bg-slate-50 border-slate-100' : isAnchor ? 'bg-blue-50/50 border-blue-100' : 'bg-white border-slate-200'
    }`}>
      {/* Left: checkbox (tracking) or anchor pin */}
      {isDraft ? (
        <div className="mt-0.5 shrink-0">
          {isAnchor
            ? <Pin size={15} className="text-blue-500" />
            : <span className="block w-2 h-2 rounded-full bg-indigo-400 mt-1.5 ml-1.5" />}
        </div>
      ) : (
        <button
          onClick={onToggle}
          aria-label={item.done ? 'Mark not done' : 'Mark done'}
          className={`mt-0.5 w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
            item.done ? 'bg-green-500 border-green-500 text-white' : 'border-slate-300 hover:border-indigo-400'
          }`}
        >
          {item.done && <Check size={13} />}
        </button>
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {time && <span className="text-xs font-bold text-blue-600 tabular-nums">{time}</span>}
          <span className={`text-sm font-semibold leading-snug ${item.done ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
            {item.title}
          </span>
          {cat && !item.done && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: `${cat.color}18`, color: cat.color }}>
              {cat.emoji}
            </span>
          )}
        </div>
        {item.why && !item.done && <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{item.why}</p>}
        {/* Structured plans break a move into ordered steps; flexible ones give
            a single tiny first step. Show whichever is present. */}
        {item.steps?.length && !item.done && !isAnchor ? (
          <ol className="mt-1.5 space-y-1">
            {item.steps.map((s, i) => (
              <li key={i} className="flex gap-2 text-xs text-slate-600 leading-snug">
                <span className="text-indigo-500 font-bold tabular-nums shrink-0">{i + 1}.</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        ) : item.firstStep && !item.done && !isAnchor ? (
          <p className="text-xs text-indigo-600 mt-1">
            <span className="font-semibold">Start:</span> {item.firstStep}
          </p>
        ) : null}
        {item.minutes && !item.done && <span className="text-[11px] text-slate-400">~{item.minutes} min</span>}

        {/* Per-card reschedule feedback — tell the coach when this should be and
            it reorganizes around it (keeping the rest of the day intact). */}
        {fbOpen && (
          <div className="mt-2 flex items-center gap-2">
            <input
              autoFocus
              value={fbText}
              onChange={(e) => setFbText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitFeedback(); if (e.key === 'Escape') setFbOpen(false) }}
              placeholder="When should this be? e.g. “after the gym, not before”"
              disabled={busy}
              className="flex-1 text-xs rounded-lg px-2.5 py-1.5 border border-indigo-200 focus:outline-none focus:border-indigo-400 bg-white"
            />
            <button
              onClick={submitFeedback}
              disabled={!fbText.trim() || busy}
              className="p-1.5 rounded-lg bg-indigo-100 text-indigo-600 hover:bg-indigo-200 disabled:opacity-40 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        )}
      </div>

      {/* Right: remove (draft) or reschedule (committed, not done). */}
      {isDraft ? (
        <button onClick={onRemove} aria-label="Remove" className="p-1 text-slate-300 hover:text-red-500 transition-colors shrink-0">
          <X size={15} />
        </button>
      ) : onReschedule && !item.done ? (
        <button
          onClick={() => setFbOpen((v) => !v)}
          aria-label="Reschedule this"
          title="Reschedule / adjust this"
          className={`p-1.5 rounded-lg transition-colors shrink-0 ${fbOpen ? 'text-indigo-600 bg-indigo-50' : 'text-slate-300 hover:text-indigo-600 hover:bg-indigo-50'}`}
        >
          <Clock size={15} />
        </button>
      ) : null}
    </div>
  )
}
