'use client'

import { useState, useEffect } from 'react'
import { Bell, X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useFamily } from '@/contexts/FamilyContext'
import { useToast } from '@/contexts/ToastContext'
import { enableNotifications, notificationsSupported, onForegroundMessage } from '@/lib/messaging'

const DISMISS_KEY = 'fcc_notif_dismissed'

export function NotificationPrompt() {
  const { user } = useAuth()
  const { familyId } = useFamily()
  const { toast } = useToast()
  const [show, setShow] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let active = true
    async function check() {
      if (!(await notificationsSupported())) return
      if (typeof Notification === 'undefined') return
      const dismissed = localStorage.getItem(DISMISS_KEY)
      // Show only if permission hasn't been granted/denied and user hasn't dismissed.
      if (Notification.permission === 'default' && !dismissed && active) {
        setShow(true)
      }
      if (Notification.permission === 'granted') {
        onForegroundMessage((title, body) => toast(`${title}: ${body}`, 'info'))
      }
    }
    check()
    return () => { active = false }
  }, [toast])

  async function handleEnable() {
    if (!familyId || !user?.email) return
    setLoading(true)
    try {
      await enableNotifications(familyId, user.email)
      toast('Notifications enabled! You\'ll get a daily agenda.', 'success')
      setShow(false)
      onForegroundMessage((title, body) => toast(`${title}: ${body}`, 'info'))
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Could not enable notifications'
      toast(msg, 'error')
    } finally {
      setLoading(false)
    }
  }

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1')
    setShow(false)
  }

  if (!show) return null

  return (
    <div className="flex items-center gap-3 bg-blue-50 border border-blue-100 rounded-xl p-3 animate-slide-up">
      <div className="w-9 h-9 rounded-lg bg-blue-100 flex items-center justify-center shrink-0">
        <Bell size={18} className="text-blue-600" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">Turn on notifications</p>
        <p className="text-xs text-gray-500">Get a daily agenda and reminders on this device.</p>
      </div>
      <button
        onClick={handleEnable}
        disabled={loading}
        className="text-xs font-medium bg-blue-600 text-white rounded-lg px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50 shrink-0"
      >
        {loading ? 'Enabling…' : 'Enable'}
      </button>
      <button onClick={dismiss} className="text-gray-300 hover:text-gray-500 shrink-0">
        <X size={16} />
      </button>
    </div>
  )
}
