const MAX_REPORT_ENTRIES = 50
const { ANIMALS, createAnimalStates } = require('./animals')
const { createBookInventory, normalizeBookInventory } = require('./books')
const { createShopState, normalizeShopState } = require('./shop')
const { STAGE_BY_NUMBER } = require('./stages')

const DEFAULT_GAME_STATE = {
  ink: 0,
  feather: 0,
  candleSeconds: 0,
  books: createBookInventory(),
  stage: 1,
  cycleElapsedMs: 0,
  animals: createAnimalStates(),
  resourceGainRemainders: {
    ink: 0,
    candleSeconds: 0,
    feather: 0,
  },
  shop: createShopState(),
  librarian: {
    trustLevel: 1,
    approvalCount: 0,
    directive: '',
    pendingProposal: null,
    report: [],
  },
}

function createGameState () {
  return JSON.parse(JSON.stringify(DEFAULT_GAME_STATE))
}

function createSessionState () {
  return {
    sessionStartTime: Date.now(),
    sessionInk: 0,
    sessionCandle: 0,
  }
}

function copyReport (report) {
  if (!Array.isArray(report)) return []
  return report
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.action === 'string' && typeof entry.reason === 'string')
    .slice(-MAX_REPORT_ENTRIES)
    .map((entry) => ({
      at: Number.isFinite(entry.at) ? entry.at : Date.now(),
      action: entry.action,
      reason: entry.reason,
      status: typeof entry.status === 'string' ? entry.status : 'completed',
      seen: entry.seen === true,
    }))
}

// 저장 파일에는 게임 진행에 필요한 값만 넣는다. 실제 입력 기록은 저장하지 않는다.
function applySavedState (saved) {
  const state = createGameState()
  if (!saved || typeof saved !== 'object') return state

  for (const key of ['ink', 'feather', 'candleSeconds', 'cycleElapsedMs']) {
    if (Number.isFinite(saved[key]) && saved[key] >= 0) state[key] = saved[key]
  }
  state.books = normalizeBookInventory(saved.books)
  state.shop = normalizeShopState(saved.shop)
  if (STAGE_BY_NUMBER[saved.stage]) state.stage = saved.stage

  for (const definition of ANIMALS) {
    const savedAnimal = saved.animals?.[definition.id]
    if (!savedAnimal || typeof savedAnimal !== 'object') continue
    // 데모 조정 상태도 저장될 수 있도록 모든 동물에 같은 상태 집합을 허용한다.
    const allowedStatuses = ['unknown', 'discovered', 'invited', 'collected']
    if (!allowedStatuses.includes(savedAnimal.status)) continue
    state.animals[definition.id].status = savedAnimal.status
    state.animals[definition.id].visits = Number.isFinite(savedAnimal.visits) && savedAnimal.visits >= 0
      ? savedAnimal.visits
      : 0
    state.animals[definition.id].placed = savedAnimal.placed === true && savedAnimal.status === 'collected'
    const position = savedAnimal.screenPosition
    if (
      savedAnimal.status === 'collected' &&
      Number.isFinite(position?.x) &&
      Number.isFinite(position?.y)
    ) {
      state.animals[definition.id].screenPosition = {
        x: Math.min(1, Math.max(0, position.x)),
        y: Math.min(1, Math.max(0, position.y)),
      }
    }
  }

  for (const resource of ['ink', 'candleSeconds', 'feather']) {
    const remainder = saved.resourceGainRemainders?.[resource]
    if (Number.isFinite(remainder) && remainder >= 0 && remainder < 100) {
      state.resourceGainRemainders[resource] = remainder
    }
  }

  const librarian = saved.librarian
  if (librarian && typeof librarian === 'object') {
    state.librarian.trustLevel = Number.isFinite(librarian.trustLevel)
      ? Math.max(0, librarian.trustLevel)
      : state.librarian.trustLevel
    state.librarian.approvalCount = Number.isFinite(librarian.approvalCount)
      ? Math.max(0, librarian.approvalCount)
      : 0
    state.librarian.directive = typeof librarian.directive === 'string'
      ? librarian.directive.slice(0, 500)
      : ''
    state.librarian.report = copyReport(librarian.report)

    const proposal = librarian.pendingProposal
    if (proposal && proposal.action === 'craftBook' && typeof proposal.reason === 'string') {
      state.librarian.pendingProposal = {
        action: proposal.action,
        reason: proposal.reason.slice(0, 500),
        at: Number.isFinite(proposal.at) ? proposal.at : Date.now(),
      }
    }
  }
  return state
}

module.exports = { createGameState, createSessionState, applySavedState }
