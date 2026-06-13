'use client'

import { useState } from 'react'
import { Plus, Trash2, ArrowLeft, Sparkles } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { SHOPPING_CATEGORIES } from '@/lib/types'
import type { ShoppingList, ShoppingItem, Template } from '@/lib/types'
import { generateId } from '@/lib/utils'

interface ShoppingListDetailProps {
  list: ShoppingList
  onBack: () => void
}

export function ShoppingListDetail({ list, onBack }: ShoppingListDetailProps) {
  const { data: shoppingLists, update } = useFirestore<ShoppingList>('shopping_lists')
  const { data: templates } = useFirestore<Template>('templates')
  const { toast } = useToast()
  const [aiLoading, setAiLoading] = useState(false)
  const [newName, setNewName] = useState('')
  const [newQty, setNewQty] = useState('1')
  const [newUnit, setNewUnit] = useState('')
  const [newCategory, setNewCategory] = useState<string>(SHOPPING_CATEGORIES[0])

  const current = shoppingLists.find((s) => s.id === list.id) ?? list

  const grouped = SHOPPING_CATEGORIES.reduce<Record<string, ShoppingItem[]>>((acc, cat) => {
    const items = current.items.filter((i) => i.category === cat && !i.isPurchased)
    if (items.length > 0) acc[cat] = items
    return acc
  }, {})

  const purchased = current.items.filter((i) => i.isPurchased)
  const remaining = current.items.filter((i) => !i.isPurchased).length

  async function addItem() {
    if (!newName.trim()) return
    const item: ShoppingItem = {
      id: generateId(), name: newName.trim(),
      quantity: parseFloat(newQty) || 1, unit: newUnit,
      category: newCategory, isPurchased: false,
    }
    await update({ ...current, items: [...current.items, item] })
    setNewName('')
    setNewQty('1')
  }

  async function togglePurchased(id: string) {
    await update({
      ...current,
      items: current.items.map((i) => (i.id === id ? { ...i, isPurchased: !i.isPurchased } : i)),
    })
  }

  async function deleteItem(id: string) {
    await update({ ...current, items: current.items.filter((i) => i.id !== id) })
  }

  async function clearPurchased() {
    await update({ ...current, items: current.items.filter((i) => !i.isPurchased) })
  }

  async function applyTemplate(t: Template) {
    const items: ShoppingItem[] = t.items.map((name) => ({
      id: generateId(), name, quantity: 1, unit: '', category: 'Other', isPurchased: false,
    }))
    await update({ ...current, items: [...current.items, ...items] })
  }

  async function generateWithAI() {
    setAiLoading(true)
    try {
      const res = await fetch('/api/ai/generate-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: current.name, kind: 'shopping' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'AI error')
      const generated: { name: string; quantity?: number; category?: string }[] = data.items ?? []
      const items: ShoppingItem[] = generated
        .filter((g) => g && typeof g.name === 'string')
        .map((g) => ({
          id: generateId(), name: g.name, quantity: g.quantity ?? 1, unit: '',
          category: g.category ?? 'Other', isPurchased: false,
        }))
      await update({ ...current, items: [...current.items, ...items] })
      toast(`AI added ${items.length} items`, 'success')
    } catch (e: unknown) {
      toast(e instanceof Error ? e.message : 'AI error', 'error')
    } finally {
      setAiLoading(false)
    }
  }

  const shoppingTemplates = templates.filter((t) => t.kind === 'shopping')

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <h1 className="text-lg font-bold text-gray-900">{current.name}</h1>
          <p className="text-xs text-gray-400">{remaining} items remaining{current.store ? ` · ${current.store}` : ''}</p>
        </div>
        {purchased.length > 0 && (
          <Button size="sm" variant="ghost" onClick={clearPurchased} className="text-xs text-red-500">
            Clear purchased
          </Button>
        )}
      </div>

      {current.items.length === 0 && (
        <div className="mb-4 space-y-3">
          <Button size="sm" onClick={generateWithAI} disabled={aiLoading} className="w-full">
            <Sparkles size={14} className="mr-1.5" />
            {aiLoading ? 'Generating…' : `Generate "${current.name}" list with AI`}
          </Button>
          {shoppingTemplates.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 mb-2">Or use a template:</p>
              <div className="flex flex-wrap gap-2">
                {shoppingTemplates.map((t) => (
                  <Button key={t.id} size="sm" variant="outline" onClick={() => applyTemplate(t)}>{t.name}</Button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} className="mb-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{cat}</h2>
          <div className="space-y-1">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100 shadow-sm group">
                <button
                  onClick={() => togglePurchased(item.id)}
                  className={`w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 ${item.isPurchased ? 'border-green-500 bg-green-500' : 'border-gray-300'}`}
                >
                  {item.isPurchased && <span className="text-white text-xs">✓</span>}
                </button>
                <p className={`text-sm flex-1 ${item.isPurchased ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                  {item.name}
                </p>
                {(item.quantity > 1 || item.unit) && (
                  <Badge variant="secondary" className="text-xs shrink-0">
                    {item.quantity}{item.unit}
                  </Badge>
                )}
                <button
                  onClick={() => deleteItem(item.id)}
                  className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-400"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {purchased.length > 0 && (
        <div className="mb-4 opacity-40">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
            Purchased ({purchased.length})
          </h2>
          <div className="space-y-1">
            {purchased.map((item) => (
              <div key={item.id} className="flex items-center gap-3 p-3 bg-white rounded-xl border border-gray-100">
                <button onClick={() => togglePurchased(item.id)} className="w-5 h-5 rounded-md border-2 border-green-500 bg-green-500 flex items-center justify-center shrink-0">
                  <span className="text-white text-xs">✓</span>
                </button>
                <p className="text-sm line-through text-gray-400 flex-1">{item.name}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-gray-100 pt-4 space-y-2">
        <Input placeholder="Item name..." value={newName} onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') addItem() }} />
        <div className="flex gap-2">
          <Input type="number" placeholder="Qty" value={newQty} onChange={(e) => setNewQty(e.target.value)} className="w-16" />
          <Input placeholder="Unit" value={newUnit} onChange={(e) => setNewUnit(e.target.value)} className="w-20" />
          <Select value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className="flex-1">
            {SHOPPING_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <Button size="icon" onClick={addItem} disabled={!newName.trim()}>
            <Plus size={16} />
          </Button>
        </div>
      </div>
    </div>
  )
}
