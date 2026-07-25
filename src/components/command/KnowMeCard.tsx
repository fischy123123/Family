'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { MessageCircleQuestion, Send, Mic, Square, Loader2, Check, X, Sparkles, GraduationCap, ChevronRight } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { useKnowledgeOps, type IngestOp } from '@/hooks/useKnowledgeOps'
import { DeepDiveSheet } from './DeepDiveSheet'

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

const ASK_EVERY_MS = 20 * 60 * 60 * 1000  // roughly one question per day

// The "getting to know you" card. The app decides what it most needs to know
// (or which aging fact to re-verify), asks ONE conversational question, and
// distills the answer into structured knowledge automatically. This flips the
// burden: the user never has to think about what to tell the app. For a real
// sit-down, the Deep Dive button opens a full multi-turn training session.
export function KnowMeCard() {
  const { toast } = useToast()
  const { user, myKey, members, buildDigest, applyOps } = useKnowledgeOps()
  const { data: states, create: createState, update: updateState } = useFirestore<InterviewState>('interviewState')

  const state = useMemo(() => (myKey ? states.find((s) => s.id === myKey) ?? null : null), [states, myKey])

  const [question, setQuestion] = useState<InterviewQuestion | null>(null)
  const [fetching, setFetching] = useState(false)
  const [answer, setAnswer] = useState('')
  const [showAnswerBox, setShowAnswerBox] = useState(false)
  const [applying, setApplying] = useState(false)
  const [learned, setLearned] = useState<string | null>(null)
  const [deepDive, setDeepDive] = useState(false)
  const autoFetched = useRef(false)

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

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
        body: JSON.stringify({ mode: 'question', ...buildDigest(state?.recentQuestions) }),
      })
      const data = await res.json()
      if (res.ok && data.question?.text) {
        setQuestion(data.question)
        // Buttons only make sense for a refresh that targets a specific fact;
        // anything else (learn, or a refresh with no target) gets the text box.
        setShowAnswerBox(!(data.question.kind === 'refresh' && data.question.target))
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
      setShowAnswerBox(!(state.currentQuestion.kind === 'refresh' && state.currentQuestion.target))
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
          target: question.target, answer: a, ...buildDigest(state?.recentQuestions),
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

  // Refresh quick-actions: confirm or retire without an AI round-trip —
  // expressed as the same knowledge ops the engines emit.
  async function quickStillTrue() {
    if (!question?.target) return
    if (question.target.type === 'memory') {
      await applyOps([{ op: 'refresh_memory', id: question.target.id } as IngestOp])
    }
    await finishQuestion('Noted — still true. I’ll keep treating it as current.')
  }
  async function quickNoLonger() {
    if (!question?.target) return
    const op: IngestOp = question.target.type === 'memory'
      ? { op: 'expire_memory', id: question.target.id }
      : { op: 'deactivate_goal', id: question.target.id }
    await applyOps([op])
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

  const sheet = deepDive ? (
    <DeepDiveSheet
      onClose={() => setDeepDive(false)}
      onFinished={(captured) => {
        // A session counts as "answered" — don't fire the daily question right after.
        saveState({ lastAnsweredAt: new Date().toISOString() })
        if (captured > 0) setLearned(`Deep dive done — ${captured} thing${captured === 1 ? '' : 's'} captured.`)
      }}
    />
  ) : null

  // Collapsed chip / learned confirmation — keep the card tiny when idle.
  if (!question && !fetching) {
    return (
      <>
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-white shadow-card px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <MessageCircleQuestion size={15} className="text-teal-500 shrink-0" />
            {learned ? (
              <p className="text-xs text-slate-600 leading-relaxed">{learned}</p>
            ) : (
              <p className="text-xs text-slate-400">The more I know, the sharper the radar and plans get.</p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              onClick={fetchQuestion}
              className="text-xs font-semibold text-teal-600 hover:text-teal-700 transition-colors"
            >
              {learned ? 'Ask me another' : 'Ask me something'}
            </button>
            <button
              onClick={() => setDeepDive(true)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-white bg-teal-600 hover:bg-teal-700 rounded-lg px-2.5 py-1.5 transition-colors"
            >
              <GraduationCap size={13} /> Deep dive
            </button>
          </div>
        </div>
        {sheet}
      </>
    )
  }

  return (
    <>
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

      {/* Always visible, always labeled. One question a day is a trickle; this
          is the door to a real sit-down where you teach it everything at once. */}
      <button
        onClick={() => setDeepDive(true)}
        className="mt-3 w-full flex items-center gap-2.5 rounded-xl border border-teal-200 bg-teal-50/60 px-3 py-2.5 text-left hover:bg-teal-50 transition-colors"
      >
        <GraduationCap size={16} className="text-teal-600 shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block text-xs font-bold text-teal-800">Train me on your life</span>
          <span className="block text-[11px] text-teal-600/80">A real 15–60 min conversation — I ask, you talk</span>
        </span>
        <ChevronRight size={15} className="text-teal-400 shrink-0" />
      </button>
    </section>
    {sheet}
    </>
  )
}
