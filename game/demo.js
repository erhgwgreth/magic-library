const { BOOK_TIERS } = require('./books')
const { ANIMALS } = require('./animals')
const { UPGRADES } = require('./shop')
const {
  normalizeApprovalCount,
  setLibrarianApprovalCount,
  setLibrarianTrustLevel,
} = require('./trust')
const { clearDisallowedCraftGoal } = require('./directive')

const NORMAL_TIMING = Object.freeze({
  cycleMs: 40 * 60 * 1000,
  librarianIntervalMs: 5 * 60 * 1000,
  librarianMinGapMs: 60 * 1000,
  buffDurationMs: 30 * 60 * 1000,
})

const DEMO_TIMING = Object.freeze({
  cycleMs: 40 * 1000,
  librarianIntervalMs: 20 * 1000,
  librarianMinGapMs: 5 * 1000,
  buffDurationMs: 30 * 1000,
})

const TIME_OF_DAY_PROGRESS = Object.freeze({
  day: 0,
  afternoon: 0.25,
  sunset: 0.5,
  night: 0.75,
})

const ANIMAL_STATUSES = new Set(['unknown', 'discovered', 'invited', 'collected'])

function timingFor (demoMode) {
  return demoMode ? DEMO_TIMING : NORMAL_TIMING
}

function rescaleCycleElapsed (elapsedMs, fromCycleMs, toCycleMs) {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(fromCycleMs) || fromCycleMs <= 0 || !Number.isFinite(toCycleMs) || toCycleMs <= 0) return 0
  const progress = ((elapsedMs % fromCycleMs) + fromCycleMs) % fromCycleMs / fromCycleMs
  return progress * toCycleMs
}

function cycleElapsedForTimeOfDay (timeOfDay, cycleMs) {
  const progress = TIME_OF_DAY_PROGRESS[timeOfDay]
  if (!Number.isFinite(progress) || !Number.isFinite(cycleMs) || cycleMs <= 0) return null
  return progress * cycleMs
}

function validNonNegativeInteger (value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function applyDemoStatePatch (state, patch) {
  if (!state || typeof state !== 'object' || !patch || typeof patch !== 'object') return false
  let changed = false

  for (const resource of ['ink', 'candleSeconds', 'feather']) {
    const value = validNonNegativeInteger(patch.resources?.[resource])
    if (value !== null) {
      state[resource] = value
      changed = true
    }
  }

  for (const tier of BOOK_TIERS) {
    const value = validNonNegativeInteger(patch.books?.[tier.id])
    if (value !== null) {
      state.books[tier.id] = value
      changed = true
    }
  }

  const stage = validNonNegativeInteger(patch.stage)
  if (stage !== null && stage >= 1 && stage <= 5) {
    state.stage = stage
    changed = true
  }

  const trustLevel = validNonNegativeInteger(patch.librarian?.trustLevel)
  if (trustLevel !== null && trustLevel >= 1 && trustLevel <= 4) {
    changed = setLibrarianTrustLevel(state.librarian, trustLevel) || changed
  } else {
    const approvalCount = normalizeApprovalCount(patch.librarian?.approvalCount)
    if (approvalCount !== null) {
      changed = setLibrarianApprovalCount(state.librarian, approvalCount) || changed
    }
  }
  changed = clearDisallowedCraftGoal(state.librarian) || changed

  for (const animalDefinition of ANIMALS) {
    const status = patch.animals?.[animalDefinition.id]
    if (!ANIMAL_STATUSES.has(status)) continue
    const animal = state.animals[animalDefinition.id]
    animal.status = status
    if (status !== 'collected') animal.placed = false
    changed = true
  }

  for (const upgrade of UPGRADES) {
    const level = validNonNegativeInteger(patch.upgrades?.[upgrade.id])
    if (level !== null) {
      state.shop.upgrades[upgrade.id] = level
      changed = true
    }
  }
  return changed
}

module.exports = {
  NORMAL_TIMING,
  DEMO_TIMING,
  TIME_OF_DAY_PROGRESS,
  timingFor,
  rescaleCycleElapsed,
  cycleElapsedForTimeOfDay,
  applyDemoStatePatch,
}
