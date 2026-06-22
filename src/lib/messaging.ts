'use client'

import { getMessaging, getToken, isSupported, onMessage, type Messaging } from 'firebase/messaging'
import { doc, setDoc } from 'firebase/firestore'
import { initializeApp, getApps } from 'firebase/app'
import { db } from './firebase'

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

const VAPID_KEY = process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY

let messaging: Messaging | null = null

async function getMessagingInstance(): Promise<Messaging | null> {
  if (typeof window === 'undefined') return null
  if (!(await isSupported())) return null
  if (messaging) return messaging
  const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0]
  messaging = getMessaging(app)
  return messaging
}

/**
 * Requests notification permission, retrieves the FCM token, and stores it in
 * Firestore so the daily cron can deliver push notifications to this device.
 * Returns true on success.
 */
export async function enableNotifications(familyId: string, userEmail: string): Promise<boolean> {
  if (!VAPID_KEY) {
    throw new Error('Push notifications are not configured (missing VAPID key).')
  }
  const msg = await getMessagingInstance()
  if (!msg) throw new Error('This browser does not support push notifications.')

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was denied.')

  const swParams = new URLSearchParams({
    apiKey: firebaseConfig.apiKey ?? '',
    authDomain: firebaseConfig.authDomain ?? '',
    projectId: firebaseConfig.projectId ?? '',
    messagingSenderId: firebaseConfig.messagingSenderId ?? '',
    appId: firebaseConfig.appId ?? '',
  })
  const registration = await navigator.serviceWorker.register(
    `/firebase-messaging-sw.js?${swParams.toString()}`
  )
  const token = await getToken(msg, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration })
  if (!token) throw new Error('Could not retrieve a notification token.')

  await setDoc(doc(db, 'families', familyId, 'pushTokens', token), {
    token,
    userEmail,
    createdAt: new Date().toISOString(),
  })
  return true
}

/** Subscribe to foreground messages (when the app is open). */
export async function onForegroundMessage(cb: (title: string, body: string) => void) {
  const msg = await getMessagingInstance()
  if (!msg) return
  onMessage(msg, (payload) => {
    cb(payload.notification?.title ?? 'Family Command Center', payload.notification?.body ?? '')
  })
}

async function notificationsSupported(): Promise<boolean> {
  if (typeof window === 'undefined') return false
  return (await isSupported()) && 'Notification' in window
}

/** Returns the current notification permission status. */
export async function getNotificationStatus(): Promise<'unsupported' | 'granted' | 'denied' | 'default'> {
  if (!(await notificationsSupported())) return 'unsupported'
  return Notification.permission as 'granted' | 'denied' | 'default'
}
