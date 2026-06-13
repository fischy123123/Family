import { google } from 'googleapis'
import { createOAuth2Client } from './client'

const SHEET_ID = process.env.FAMILY_SHEET_ID!

export type SheetTab =
  | 'family'
  | 'reminders'
  | 'chores'
  | 'checklists'
  | 'shopping_lists'
  | 'meal_plans'
  | 'templates'
  | 'push_subscriptions'

function getSheets(accessToken: string) {
  return google.sheets({ version: 'v4', auth: createOAuth2Client(accessToken) })
}

export async function readSheet(accessToken: string, tab: SheetTab): Promise<string[][]> {
  const sheets = getSheets(accessToken)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
  })
  return (response.data.values as string[][]) ?? []
}

export async function appendRow(
  accessToken: string,
  tab: SheetTab,
  values: string[]
): Promise<void> {
  const sheets = getSheets(accessToken)
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:A`,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  })
}

export async function updateRow(
  accessToken: string,
  tab: SheetTab,
  rowIndex: number, // 1-based (1 = header row)
  values: string[]
): Promise<void> {
  const sheets = getSheets(accessToken)
  const row = rowIndex + 1 // +1 because row 1 is header, data starts at row 2
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${row}:Z${row}`,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  })
}

export async function deleteRow(
  accessToken: string,
  tab: SheetTab,
  rowIndex: number // 0-based index in the data rows (not counting header)
): Promise<void> {
  const sheets = getSheets(accessToken)

  // Get the sheet ID for the named tab
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID })
  const sheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === tab
  )
  const sheetId = sheet?.properties?.sheetId ?? 0

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex + 1, // +1 for header row
              endIndex: rowIndex + 2,
            },
          },
        },
      ],
    },
  })
}

// Helper: find row index by id column (column A)
export async function findRowById(
  accessToken: string,
  tab: SheetTab,
  id: string
): Promise<number> {
  const rows = await readSheet(accessToken, tab)
  // Skip header row (index 0), find in data rows
  const idx = rows.slice(1).findIndex((row) => row[0] === id)
  return idx // -1 if not found, otherwise 0-based data index
}

export async function upsertRow(
  accessToken: string,
  tab: SheetTab,
  id: string,
  values: string[]
): Promise<void> {
  const idx = await findRowById(accessToken, tab, id)
  if (idx === -1) {
    await appendRow(accessToken, tab, values)
  } else {
    await updateRow(accessToken, tab, idx + 1, values) // +1 because updateRow expects 1-based data index
  }
}
