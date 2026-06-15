'use client'

import { X, Check } from 'lucide-react'
import { INSIGHT_META, LIFE_AREAS } from '@/lib/types'
import type { CoachingInsight } from '@/lib/types'

export function InsightCard({
  insight, onDismiss, onAcknowledge, onAction,
}: {
  insight: CoachingInsight
  onDismiss?: () => void
  onAcknowledge?: () => void
  onAction?: (insight: CoachingInsight) => void
}) {
  const meta = INSIGHT_META[insight.type] ?? INSIGHT_META.pattern
  const area = insight.area ? LIFE_AREAS.find((a) => a.area === insight.area) : null

  return (
    <div
      className="rounded-2xl p-4 bg-white shadow-card animate-slide-up"
      style={{ borderLeft: `3px solid ${meta.color}` }}
    >
      <div className="flex items-start gap-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-base"
          style={{ background: `${meta.color}18` }}
        >
          {meta.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5 flex-wrap">
            <span
              className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{ background: `${meta.color}15`, color: meta.color }}
            >
              {meta.label}
            </span>
            {area && (
              <span className="inline-flex items-center gap-1 text-[10px] text-slate-400">
                {area.emoji} {area.label}
              </span>
            )}
          </div>
          <p className="text-sm font-semibold text-slate-900">{insight.title}</p>
          <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{insight.detail}</p>
          {insight.question && (
            <p className="text-xs text-slate-700 mt-2 italic leading-relaxed border-l-2 border-slate-200 pl-2.5">
              {insight.question}
            </p>
          )}
          {insight.suggestedAction && onAction && (
            <button
              onClick={() => onAction(insight)}
              className="mt-2.5 inline-flex items-center px-3 py-1.5 rounded-xl text-xs font-semibold text-white transition-all"
              style={{ background: meta.color }}
            >
              {insight.suggestedAction}
            </button>
          )}
        </div>
        <div className="flex items-start gap-0.5 shrink-0">
          {onAcknowledge && !insight.acknowledged && (
            <button
              onClick={onAcknowledge}
              className="p-1.5 rounded-lg text-slate-300 hover:text-green-600 hover:bg-green-50 transition-colors"
              title="Got it"
            >
              <Check size={14} />
            </button>
          )}
          {onDismiss && (
            <button
              onClick={onDismiss}
              className="p-1.5 rounded-lg text-slate-300 hover:text-slate-500 hover:bg-slate-50 transition-colors"
              title="Dismiss"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
