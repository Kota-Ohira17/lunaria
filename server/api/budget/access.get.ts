/** 自分が集約の段取り（局・部・担当と入力する人）と昨年の本予算・決算の取り込みをできるか（画面の出し分けに使う） */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  return { canArrange: canArrangeBudget(user) }
})
