'use client'

import { useRouter } from 'next/navigation'
import { ArrowLeft, Flame, Target, CheckCircle2, TrendingUp, HeartPulse, Sparkles } from 'lucide-react'
import { useInsights } from '@/hooks/useInsights'
import {
  MOMENT_ENERGY_META, MOMENT_MOOD_META, MOMENT_KIND_META, LIFE_AREAS,
} from '@/lib/types'
import type { MomentEnergy, MomentMood } from '@/lib/types'

const CAT_LABEL: Record<string, { label: string; emoji: string; color: string }> = {
  ...MOMENT_KIND_META,
  anchor: { label: 'Events', emoji: '📌', color: '#3B82F6' },
  other: { label: 'Other', emoji: '•', color: '#94A3B8' },
}

function dayLabel(dateStr: string): string {
  try { return new Date(`${dateStr}T00:00:00`).toLocaleDateString('en-US', { weekday: 'narrow' }) } catch { return '' }
}

function barColor(pct: number): string {
  if (pct >= 80) return '#22C55E'
  if (pct >= 40) return '#6366F1'
  if (pct > 0) return '#F59E0B'
  return '#E2E8F0'
}

export function InsightsView() {
  const router = useRouter()
  const d = useInsights()
  const today = (() => { const x = new Date(); return `${x.getFullYear()}-${`${x.getMonth() + 1}`.padStart(2, '0')}-${`${x.getDate()}`.padStart(2, '0')}` })()

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={() => router.push('/coach')} aria-label="Back" className="p-2 -ml-2 rounded-lg text-slate-500 hover:bg-slate-100 transition-colors">
          <ArrowLeft size={18} />
        </button>
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-blue-600 flex items-center justify-center shadow-card">
            <TrendingUp size={20} className="text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Your progress</h1>
            <p className="text-sm text-slate-400">How your days have been going</p>
          </div>
        </div>
      </div>

      {!d.hasHistory ? (
        <div className="rounded-2xl p-8 bg-white shadow-card text-center">
          <div className="text-3xl mb-2">📊</div>
          <p className="text-sm font-semibold text-slate-700">No history yet</p>
          <p className="text-xs text-slate-400 mt-1">Lock in a few daily plans and your stats will show up here.</p>
        </div>
      ) : (
        <>
          {/* Hero stats */}
          <div className="grid grid-cols-3 gap-3">
            <StatCard icon={Flame} color="#F97316" value={`${d.streak}`} label={d.streak === 1 ? 'day streak' : 'day streak'} />
            <StatCard icon={CheckCircle2} color="#22C55E" value={`${d.completionPct}%`} label="completed" />
            <StatCard icon={Target} color="#6366F1" value={`${d.itemsDone}`} label="things done" />
          </div>

          {/* Last 14 days */}
          <Section title="Last 14 days" sub={`${d.itemsDone} of ${d.itemsTotal} planned items done`}>
            <div className="flex items-end justify-between gap-1 h-28">
              {d.recentDays.map((day) => {
                const h = day.hasPlan ? Math.max(6, (day.pct / 100) * 100) : 4
                const isToday = day.date === today
                return (
                  <div key={day.date} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                    <div className="w-full flex-1 flex items-end">
                      <div
                        className="w-full rounded-md transition-all"
                        style={{ height: `${h}%`, background: barColor(day.hasPlan ? day.pct : -1), opacity: day.hasPlan ? 1 : 0.5 }}
                        title={day.hasPlan ? `${day.done}/${day.total} done` : 'No plan'}
                      />
                    </div>
                    <span className={`text-[9px] ${isToday ? 'font-bold text-indigo-600' : 'text-slate-400'}`}>{dayLabel(day.date)}</span>
                  </div>
                )
              })}
            </div>
          </Section>

          {/* Category balance */}
          {d.byCategory.length > 0 && (
            <Section title="Where your effort goes" sub="Completed vs planned, by type">
              <div className="space-y-2.5">
                {d.byCategory.map((c) => {
                  const meta = CAT_LABEL[c.key] ?? CAT_LABEL.other
                  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0
                  return (
                    <div key={c.key}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium text-slate-600">{meta.emoji} {meta.label}</span>
                        <span className="text-[11px] text-slate-400 tabular-nums">{c.done}/{c.total}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: meta.color }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          {/* Wellbeing */}
          {d.checkinCount > 0 && (
            <Section title="How you've been feeling" sub={`${d.checkinCount} check-in${d.checkinCount > 1 ? 's' : ''} in the last 30 days`}>
              <div className="space-y-3">
                <Distribution
                  rows={(['wired', 'okay', 'drained'] as MomentEnergy[]).map((k) => ({
                    label: MOMENT_ENERGY_META[k].label, emoji: MOMENT_ENERGY_META[k].emoji, color: MOMENT_ENERGY_META[k].color, n: d.energyMix[k],
                  }))}
                />
                <Distribution
                  rows={(['good', 'meh', 'low', 'anxious'] as MomentMood[]).map((k) => ({
                    label: MOMENT_MOOD_META[k].label, emoji: MOMENT_MOOD_META[k].emoji, color: MOMENT_MOOD_META[k].color, n: d.moodMix[k],
                  }))}
                />
                {d.followThroughPct !== null && (
                  <div className="flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-2.5">
                    <HeartPulse size={15} className="text-indigo-500 shrink-0" />
                    <p className="text-xs text-indigo-900">
                      You acted on <span className="font-bold">{d.followThroughPct}%</span> of the coach&apos;s in-the-moment nudges.
                    </p>
                  </div>
                )}
              </div>
            </Section>
          )}

          {/* Goals */}
          {d.goals.length > 0 && (
            <Section title="What you're working toward" sub="Your standing commitments">
              <div className="space-y-2">
                {d.goals.map((g) => {
                  const area = LIFE_AREAS.find((a) => a.area === g.area)
                  return (
                    <div key={g.id} className="rounded-xl p-3 bg-white shadow-card flex items-start gap-3" style={{ borderLeft: `3px solid ${area?.color ?? '#94a3b8'}` }}>
                      <span className="text-base mt-0.5">{area?.emoji ?? '🎯'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-900">{g.text}</p>
                        {(area?.label || g.cadence) && (
                          <p className="text-xs text-slate-400 mt-0.5">{area?.label}{g.cadence ? ` · ${g.cadence}` : ''}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          <button
            onClick={() => router.push('/coach')}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-500 hover:bg-slate-100 transition-colors flex items-center justify-center gap-1.5"
          >
            <Sparkles size={14} /> Back to today&apos;s plan
          </button>
        </>
      )}
    </div>
  )
}

function StatCard({ icon: Icon, color, value, label }: { icon: typeof Flame; color: string; value: string; label: string }) {
  return (
    <div className="rounded-2xl p-3.5 bg-white shadow-card flex flex-col items-center text-center gap-1">
      <Icon size={18} style={{ color }} />
      <span className="text-2xl font-bold text-slate-900 leading-none tabular-nums">{value}</span>
      <span className="text-[11px] text-slate-400 leading-tight">{label}</span>
    </div>
  )
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-5 bg-white shadow-card">
      <div className="mb-3">
        <h2 className="text-sm font-bold text-slate-800">{title}</h2>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
      </div>
      {children}
    </section>
  )
}

function Distribution({ rows }: { rows: { label: string; emoji: string; color: string; n: number }[] }) {
  const total = rows.reduce((s, r) => s + r.n, 0)
  if (total === 0) return null
  return (
    <div className="flex items-center gap-1.5">
      {rows.filter((r) => r.n > 0).map((r) => (
        <div
          key={r.label}
          className="h-8 rounded-lg flex items-center justify-center text-[11px] font-semibold gap-1 min-w-0 px-1"
          style={{ flexGrow: r.n, background: `${r.color}22`, color: r.color }}
          title={`${r.label}: ${r.n}`}
        >
          <span>{r.emoji}</span>
          <span className="tabular-nums">{r.n}</span>
        </div>
      ))}
    </div>
  )
}
