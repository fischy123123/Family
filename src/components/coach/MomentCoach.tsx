'use client'

import { useState } from 'react'
import {
  Sparkles, ArrowRight, RefreshCw, Check, Loader2, Clock, Settings2, X, ChevronRight,
} from 'lucide-react'
import { useMomentCoach } from '@/hooks/useMomentCoach'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { generateId } from '@/lib/utils'
import {
  MOMENT_ENERGY_META, MOMENT_MOOD_META, MOMENT_KIND_META,
} from '@/lib/types'
import type {
  PersonalProfile, MomentEnergy, MomentMood, MomentMove, Task,
} from '@/lib/types'

const ENERGY_ORDER: MomentEnergy[] = ['wired', 'okay', 'drained']
const MOOD_ORDER: MomentMood[] = ['good', 'meh', 'low', 'anxious']

export function MomentCoach() {
  const {
    personalProfile, hasProfile, savePersonalProfile,
    guidance, loading, error, requestGuidance, clearGuidance,
  } = useMomentCoach()
  const { create: createTask } = useFirestore<Task>('tasks')
  const { toast } = useToast()

  const [setupOpen, setSetupOpen] = useState(false)
  const [energy, setEnergy] = useState<MomentEnergy | null>(null)
  const [mood, setMood] = useState<MomentMood | null>(null)
  const [showFallback, setShowFallback] = useState(false)

  const needsSetup = !hasProfile || setupOpen

  async function runCoach() {
    if (!energy) return
    setShowFallback(false)
    await requestGuidance(energy, mood ?? undefined)
  }

  function resetCheckIn() {
    clearGuidance()
    setEnergy(null)
    setMood(null)
    setShowFallback(false)
  }

  // Tapping "I did it" logs the move as a completed task so it becomes momentum
  // ("already done today") on the next check-in, then resets for the next thing.
  async function markDone(move: MomentMove) {
    try {
      await createTask({
        id: generateId(),
        title: move.title,
        isCompleted: true,
        completedAt: new Date().toISOString(),
        priority: 'none',
        source: 'ai',
        createdAt: new Date().toISOString(),
      } as Task)
    } catch { /* non-fatal — celebration still shows */ }
    toast('Nice — that counts. 🎉', 'success')
    resetCheckIn()
  }

  return (
    <section className="rounded-2xl p-5 bg-gradient-to-br from-violet-600 via-indigo-600 to-blue-600 text-white shadow-elevated">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-white/15 backdrop-blur flex items-center justify-center shrink-0">
            <Sparkles size={18} className="text-white" />
          </div>
          <div>
            <h2 className="text-lg font-bold tracking-tight leading-tight">Right now</h2>
            <p className="text-xs text-white/70">One thing, made easy to start.</p>
          </div>
        </div>
        {hasProfile && !needsSetup && (
          <button
            onClick={() => setSetupOpen(true)}
            className="p-1.5 rounded-lg text-white/60 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Edit about me"
          >
            <Settings2 size={16} />
          </button>
        )}
      </div>

      {needsSetup ? (
        <QuickSetup
          existing={personalProfile}
          onCancel={hasProfile ? () => setSetupOpen(false) : undefined}
          onSave={async (patch) => { await savePersonalProfile(patch); setSetupOpen(false) }}
        />
      ) : loading ? (
        <div className="rounded-xl bg-white/10 p-6 flex flex-col items-center justify-center gap-3">
          <Loader2 size={22} className="animate-spin text-white/90" />
          <p className="text-sm text-white/80">Thinking about what fits this moment…</p>
        </div>
      ) : guidance ? (
        <GuidanceCard
          guidance={guidance}
          showFallback={showFallback}
          onShowFallback={() => setShowFallback(true)}
          onDone={markDone}
          onSomethingElse={runCoach}
          onNewCheckIn={resetCheckIn}
        />
      ) : (
        <CheckIn
          energy={energy} mood={mood}
          setEnergy={setEnergy} setMood={setMood}
          onSubmit={runCoach}
          error={error}
        />
      )}
    </section>
  )
}

