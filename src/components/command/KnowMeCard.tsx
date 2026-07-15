'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { MessageCircleQuestion, Send, Mic, Square, Loader2, Check, X, Sparkles } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { useToast } from '@/contexts/ToastContext'
import { generateId } from '@/lib/utils'
import { resolveMemberRef } from '@/lib/members'
import type { FamilyMember, FamilyMemory, FamilyGoal, FamilyProfile, PersonalProfile, LifeArea } from '@/lib/types'

type InterviewQuestion = {
  text: string
  why?: string
  kind: 'learn' | 'refresh'
  target?: { type: 'memory' | 'goal'; id: string; currentText: string }
}

type InterviewState = {
  id: string
  currentQuestion?: InterviewQuestion | null
  lastAskedAt?: string
  lastAnsweredAt?: string
  recentQuestions?: string[]
}

type IngestOp =
  | { op: 'add_memory'; text: string; category?: FamilyMemory['category']; subjectNames?: string[]; expiresAt?: string }
  | { op: 'update_memory'; id: string; text: string }
  | { op: 'expire_memory'; id: string }
  | { op: 'refresh_memory'; id: string }
  | { op: 'deactivate_goal'; id: string }
  | { op: 'add_goal'; text: string; area?: LifeArea; cadence?: string; why?: string }
  | { op: 'update_profile'; patch: Partial<PersonalProfile> }

const PROFILE_KEYS: (keyof PersonalProfile)[] = [
  'goals', 'biggestStruggle', 'energizers', 'drainers', 'startStrategies', 'avoiding',
  'rhythm', 'fixedAnchors', 'householdRoles', 'careSchedule', 'planStyle', 'protectRest',
  'nonNegotiables', 'freeform',
]

const STALE_MS = 45 * 24 * 60 * 60 * 1000
const ASK_EVERY_MS = 20 * 60 * 60 * 1000  // roughly one question per day

