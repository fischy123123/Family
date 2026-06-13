import { initializeApp, getApps, cert, type App } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getMessaging } from 'firebase-admin/messaging'

let app: App | null = null

/**
 * Lazily initializes the Firebase Admin SDK from the FIREBASE_SERVICE_ACCOUNT
 * env var (the service account JSON, as a single-line string).
 * Returns null if not configured so callers can degrade gracefully.
 */
export function getAdminApp(): App | null {
  if (app) return app
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (!raw) return null

  const serviceAccount = JSON.parse(raw)
  app = getApps().length === 0
    ? initializeApp({ credential: cert(serviceAccount) })
    : getApps()[0]
  return app
}

export function getAdminDb() {
  const a = getAdminApp()
  if (!a) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured')
  return getFirestore(a)
}

export function getAdminMessaging() {
  const a = getAdminApp()
  if (!a) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured')
  return getMessaging(a)
}
