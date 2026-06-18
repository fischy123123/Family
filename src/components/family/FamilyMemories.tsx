'use client'

import { useState } from 'react'
import { Brain, Pin, PinOff, Trash2, Loader2, CornerDownLeft } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { generateId } from '@/lib/utils'
import type { FamilyMemory } from '@/lib/types'

// "What your assistant knows" — durable facts that shape every briefing. The
// add box is intentionally dead-simple: type or speak anything, and it sticks.
export function FamilyMemories() {
  const { data: memories, create, update, remove } = useFirestore<FamilyMemory>('memories')
  const { toast } = useToast()
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const ordered = [...memories].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })

  async function add() {
    const text = draft.trim()
    if (!text) return
    setSaving(true)
    try {
      await create({
        id: generateId(),
        text,
        source: 'manual',
        createdAt: new Date().toISOString(),
      } as FamilyMemory)
      setDraft('')
    } catch {
      toast('Could not save', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function togglePin(m: FamilyMemory) {
    await update({ ...m, pinned: !m.pinned })
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5 mb-6 animate-scale-in">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
          <Brain size={16} className="text-amber-600" />
        </div>
        <h2 className="text-base font-bold text-slate-900">What your assistant knows</h2>
      </div>
      <p className="text-xs text-slate-500 mb-4 ml-10">
        Tell it anything — facts, routines, preferences. It remembers and uses these in every briefing.
      </p>

      {/* Frictionless add */}
      <div className="relative mb-4">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add() } }}
          placeholder="e.g. Leo is allergic to peanuts · Trash goes out Tuesday nights · Grandma visits the first Sunday each month"
          rows={2}
          className="w-full input-premium px-3 py-2.5 pr-14 text-sm text-slate-800 resize-none"
        />
      </div>
      <button
        onClick={add}
        disabled={saving || !draft.trim()}
        className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 disabled:opacity-40 transition-all"
      >
        {saving ? <Loader2 size={15} className="animate-spin" /> : <CornerDownLeft size={15} />}
        {saving ? 'Saving…' : 'Remember this'}
      </button>

      {/* Known facts */}
      {ordered.length > 0 && (
        <div className="mt-5 space-y-2">
          {ordered.map((m) => (
            <div
              key={m.id}
              className="group flex items-start gap-3 p-3 rounded-xl border border-slate-100 bg-slate-50/50"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm text-slate-800 leading-relaxed">{m.text}</p>
                <div className="flex items-center gap-2 mt-1">
                  {m.source && m.source !== 'manual' && (
                    <span className="text-[10px] uppercase tracking-wide text-slate-400">via {m.source}</span>
                  )}
                  {m.pinned && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-600">
                      <Pin size={9} /> pinned
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-0.5 shrink-0">
                <button
                  onClick={() => togglePin(m)}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-amber-500 hover:bg-white transition-colors"
                  title={m.pinned ? 'Unpin' : 'Pin (always remembered)'}
                >
                  {m.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <button
                  onClick={() => remove(m.id)}
                  className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-white transition-colors"
                  title="Forget this"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
