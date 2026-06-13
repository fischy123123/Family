import { google } from 'googleapis'
import { createOAuth2Client } from './client'
import type { EmailSnippet } from '../types'

function getGmail(accessToken: string) {
  return google.gmail({ version: 'v1', auth: createOAuth2Client(accessToken) })
}

export async function fetchRecentEmails(
  accessToken: string,
  daysBack = 7,
  maxResults = 30
): Promise<EmailSnippet[]> {
  const gmail = getGmail(accessToken)

  const after = Math.floor((Date.now() - daysBack * 24 * 60 * 60 * 1000) / 1000)

  // Skip promotions, social, and spam
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${after} -category:promotions -category:social`,
    maxResults,
  })

  const messages = res.data.messages ?? []
  const snippets: EmailSnippet[] = []

  for (const msg of messages) {
    if (!msg.id) continue
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'metadata',
      metadataHeaders: ['Subject', 'Date'],
    })

    const headers = detail.data.payload?.headers ?? []
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(no subject)'
    const date = headers.find((h) => h.name === 'Date')?.value ?? ''
    const snippet = detail.data.snippet ?? ''

    snippets.push({ subject, snippet, date })
  }

  return snippets
}