// ── Check-in: pick energy (required) + mood (optional), then ask ────────────
function CheckIn({
  energy, mood, setEnergy, setMood, onSubmit, error,
}: {
  energy: MomentEnergy | null
  mood: MomentMood | null
  setEnergy: (e: MomentEnergy) => void
  setMood: (m: MomentMood) => void
  onSubmit: () => void
  error: string | null
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-white/60 mb-2">Energy right now</p>
        <div className="grid grid-cols-3 gap-2">
          {ENERGY_ORDER.map((e) => {
            const meta = MOMENT_ENERGY_META[e]
            const active = energy === e
            return (
              <button
                key={e}
                onClick={() => setEnergy(e)}
                className={`rounded-xl py-2.5 flex flex-col items-center gap-1 transition-all border ${
                  active ? 'bg-white text-slate-900 border-white shadow-card' : 'bg-white/10 text-white border-white/15 hover:bg-white/20'
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
        <p className="text-xs font-semibold uppercase tracking-wider text-white/60 mb-2">
          Mood <span className="font-normal normal-case text-white/40">· optional</span>
        </p>
        <div className="grid grid-cols-4 gap-2">
          {MOOD_ORDER.map((m) => {
            const meta = MOMENT_MOOD_META[m]
            const active = mood === m
            return (
              <button
                key={m}
                onClick={() => setMood(m)}
                className={`rounded-xl py-2 flex flex-col items-center gap-0.5 transition-all border ${
                  active ? 'bg-white text-slate-900 border-white shadow-card' : 'bg-white/10 text-white border-white/15 hover:bg-white/20'
                }`}
              >
                <span className="text-base leading-none">{meta.emoji}</span>
                <span className="text-[11px] font-medium">{meta.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {error && <p className="text-xs text-rose-100 bg-rose-500/30 rounded-lg px-3 py-2">{error}</p>}

      <button
        onClick={onSubmit}
        disabled={!energy}
        className="w-full py-3 rounded-xl bg-white text-indigo-700 font-bold text-sm flex items-center justify-center gap-2 shadow-card disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.99] transition-transform"
      >
        Tell me what to do
        <ArrowRight size={16} />
      </button>
    </div>
  )
}

// ── Guidance: pep + primary move + fallback + big picture ────────────────────
function GuidanceCard({
  guidance, showFallback, onShowFallback, onDone, onSomethingElse, onNewCheckIn,
}: {
  guidance: import('@/lib/types').MomentGuidance
  showFallback: boolean
  onShowFallback: () => void
  onDone: (m: MomentMove) => void
  onSomethingElse: () => void
  onNewCheckIn: () => void
}) {
  const { pep, primary, fallback, bigPicture } = guidance
  return (
    <div className="space-y-3">
      {pep && <p className="text-sm leading-relaxed text-white/90">{pep}</p>}

      <MoveCard move={primary} onDone={() => onDone(primary)} primary />

      {fallback && (
        showFallback ? (
          <div className="animate-slide-up">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-white/50 mb-1.5 ml-1">If that&apos;s too much</p>
            <MoveCard move={fallback} onDone={() => onDone(fallback)} />
          </div>
        ) : (
          <button
            onClick={onShowFallback}
            className="w-full text-left text-xs font-medium text-white/70 hover:text-white flex items-center gap-1.5 px-1 py-1 transition-colors"
          >
            <ChevronRight size={13} />
            That feels like too much — show me something smaller
          </button>
        )
      )}

      {bigPicture && (
        <p className="text-xs italic text-white/60 border-l-2 border-white/20 pl-3">{bigPicture}</p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSomethingElse}
          className="flex-1 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
        >
          <RefreshCw size={13} /> Something else
        </button>
        <button
          onClick={onNewCheckIn}
          className="flex-1 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
        >
          <X size={13} /> New check-in
        </button>
      </div>
    </div>
  )
}

function MoveCard({ move, onDone, primary }: { move: MomentMove; onDone: () => void; primary?: boolean }) {
  const kindMeta = move.kind ? MOMENT_KIND_META[move.kind] : null
  return (
    <div className={`rounded-xl p-4 ${primary ? 'bg-white text-slate-900 shadow-card' : 'bg-white/90 text-slate-900'}`}>
      <div className="flex items-start gap-2 mb-1.5">
        <h3 className="flex-1 text-[15px] font-bold leading-snug">{move.title}</h3>
        {kindMeta && (
          <span
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0"
            style={{ background: `${kindMeta.color}18`, color: kindMeta.color }}
          >
            {kindMeta.emoji} {kindMeta.label}
          </span>
        )}
      </div>
      {move.why && <p className="text-xs text-slate-500 leading-relaxed mb-3">{move.why}</p>}

      {move.firstStep && (
        <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-3 mb-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-indigo-500 mb-0.5">Start here</p>
          <p className="text-sm font-medium text-indigo-900 leading-snug">{move.firstStep}</p>
        </div>
      )}

      <div className="flex items-center justify-between">
        {move.minutes ? (
          <span className="inline-flex items-center gap-1 text-xs text-slate-400 font-medium">
            <Clock size={12} /> ~{move.minutes} min
          </span>
        ) : <span />}
        <button
          onClick={onDone}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold transition-colors active:scale-[0.98]"
        >
          <Check size={13} /> I did it
        </button>
      </div>
    </div>
  )
}

// ── Quick setup: a few essential questions, refine later ─────────────────────
function QuickSetup({
  existing, onSave, onCancel,
}: {
  existing: PersonalProfile | null
  onSave: (patch: Partial<PersonalProfile>) => void
  onCancel?: () => void
}) {
  const [goals, setGoals] = useState((existing?.goals ?? []).join('\n'))
  const [biggestStruggle, setBiggestStruggle] = useState(existing?.biggestStruggle ?? '')
  const [hasAdhd, setHasAdhd] = useState(existing?.hasAdhd ?? false)
  const [freeform, setFreeform] = useState(existing?.freeform ?? '')

  const linesToArr = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean)
  const canSave = linesToArr(goals).length > 0 || biggestStruggle.trim().length > 0

  return (
    <div className="rounded-xl bg-white/10 backdrop-blur p-4 space-y-4">
      <p className="text-sm text-white/85 leading-relaxed">
        {existing ? 'Update what I know about you.' : 'A few quick things, so my nudges actually fit you. You can refine these anytime.'}
      </p>

      <div>
        <label className="block text-xs font-semibold text-white/70 mb-1.5">
          What are you working toward right now? <span className="font-normal text-white/40">(one per line)</span>
        </label>
        <textarea
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
          rows={3}
          placeholder={'Be more present with the kids\nGet back to the gym\nFinish the garage project'}
          className="w-full text-sm rounded-lg px-3 py-2 bg-white/90 text-slate-900 placeholder:text-slate-400 focus:outline-none resize-none leading-relaxed"
        />
      </div>

      <div>
        <label className="block text-xs font-semibold text-white/70 mb-1.5">
          What most gets in your way?
        </label>
        <input
          value={biggestStruggle}
          onChange={(e) => setBiggestStruggle(e.target.value)}
          placeholder="e.g. I freeze when there's too much, and never start"
          className="w-full text-sm rounded-lg px-3 py-2 bg-white/90 text-slate-900 placeholder:text-slate-400 focus:outline-none"
        />
      </div>

      <button
        onClick={() => setHasAdhd((v) => !v)}
        className="flex items-center gap-2.5 w-full text-left"
      >
        <span className={`w-5 h-5 rounded-md flex items-center justify-center shrink-0 transition-colors ${hasAdhd ? 'bg-white' : 'bg-white/20 border border-white/30'}`}>
          {hasAdhd && <Check size={13} className="text-indigo-600" />}
        </span>
        <span className="text-sm text-white/85">I have ADHD / struggle to get started — lean on tiny first steps</span>
      </button>

      <div>
        <label className="block text-xs font-semibold text-white/70 mb-1.5">
          Anything else I should know? <span className="font-normal text-white/40">(optional)</span>
        </label>
        <textarea
          value={freeform}
          onChange={(e) => setFreeform(e.target.value)}
          rows={2}
          placeholder="What helps you, what drains you, what you keep avoiding…"
          className="w-full text-sm rounded-lg px-3 py-2 bg-white/90 text-slate-900 placeholder:text-slate-400 focus:outline-none resize-none leading-relaxed"
        />
      </div>

      <div className="flex items-center gap-2">
        {onCancel && (
          <button
            onClick={onCancel}
            className="px-3 py-2.5 rounded-xl text-sm font-medium text-white/70 hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => onSave({
            goals: linesToArr(goals),
            biggestStruggle: biggestStruggle.trim() || undefined,
            hasAdhd,
            freeform: freeform.trim() || undefined,
          })}
          disabled={!canSave}
          className="flex-1 py-2.5 rounded-xl bg-white text-indigo-700 font-bold text-sm shadow-card disabled:opacity-50 transition-opacity"
        >
          {existing ? 'Save' : 'Save & start'}
        </button>
      </div>
    </div>
  )
}
