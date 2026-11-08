import { eq } from 'drizzle-orm'
import { executeSchema } from '../../../../shared/schemas'
import type { Entry } from '../../../db/schema'

function paymentMethodFor(entry: Entry, bank?: string) {
  switch (entry.type) {
    case '振込': return `振込（${bank}）`
    case '発注': return '口座引落'
    case 'カード決済': return 'デビット（MUFG）'
    case 'その他': return entry.details.otherMethod ? `その他（${entry.details.otherMethod}）` : 'その他'
    default: return entry.type
  }
}

/**
 * 対応済みにする / 戻す（旧 onEdit.gs の置き換え）。
 * 1行しか持たないので、旧GASのようにタイムスタンプで他シートの行を探して同期する必要はない。
 */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'executeEntries')
  const id = Number(getRouterParam(event, 'id'))
  const body = parseOr400(executeSchema.safeParse(await readBody(event)))
  const db = useDb()
  const e = schema.entries

  const entry = await db.query.entries.findFirst({ where: eq(e.id, id) })
  if (!entry) throw createError({ statusCode: 404, message: '申請が見つかりません。' })

  if (body.done && entry.type === '振込' && !body.bank) {
    throw createError({ statusCode: 400, message: '振込に使った口座を選んでください。' })
  }
  if (body.done && entry.type === '振込' && body.transferFee == null) {
    throw createError({ statusCode: 400, message: '振込手数料を入力してください（かからなかったときは 0）。' })
  }
  // 振込手数料は details に持つ（表を足さない）。執行待ちに戻したら消す
  const { transferFee: _fee, ...restDetails } = entry.details
  const details = body.done && entry.type === '振込' ? { ...restDetails, transferFee: body.transferFee } : restDetails

  const [updated] = await db
    .update(e)
    .set(body.done
      ? {
          status: 'done',
          executedAt: new Date(),
          executedBy: user.email,
          paymentMethod: paymentMethodFor(entry, body.bank),
          amount: body.amount ?? entry.amount,
          quantity: body.quantity || entry.quantity,
          details,
        }
      : {
          status: 'pending',
          details,
          executedAt: null,
          executedBy: null,
          paymentMethod: null,
          // 執行待ちに戻したら、証憑の確認もやり直す
          evidenceCheckedAt: null,
          evidenceCheckedBy: null,
        })
    .where(eq(e.id, id))
    .returning()

  await syncVoucher('execution', id, user.email)
  const [withItemsEntry] = await withItems([updated!])
  if (body.done) await notifyN8n('executed', withItemsEntry!)
  return withItemsEntry
})
