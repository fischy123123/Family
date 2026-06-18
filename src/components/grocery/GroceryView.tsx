'use client'

import { useState, useMemo } from 'react'
import { Plus, Trash2, ShoppingCart, Sparkles, Loader2, ChevronRight, Check } from 'lucide-react'
import { useFirestore } from '@/hooks/useFirestore'
import { useAuth } from '@/contexts/AuthContext'
import { generateId } from '@/lib/utils'
import { cn } from '@/lib/utils'
import type { GroceryItem, GroceryCategory } from '@/lib/types'

const CATEGORY_META: Record<GroceryCategory, { label: string; emoji: string; order: number }> = {
  produce:   { label: 'Produce',    emoji: '🥦', order: 1 },
  dairy:     { label: 'Dairy',      emoji: '🥛', order: 2 },
  meat:      { label: 'Meat',       emoji: '🥩', order: 3 },
  bakery:    { label: 'Bakery',     emoji: '🍞', order: 4 },
  pantry:    { label: 'Pantry',     emoji: '🥫', order: 5 },
  frozen:    { label: 'Frozen',     emoji: '🧊', order: 6 },
  household: { label: 'Household',  emoji: '🧹', order: 7 },
  other:     { label: 'Other',      emoji: '🛒', order: 8 },
}

type Mode = 'restock' | 'shop'

