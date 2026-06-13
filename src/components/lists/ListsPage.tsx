'use client'

import { useState } from 'react'
import { Plus, ListChecks, ShoppingCart, UtensilsCrossed, Trash2 } from 'lucide-react'
import { useSheetsData } from '@/hooks/useSheetsData'
import { ChecklistDetail } from './ChecklistDetail'
import { ShoppingListDetail } from './ShoppingListDetail'
import { MealPlannerView } from './meals/MealPlannerView'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { MEMBER_COLORS } from '@/lib/types'
import type { Checklist, ShoppingList } from '@/lib/types'
import { generateId } from '@/lib/utils'

type Tab = 'checklists' | 'shopping' | 'meals'

function NewListForm({ type, onSave, onClose }: {
  type: Tab
  onSave: (name: string, colorHex: string, store?: string) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [store, setStore] = useState('')
  const [colorHex, setColorHex] = useState(MEMBER_COLORS[1])
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try { await onSave(name.trim(), colorHex, store || undefined); onClose() }
    finally { setSaving(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Input placeholder={type === 'checklists' ? 'Checklist name' : 'Shopping list name'} value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      {type === 'shopping' && <Input placeholder="Store (optional)" value={store} onChange={(e) => setStore(e.target.value)} />}
      <div>
        <p className="text-xs text-gray-500 mb-1.5">Color</p>
        <div className="flex flex-wrap gap-2">
          {MEMBER_COLORS.map((c) => (
            <button key={c} type="button" onClick={() => setColorHex(c)}
              className={`w-7 h-7 rounded-full border-2 ${colorHex === c ? 'border-gray-800 scale-110' : 'border-transparent'}`}
              style={{ backgroundColor: c }} />
          ))}
        </div>
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={saving} className="flex-1">{saving ? 'Creating...' : 'Create'}</Button>
      </div>
    </form>
  )
}

export function ListsPage({ defaultTab }: { defaultTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(defaultTab ?? 'checklists')
  const [formOpen, setFormOpen] = useState(false)
  const [selectedChecklist, setSelectedChecklist] = useState<Checklist>()
  const [selectedShoppingList, setSelectedShoppingList] = useState<ShoppingList>()

  const checklists = useSheetsData<Checklist>('checklists')
  const shoppingLists = useSheetsData<ShoppingList>('shopping_lists')

  if (selectedChecklist) {
    return <ChecklistDetail checklist={selectedChecklist} onBack={() => setSelectedChecklist(undefined)} />
  }
  if (selectedShoppingList) {
    return <ShoppingListDetail list={selectedShoppingList} onBack={() => setSelectedShoppingList(undefined)} />
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-gray-900">Lists</h1>
        {tab !== 'meals' && (
          <Button size="sm" onClick={() => setFormOpen(true)}>
            <Plus size={16} className="mr-1" /> New
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 bg-gray-100 p-1 rounded-xl">
        {([['checklists', 'Checklists', ListChecks], ['shopping', 'Shopping', ShoppingCart], ['meals', 'Meals', UtensilsCrossed]] as const).map(([t, label, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 rounded-lg text-xs font-medium transition-colors ${
              tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}
          >
            <Icon size={14} />{label}
          </button>
        ))}
      </div>

      {tab === 'checklists' && (
        <div className="space-y-2">
          {checklists.data.map((c) => {
            const done = c.items.filter((i) => i.isCompleted).length
            const total = c.items.length
            const pct = total > 0 ? Math.round((done / total) * 100) : 0
            return (
              <div
                key={c.id}
                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-100 shadow-sm cursor-pointer hover:border-blue-200 transition-colors"
                onClick={() => setSelectedChecklist(c)}
              >
                <div className="w-1 h-10 rounded-full shrink-0" style={{ backgroundColor: c.colorHex }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{c.name}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: c.colorHex }} />
                    </div>
                    <p className="text-xs text-gray-400 shrink-0">{done}/{total}</p>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); checklists.remove(c.id) }}
                  className="p-1 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-400 shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
          {checklists.data.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <ListChecks size={40} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Create your first checklist</p>
            </div>
          )}
        </div>
      )}

      {tab === 'shopping' && (
        <div className="space-y-2">
          {shoppingLists.data.map((s) => {
            const remaining = s.items.filter((i) => !i.isPurchased).length
            return (
              <div
                key={s.id}
                className="flex items-center gap-3 p-4 bg-white rounded-xl border border-gray-100 shadow-sm cursor-pointer hover:border-blue-200 transition-colors"
                onClick={() => setSelectedShoppingList(s)}
              >
                <div className="w-1 h-10 rounded-full shrink-0" style={{ backgroundColor: s.colorHex }} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-900">{s.name}</p>
                  <p className="text-xs text-gray-400">
                    {remaining} items left{s.store ? ` · ${s.store}` : ''}
                  </p>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); shoppingLists.remove(s.id) }}
                  className="p-1 rounded-lg hover:bg-red-50 text-gray-300 hover:text-red-400 shrink-0"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )
          })}
          {shoppingLists.data.length === 0 && (
            <div className="text-center py-12 text-gray-400">
              <ShoppingCart size={40} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Create your first shopping list</p>
            </div>
          )}
        </div>
      )}

      {tab === 'meals' && <MealPlannerView />}

      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={tab === 'checklists' ? 'New Checklist' : 'New Shopping List'}
      >
        <NewListForm
          type={tab}
          onClose={() => setFormOpen(false)}
          onSave={async (name, colorHex, store) => {
            if (tab === 'checklists') {
              await checklists.create({ id: generateId(), name, colorHex, items: [], createdAt: new Date().toISOString() })
            } else {
              await shoppingLists.create({ id: generateId(), name, store, colorHex, items: [] })
            }
          }}
        />
      </Dialog>
    </div>
  )
}
