import { manualJournalSchema } from '../../../../shared/schemas'

/** 仕訳を手で入れる（財務局長・管理者）。借方の合計＝貸方の合計。⑬総勘定元帳DBに直接書く */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const input = parseOr400(manualJournalSchema.safeParse(await readBody(event)))
  const journal = await postManualJournal(input, user.email)
  setResponseStatus(event, 201)
  return journal
})