export function GroceryView() {
  const { user } = useAuth()
  const { data: items, loading, create, update, remove } = useFirestore<GroceryItem>('groceryItems')

  // Add item form state
  const [newName, setNewName] = useState('')
  const [newCategory, setNewCategory] = useState<GroceryCategory>('other')
  const [newFrequency, setNewFrequency] = useState<'always' | 'sometimes'>('sometimes')
  const [submitting, setSubmitting] = useState(false)

  // Mode
  const [mode, setMode] = useState<Mode>('restock')

  // AI suggest state
  const [suggesting, setSuggesting] = useState(false)
  const [suggestError, setSuggestError] = useState('')

  const needItems = useMemo(() => items.filter((i) => i.status === 'need'), [items])
  const stockedItems = useMemo(() => items.filter((i) => i.status === 'stocked'), [items])

  // Group items by category, sorted by category order
  function groupByCategory(list: GroceryItem[]) {
    const groups = new Map<GroceryCategory, GroceryItem[]>()
    for (const item of list) {
      const cat = item.category ?? 'other'
      if (!groups.has(cat)) groups.set(cat, [])
      groups.get(cat)!.push(item)
    }
    return Array.from(groups.entries()).sort(
      ([a], [b]) => CATEGORY_META[a].order - CATEGORY_META[b].order
    )
  }

  async function handleAddItem(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setSubmitting(true)
    try {
      await create({
        id: generateId(),
        name,
        category: newCategory,
        frequency: newFrequency,
        status: 'need',
        addedBy: user?.email ?? undefined,
        createdAt: new Date().toISOString(),
      })
      setNewName('')
    } finally {
      setSubmitting(false)
    }
  }

  async function toggleItemStatus(item: GroceryItem) {
    const now = new Date().toISOString()
    if (item.status === 'need') {
      await update({ ...item, status: 'stocked', lastBoughtAt: now })
    } else {
      await update({ ...item, status: 'need' })
    }
  }

  async function handleSmartSuggest() {
    setSuggesting(true)
    setSuggestError('')
    try {
      const res = await fetch('/api/ai/grocery-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'AI error')
      const suggestedIds: string[] = data.suggestedIds ?? []
      // Mark suggested items as 'need'
      for (const id of suggestedIds) {
        const item = items.find((i) => i.id === id)
        if (item && item.status === 'stocked') {
          await update({ ...item, status: 'need' })
        }
      }
      if (suggestedIds.length === 0) {
        setSuggestError('Nothing to restock right now.')
      }
    } catch (e: unknown) {
      setSuggestError(e instanceof Error ? e.message : 'AI suggestion failed')
    } finally {
      setSuggesting(false)
    }
  }

  async function handleDeleteItem(id: string) {
    await remove(id)
  }

  // Shop mode: all items checked
  const allChecked = needItems.length > 0 && needItems.every((i) => i.status === 'stocked')

  // This is for when we're in shop mode — only show need items
  const shopItems = useMemo(() => items.filter((i) => i.status === 'need'), [items])
  const shopTotal = needItems.length + stockedItems.length

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // ── Shop Mode ──────────────────────────────────────────────────────────────
  if (mode === 'shop') {
    const shopGroups = groupByCategory(shopItems)
    const checkedCount = needItems.length - shopItems.length
    // Actually track progress: total items that were 'need' when we entered shop mode
    // We track via the original needItems count at that time — we'll use a simple count

    // Progress: items that started as 'need' but are now stocked (i.e., not in shopItems)
    // For simplicity: total need+stocked relative to what was 'need' when shop started
    // We'll track this by looking at items that have a recent lastBoughtAt
    const progress = shopTotal > 0 ? Math.round(((shopTotal - shopItems.length) / shopTotal) * 100) : 0

    const isDone = shopItems.length === 0

    return (
      <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
        {/* Header */}
        <div className="rounded-2xl bg-white shadow-card p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Shopping</h1>
              {!isDone && (
                <p className="text-sm text-slate-500">{shopItems.length} item{shopItems.length !== 1 ? 's' : ''} left</p>
              )}
            </div>
            <button
              onClick={() => setMode('restock')}
              className="px-4 py-2 rounded-xl bg-slate-100 text-slate-700 text-sm font-medium hover:bg-slate-200 transition-colors"
            >
              Done
            </button>
          </div>

          {/* Progress bar */}
          {shopTotal > 0 && (
            <div className="space-y-1">
              <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <p className="text-xs text-slate-400 text-right">{progress}% complete</p>
            </div>
          )}
        </div>

        {/* All done state */}
        {isDone ? (
          <div className="rounded-2xl bg-emerald-50 border border-emerald-100 p-8 text-center space-y-4">
            <div className="text-4xl">🛒</div>
            <h2 className="text-xl font-bold text-emerald-800">All done!</h2>
            <p className="text-sm text-emerald-600">Everything is checked off. Great shopping trip!</p>
            <button
              onClick={() => setMode('restock')}
              className="px-6 py-3 rounded-xl bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-700 transition-colors"
            >
              Done shopping
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            {shopGroups.map(([category, catItems]) => {
              const meta = CATEGORY_META[category]
              return (
                <div key={category} className="rounded-2xl bg-white shadow-card overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-slate-50">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                      {meta.emoji} {meta.label}
                    </span>
                  </div>
                  <ul className="divide-y divide-slate-50">
                    {catItems.map((item) => (
                      <li key={item.id}>
                        <button
                          onClick={() => toggleItemStatus(item)}
                          className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-slate-50 transition-colors text-left"
                          style={{ minHeight: 56 }}
                        >
                          {/* Large checkbox — 44px+ touch target */}
                          <div className={cn(
                            'w-7 h-7 rounded-lg border-2 flex items-center justify-center shrink-0 transition-all',
                            item.status === 'stocked'
                              ? 'bg-emerald-500 border-emerald-500'
                              : 'border-slate-300 bg-white'
                          )}>
                            {item.status === 'stocked' && <Check size={14} className="text-white" strokeWidth={3} />}
                          </div>
                          <span className={cn(
                            'text-sm font-medium flex-1',
                            item.status === 'stocked' ? 'line-through text-slate-400' : 'text-slate-800'
                          )}>
                            {item.name}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  // ── Restock Mode ───────────────────────────────────────────────────────────
  const restockGroups = groupByCategory(items)

  return (
    <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
      {/* Header */}
      <div className="rounded-2xl bg-white shadow-card p-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Weekly Shop</h1>
            <p className="text-sm text-slate-500">
              {needItems.length} needed · {stockedItems.length} stocked
            </p>
          </div>
          {needItems.length > 0 && (
            <button
              onClick={() => setMode('shop')}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 transition-colors"
            >
              Start shopping
              <ChevronRight size={15} />
            </button>
          )}
        </div>
      </div>

      {/* Add item form */}
      <div className="rounded-2xl bg-white shadow-card p-4">
        <form onSubmit={handleAddItem} className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Add item…"
                className="w-full pr-12 pl-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-800 placeholder-slate-400 focus:outline-none focus:border-emerald-400 focus:bg-white transition-colors"
              />
            </div>
            <button
              type="submit"
              disabled={!newName.trim() || submitting}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-40 transition-colors shrink-0"
            >
              {submitting ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Add
            </button>
          </div>

          {/* Category + Frequency row */}
          <div className="flex gap-2 items-center">
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as GroceryCategory)}
              className="flex-1 text-xs pl-3 pr-8 py-2 rounded-lg border border-slate-200 bg-slate-50 text-slate-700 focus:outline-none focus:border-emerald-400 appearance-none"
            >
              {(Object.entries(CATEGORY_META) as [GroceryCategory, typeof CATEGORY_META[GroceryCategory]][])
                .sort(([, a], [, b]) => a.order - b.order)
                .map(([key, meta]) => (
                  <option key={key} value={key}>
                    {meta.emoji} {meta.label}
                  </option>
                ))
              }
            </select>

            {/* Frequency toggle */}
            <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs shrink-0">
              <button
                type="button"
                onClick={() => setNewFrequency('always')}
                className={cn(
                  'px-3 py-2 font-medium transition-colors',
                  newFrequency === 'always'
                    ? 'bg-blue-500 text-white'
                    : 'bg-white text-slate-500 hover:bg-slate-50'
                )}
              >
                Always
              </button>
              <button
                type="button"
                onClick={() => setNewFrequency('sometimes')}
                className={cn(
                  'px-3 py-2 font-medium transition-colors border-l border-slate-200',
                  newFrequency === 'sometimes'
                    ? 'bg-blue-500 text-white'
                    : 'bg-white text-slate-500 hover:bg-slate-50'
                )}
              >
                Sometimes
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Items list */}
      {items.length === 0 ? (
        <div className="rounded-2xl bg-white shadow-card p-8 text-center space-y-2">
          <ShoppingCart size={32} className="text-slate-300 mx-auto" />
          <p className="text-sm font-medium text-slate-500">No grocery items yet</p>
          <p className="text-xs text-slate-400">Add items above to build your list</p>
        </div>
      ) : (
        <div className="space-y-4">
          {restockGroups.map(([category, catItems]) => {
            const meta = CATEGORY_META[category]
            return (
              <div key={category} className="rounded-2xl bg-white shadow-card overflow-hidden">
                <div className="px-4 py-2.5 border-b border-slate-50">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    {meta.emoji} {meta.label}
                  </span>
                </div>
                <ul className="divide-y divide-slate-50">
                  {catItems.map((item) => (
                    <li key={item.id} className="flex items-center gap-3 px-4 py-3 group" style={{ minHeight: 52 }}>
                      {/* Checkbox */}
                      <button
                        onClick={() => toggleItemStatus(item)}
                        className={cn(
                          'w-7 h-7 rounded-lg border-2 flex items-center justify-center shrink-0 transition-all',
                          item.status === 'stocked'
                            ? 'bg-emerald-500 border-emerald-500'
                            : 'border-slate-300 bg-white hover:border-emerald-400'
                        )}
                        style={{ minWidth: 28, minHeight: 28 }}
                        aria-label={`Mark ${item.name} as ${item.status === 'need' ? 'stocked' : 'needed'}`}
                      >
                        {item.status === 'stocked' && <Check size={14} className="text-white" strokeWidth={3} />}
                      </button>

                      {/* Name + badges */}
                      <div className="flex-1 min-w-0 flex items-center gap-2">
                        <span className={cn(
                          'text-sm font-medium truncate',
                          item.status === 'stocked' ? 'text-slate-400 line-through' : 'text-slate-800'
                        )}>
                          {item.name}
                        </span>
                        {/* Always frequency indicator */}
                        {item.frequency === 'always' && (
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" title="Always buy" />
                        )}
                        {item.frequency === 'always' && (
                          <span className="text-[10px] font-medium text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded-full shrink-0">
                            always
                          </span>
                        )}
                      </div>

                      {/* Delete button — shown inline (visible on hover on desktop, always on mobile) */}
                      <button
                        onClick={() => handleDeleteItem(item.id)}
                        className="p-1.5 rounded-lg text-slate-300 hover:text-red-400 hover:bg-red-50 transition-colors opacity-0 group-hover:opacity-100 sm:opacity-0 max-sm:opacity-100"
                        aria-label={`Delete ${item.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}

      {/* Smart suggest */}
      <div className="rounded-2xl bg-white shadow-card p-4 space-y-2">
        <button
          onClick={handleSmartSuggest}
          disabled={suggesting || items.length === 0}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl border-2 border-dashed border-emerald-200 text-emerald-700 text-sm font-medium hover:bg-emerald-50 disabled:opacity-40 transition-colors"
        >
          {suggesting ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Sparkles size={16} />
          )}
          {suggesting ? 'Checking what to restock…' : 'Smart suggest'}
        </button>
        {suggestError && (
          <p className="text-xs text-center text-slate-500">{suggestError}</p>
        )}
        <p className="text-xs text-center text-slate-400">
          AI reviews your stocked items and marks what you probably need this week
        </p>
      </div>
    </div>
  )
}
