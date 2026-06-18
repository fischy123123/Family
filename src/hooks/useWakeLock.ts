'use client'

import { useEffect, useRef } from 'react'

// Keeps the device screen awake while `active` is true, using the Screen Wake
// Lock API. The lock is automatically released by the browser whenever the page
// is hidden (tab switch, lock screen), so we re-acquire it on visibilitychange.
export function useWakeLock(active: boolean) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lockRef = useRef<any>(null)

  useEffect(() => {
    if (!active) return
    // Not all browsers/contexts support it (requires HTTPS + a visible page).
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } }).wakeLock
    if (!wl) return

    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      try {
        lockRef.current = await wl.request('screen')
      } catch {
        /* user/agent denied — nothing else to do */
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      try { lockRef.current?.release?.() } catch { /* noop */ }
      lockRef.current = null
    }
  }, [active])
}
