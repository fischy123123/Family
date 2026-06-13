import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export async function GET() {
  const cookieStore = await cookies()
  const cookie = cookieStore.get('google_tokens_pending')
  if (!cookie) return NextResponse.json({ error: 'No pending tokens' }, { status: 404 })
  cookieStore.delete('google_tokens_pending')
  return NextResponse.json({ tokens: JSON.parse(cookie.value) })
}
