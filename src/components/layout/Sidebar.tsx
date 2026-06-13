'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { signOut } from 'next-auth/react'
import { Home, Calendar, ListChecks, ShoppingCart, UtensilsCrossed, Bell, Dumbbell, Users, BookTemplate, LogOut } from 'lucide-react'
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
  { href: '/family?tab=templates', label: 'Templates', icon: BookTemplate },
]

export function Sidebar() {
  const pathname = usePathname()

  return (
    <aside className="hidden sm:flex flex-col w-56 min-h-screen bg-white border-r border-gray-100 py-6">
      <div className="px-4 mb-6">
        <h1 className="text-lg font-bold text-gray-900">🏠 Family CC</h1>
        <p className="text-xs text-gray-500 mt-0.5">Command Center</p>
      </div>

      <nav className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const basePath = href.split('?')[0]
          const active = pathname === basePath || pathname.startsWith(basePath + '/')
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors',
                active
                  ? 'bg-blue-50 text-blue-700 font-medium'
                  : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
              )}
            >
              <Icon size={18} />
              {label}
            </Link>
          )
        })}
      </nav>

      <div className="px-2 mt-4">
        <button
          onClick={() => signOut({ callbackUrl: '/signin' })}
          className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-gray-500 hover:bg-gray-50 hover:text-gray-700 w-full"
        >
          <LogOut size={18} />
          Sign Out
        </button>
      </div>
    </aside>
  )
}
