import { google } from 'googleapis'
import { getAuthorizedClient } from './oauth'

export async function fetchRecentEmails(
  accessToken: string,
  refreshToken: string,
  days = 7
): Promise<Array<{ subject: string; snippet: string; date: string }>> {
  const auth = getAuthorizedClient(accessToken, refreshToken)
  const gmail = google.gmail({ version: 'v1', auth })

  const { data: listData } = await gmail.users.messages.list({
    userId: 'me',
    q: `newer_than:${days}d`,
    maxResults: 25,
  })

  const messages = listData.messages ?? []
  const results: Array<{ subject: string; snippet: string; date: string }> = []

  for (const msg of messages) {
    if (!msg.id) continue
    try {
      const { data: msgData } = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'Date'],
      })

      const headers = msgData.payload?.headers ?? []
      const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)'
      const date = headers.find((h) => h.name === 'Date')?.value ?? ''
      const snippet = msgData.snippet ?? ''

      results.push({ subject, snippet, date })
    } catch (err) {
      console.warn(`Skipping message ${msg.id}:`, err)
    }
  }

  return results
}
