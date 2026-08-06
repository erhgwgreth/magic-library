const { BOOK_TIERS, BOOK_BY_ID } = require('./books')

const LIBRARIAN_GOAL_TRUST_LEVEL = 3
const BOOK_TIER_IDS = BOOK_TIERS.map((tier) => tier.id)
const BOOK_TIER_ID_SET = new Set(BOOK_TIER_IDS)

function normalizeCraftGoal (rawGoal) {
  if (rawGoal === null || rawGoal === undefined) return null
  if (typeof rawGoal !== 'object' || Array.isArray(rawGoal)) return null
  if (Object.keys(rawGoal).some((tierId) => !BOOK_TIER_ID_SET.has(tierId))) return null

  const goal = {}
  for (const tierId of BOOK_TIER_IDS) {
    const amount = rawGoal[tierId]
    if (amount === null || amount === undefined) continue
    if (!Number.isSafeInteger(amount) || amount < 0) return null
    if (amount > 0) goal[tierId] = amount
  }
  return Object.keys(goal).length ? goal : null
}

function safeBookAmount (books, tierId) {
  const amount = books?.[tierId]
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
}

function isCraftGoalComplete (books, rawGoal) {
  const goal = normalizeCraftGoal(rawGoal)
  if (!goal) return false
  return Object.entries(goal).every(([tierId, amount]) => safeBookAmount(books, tierId) >= amount)
}

function canUseCraftGoal (trustLevel, rawGoal) {
  return Number.isFinite(trustLevel) && trustLevel >= LIBRARIAN_GOAL_TRUST_LEVEL && Boolean(normalizeCraftGoal(rawGoal))
}

function addRequiredAmount (required, tierId, amount) {
  if (!BOOK_TIER_ID_SET.has(tierId) || !Number.isSafeInteger(amount) || amount < 0) return false
  const nextAmount = required[tierId] + amount
  if (!Number.isSafeInteger(nextAmount) || nextAmount < 0) return false
  required[tierId] = nextAmount
  return true
}

function simulateCraft (books, tierId) {
  const tier = BOOK_BY_ID[tierId]
  if (!tier) return null
  const simulated = Object.fromEntries(BOOK_TIER_IDS.map((id) => [id, safeBookAmount(books, id)]))
  for (const [materialTierId, amount] of Object.entries(tier.cost.books || {})) {
    if (simulated[materialTierId] < amount) return null
    simulated[materialTierId] -= amount
  }
  simulated[tierId] += 1
  return simulated
}

// 상위 목표부터 소모될 하위 장서를 역산한 뒤, 가장 낮은 부족 등급 하나를 고른다.
function planCraftGoal (books, rawGoal) {
  const goal = normalizeCraftGoal(rawGoal)
  if (!goal) return { status: 'invalid', goal: null }

  const required = Object.fromEntries(BOOK_TIER_IDS.map((tierId) => [tierId, goal[tierId] || 0]))
  if (isCraftGoalComplete(books, goal)) {
    return { status: 'complete', goal, required }
  }

  for (let index = BOOK_TIER_IDS.length - 1; index >= 1; index -= 1) {
    const tierId = BOOK_TIER_IDS[index]
    const shortage = Math.max(0, required[tierId] - safeBookAmount(books, tierId))
    if (!shortage) continue

    for (const [materialTierId, amountPerBook] of Object.entries(BOOK_BY_ID[tierId].cost.books || {})) {
      const materialAmount = shortage * amountPerBook
      if (!Number.isSafeInteger(materialAmount) || !addRequiredAmount(required, materialTierId, materialAmount)) {
        return { status: 'invalid', goal: null }
      }
    }
  }

  for (const tierId of BOOK_TIER_IDS) {
    if (safeBookAmount(books, tierId) >= required[tierId]) continue
    const simulatedBooks = simulateCraft(books, tierId)
    return {
      status: 'craft',
      goal,
      required,
      tierId,
      willCompleteAfterNextCraft: Boolean(simulatedBooks && isCraftGoalComplete(simulatedBooks, goal)),
    }
  }

  return { status: 'complete', goal, required }
}

function craftGoalText (rawGoal) {
  const goal = normalizeCraftGoal(rawGoal)
  if (!goal) return ''
  return BOOK_TIER_IDS
    .filter((tierId) => goal[tierId])
    .map((tierId) => `${BOOK_BY_ID[tierId].name.replace(' 마법장서', '')} ${goal[tierId]}권`)
    .join(', ')
}

function clearCompletedCraftGoal (librarian) {
  if (!librarian || typeof librarian !== 'object') return
  const sourceDirective = typeof librarian.craftGoalDirective === 'string'
    ? librarian.craftGoalDirective
    : ''
  librarian.craftGoal = null
  librarian.craftGoalDirective = ''
  if (sourceDirective && librarian.directive === sourceDirective) librarian.directive = ''
}

module.exports = {
  LIBRARIAN_GOAL_TRUST_LEVEL,
  normalizeCraftGoal,
  canUseCraftGoal,
  isCraftGoalComplete,
  planCraftGoal,
  craftGoalText,
  clearCompletedCraftGoal,
}
