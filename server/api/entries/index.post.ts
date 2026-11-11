import { bureauCodeOf } from '../../../shared/constants'
import { can } from '../../../shared/roles'
import { budgetChangeOfItems, changedItems, LARGE_INCREASE } from '../../../shared/constants'
import { executionRequestSchema } from '../../../shared/schemas'

/** 執行依頼（旧「執行依頼」フォーム）。予算前執行も同じフォームで出す（予算の表から選ばず、支出項目名を書く） */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const { payload, file } = await readPayloadAndFile(event)
  const input = parseOr400(executionRequestSchema.safeParse(payload))

  const {
    type, applicantName, department: writtenBureau, inCharge: writtenTeam, budgetLineKeys, itemNumber: manualItemNumber, itemName, remark, deadline,
    itemAmounts, itemQuantities, itemVendors: _itemVendors, budgetCommitteeApproved, preExecution, preExecutionReason, budgetPath,
    requestBudgetChange: _requestBudgetChange, budgetChangeReason,
    ...rest
  } = input
  const { amount, quantity, ...details } = rest as typeof rest & { amount?: number, quantity?: string }
  // 予算前執行は予算の表から選ばない（本予算が確定したら、その項目に付け替える）
  const { itemNumber, lines } = preExecution
    ? { itemNumber: '予算前執行', lines: [] }
    : await resolveBudgetLines(budgetLineKeys, manualItemNumber)

  // 局・担当は、明細を選んだときは最初の明細のもの
  const picked = lines[0]
  const department = picked ? bureauCodeOf(picked.bureau) || writtenBureau : writtenBureau
  const inCharge = picked?.team || writtenTeam

  // 発注の数量: 予算の表に数量がある明細だけ必須
  if (type === '発注') requireItemQuantities(lines, itemQuantities)

  // 予算からの変更は申請者に選ばせず、予算額と執行額から決める（予算にない項目なら決めない）
  const budgetChange = lines.length ? budgetChangeOfItems(lines, itemAmounts).change : null
  if (budgetChange === LARGE_INCREASE && !budgetCommitteeApproved) {
    throw createError({ statusCode: 400, message: '1万円以上の増額は、役員会の承認を得てから申請してください（承認のチェックが必要です）。' })
  }

  // 金額が予算額と違う明細（「予算の変更も申請する」にチェックがあれば、あとで申請する）
  const changed = changedItems(lines, itemAmounts)
  // 金額が予算額と違う明細があれば、予算の変更（②）を必ず申請する。理由は必須
  if (changed.length && !budgetChangeReason) throw createError({ statusCode: 400, message: '金額が予算額と違う明細があります。予算の変更の理由を書いてください。' })

  const attachmentId = file
    ? await saveAttachment(file, `${inCharge}_${itemName}_請求書`)
    : null

  const entry = await insertEntry({
    seq: await nextSeq('execution'),
    kind: 'execution',
    type,
    createdAt: new Date(),
    applicantEmail: user.email,
    applicantName,
    department,
    inCharge,
    itemNumber,
    itemName,
    amount: amount ?? null,
    quantity: quantity || null,
    deadline,
    remark,
    details: {
      ...details,
      ...(budgetChange ? { budgetChange } : {}),
      ...(budgetChange === LARGE_INCREASE ? { budgetCommitteeApproved: true } : {}),
      ...(preExecution ? { preExecution: true, preExecutionReason } : {}),
      // 予算にない項目は、款・項・目・節を残す（決算の「予算にない項目」に出す）
      ...(!preExecution && !lines.length ? { budgetPath } : {}),
    },
    attachmentId,
  }, lines, input)
  // 執行依頼は受け付けたので、予算の変更の申請で失敗しても依頼は取り消さない（申請できなかった明細を返す）
  const budgetChangeRequests = changed.length
    ? await requestChangesFromEntry(entry, changed, user, budgetChangeReason)
    : null

  await notifyN8n('created', entry)
  setResponseStatus(event, 201)
  return { ...toPublicEntry(entry, can(user.role, 'viewBankAccount')), budgetChangeRequests }
})