// The "getting to know you" card. The app decides what it most needs to know
// (or which aging fact to re-verify), asks ONE conversational question, and
// distills the answer into structured knowledge automatically. This flips the
// burden: the user never has to think about what to tell the app.
export function KnowMeCard() {
  const { user } = useAuth()
  const { toast } = useToast()
  const { data: members } = useFirestore<FamilyMember>('members')
  const { data: memories, create: createMemory, update: updateMemory } = useFirestore<FamilyMemory>('memories')
  const { data: goals, create: createGoal, update: updateGoal } = useFirestore<FamilyGoal>('goals')
  const { data: profiles } = useFirestore<FamilyProfile>('profile')
  const { data: personalProfiles, create: createPP, update: updatePP } = useFirestore<PersonalProfile>('personalProfiles')
  const { data: states, create: createState, update: updateState } = useFirestore<InterviewState>('interviewState')

  const myKey = user?.email ? user.email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() : null
  const state = useMemo(() => (myKey ? states.find((s) => s.id === myKey) ?? null : null), [states, myKey])
  const myProfile = useMemo(() => (myKey ? personalProfiles.find((p) => p.id === myKey) ?? null : null), [personalProfiles, myKey])

  const [question, setQuestion] = useState<InterviewQuestion | null>(null)
  const [fetching, setFetching] = useState(false)
  const [answer, setAnswer] = useState('')
  const [showAnswerBox, setShowAnswerBox] = useState(false)
  const [applying, setApplying] = useState(false)
  const [learned, setLearned] = useState<string | null>(null)
  const autoFetched = useRef(false)

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  // Compact digest of everything known — the engine picks its question from this.
  function buildDigest() {
    const today = new Date().toISOString().slice(0, 10)
    const active = memories.filter((m) => !m.expiresAt || m.expiresAt >= today)
    return {
      members: members.map((m) => ({ name: m.name, role: m.role })),
      profile: profiles[0] ?? null,
      personalProfile: myProfile,
      memories: active.slice(0, 80).map((m) => {
        const freshest = m.confirmedAt ?? m.createdAt
        return {
          id: m.id, text: m.text, category: m.category,
          notedOn: (freshest ?? '').slice(0, 10),
          aging: !m.pinned && Date.now() - new Date(freshest).getTime() > STALE_MS,
          pinned: m.pinned,
        }
      }),
      goals: goals.filter((g) => g.active).map((g) => ({ id: g.id, text: g.text, area: g.area, cadence: g.cadence })),
      recentQuestions: state?.recentQuestions ?? [],
      now: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }

  async function saveState(patch: Partial<InterviewState>) {
    if (!myKey) return
    const next = { ...(state ?? { id: myKey }), ...patch, id: myKey }
    try {
      if (state) await updateState(next as InterviewState)
      else await createState(next as InterviewState)
    } catch { /* non-fatal */ }
  }

  async function fetchQuestion() {
    if (fetching || !myKey) return
    setFetching(true)
    setLearned(null)
    try {
      const res = await fetch('/api/ai/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'question', ...buildDigest() }),
      })
      const data = await res.json()
      if (res.ok && data.question?.text) {
        setQuestion(data.question)
        setShowAnswerBox(data.question.kind !== 'refresh')
        setAnswer('')
        saveState({ currentQuestion: data.question, lastAskedAt: new Date().toISOString() })
      }
    } catch { /* stay quiet — card just shows the ask button */ } finally {
      setFetching(false)
    }
  }

  // Restore a pending question, or auto-ask roughly once a day.
  useEffect(() => {
    if (!myKey || autoFetched.current || question) return
    if (state === null && states.length === 0) return  // still hydrating
    if (state?.currentQuestion?.text) {
      setQuestion(state.currentQuestion)
      setShowAnswerBox(state.currentQuestion.kind !== 'refresh')
      autoFetched.current = true
      return
    }
    const last = state?.lastAnsweredAt ?? state?.lastAskedAt
    if (!last || Date.now() - new Date(last).getTime() > ASK_EVERY_MS) {
      // Wait until the knowledge digest has something to chew on.
      if (members.length > 0) {
        autoFetched.current = true
        fetchQuestion()
      }
    } else {
      /* stays collapsed — the idle chip renders when no question is active */
      autoFetched.current = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myKey, state, states, members.length])

  async function finishQuestion(learnedText: string | null) {
    const recent = [...(state?.recentQuestions ?? []), ...(question ? [question.text] : [])].slice(-20)
    await saveState({ currentQuestion: null, lastAnsweredAt: new Date().toISOString(), recentQuestions: recent })
    setQuestion(null)
    setAnswer('')
    setShowAnswerBox(false)
    if (learnedText) setLearned(learnedText)
    // no learned line → the idle chip renders on next paint
  }

  async function applyOps(ops: IngestOp[]) {
    const now = new Date().toISOString()
    const today = now.slice(0, 10)
    for (const op of ops) {
      try {
        if (op.op === 'add_memory' && op.text?.trim()) {
          const subjectEmails = (op.subjectNames ?? [])
            .map((n) => resolveMemberRef(members, n))
            .filter(Boolean)
            .map((m) => m!.email || m!.id)
          await createMemory({
            id: generateId(), text: op.text.trim(), category: op.category ?? 'fact',
            ...(subjectEmails.length ? { subjectEmails } : {}),
            ...(op.expiresAt ? { expiresAt: op.expiresAt } : {}),
            source: 'manual', createdAt: now,
          } as FamilyMemory)
        } else if (op.op === 'update_memory') {
          const m = memories.find((x) => x.id === op.id)
          if (m) await updateMemory({ ...m, text: op.text, confirmedAt: now })
        } else if (op.op === 'expire_memory') {
          const m = memories.find((x) => x.id === op.id)
          if (m) await updateMemory({ ...m, expiresAt: today })
        } else if (op.op === 'refresh_memory') {
          const m = memories.find((x) => x.id === op.id)
          if (m) await updateMemory({ ...m, confirmedAt: now })
        } else if (op.op === 'deactivate_goal') {
          const g = goals.find((x) => x.id === op.id)
          if (g) await updateGoal({ ...g, active: false })
        } else if (op.op === 'add_goal' && op.text?.trim()) {
          await createGoal({
            id: generateId(), text: op.text.trim(), area: (op.area ?? 'personal') as LifeArea,
            ...(op.cadence ? { cadence: op.cadence } : {}), ...(op.why ? { why: op.why } : {}),
            active: true, createdAt: now,
          } as FamilyGoal)
        } else if (op.op === 'update_profile' && op.patch && user?.email && myKey) {
          const patch: Partial<PersonalProfile> = {}
          for (const k of PROFILE_KEYS) {
            if (k in op.patch) (patch as Record<string, unknown>)[k] = (op.patch as Record<string, unknown>)[k]
          }
          const next = { ...(myProfile ?? { id: myKey, email: user.email }), ...patch, id: myKey, email: user.email, updatedAt: now }
          if (myProfile) await updatePP(next as PersonalProfile)
          else await createPP(next as PersonalProfile)
        }
      } catch { /* apply the rest — one failed op shouldn't lose the answer */ }
    }
  }

  async function submitAnswer() {
    const a = answer.trim()
    if (!a || !question || applying) return
    setApplying(true)
    try {
      const res = await fetch('/api/ai/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'ingest', question: question.text, questionKind: question.kind,
          target: question.target, answer: a, ...buildDigest(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      await applyOps(data.ops ?? [])
      await finishQuestion(data.learned || 'Got it — noted.')
    } catch {
      toast('Couldn’t save that — try again.', 'error')
    } finally {
      setApplying(false)
    }
  }

  // Refresh quick-actions: confirm or retire without an AI round-trip.
  async function quickStillTrue() {
    if (!question?.target) return
    const now = new Date().toISOString()
    if (question.target.type === 'memory') {
      const m = memories.find((x) => x.id === question.target!.id)
      if (m) await updateMemory({ ...m, confirmedAt: now })
    }
    await finishQuestion('Noted — still true. I’ll keep treating it as current.')
  }
  async function quickNoLonger() {
    if (!question?.target) return
    if (question.target.type === 'memory') {
      const m = memories.find((x) => x.id === question.target!.id)
      if (m) await updateMemory({ ...m, expiresAt: new Date().toISOString().slice(0, 10) })
    } else {
      const g = goals.find((x) => x.id === question.target!.id)
      if (g) await updateGoal({ ...g, active: false })
    }
    await finishQuestion('Cleared it — I’ll stop bringing that up.')
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        setRecording(false)
        if (blob.size === 0) return
        setTranscribing(true)
        try {
          const fd = new FormData()
          fd.append('file', blob, 'clip.webm')
          const res = await fetch('/api/transcribe', { method: 'POST', body: fd })
          const data = await res.json()
          if (res.ok && data.text) setAnswer((cur) => (cur.trim() ? `${cur.trim()} ${data.text}` : data.text))
        } catch { /* keep typed text */ } finally { setTranscribing(false) }
      }
      recorderRef.current = rec
      rec.start()
      setRecording(true)
    } catch { /* mic denied — typing still works */ }
  }

  if (!user?.email) return null

  // Collapsed chip / learned confirmation — keep the card tiny when idle.
  if (!question && !fetching) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-white shadow-card px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <MessageCircleQuestion size={15} className="text-teal-500 shrink-0" />
          {learned ? (
            <p className="text-xs text-slate-600 leading-relaxed">{learned}</p>
          ) : (
            <p className="text-xs text-slate-400">The more I know, the sharper the radar and plans get.</p>
          )}
        </div>
        <button
          onClick={fetchQuestion}
          className="shrink-0 text-xs font-semibold text-teal-600 hover:text-teal-700 transition-colors"
        >
          {learned ? 'Ask me another' : 'Ask me something'}
        </button>
      </div>
    )
  }

  return (
    <section className="rounded-2xl bg-white shadow-card p-4 border-l-[3px] border-teal-400">
      <div className="flex items-center gap-2 mb-2">
        <MessageCircleQuestion size={15} className="text-teal-500" />
        <h2 className="text-sm font-bold text-slate-800">Getting to know you</h2>
        {question?.kind === 'refresh' && (
          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-500 bg-amber-50 px-1.5 py-0.5 rounded-full">Still true?</span>
        )}
        {question && (
          <button
            onClick={() => finishQuestion(null)}
            aria-label="Skip"
            className="ml-auto p-1 -m-1 text-slate-300 hover:text-slate-500 transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {fetching ? (
        <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
          <Loader2 size={13} className="animate-spin" /> Thinking about what I most need to know…
        </div>
      ) : question ? (
        <div className="space-y-3">
          <div>
            <p className="text-sm text-slate-800 leading-relaxed">{question.text}</p>
            {question.why && <p className="text-[11px] text-slate-400 mt-1">Why: {question.why}</p>}
          </div>

          {question.kind === 'refresh' && question.target && !showAnswerBox && (
            <div className="flex items-center gap-2">
              <button
                onClick={quickStillTrue}
                className="flex-1 py-2 rounded-lg bg-green-50 text-green-700 text-xs font-semibold hover:bg-green-100 transition-colors inline-flex items-center justify-center gap-1"
              >
                <Check size={13} /> Still true
              </button>
              <button
                onClick={() => setShowAnswerBox(true)}
                className="flex-1 py-2 rounded-lg bg-slate-100 text-slate-600 text-xs font-semibold hover:bg-slate-200 transition-colors"
              >
                It changed…
              </button>
              <button
                onClick={quickNoLonger}
                className="flex-1 py-2 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100 transition-colors"
              >
                No longer
              </button>
            </div>
          )}

          {showAnswerBox && (
            <div className="flex items-end gap-2">
              <div className="relative flex-1">
                <textarea
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  rows={2}
                  placeholder={transcribing ? 'Transcribing…' : 'Type or talk — a sentence is plenty…'}
                  className="w-full text-sm rounded-lg pl-3 pr-10 py-2 border border-slate-200 focus:outline-none focus:border-teal-300 bg-slate-50 resize-none leading-relaxed"
                  disabled={applying}
                />
                <button
                  onClick={recording ? () => recorderRef.current?.stop() : startRecording}
                  aria-label={recording ? 'Stop recording' : 'Answer by voice'}
                  className={`absolute top-2 right-2 w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                    recording ? 'bg-rose-500 text-white animate-pulse' : 'bg-teal-50 text-teal-600 hover:bg-teal-100'
                  }`}
                >
                  {transcribing ? <Loader2 size={13} className="animate-spin" /> : recording ? <Square size={12} /> : <Mic size={13} />}
                </button>
              </div>
              <button
                onClick={submitAnswer}
                disabled={!answer.trim() || applying}
                className="w-9 h-9 rounded-xl bg-teal-600 text-white flex items-center justify-center disabled:opacity-40 transition-opacity shrink-0"
                aria-label="Save answer"
              >
                {applying ? <Loader2 size={15} className="animate-spin" /> : <Send size={14} />}
              </button>
            </div>
          )}

          {applying && (
            <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
              <Sparkles size={11} className="text-teal-500" /> Turning that into things I&apos;ll remember…
            </p>
          )}
        </div>
      ) : null}
    </section>
  )
}
