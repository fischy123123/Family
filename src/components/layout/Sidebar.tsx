'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { LayoutGrid, Users, Map, ListChecks, Sparkles, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/command', label: 'Command Center', icon: LayoutGrid },
  { href: '/family', label: 'Family', icon: Users },
  { href: '/plans', label: 'Plans', icon: Map },
  { href: '/lists', label: 'Lists', icon: ListChecks },
  { href: '/copilot', label: 'Copilot', icon: Sparkles },
]

export function Sidebar() {
  const pathname = usePathname()
  const { signOut, user } = useAuth()

  return (
    <aside className="hidden sm:flex flex-col w-[230px] min-h-screen bg-slate-900 border-r border-slate-800">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shrink-0">
            <span className="text-base">🏠</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">FamilyOS</h1>
            <p className="text-xs text-slate-500">Your chief of staff</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 py-2.5 rounded-xl text-sm transition-all duration-150 border-l-2 pl-[10px] pr-3',
                active
                  ? 'bg-blue-500/20 text-blue-400 font-medium border-blue-500'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border-transparent'
              )}
            >
              <Icon size={17} strokeWidth={active ? 2.5 : 2} />
              {label}
            </Link>
          )
        })}
      </nav>

      {/* User + sign out */}
      <div className="px-3 py-4 border-t border-slate-800 space-y-1">
        {user?.email && (
          <p className="px-3 text-xs text-slate-600 truncate mb-2">{user.email}</p>
        )}
        <button
          onClick={signOut}
          className="flex items-center gap-3 py-2 rounded-xl text-sm text-slate-500 hover:bg-slate-800 hover:text-slate-300 w-full transition-all duration-150 border-l-2 border-transparent pl-[10px] pr-3"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
