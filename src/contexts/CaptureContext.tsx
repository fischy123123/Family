'use client'

import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { X, Sparkles, Camera, Loader2, Check, Calendar, ShoppingCart, ListTodo, Brain, CornerUpRight, Plane } from 'lucide-react'
import { useFamily } from '@/contexts/FamilyContext'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { generateId } from '@/lib/utils'
import { MicButton } from '@/components/ui/MicButton'
import type { FamilyMember, Task, CalendarEvent, SmartList, ExtractedOutcome, FamilyMemory } from '@/lib/types'

interface CaptureContextValue {
  open: (opts?: { text?: string; autoAnalyze?: boolean }) => void
  isOpen: boolean
}

const CaptureContext = createContext<CaptureContextValue>({ open: () => {}, isOpen: false })
export const useCapture = () => useContext(CaptureContext)

const OUTCOME_META: Record<string, { icon: typeof Calendar; color: string; label: string }> = {
  task: { icon: ListTodo, color: '#3B82F6', label: 'Task' },
  event: { icon: Calendar, color: '#8B5CF6', label: 'Event' },
  shopping_item: { icon: ShoppingCart, color: '#22C55E', label: 'Shopping' },
  packing_item: { icon: Plane, color: '#14B8A6', label: 'Packing' },
  memory: { icon: Brain, color: '#F59E0B', label: 'Memory' },
  follow_up: { icon: CornerUpRight, color: '#EC4899', label: 'Follow-up' },
}

