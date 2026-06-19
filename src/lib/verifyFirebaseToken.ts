import { createRemoteJWKSet, jwtVerify } from 'jose'

// Firebase ID tokens are signed by Google's securetoken service — different
// JWKS endpoint from regular Google OAuth tokens.
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL(
    'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
  ),
)

function getProjectId(): string {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { project_id?: string }
      if (parsed.project_id) return parsed.project_id
    } catch { /* fall through */ }
  }
  const pid = process.env.FIREBASE_PROJECT_ID
  if (pid) return pid
  throw new Error('Firebase project ID not configured')
}

export async function verifyFirebaseIdToken(
  idToken: string,
): Promise<{ uid: string; email: string }> {
  const projectId = getProjectId()
  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  })
  const uid = typeof payload.sub === 'string' ? payload.sub : ''
  if (!uid) throw new Error('No uid in Firebase ID token')
  const email = typeof payload.email === 'string' ? payload.email : ''
  return { uid, email }
}
