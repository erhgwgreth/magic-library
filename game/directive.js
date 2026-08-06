const { LIBRARIAN_GOAL_TRUST_LEVEL } = require('./librarian-goal')

const CRAFT_SUBJECT_PATTERN = /(?:기초|중급|고급|신화급)(?:\s*마법)?\s*(?:장서|책)?|(?:장서|책)/
const CRAFT_REQUEST_PATTERN = /만들|제작|준비|완성|보유|모아|모으|채워|쌓아/
const CRAFT_TIER_PATTERN = /(?:기초|중급|고급|신화급)(?:\s*마법)?\s*(?:장서|책)?/

function craftGoalAllowed (trustLevel) {
  return Number.isFinite(trustLevel) && trustLevel >= LIBRARIAN_GOAL_TRUST_LEVEL
}

function clearDisallowedCraftGoal (librarian) {
  if (!librarian || typeof librarian !== 'object' || craftGoalAllowed(librarian.trustLevel)) return false
  if (!librarian.craftGoal && !librarian.craftGoalDirective) return false
  librarian.craftGoal = null
  librarian.craftGoalDirective = ''
  return true
}

function directiveContainsCraftGoal (directive) {
  const text = typeof directive === 'string' ? directive.trim() : ''
  return Boolean(text && CRAFT_SUBJECT_PATTERN.test(text) && CRAFT_REQUEST_PATTERN.test(text))
}

function reasonMentionsCraftGoal (reason) {
  const text = typeof reason === 'string' ? reason.trim() : ''
  if (!text) return false
  return CRAFT_TIER_PATTERN.test(text) || (
    CRAFT_SUBJECT_PATTERN.test(text) && CRAFT_REQUEST_PATTERN.test(text)
  )
}

function neutralLibrarianReason (actionId) {
  if (actionId === 'craftBook') return '장서 한 권을 조용히 정리해 두었어요.'
  if (actionId === 'wait') return '도서관을 살피며 조용히 기다리고 있어요.'
  if (actionId === 'notify') return '도서관은 고요히 잘 돌아가고 있어요.'
  return '도서관을 조용히 돌보았어요.'
}

function safeDirectiveReason ({ directive, reason, actionId, trustLevel }) {
  if (craftGoalAllowed(trustLevel)) return reason
  if (!directiveContainsCraftGoal(directive)) return reason
  return reasonMentionsCraftGoal(reason) ? neutralLibrarianReason(actionId) : reason
}

module.exports = {
  craftGoalAllowed,
  clearDisallowedCraftGoal,
  directiveContainsCraftGoal,
  reasonMentionsCraftGoal,
  neutralLibrarianReason,
  safeDirectiveReason,
}
