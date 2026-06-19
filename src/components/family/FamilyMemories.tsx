'use client'

import { useState } from 'react'
import { Brain, Pin, PinOff, Trash2, Loader2, CornerDownLeft, Sparkles } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { generateId } from '@/lib/utils'
import type { FamilyMemory, FamilyMember } from '@/lib/types'

export function FamilyMemories() {
  const { data: memories, create, update, remove } = useFirestore<FamilyMemory>('memories')
  const { data: members } = useFirestore<FamilyMember>('members')
  const { toast } = useToast()
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [cleaning, setCleaning] = useState(false)

  const ordered = [...memories].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })

  function memberRefs() {
    return members.map((m) => ({ id: m.id, name: m.name, email: m.email || undefined, role: m.role }))
  }

  async function add() {
    const text = draft.trim()
    if (!text) return
    setSaving(true)
    try {
      const res = await fetch('/api/ai/consolidate-memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newText: text, existingMemories: memories, members: memberRefs() }),
      })
      const result = res.ok ? await res.json() : null

      const subjectIdentifier: string | null = result?.subjectIdentifier ?? null
      const finalText: string = result?.finalText ?? text
      const supersededIds: string[] = result?.supersededIds ?? []

      for (const oldId of supersededIds) {
        await remove(oldId)
      }

      await create({
        id: generateId(),
        text: finalText,
        source: 'manual',
        createdAt: new Date().toISOString(),
        ...(subjectIdentifier ? { subjectEmail: subjectIdentifier } : {}),
      } as FamilyMemory)

      setDraft('')
      if (supersededIds.length > 0) {
        toast(`Memory updated — ${supersededIds.length} outdated ${supersededIds.length === 1 ? 'entry' : 'entries'} removed`, 'success')
      }
    } catch {
      toast('Could not save', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function cleanupMemories() {
    if (memories.length < 2) return
    setCleaning(true)
    try {
      const res = await fetch('/api/ai/cleanup-memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memories, members: memberRefs() }),
      })
      if (!res.ok) throw new Error('cleanup failed')
      const result = await res.json()

      const toDelete: string[] = result.toDelete ?? []
      const toMerge: Array<{ supersededIds: string[]; consolidatedText: string; subjectIdentifier: string | null }> = result.toMerge ?? []
      const toTag: Array<{ id: string; subjectIdentifier: string }> = result.toTag ?? []

      // Tag untagged memories that belong to a specific member
      for (const { id, subjectIdentifier } of toTag) {
        const memory = memories.find((m) => m.id === id)
        if (memory) await update({ ...memory, subjectEmail: subjectIdentifier })
      }

      // Delete fully redundant memories
      for (const id of toDelete) {
        await remove(id)
      }

      // Replace merged groups with a single consolidated entry
      for (const group of toMerge) {
        for (const id of group.supersededIds) {
          await remove(id)
        }
        await create({
          id: generateId(),
          text: group.consolidatedText,
          source: 'manual',
          createdAt: new Date().toISOString(),
          ...(group.subjectIdentifier ? { subjectEmail: group.subjectIdentifier } : {}),
        } as FamilyMemory)
      }

      const removed = toDelete.length + toMerge.reduce((n, g) => n + g.supersededIds.length, 0)
      const tagged = toTag.length
      const merged = toMerge.length

      if (removed === 0 && tagged === 0 && merged === 0) {
        toast('Memories are already clean', 'success')
      } else {
        const parts: string[] = []
        if (removed > 0) parts.push(`${removed} removed`)
        if (merged > 0) parts.push(`${merged} merged`)
        if (tagged > 0) parts.push(`${tagged} linked to family members`)
        toast(`Cleaned up: ${parts.join(', ')}`, 'success')
      }
    } catch {
      toast('Cleanup failed — try again', 'error')
    } finally {
      setCleaning(false)
    }
  }

  async function togglePin(m: FamilyMemory) {
    await update({ ...m, pinned: !m.pinned })
  }

  function memberNameForId(identifier: string): string | null {
    const byEmail = members.find((m) => m.email?.toLowerCase() === identifier.toLowerCase())
    if (byEmail) return byEmail.name
    const byId = members.find((m) => m.id === identifier)
    if (byId) return byId.name
    return null
  }

  return (
    <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-5 mb-6 animate-scale-in">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
          <Brain size={16} className="text-amber-600" />
        </div>
        <h2 className="text-base font-bold text-slate-900">What your assistant knows</h2>
        {memories.length >= 2 && (
          <button
            onClick={cleanupMemories}
            disabled={cleaning}
            className="ml-auto flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold text-violet-700 bg-violet-50 hover:bg-violet-100 border border-violet-200 disabled:opacity-50 transition-all"
            title="Have AI consolidate and clean up redundant memories"
          >
            {cleaning ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {cleaning ? 'Cleaning…' : 'Clean up'}
          </button>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-4 ml-10">
        Tell it anything — facts, routines, preferences. It remembers and uses these in every briefing.
      </p>

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

      {ordered.length > 0 && (
        <div className="mt-5 space-y-2">
          {ordered.map((m) => {
            const taggedName = m.subjectEmail ? memberNameForId(m.subjectEmail) : null
            return (
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
                    {taggedName && (
                      <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-full">
                        {taggedName}
                      </span>
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
            )
          })}
        </div>
      )}
    </div>
  )
}
