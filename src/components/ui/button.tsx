import * as React from 'react'
import { cn } from '@/lib/utils'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline'
  size?: 'sm' | 'md' | 'lg' | 'icon'
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'md', ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex items-center justify-center rounded-xl font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none',
          {
            'bg-gradient-to-r from-blue-600 to-blue-700 text-white shadow-sm hover:from-blue-500 hover:to-blue-600 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0': variant === 'default',
            'bg-slate-100 text-slate-700 hover:bg-slate-200': variant === 'secondary',
            'text-slate-600 hover:bg-slate-100 hover:text-slate-800': variant === 'ghost',
            'bg-gradient-to-r from-red-600 to-red-700 text-white shadow-sm hover:from-red-500 hover:to-red-600': variant === 'destructive',
            'border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:border-slate-300': variant === 'outline',
          },
          {
            'text-xs px-2.5 py-1.5 h-7 rounded-lg': size === 'sm',
            'text-sm px-4 py-2 h-9': size === 'md',
            'text-base px-6 py-3 h-11': size === 'lg',
            'h-9 w-9 p-0': size === 'icon',
          },
          className
        )}
        {...props}
      />
    )
  }
)
Button.displayName = 'Button'
