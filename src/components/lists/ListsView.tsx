'use client'

import { useState } from 'react'
import { Plus, Store } from 'lucide-react'
import { LIST_KINDS, type ListKind, type SmartList } from '@/lib/types'
import { useFirestore } from '@/hooks/useFirestore'
import { useToast } from '@/contexts/ToastContext'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CreateListForm } from './CreateListForm'
import { SmartListDetail } from './SmartListDetail'

type View =
  | { mode: 'grid' }
  | { mode: 'create' }
  | { mode: 'detail'; id: string }

export function ListsView() {
  const { data: lists, loading, create } = useFirestore<SmartList>('lists')
  const { toast } = useToast()
  const [view, setView] = useState<View>({ mode: 'grid' })
  const [filter, setFilter] = useState<ListKind | 'all'>('all')

  async function handleCreated(list: SmartList) {
    try {
      const created = await create(list)
      toast('List created', 'success')
      setView({ mode: 'detail', id: created.id })
    } catch {
      toast('Could not create list', 'error')
    }
  }

  if (view.mode === 'create') {
    return (
      <CreateListForm
        onDone={() => setView({ mode: 'grid' })}
        onCreated={handleCreated}
      />
    )
  }

  if (view.mode === 'detail') {
    const list = lists.find((l) => l.id === view.id)
    if (list) {
      return <SmartListDetail list={list} onBack={() => setView({ mode: 'grid' })} />
    }
    // list gone (deleted) — fall back to grid
  }

  const filtered =
    filter === 'all' ? lists : lists.filter((l) => l.kind === filter)
  const sorted = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  return (
    <div className="max-w-5xl mx-auto animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Lists</h1>
          <p className="text-slate-500 mt-1">Smart lists that know your family</p>
        </div>
        <Button
          onClick={() => setView({ mode: 'create' })}
          size="lg"
          className="bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 self-start sm:self-auto"
        >
          <Plus size={18} className="mr-1.5" /> New List
        </Button>
      </div>

      {/* Filter chips */}
      {lists.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-6">
          <FilterChip active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </FilterChip>
          {LIST_KINDS.map((k) => (
            <FilterChip
              key={k.kind}
              active={filter === k.kind}
              onClick={() => setFilter(k.kind)}
            >
              <span className="mr-1">{k.emoji}</span>
              {k.label}
            </FilterChip>
          ))}
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="flex justify-center py-24">
          <div className="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : lists.length === 0 ? (
        <EmptyState onCreate={() => setView({ mode: 'create' })} />
      ) : sorted.length === 0 ? (
        <div className="text-center py-20 text-slate-400">
          No lists of this type yet.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-6 stagger-children">
          {sorted.map((list) => (
            <ListCard
              key={list.id}
              list={list}
              onClick={() => setView({ mode: 'detail', id: list.id })}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex items-center px-4 py-1.5 rounded-full text-sm font-medium transition-all',
        active
          ? 'bg-gradient-to-r from-blue-600 to-purple-600 text-white shadow-sm'
          : 'bg-white text-slate-600 border border-slate-200 hover:border-slate-300 hover:bg-slate-50'
      )}
    >
      {children}
    </button>
  )
}

function ListCard({ list, onClick }: { list: SmartList; onClick: () => void }) {
  const total = list.items.length
  const done = list.items.filter((i) => i.isComplete).length
  const remaining = total - done
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const kindLabel = LIST_KINDS.find((k) => k.kind === list.kind)?.label ?? list.kind

  return (
    <button
      onClick={onClick}
      className="text-left bg-white rounded-2xl shadow-card border border-slate-100 p-5 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg group"
    >
      <div className="flex items-start gap-3">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center text-xl shrink-0"
          style={{ backgroundColor: `${list.colorHex}1A` }}
        >
          {list.emoji}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-bold text-slate-900 truncate group-hover:text-blue-600 transition-colors">
            {list.name}
          </h3>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-xs text-slate-400 capitalize">{kindLabel}</span>
            {list.store && (
              <span className="inline-flex items-center gap-1 text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                <Store size={11} />
                {list.store}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between text-xs mb-1.5">
          <span className="text-slate-500">
            {done} of {total} done
          </span>
          <span className="text-slate-400">
            {remaining > 0 ? `${remaining} left` : total > 0 ? 'Complete' : 'Empty'}
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-600 to-purple-600 transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </button>
  )
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-24 animate-fade-in">
      <div className="text-6xl mb-4">📝</div>
      <h2 className="text-xl font-bold text-slate-900">No lists yet</h2>
      <p className="text-slate-500 mt-1 max-w-sm">
        Create your first smart list — groceries, packing, tasks and more.
      </p>
      <Button
        onClick={onCreate}
        size="lg"
        className="mt-6 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500"
      >
        <Plus size={18} className="mr-1.5" /> New List
      </Button>
    </div>
  )
}
