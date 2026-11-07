import { inArray } from 'drizzle-orm'
import { manualJournalSchema } from '../../../../shared/schemas'

/** 仕訳を手で入れる（財務局長・管理者）。借方の合計＝貸方の合計 */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const input = parseOr400(manualJournalSchema.safeParse(await readBody(event)))
  await assertPeriodsOpen([input.date])
  // 科目は⑭にある、使っている科目から選ぶ（区分は科目のもの）
  const names = [...new Set(input.lines.map(l => l.account))]
  const found = await useDb().select().from(schema.accounts).where(inArray(schema.accounts.name, names))
  const byName = new Map(found.map(a => [a.name, a]))
  const unknown = names.filter(n => !byName.has(n))
  if (unknown.length) throw createError({ statusCode: 400, message: `勘定科目にない科目です：${unknown.join('、')}。先に「勘定科目」で足してください。` })
  const disabled = names.filter(n => byName.get(n)!.disabled)
  if (disabled.length) throw createError({ statusCode: 400, message: `使わない設定の科目です：${disabled.join('、')}` })
  const [journal] = await useDb().insert(schema.manualJournals).values({
    date: input.date,
    memo: input.memo,
    lines: input.lines.map(l => ({ ...l, kind: byName.get(l.account)!.kind })),
    createdBy: user.email,
    createdAt: new Date(),
  }).returning()
  await syncVoucher('manual', journal!.id, user.email)
  setResponseStatus(event, 201)
  return journal
})
