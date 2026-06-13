import webpush from 'web-push'

function setupWebPush() {
  const email = process.env.VAPID_EMAIL ?? 'mailto:admin@example.com'
  const pub = process.env.VAPID_PUBLIC_KEY ?? ''
  const priv = process.env.VAPID_PRIVATE_KEY ?? ''
  if (pub && priv) {
    webpush.setVapidDetails(email, pub, priv)
  }
}

export async function sendPushNotification(
  subscriptionJson: string,
  payload: { title: string; body: string; url?: string }
): Promise<void> {
  setupWebPush()
  const subscription = JSON.parse(subscriptionJson)
  await webpush.sendNotification(subscription, JSON.stringify(payload))
}
