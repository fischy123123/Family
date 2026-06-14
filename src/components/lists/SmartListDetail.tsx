'use client'

import { useState } from 'react'
import {
  ArrowLeft,
  Check,
  Plus,
  Trash2,
  Store,
  Sparkles,
  Loader2,
  Repeat,
} from 'lucide-react'
import {
  SHOPPING_CATEGORIES,
  type SmartList,
  type SmartListItem,
} from '@/lib/types'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { cn, generateId } from '@/lib/utils'
import { mapGeneratedItems } from './CreateListForm'

interface SmartListDetailProps {
  list: SmartList
  onBack: () => void
}

const UNCATEGORIZED = 'Uncategorized'

export function SmartListDetail({ list, onBack }: SmartListDetailProps) {
  const { data, update, remove } = useFirestore<SmartList>('lists')
  const { toast } = useToast()
  const [newName, setNewName] = useState('')
  const [newQty, setNewQty] = useState('')
  const [newCategory, setNewCategory] = useState('')
  const [aiBusy, setAiBusy] = useState(false)

  // Always re-read the current list from live data, fall back to prop.
  const current = data.find((l) => l.id === list.id) ?? list

  const isShoppingKind = current.kind === 'grocery' || current.kind === 'shopping'

  async function persist(items: SmartListItem[]) {
    await update({ ...current, items })
  }

  async function addItem() {
    const name = newName.trim()
    if (!name) return
    const item: SmartListItem = { id: generateId(), name, isComplete: false }
    const qty = parseFloat(newQty)
    if (!Number.isNaN(qty) && qty > 0) item.quantity = qty
    if (isShoppingKind && newCategory) item.category = newCategory
    await persist([...current.items, item])
    setNewName('')
    setNewQty('')
  }

  async function toggleItem(id: string) {
    await persist(
      current.items.map((i) =>
        i.id === id ? { ...i, isComplete: !i.isComplete } : i
      )
    )
  }

  async function deleteItem(id: string) {
    await persist(current.items.filter((i) => i.id !== id))
  }

  async function clearCompleted() {
    await persist(current.items.filter((i) => !i.isComplete))
  }

  async function deleteList() {
    if (!confirm(`Delete "${current.name}"? This cannot be undone.`)) return
    await remove(current.id)
    toast('List deleted', 'success')
    onBack()
  }

  async function generateWithAI() {
    setAiBusy(true)
    try {
      const aiKind = isShoppingKind ? 'shopping' : 'checklist'
      const res = await fetch('/api/ai/generate-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: current.name, kind: aiKind }),
      })
      if (!res.ok) throw new Error('AI request failed')
      const { items: raw } = (await res.json()) as { items: unknown[] }
      const generated = mapGeneratedItems(raw)
      await persist([...current.items, ...generated])
      toast(`Added ${generated.length} items`, 'success')
    } catch {
      toast('Could not generate list', 'error')
    } finally {
      setAiBusy(false)
    }
  }

  const active = current.items.filter((i) => !i.isComplete)
  const completed = current.items.filter((i) => i.isComplete)
  const completedCount = completed.length
  const remaining = active.length

  // Group active items by category if any item has a category.
  const hasCategories = current.items.some((i) => i.category)
  const groups = hasCategories ? groupByCategory(active) : null

  return (
    <div className="max-w-2xl mx-auto animate-fade-in">
      {/* Header */}
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 transition-colors mb-5"
      >
        <ArrowLeft size={16} /> Back to lists
      </button>

      <div className="flex items-start gap-3">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl shrink-0"
          style={{ backgroundColor: `${current.colorHex}1A` }}
        >
          {current.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-slate-900 truncate">{current.name}</h1>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {current.store && (
              <span className="inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                <Store size={11} />
                {current.store}
              </span>
            )}
            <span className="text-xs text-slate-400">
              {remaining > 0
                ? `${remaining} remaining`
                : current.items.length > 0
                ? 'All done 🎉'
                : 'Empty list'}
            </span>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={deleteList}
          className="text-slate-400 hover:text-red-600 hover:bg-red-50 shrink-0"
          aria-label="Delete list"
        >
          <Trash2 size={18} />
        </Button>
      </div>

      {/* Empty items state */}
      {current.items.length === 0 && (
        <div className="mt-8 bg-white rounded-2xl shadow-card border border-slate-100 p-8 text-center">
          <div className="text-4xl mb-3">{current.emoji}</div>
          <h3 className="font-bold text-slate-900">This list is empty</h3>
          <p className="text-slate-500 mt-1 mb-5 text-sm">
            Add items below, or let AI build it for you.
          </p>
          <Button
            onClick={generateWithAI}
            disabled={aiBusy}
            size="lg"
            className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500"
          >
            {aiBusy ? (
              <Loader2 size={18} className="mr-1.5 animate-spin" />
            ) : (
              <Sparkles size={18} className="mr-1.5" />
            )}
            Generate with AI
          </Button>
        </div>
      )}

      {/* Items */}
      {current.items.length > 0 && (
        <div className="mt-6 space-y-6">
          {hasCategories && groups ? (
            groups.map(({ category, items }) => (
              <div key={category}>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2 px-1">
                  {category}
                </h4>
                <div className="bg-white rounded-2xl shadow-card border border-slate-100 divide-y divide-slate-100 overflow-hidden">
                  {items.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      onToggle={() => toggleItem(item.id)}
                      onDelete={() => deleteItem(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))
          ) : (
            active.length > 0 && (
              <div className="bg-white rounded-2xl shadow-card border border-slate-100 divide-y divide-slate-100 overflow-hidden">
                {active.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onToggle={() => toggleItem(item.id)}
                    onDelete={() => deleteItem(item.id)}
                  />
                ))}
              </div>
            )
          )}

          {/* Completed */}
          {completedCount > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2 px-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Completed · {completedCount}
                </h4>
                <button
                  onClick={clearCompleted}
                  className="text-xs font-medium text-slate-400 hover:text-red-600 transition-colors"
                >
                  Clear completed
                </button>
              </div>
              <div className="bg-white rounded-2xl shadow-card border border-slate-100 divide-y divide-slate-100 overflow-hidden opacity-70">
                {completed.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    onToggle={() => toggleItem(item.id)}
                    onDelete={() => deleteItem(item.id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add-item bar */}
      <div className="sticky bottom-4 mt-6">
        <div className="bg-white rounded-2xl shadow-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Add an item…"
              className="flex-1 min-w-[10rem]"
              onKeyDown={(e) => {
                if (e.key === 'Enter') addItem()
              }}
            />
            {isShoppingKind && (
              <>
                <Input
                  value={newQty}
                  onChange={(e) => setNewQty(e.target.value)}
                  placeholder="Qty"
                  type="number"
                  min="0"
                  className="w-20"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addItem()
                  }}
                />
                <Select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="w-40"
                >
                  <option value="">Category</option>
                  {SHOPPING_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </>
            )}
            <Button
              onClick={addItem}
              size="icon"
              className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 shrink-0"
              aria-label="Add item"
            >
              <Plus size={18} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ItemRow({
  item,
  onToggle,
  onDelete,
}: {
  item: SmartListItem
  onToggle: () => void
  onDelete: () => void
}) {
  const qtyLabel =
    item.quantity != null
      ? `${item.quantity}${item.unit ? ` ${item.unit}` : ''}`
      : item.unit ?? ''

  return (
    <div className="group flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
      <button
        onClick={onToggle}
        className={cn(
          'w-5 h-5 rounded-full border-2 flex items-center justify-center transition-all shrink-0',
          item.isComplete
            ? 'bg-green-500 border-green-500 text-white'
            : 'border-slate-300 hover:border-green-400'
        )}
        aria-label={item.isComplete ? 'Mark incomplete' : 'Mark complete'}
      >
        {item.isComplete && <Check size={13} strokeWidth={3} />}
      </button>

      <div className="flex-1 min-w-0 flex items-center gap-2">
        <span
          className={cn(
            'text-sm truncate',
            item.isComplete ? 'line-through text-slate-400' : 'text-slate-800'
          )}
        >
          {item.name}
        </span>
        {item.isRecurring && (
          <Repeat size={12} className="text-slate-400 shrink-0" aria-label="Recurring" />
        )}
      </div>

      {qtyLabel && (
        <span className="text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5 shrink-0">
          {qtyLabel}
        </span>
      )}

      <button
        onClick={onDelete}
        className="text-slate-300 hover:text-red-500 transition-all opacity-0 group-hover:opacity-100 shrink-0"
        aria-label="Delete item"
      >
        <Trash2 size={15} />
      </button>
    </div>
  )
}

// Group active items by SHOPPING_CATEGORIES order, with uncategorized last.
function groupByCategory(
  items: SmartListItem[]
): { category: string; items: SmartListItem[] }[] {
  const order = [...SHOPPING_CATEGORIES, UNCATEGORIZED]
  const buckets = new Map<string, SmartListItem[]>()
  for (const item of items) {
    const cat = item.category && item.category.trim() ? item.category : UNCATEGORIZED
    const arr = buckets.get(cat) ?? []
    arr.push(item)
    buckets.set(cat, arr)
  }
  const result: { category: string; items: SmartListItem[] }[] = []
  // Known categories in canonical order first.
  for (const cat of order) {
    const arr = buckets.get(cat)
    if (arr && arr.length) {
      result.push({ category: cat, items: arr })
      buckets.delete(cat)
    }
  }
  // Any remaining (non-canonical) categories.
  buckets.forEach((arr, cat) => {
    if (arr.length) result.push({ category: cat, items: arr })
  })
  return result
}
