'use client'

import Link from 'next/link'
import { Compass, Sparkles, RefreshCw, ChevronRight, Target } from 'lucide-react'
import { InsightCard } from './InsightCard'
import { useCoaching } from '@/hooks/useCoaching'
import type { CoachingInsight } from '@/lib/types'

function startOfWeekISO(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay())
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

// The life-coaching block on the command center. Distinct, calmer tone than the
// attention engine: this is the "how are we really doing" layer, not the
// "what's next" layer. Reads from Firestore; the user (or the weekly cron) runs
// the engine — we never auto-fire the expensive Opus pass on load.
export function CoachingSection({
  onCapture,
}: {
  onCapture?: (text: string) => void
}) {
  const {
    goals, insights, summary, generating, generate, dismissInsight, acknowledgeInsight,
  } = useCoaching()

  const week = startOfWeekISO()
  const active = insights
    .filter((i) => !i.dismissed)
    .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
  // Prefer this week's insights; if none, show the most recent batch.
  const thisWeek = active.filter((i) => i.weekOf === week)
  const shown = (thisWeek.length > 0 ? thisWeek : active).slice(0, 4)

  function handleAction(insight: CoachingInsight) {
    if (insight.actionType === 'capture' && insight.suggestedAction && onCapture) {
      onCapture(`${insight.title}. ${insight.suggestedAction}`)
    }
  }

  const hasContent = shown.length > 0 || !!summary

  // First-run invitation: no goals and nothing generated yet.
  if (!hasContent && goals.length === 0) {
    return (
      <section className="rounded-2xl p-5 bg-gradient-to-br from-rose-50 to-amber-50 border border-rose-100 animate-slide-up">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/70 flex items-center justify-center shrink-0">
            <Compass size={18} className="text-rose-500" />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-bold text-slate-900">Your family coach</h3>
            <p className="text-xs text-slate-600 mt-1 leading-relaxed">
              Beyond the day-to-day, I can help you stay true to what matters most — noticing
              when things drift, celebrating what&apos;s working, and asking the questions worth
              sitting with. Tell me what you want to protect or improve.
            </p>
            <Link
              href="/coach"
              className="inline-flex items-center gap-1.5 mt-3 px-3.5 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-rose-500 to-amber-500 hover:from-rose-400 hover:to-amber-400 transition-all"
            >
              <Target size={13} /> Set your family&apos;s goals
            </Link>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Compass size={16} className="text-rose-500" />
          <h2 className="text-base font-bold text-slate-900">Family Coach</h2>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => generate()}
            disabled={generating}
            className="p-2 rounded-lg text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors disabled:opacity-50"
            title="Fresh check-in"
          >
            <RefreshCw size={14} className={generating ? 'animate-spin' : ''} />
          </button>
          <Link
            href="/coach"
            className="p-2 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors"
            title="Open coach"
          >
            <ChevronRight size={16} />
          </Link>
        </div>
      </div>

      {/* Weekly reflective headline */}
      {summary && (
        <div className="rounded-2xl p-5 bg-gradient-to-br from-rose-500 to-amber-500 text-white shadow-elevated animate-scale-in mb-3">
          <div className="flex items-start gap-3">
            <Sparkles size={18} className="mt-0.5 shrink-0 opacity-90" />
            <p className="text-[15px] leading-relaxed font-medium">{summary.summary}</p>
          </div>
        </div>
      )}

      {/* Generating state when there's nothing yet */}
      {generating && shown.length === 0 && (
        <div className="rounded-2xl p-5 bg-white shadow-card flex items-center gap-3 animate-slide-up">
          <RefreshCw size={15} className="text-rose-400 animate-spin shrink-0" />
          <p className="text-sm text-slate-500">Reflecting on how things have been going…</p>
        </div>
      )}

      {/* Insights */}
      {shown.length > 0 && (
        <div className="space-y-2 stagger-children">
          {shown.map((i) => (
            <InsightCard
              key={i.id}
              insight={i}
              onDismiss={() => dismissInsight(i)}
              onAcknowledge={() => acknowledgeInsight(i)}
              onAction={handleAction}
            />
          ))}
        </div>
      )}

      {/* Goals set but no insights yet */}
      {!summary && shown.length === 0 && !generating && goals.length > 0 && (
        <div className="rounded-2xl p-5 bg-white shadow-card text-center animate-slide-up">
          <p className="text-sm text-slate-600 mb-3">
            Ready for your check-in based on {goals.length} {goals.length === 1 ? 'goal' : 'goals'}.
          </p>
          <button
            onClick={() => generate()}
            disabled={generating}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-rose-500 to-amber-500 hover:from-rose-400 hover:to-amber-400 transition-all disabled:opacity-50"
          >
            <Sparkles size={14} /> Get this week&apos;s check-in
          </button>
        </div>
      )}
    </section>
  )
}
