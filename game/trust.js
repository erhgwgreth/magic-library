const TRUST_LEVEL_THRESHOLDS = Object.freeze([0, 3, 6, 9])
const TRUST_PROGRESS_PROPOSAL_ACCEPT = 1
const TRUST_PROGRESS_CRAFT_BOOK = 0.25
const TRUST_PROGRESS_INVITE_ANIMAL = 0.5
const TRUST_PROGRESS_PROPOSAL_DECLINE = -0.5

const MIN_TRUST_LEVEL = 1
const MAX_TRUST_LEVEL = TRUST_LEVEL_THRESHOLDS.length

function normalizeApprovalCount (value) {
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 100) / 100
}

function normalizeTrustLevel (value) {
  if (!Number.isFinite(value)) return null
  return Math.min(MAX_TRUST_LEVEL, Math.max(MIN_TRUST_LEVEL, Math.floor(value)))
}

function trustLevelFromApprovalCount (value) {
  const approvalCount = normalizeApprovalCount(value) ?? 0
  for (let index = TRUST_LEVEL_THRESHOLDS.length - 1; index >= 0; index -= 1) {
    if (approvalCount >= TRUST_LEVEL_THRESHOLDS[index]) return index + 1
  }
  return MIN_TRUST_LEVEL
}

function setLibrarianApprovalCount (librarian, value) {
  if (!librarian || typeof librarian !== 'object') return false
  const approvalCount = normalizeApprovalCount(value)
  if (approvalCount === null) return false
  const trustLevel = trustLevelFromApprovalCount(approvalCount)
  const changed = librarian.approvalCount !== approvalCount || librarian.trustLevel !== trustLevel
  librarian.approvalCount = approvalCount
  librarian.trustLevel = trustLevel
  return changed
}

function adjustLibrarianApprovalCount (librarian, delta) {
  if (!Number.isFinite(delta)) return false
  const current = normalizeApprovalCount(librarian?.approvalCount) ?? 0
  return setLibrarianApprovalCount(librarian, Math.max(0, current + delta))
}

// 신뢰 단계를 직접 지정할 때는 그 값이 우선이며, 진행도를 해당 단계 범위로 맞춘다.
function setLibrarianTrustLevel (librarian, value) {
  if (!librarian || typeof librarian !== 'object') return false
  const trustLevel = normalizeTrustLevel(value)
  if (trustLevel === null) return false
  let approvalCount = normalizeApprovalCount(librarian.approvalCount) ?? 0
  if (trustLevelFromApprovalCount(approvalCount) !== trustLevel) {
    approvalCount = TRUST_LEVEL_THRESHOLDS[trustLevel - 1]
  }
  const changed = librarian.trustLevel !== trustLevel || librarian.approvalCount !== approvalCount
  librarian.trustLevel = trustLevel
  librarian.approvalCount = approvalCount
  return changed
}

function librarianTrustProgress (librarian) {
  const approvalCount = normalizeApprovalCount(librarian?.approvalCount) ?? 0
  const trustLevel = normalizeTrustLevel(librarian?.trustLevel) ?? trustLevelFromApprovalCount(approvalCount)
  const currentThreshold = TRUST_LEVEL_THRESHOLDS[trustLevel - 1]
  const nextThreshold = TRUST_LEVEL_THRESHOLDS[trustLevel] ?? null
  return {
    approvalCount,
    trustLevel,
    currentThreshold,
    nextThreshold,
    remaining: nextThreshold === null ? 0 : Math.max(0, nextThreshold - approvalCount),
    span: nextThreshold === null ? 0 : nextThreshold - currentThreshold,
  }
}

module.exports = {
  TRUST_LEVEL_THRESHOLDS,
  TRUST_PROGRESS_PROPOSAL_ACCEPT,
  TRUST_PROGRESS_CRAFT_BOOK,
  TRUST_PROGRESS_INVITE_ANIMAL,
  TRUST_PROGRESS_PROPOSAL_DECLINE,
  normalizeApprovalCount,
  normalizeTrustLevel,
  trustLevelFromApprovalCount,
  setLibrarianApprovalCount,
  adjustLibrarianApprovalCount,
  setLibrarianTrustLevel,
  librarianTrustProgress,
}
