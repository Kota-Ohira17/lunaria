import { eq } from 'drizzle-orm'
import { can } from '../../../../shared/roles'
import { evidenceCheckSchema } from '../../../../shared/schemas'

/**
 * 証憑を確認する（財務局長・財務局長補佐・管理者）。対応済みで証憑が付いている申請だけ。
 * - confirm：確認済み（完了）にする
 * - return：理由を付けて差し戻す（証憑提出待ちに戻る。証憑を付け直すとまた確認待ちになる）
 * - undo：確認済みを取り消して、確認待ちに戻す
 */
export default defineEventHandler(async (event) => {
  const user = await requirePermission(event, 'executeEntries')
  const id = Number(getRouterParam(event, 'id'))
  const body = parseOr400(evidenceCheckSchema.safeParse(await readBody(event)))
  const db = useDb()
  const e = schema.entries

  const entry = await db.query.entries.findFirst({ where: eq(e.id, id) })
  if (!entry) throw createError({ statusCode: 404, message: '申請が見つかりません。' })
  if (entry.status !== 'done') throw createError({ statusCode: 400, message: '執行待ちの申請の証憑は、まだ確認できません。' })
  const evidences = (await evidencesOf([id])).get(id) ?? []
  const hasEvidence = evidences.length > 0
  if (!hasEvidence) throw createError({ statusCode: 400, message: '証憑がまだ提出されていません。' })

  const [updated] = await db.update(e)
    .set(body.action === 'confirm'
      ? { evidenceCheckedAt: new Date(), evidenceCheckedBy: user.email, evidenceReturnComment: '' }
      : body.action === 'return'
        ? { evidenceCheckedAt: null, evidenceCheckedBy: null, evidenceReturnComment: body.comment }
        : { evidenceCheckedAt: null, evidenceCheckedBy: null })
    .where(eq(e.id, id))
    .returning()
  const [withEv] = await withEvidences(await withItems([updated!]))
  return toPublicEntry(withEv!, can(user.role, 'viewBankAccount'))
})
