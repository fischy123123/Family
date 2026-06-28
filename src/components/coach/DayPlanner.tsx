'use client'

import { useState } from 'react'
import {
  CalendarDays, Sparkles, ArrowRight, Loader2, Check, X, ChevronUp, ChevronDown,
  Plus, Send, RefreshCw, Lock, Pin, LifeBuoy, Trash2,
} from 'lucide-react'
import { useDayPlan } from '@/hooks/useDayPlan'
import { MOMENT_ENERGY_META, MOMENT_KIND_META } from '@/lib/types'
import type { MomentEnergy, DayPlanItem } from '@/lib/types'

const ENERGY_ORDER: MomentEnergy[] = ['wired', 'okay', 'drained']

function fmtTime(iso?: string): string {
  if (!iso) return ''
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) } catch { return '' }
}

export function DayPlanner() {
  const {
    todayPlan, working, error,
    draftPlan, refinePlan, replanRest, finalizePlan,
    toggleItem, removeItem, addItem, moveItem, discardPlan,
  } = useDayPlan()

  const [energy, setEnergy] = useState<MomentEnergy | null>(null)
  const [intention, setIntention] = useState('')
  const [chat, setChat] = useState('')
  const [reply, setReply] = useState<string | null>(null)
  const [addText, setAddText] = useState('')

  const status = todayPlan?.status
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

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

  function nudge() {
    try { window.dispatchEvent(new CustomEvent('open-moment-coach')) } catch { /* no-op */ }
  }

  // ── Header ────────────────────────────────────────────────────────────────
  const header = (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shrink-0">
        <CalendarDays size={18} className="text-white" />
      </div>
      <div className="min-w-0">
        <h2 className="text-lg font-bold text-slate-900 tracking-tight leading-tight">Today&apos;s plan</h2>
        <p className="text-xs text-slate-400 truncate">{dateLabel}</p>
      </div>
    </div>
  )

  // ── Kickoff (no plan yet) ───────────────────────────────────────────────────
  if (!todayPlan) {
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
              Tell me where you&apos;re at and I&apos;ll draft a realistic plan for today. You can tweak it before locking it in.
            </p>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Energy today</p>
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
                What&apos;s on your mind today? <span className="font-normal normal-case text-slate-300">· optional</span>
              </p>
              <textarea
                value={intention}
                onChange={(e) => setIntention(e.target.value)}
                rows={2}
                placeholder="What you want to get done, what you're dreading, anything special about today…"
                className="w-full text-sm rounded-lg px-3 py-2 border border-slate-200 focus:outline-none focus:border-indigo-300 bg-slate-50 resize-none leading-relaxed"
              />
            </div>
            {error && <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</p>}
            <button
              onClick={() => energy && draftPlan(energy, intention)}
              disabled={!energy}
              className="w-full py-3 rounded-xl bg-indigo-600 text-white font-bold text-sm flex items-center justify-center gap-2 disabled:opacity-50 active:scale-[0.99] transition-transform"
            >
              Draft my day <ArrowRight size={16} />
            </button>
          </div>
        )}
      </section>
    )
  }

  const items = todayPlan.items
  const doneCount = items.filter((i) => i.done).length
  const pct = items.length ? Math.round((doneCount / items.length) * 100) : 0
  const isDraft = status === 'draft'
  const isDone = status === 'done'

  return (
    <section className="rounded-2xl p-5 bg-white shadow-card">
      {header}

      {todayPlan.headline && (
        <p className="text-sm text-slate-600 leading-relaxed mb-4 -mt-1">{todayPlan.headline}</p>
      )}

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

      {/* Items */}
      <div className="space-y-2">
        {items.map((it, idx) => (
          <ItemRow
            key={it.id}
            item={it}
            isDraft={isDraft}
            onToggle={() => toggleItem(it.id)}
            onRemove={() => removeItem(it.id)}
            onUp={idx > 0 ? () => moveItem(it.id, -1) : undefined}
            onDown={idx < items.length - 1 ? () => moveItem(it.id, 1) : undefined}
          />
        ))}
      </div>

      {/* Draft controls: add, chat-refine, finalize */}
      {isDraft && (
        <div className="mt-4 space-y-3">
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
          {!isDone && (
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
          <button
            onClick={discardPlan}
            className="w-full py-2 rounded-xl text-xs font-medium text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors flex items-center justify-center gap-1.5"
          >
            <Trash2 size={12} /> Clear today&apos;s plan
          </button>
        </div>
      )}
    </section>
  )
}

function ItemRow({
  item, isDraft, onToggle, onRemove, onUp, onDown,
}: {
  item: DayPlanItem
  isDraft: boolean
  onToggle: () => void
  onRemove: () => void
  onUp?: () => void
  onDown?: () => void
}) {
  const isAnchor = item.kind === 'anchor'
  const cat = item.category ? MOMENT_KIND_META[item.category] : null
  const time = fmtTime(item.startTime)

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
        {item.firstStep && !item.done && !isAnchor && (
          <p className="text-xs text-indigo-600 mt-1">
            <span className="font-semibold">Start:</span> {item.firstStep}
          </p>
        )}
        {item.minutes && !item.done && <span className="text-[11px] text-slate-400">~{item.minutes} min</span>}
      </div>

      {/* Right: draft reorder/remove */}
      {isDraft && (
        <div className="flex flex-col items-center gap-0.5 shrink-0">
          <button onClick={onUp} disabled={!onUp} className="p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-0 transition-colors"><ChevronUp size={15} /></button>
          <button onClick={onRemove} className="p-0.5 text-slate-300 hover:text-red-500 transition-colors"><X size={14} /></button>
          <button onClick={onDown} disabled={!onDown} className="p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-0 transition-colors"><ChevronDown size={15} /></button>
        </div>
      )}
    </div>
  )
}