export function CaptureProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const [text, setText] = useState('')
  const [imageData, setImageData] = useState<{ base64: string; mediaType: string; preview: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState('')
  const [outcomes, setOutcomes] = useState<ExtractedOutcome[]>([])
  const [applied, setApplied] = useState<Set<number>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: members } = useFirestore<FamilyMember>('members')
  const { create: createTask } = useFirestore<Task>('tasks')
  const { create: createEvent } = useFirestore<CalendarEvent>('events')
  const { data: lists, update: updateList, create: createList } = useFirestore<SmartList>('lists')
  const { create: createMemory } = useFirestore<FamilyMemory>('memories')
  const { toast } = useToast()

  const open = useCallback((opts?: { text?: string; autoAnalyze?: boolean }) => {
    const prefill = opts?.text ?? ''
    setIsOpen(true)
    setText(prefill)
    setImageData(null)
    setSummary('')
    setOutcomes([])
    setApplied(new Set())

    // If pre-filled text is provided and autoAnalyze is requested, immediately
    // call the extraction API so the user sees results right away.
    if (prefill && opts?.autoAnalyze) {
      setLoading(true)
      fetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: prefill,
          members: members.map((m) => ({ name: m.name, email: m.email, role: m.role })),
          today: new Date().toISOString(),
        }),
      })
        .then((r) => r.json())
        .then((data: { summary?: string; outcomes?: ExtractedOutcome[]; error?: string }) => {
          if (data.error) throw new Error(data.error)
          setSummary(data.summary ?? '')
          setOutcomes(data.outcomes ?? [])
        })
        .catch(() => { /* user can still type and manually analyze */ })
        .finally(() => setLoading(false))
    }
  }, [members])

  function close() {
    setIsOpen(false)
  }

  async function handleImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      setImageData({ base64, mediaType: file.type, preview: result })
    }
    reader.readAsDataURL(file)
  }

  async function process() {
    if (!text.trim() && !imageData) return
    setLoading(true)
    setOutcomes([])
    setSummary('')
    try {
      const res = await fetch('/api/ai/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rawText: text,
          imageBase64: imageData?.base64,
          imageMediaType: imageData?.mediaType,
          members: members.map((m) => ({ name: m.name, email: m.email, role: m.role })),
          today: new Date().toISOString(),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Extraction failed')
      setSummary(data.summary ?? '')
      setOutcomes(data.outcomes ?? [])
      if ((data.outcomes ?? []).length === 0) {
        toast('Nothing actionable found', 'info')
      }
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Extraction failed', 'error')
    } finally {
      setLoading(false)
    }
  }

  async function applyOutcome(o: ExtractedOutcome, idx: number) {
    try {
      if (o.kind === 'task' || o.kind === 'follow_up') {
        await createTask({
          id: generateId(),
          title: o.title,
          notes: o.notes ?? '',
          isCompleted: false,
          dueDate: o.date,
          assigneeEmail: o.assigneeEmail,
          priority: o.kind === 'follow_up' ? 'medium' : 'none',
          source: 'capture',
          createdAt: new Date().toISOString(),
        } as Task)
      } else if (o.kind === 'event') {
        const start = o.date ?? new Date().toISOString()
        const end = new Date(new Date(start).getTime() + 60 * 60 * 1000).toISOString()
        await createEvent({
          id: generateId(),
          title: o.title,
          start,
          end,
          isAllDay: false,
          notes: o.notes ?? '',
          calendarId: 'primary',
          ownerEmail: o.assigneeEmail ?? '',
          color: '#8B5CF6',
        })
      } else if (o.kind === 'shopping_item' || o.kind === 'packing_item') {
        const kind = o.kind === 'packing_item' ? 'packing' : 'grocery'
        let target = lists.find((l) => l.kind === kind)
        if (!target) {
          target = await createList({
            id: generateId(),
            name: kind === 'packing' ? 'Packing' : 'Groceries',
            kind,
            emoji: kind === 'packing' ? '🧳' : '🛒',
            colorHex: kind === 'packing' ? '#14B8A6' : '#22C55E',
            createdAt: new Date().toISOString(),
            items: [],
          } as SmartList)
        }
        await updateList({
          ...target,
          items: [...target.items, { id: generateId(), name: o.title, isComplete: false, notes: o.notes }],
        })
      } else if (o.kind === 'memory') {
        // Durable family knowledge — stored at the family level so the
        // assistant reasons through it in every briefing.
        await createMemory({
          id: generateId(),
          text: o.notes ? `${o.title} — ${o.notes}` : o.title,
          subjectEmail: o.assigneeEmail,
          source: 'capture',
          createdAt: new Date().toISOString(),
        } as FamilyMemory)
      }
      setApplied((prev) => new Set(prev).add(idx))
      toast('Added', 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'Could not add', 'error')
    }
  }

  async function applyAll() {
    for (let i = 0; i < outcomes.length; i++) {
      if (!applied.has(i)) await applyOutcome(outcomes[i], i)
    }
  }

  return (
    <CaptureContext.Provider value={{ open, isOpen }}>
      {children}
      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm animate-fade-in" onClick={close} />
          <div className="relative w-full sm:max-w-lg bg-white rounded-t-3xl sm:rounded-3xl shadow-float animate-slide-up max-h-[90vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                  <Sparkles size={16} className="text-white" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">Capture</h2>
                  <p className="text-xs text-slate-400">Drop anything — AI sorts it out</p>
                </div>
              </div>
              <button onClick={close} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <X size={18} />
              </button>
            </div>

            {/* Body — scrollable; no action buttons so keyboard can't bury them */}
            <div className="flex-1 overflow-auto p-5 space-y-4">
              {imageData && (
                <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageData.preview} alt="capture" className="max-h-40 rounded-xl border border-slate-200" />
                  <button onClick={() => setImageData(null)} className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-900 text-white flex items-center justify-center">
                    <X size={12} />
                  </button>
                </div>
              )}

              <div className="relative">
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Speak or type… e.g. 'Soccer signup due Friday, bring snacks for 12 kids'"
                  rows={3}
                  className="w-full input-premium px-4 py-3 pr-14 text-sm text-slate-800 resize-none"
                />
                <div className="absolute top-2.5 right-2.5">
                  <MicButton
                    size={38}
                    title="Tap to speak"
                    onText={(spoken) => setText((prev) => (prev ? prev.trim() + ' ' : '') + spoken)}
                  />
                </div>
              </div>

              {/* Outcomes */}
              {summary && (
                <div className="pt-1">
                  <p className="text-xs text-slate-400 mb-3 italic">{summary}</p>
                  <div className="space-y-2">
                    {outcomes.map((o, i) => {
                      const meta = OUTCOME_META[o.kind] ?? OUTCOME_META.task
                      const Icon = meta.icon
                      const isApplied = applied.has(i)
                      return (
                        <div
                          key={i}
                          className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 bg-white shadow-card"
                          style={{ borderLeftWidth: 3, borderLeftColor: meta.color }}
                        >
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${meta.color}18` }}>
                            <Icon size={15} style={{ color: meta.color }} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-800 truncate">{o.title}</p>
                            <p className="text-xs text-slate-400">
                              {meta.label}
                              {o.date ? ` · ${new Date(o.date).toLocaleDateString()}` : ''}
                              {o.assigneeEmail ? ` · ${members.find((m) => m.email === o.assigneeEmail)?.name ?? o.assigneeEmail}` : ''}
                            </p>
                          </div>
                          <button
                            onClick={() => applyOutcome(o, i)}
                            disabled={isApplied}
                            className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                            style={
                              isApplied
                                ? { background: '#dcfce7', color: '#16a34a' }
                                : { background: meta.color, color: 'white' }
                            }
                          >
                            {isApplied ? <Check size={14} /> : 'Add'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                  {outcomes.length > 1 && applied.size < outcomes.length && (
                    <button
                      onClick={applyAll}
                      className="w-full mt-3 py-2.5 rounded-xl text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 transition-colors"
                    >
                      Add all {outcomes.length}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Sticky footer — stays above the keyboard on mobile */}
            <div className="shrink-0 border-t border-slate-100 px-5 py-3 flex gap-2">
              <input ref={fileRef} type="file" accept="image/*" onChange={handleImage} className="hidden" />
              <button
                onClick={() => fileRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 transition-colors shrink-0"
              >
                <Camera size={15} />
                <span className="hidden sm:inline">Photo</span>
              </button>
              <button
                onClick={process}
                disabled={loading || (!text.trim() && !imageData)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 disabled:opacity-40 transition-all"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
                {loading ? 'Analyzing…' : 'Analyze'}
              </button>
            </div>
          </div>
        </div>
      )}
    </CaptureContext.Provider>
  )
}
