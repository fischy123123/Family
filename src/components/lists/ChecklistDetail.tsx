'use client'

import { useState } from 'react'
import { Plus, Trash2, ArrowLeft } from 'lucide-react'
import { useSheetsData } from '@/hooks/useSheetsData'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { Checklist, ChecklistItem, Template } from '@/lib/types'
import { generateId } from '@/lib/utils'

interface ChecklistDetailProps {
  checklist: Checklist
  onBack: () => void
}

export function ChecklistDetail({ checklist, onBack }: ChecklistDetailProps) {
  const { data: checklists, update } = useSheetsData<Checklist>('checklists')
  const { data: templates } = useSheetsData<Template>('templates')
  const [newItem, setNewItem] = useState('')

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

      {/* Progress bar */}
      <div className="h-2 bg-gray-100 rounded-full mb-4 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, backgroundColor: current.colorHex }} />
      </div>

      {/* Apply template */}
      {checklistTemplates.length > 0 && current.items.length === 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 mb-2">Start from a template:</p>
          <div className="flex flex-wrap gap-2">
            {checklistTemplates.map((t) => (
              <Button key={t.id} size="sm" variant="outline" onClick={() => applyTemplate(t)}>
                {t.name}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Items */}
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

      {/* Add item */}
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
