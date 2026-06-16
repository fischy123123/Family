'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutGrid, Users, ShoppingCart, Sparkles, Compass, CheckSquare } from 'lucide-react'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { href: '/command', label: 'Home', icon: LayoutGrid },
  { href: '/coach', label: 'Coach', icon: Compass },
  { href: '/tasks', label: 'To Do', icon: CheckSquare },
  { href: '/lists', label: 'Groceries', icon: ShoppingCart },
  { href: '/family', label: 'Family', icon: Users },
  { href: '/copilot', label: 'Copilot', icon: Sparkles },
]

export function MobileNav() {
  const pathname = usePathname()

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 sm:hidden safe-bottom"
      style={{
        background: 'rgba(255,255,255,0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        borderTop: '1px solid rgba(0,0,0,0.06)',
      }}
    >
      <div className="flex px-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className="flex-1 flex flex-col items-center pt-2 pb-1 gap-1 relative"
            >
              {active && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-blue-500 rounded-full" />
              )}
              <Icon
                size={22}
                strokeWidth={active ? 2.5 : 1.8}
                className={cn(
                  'transition-colors',
                  active ? 'text-blue-600' : 'text-slate-400'
                )}
              />
              <span
                className={cn(
                  'text-[10px] font-medium transition-colors',
                  active ? 'text-blue-600' : 'text-slate-400'
                )}
              >
                {label}
              </span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
