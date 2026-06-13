'use client'

import { useState } from 'react'
import { Plus, Trash2, ArrowLeft, Sparkles } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { Checklist, ChecklistItem, Template } from '@/lib/types'
import { generateId } from '@/lib/utils'

interface ChecklistDetailProps {
  checklist: Checklist
  onBack: () => void
}

export function ChecklistDetail({ checklist, onBack }: ChecklistDetailProps) {
  const { data: checklists, update } = useFirestore<Checklist>('checklists')
  const { data: templates } = useFirestore<Template>('templates')
  const { toast } = useToast()
  const [newItem, setNewItem] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const current = checklists.find((c) => c.id === checklist.id) ?? checklist
  const done = current.items.filter((i) => i.isCompleted).length
  const total = current.items.length
  const pct = total > 0 ? Math.round((done / total) * 100) : 0

  async function addItem() {
    if (!newItem.trim()) return
    const item: ChecklistItem = { id: generateId(), title: newItem.trim(), isCompleted: false }
    await update({ ...current, items: [...current.items, item] })
    setNewItem('')
  }

  async function toggleItem(id: string) {
    await update({
      ...current,
      items: current.items.map((i) => (i.id === id ? { ...i, isCompleted: !i.isCompleted } : i)),
    })
  }

  async function deleteItem(id: string) {
    await update({ ...current, items: current.items.filter((i) => i.id !== id) })
  }

  async function applyTemplate(template: Template) {
    const newItems: ChecklistItem[] = template.items.map((t) => ({
      id: generateId(), title: t, isCompleted: false,
    }))
    await update({ ...current, items: [...current.items, ...newItems] })
  }

  async function generateWithAI() {
    setAiLoading(true)
    try {
      const res = await fetch('/api/ai/generate-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: current.name, kind: 'checklist' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'AI error')
      const titles: string[] = data.items ?? []
      const newItems: ChecklistItem[] = titles
        .filter((t) => typeof t === 'string')
        .map((t) => ({ id: generateId(), title: t, isCompleted: false }))
      await update({ ...current, items: [...current.items, ...newItems] })
      toast(`AI added ${newItems.length} items`, 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'AI error', 'error')
    } finally {
      setAiLoading(false)
    }
  }

  const checklistTemplates = templates.filter((t) => t.kind === 'checklist')

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-lg font-bold text-gray-900">{current.name}</h1>
          <p className="text-xs text-gray-400">{done}/{total} done · {pct}%</p>
        </div>
      </div>

      <div className="h-2 bg-gray-100 rounded-full mb-4 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: current.colorHex }} />
      </div>

      {current.items.length === 0 && (
        <div className="mb-4 space-y-3">
          <Button size="sm" onClick={generateWithAI} disabled={aiLoading} className="w-full">
            <Sparkles size={14} className="mr-1.5" />
            {aiLoading ? 'Generating…' : `Generate "${current.name}" items with AI`}
          </Button>
          {checklistTemplates.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Or start from a template:</p>
              <div className="flex flex-wrap gap-2">
                {checklistTemplates.map((t) => (
                  <Button key={t.id} size="sm" variant="outline" onClick={() => applyTemplate(t)}>
                    {t.name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1 mb-4">
        {current.items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm group">
            <button
              onClick={() => toggleItem(item.id)}
              className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors ${
                item.isCompleted ? 'border-green-500 bg-green-500' : 'border-gray-300'
              }`}
            >
              {item.isCompleted && <span className="text-white text-xs">✓</span>}
            </button>
            <p className={`text-sm flex-1 ${item.isCompleted ? 'line-through text-gray-400' : 'text-gray-800'}`}>
              {item.title}
            </p>
            <button
              onClick={() => deleteItem(item.id)}
              className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400 transition-all"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <Input
          placeholder="Add item..."
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addItem() }}
        />
        <Button size="icon" onClick={addItem} disabled={!newItem.trim()}>
          <Plus size={16} />
        </Button>
      </div>
    </div>
  )
}
