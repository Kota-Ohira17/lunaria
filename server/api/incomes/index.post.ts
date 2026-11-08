import { inArray } from 'drizzle-orm'
import { flowOf } from '../../../shared/budgetCompile'
import { bureauCodeOf } from '../../../shared/constants'
import { incomeSchema } from '../../../shared/schemas'

/**
 * 収入を記録する（だれでも）。収入の予算明細を選ぶか、予算にない収入として款〜節と項目番号を書く。
 * 明細は款などの見出しでまとめて複数選べる。そのときは明細ごとに1件ずつ記録する
 * （決算・仕訳・出納帳は「収入1件＝明細1つ」で数えるので、記録の形は変えない）。
 * ファイル（入金の明細など）を一緒に送ると、記録ごとに1件目の証憑として付ける。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { payload, file } = await readPayloadAndFile(event)
  const input = parseOr400(incomeSchema.safeParse(payload))
  const db = useDb()

  const found = input.lines.length
    ? await db.select().from(schema.budgetLines).where(inArray(schema.budgetLines.key, input.lines.map(l => l.key)))
    : []
  const byKey = new Map(found.map(l => [l.key, l]))
  for (const { key } of input.lines) {
    const line = byKey.get(key)
    if (!line) throw createError({ statusCode: 400, message: '選んだ収入の明細が見つかりません。ページを再読み込みして選び直してください。' })
    if (flowOf(line.itemNumber) !== 'income') throw createError({ statusCode: 400, message: '支出の明細は収入の記録では選べません。' })
  }

  const common = {
    status: 'pending' as const,
    applicantEmail: user.email,
    applicantName: input.applicantName,
    receivedOn: input.receivedOn,
    payer: input.payer,
    method: input.method,
    account: input.method === '振込' ? input.account : null,
    remark: input.remark,
    createdAt: new Date(),
  }
  const values = input.lines.length
    ? input.lines.map(({ key, amount }) => {
        const line = byKey.get(key)!
        return {
          ...common,
          // 局・担当は明細のもの
          department: bureauCodeOf(line.bureau) || input.department,
          inCharge: line.team || input.inCharge,
          lineKey: line.key,
          itemId: line.itemId,
          itemNumber: line.itemNumber,
          itemName: (input.lines.length === 1 && input.itemName) || line.label,
          budgetAmount: line.budgetAmount,
          amount,
          details: {},
        }
      })
    : [{
        ...common,
        department: input.department,
        inCharge: input.inCharge,
        lineKey: null,
        itemId: '',
        itemNumber: input.itemNumber,
        itemName: input.itemName,
        budgetAmount: null,
        amount: Number(input.amount),
        details: { budgetPath: input.budgetPath },
      }]

  const incomes = []
  for (const v of values) {
    const [income] = await db.insert(schema.incomeRecords).values({ ...v, seq: await nextSeq('income') }).returning()
    incomes.push(income!)
  }

  if (file) {
    // 取り消しのとき記録ごとに証憑を消すので、ファイルは記録ごとに持たせる
    for (const income of incomes) {
      const attachmentId = await saveAttachment(file, incomeFileLabel(income, 1))
      await db.insert(schema.incomeFiles).values({ incomeId: income.id, attachmentId, kind: '入金の明細', uploadedBy: user.email, createdAt: new Date() })
    }
  }
  setResponseStatus(event, 201)
  const views = await withIncomeFiles(incomes)
  return { ...views[0]!, seqs: incomes.map(i => i.seq) }
})
