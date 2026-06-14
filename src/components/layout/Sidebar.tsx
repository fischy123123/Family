'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import {
  Home,
  Calendar,
  ListChecks,
  ShoppingCart,
  UtensilsCrossed,
  Bell,
  Dumbbell,
  Users,
  BookMarked,
  LogOut,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: Home },
  { href: '/calendar', label: 'Calendar', icon: Calendar },
  { href: '/lists?tab=checklists', label: 'Checklists', icon: ListChecks },
  { href: '/lists?tab=shopping', label: 'Shopping', icon: ShoppingCart },
  { href: '/lists?tab=meals', label: 'Meals', icon: UtensilsCrossed },
  { href: '/tasks?tab=reminders', label: 'Reminders', icon: Bell },
  { href: '/tasks?tab=chores', label: 'Chores', icon: Dumbbell },
  { href: '/family?tab=members', label: 'Family', icon: Users },
  { href: '/family?tab=templates', label: 'Templates', icon: BookMarked },
]

export function Sidebar() {
  const pathname = usePathname()
  const { signOut, user } = useAuth()

  return (
    <aside className="hidden sm:flex flex-col w-[220px] min-h-screen bg-slate-900 border-r border-slate-800">
      {/* Logo */}
      <div className="px-5 py-6 border-b border-slate-800">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shrink-0">
            <span className="text-sm">🏠</span>
          </div>
          <div>
            <h1 className="text-sm font-bold text-white">Family CC</h1>
            <p className="text-xs text-slate-500">Command Center</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-auto">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const basePath = href.split('?')[0]
          const active = pathname === basePath || pathname.startsWith(basePath + '/')
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 py-2 rounded-xl text-sm transition-all duration-150 border-l-2 pl-[10px] pr-3',
                active
                  ? 'bg-blue-500/20 text-blue-400 font-medium border-blue-500'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200 border-transparent'
              )}
            >
              <Icon size={16} strokeWidth={active ? 2.5 : 2} />
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
