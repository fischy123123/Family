'use client'

import { useState } from 'react'
import { Bell, Dumbbell } from 'lucide-react'
import { RemindersView } from './reminders/RemindersView'
import { ChoresView } from './chores/ChoresView'

type Tab = 'reminders' | 'chores'

export function TasksPage({ defaultTab }: { defaultTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(defaultTab ?? 'reminders')

  return (
    <div>
      {/* Tab switcher */}
      <div className="flex gap-1 mx-4 mt-4 bg-gray-100 p-1 rounded-xl">
        {([['reminders', 'Reminders', Bell], ['chores', 'Chores', Dumbbell]] as const).map(([t, label, Icon]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'reminders' ? <RemindersView /> : <ChoresView />}
    </div>
  )
}
