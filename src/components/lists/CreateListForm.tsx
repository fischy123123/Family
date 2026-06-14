'use client'

import { useState } from 'react'
import { ArrowLeft, Sparkles, Plus, Loader2 } from 'lucide-react'
import { LIST_KINDS, type ListKind, type SmartList, type SmartListItem } from '@/lib/types'
import { generateId } from '@/lib/utils'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'

interface CreateListFormProps {
  onDone: () => void
  onCreated: (list: SmartList) => void
}

// Default color per kind
const KIND_COLORS: Record<ListKind, string> = {
  grocery: '#22C55E',
  shopping: '#EC4899',
  packing: '#F59E0B',
  tasks: '#3B82F6',
  household: '#8B5CF6',
  custom: '#14B8A6',
}

function kindEmoji(kind: ListKind): string {
  return LIST_KINDS.find((k) => k.kind === kind)?.emoji ?? '📝'
}

export function CreateListForm({ onDone, onCreated }: CreateListFormProps) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<ListKind>('grocery')
  const [store, setStore] = useState('')
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)

  const showStore = kind === 'grocery' || kind === 'shopping'

  function buildList(items: SmartListItem[]): SmartList {
    const trimmedStore = store.trim()
    const list: SmartList = {
      id: generateId(),
      name: name.trim(),
      kind,
      emoji: kindEmoji(kind),
      colorHex: KIND_COLORS[kind],
      createdAt: new Date().toISOString(),
      items,
      ...(showStore && trimmedStore ? { store: trimmedStore } : {}),
    }
    return list
  }

  async function handleCreate() {
    if (!name.trim()) {
      toast('Give your list a name', 'error')
      return
    }
    setBusy(true)
    try {
      onCreated(buildList([]))
    } finally {
      setBusy(false)
    }
  }

  async function handleCreateWithAI() {
    if (!name.trim()) {
      toast('Give your list a name', 'error')
      return
    }
    setAiBusy(true)
    try {
      const aiKind = kind === 'grocery' || kind === 'shopping' ? 'shopping' : 'checklist'
      const res = await fetch('/api/ai/generate-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: name.trim(), kind: aiKind }),
      })
      if (!res.ok) throw new Error('AI request failed')
      const { items: raw } = (await res.json()) as { items: unknown[] }
      const items = mapGeneratedItems(raw)
      onCreated(buildList(items))
      toast(`Generated ${items.length} items`, 'success')
    } catch {
      toast('Could not generate list', 'error')
    } finally {
      setAiBusy(false)
    }
  }

  return (
    <div className="max-w-xl mx-auto animate-slide-up">
      <button
        onClick={onDone}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors mb-6"
      >
        <ArrowLeft size={16} /> Back to lists
      </button>

      <div className="bg-white rounded-2xl shadow-card border border-slate-100 p-6 sm:p-8">
        <h2 className="text-2xl font-bold text-slate-900">New List</h2>
        <p className="text-slate-500 mt-1">Create a smart list for your family</p>

        <div className="mt-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Weekly groceries, Beach trip packing…"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
              }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Type</label>
            <Select value={kind} onChange={(e) => setKind(e.target.value as ListKind)}>
              {LIST_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.emoji}  {k.label}
                </option>
              ))}
            </Select>
          </div>

          {showStore && (
            <div className="animate-fade-in">
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Store <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Input
                value={store}
                onChange={(e) => setStore(e.target.value)}
                placeholder="Whole Foods, Target…"
              />
            </div>
          )}
        </div>

        <div className="mt-8 flex flex-col sm:flex-row gap-3">
          <Button
            onClick={handleCreate}
            disabled={busy || aiBusy}
            variant="outline"
            size="lg"
            className="flex-1"
          >
            <Plus size={18} className="mr-1.5" /> Create
          </Button>
          <Button
            onClick={handleCreateWithAI}
            disabled={busy || aiBusy}
            size="lg"
            className="flex-1 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500"
          >
            {aiBusy ? (
              <Loader2 size={18} className="mr-1.5 animate-spin" />
            ) : (
              <Sparkles size={18} className="mr-1.5" />
            )}
            Create + generate with AI
          </Button>
        </div>
      </div>
    </div>
  )
}

// Map raw AI output (strings or objects) into SmartListItem[]
export function mapGeneratedItems(raw: unknown[]): SmartListItem[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry): SmartListItem | null => {
      if (typeof entry === 'string') {
        const name = entry.trim()
        if (!name) return null
        return { id: generateId(), name, isComplete: false }
      }
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>
        const name = typeof obj.name === 'string' ? obj.name.trim() : ''
        if (!name) return null
        const item: SmartListItem = { id: generateId(), name, isComplete: false }
        if (typeof obj.quantity === 'number' && obj.quantity > 0) item.quantity = obj.quantity
        if (typeof obj.unit === 'string' && obj.unit.trim()) item.unit = obj.unit.trim()
        if (typeof obj.category === 'string' && obj.category.trim()) item.category = obj.category.trim()
        return item
      }
      return null
    })
    .filter((i): i is SmartListItem => i !== null)
}
