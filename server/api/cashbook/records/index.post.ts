import { cashbookRecordSchema } from '../../../../shared/schemas'

/** 出納帳に期首の残高・口座間の移動・調整・残高の照合を書く（財務局長・管理者） */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'manageCashbook')
  const input = parseOr400(cashbookRecordSchema.safeParse(await readBody(event)))
  // 残高の照合は仕訳にならないので、締めた期でも書ける
  if (input.kind !== 'check') await assertPeriodsOpen([input.date])
  const [record] = await useDb().insert(schema.cashbookRecords).values({
    kind: input.kind,
    date: input.date,
    account: input.account,
    toAccount: input.kind === 'transfer' ? input.toAccount || null : null,
    amount: input.amount,
    memo: input.memo,
    createdBy: user.email,
    createdAt: new Date(),
  }).returning()
  await syncVoucher('cashbook', record!.id, user.email)
  setResponseStatus(event, 201)
  return record
})
