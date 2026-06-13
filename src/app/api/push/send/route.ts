import { NextRequest, NextResponse } from 'next/server'
import { sendPushNotification } from '@/lib/push'

// Internal route — only called from cron job
export async function POST(req: NextRequest) {
  const cronSecret = req.headers.get('x-cron-secret')
  if (cronSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { subscriptionJson, payload } = await req.json()
  await sendPushNotification(subscriptionJson, payload)
  return NextResponse.json({ ok: true })
}
