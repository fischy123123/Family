import { initializeApp, getApps, type FirebaseApp } from 'firebase/app'
import { getAuth, setPersistence, browserLocalPersistence, type Auth } from 'firebase/auth'
import { initializeFirestore, getFirestore, type Firestore } from 'firebase/firestore'

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
}

let _app: FirebaseApp | undefined
let _auth: Auth | undefined
let _db: Firestore | undefined

if (firebaseConfig.apiKey) {
  const isNew = getApps().length === 0
  _app = isNew ? initializeApp(firebaseConfig) : getApps()[0]
  _auth = getAuth(_app)
  setPersistence(_auth, browserLocalPersistence).catch(() => {})
  // initializeFirestore (with long-polling for Safari/Firefox) can only be
  // called once. On a fresh app use it; on a cached module reuse the existing
  // Firestore instance via getFirestore.
  _db = isNew
    ? initializeFirestore(_app, { experimentalAutoDetectLongPolling: true })
    : getFirestore(_app)
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const auth = _auth!
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
export const db = _db!
