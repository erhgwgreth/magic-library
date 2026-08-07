const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { createGameState, createSessionState } = require('./game/state')
const { actions, runAutomaticAnimalRules } = require('./game/actions')
const {
  ANIMALS,
  publicAnimalCatalog,
  inviteCostText,
  grantResource,
} = require('./game/animals')
const { BOOK_BY_ID, publicBookCatalog, bookCostText } = require('./game/books')
const { BUFF_BY_ID, publicShopCatalog } = require('./game/shop')
const {
  NORMAL_TIMING,
  timingFor,
  rescaleCycleElapsed,
  cycleElapsedForTimeOfDay,
  applyDemoStatePatch,
} = require('./game/demo')
const {
  normalizeCraftGoal,
  canUseCraftGoal,
  planCraftGoal,
  craftGoalText,
  clearCompletedCraftGoal,
} = require('./game/librarian-goal')
const { stageStateFor, stageCostText } = require('./game/stages')
const { loadGame, saveGame } = require('./game/save')
const { loadLibrarianSettings, saveLibrarianSettings } = require('./game/settings')
const { requestLibrarianDecision } = require('./game/librarian')
const { setBgmVolume } = require('./game/audio')
const {
  TRUST_PROGRESS_PROPOSAL_ACCEPT,
  TRUST_PROGRESS_CRAFT_BOOK,
  TRUST_PROGRESS_INVITE_ANIMAL,
  TRUST_PROGRESS_PROPOSAL_DECLINE,
  adjustLibrarianApprovalCount,
  librarianTrustProgress,
} = require('./game/trust')
const {
  craftGoalAllowed,
  clearDisallowedCraftGoal,
  safeDirectiveReason,
} = require('./game/directive')

// 사서 모델 설정은 나중에 한 곳에서만 조정하면 된다.
const LIBRARIAN_MODEL = 'gpt-5.6-terra'
const LIBRARIAN_REASONING_EFFORT = 'low'
const LIBRARIAN_TRUST_FOR_PHASE_TWO = 2
const LIBRARIAN_BACKOFF_MAX_MS = 30 * 60 * 1000
const LIBRARIAN_BATCH_CRAFT_LIMIT = 500
const TICK_MS = 1000
const SAVE_INTERVAL_MS = 30 * 1000
const GRACE_MS = 5000
const RHYTHM_WINDOW_MS = 5 * 60 * 1000
const MAX_NOTIFICATIONS = 5
const MAX_REPORT_ENTRIES = 50
const ANIMAL_CATALOG = publicAnimalCatalog()
const BOOK_CATALOG = publicBookCatalog()
const SHOP_CATALOG = publicShopCatalog()

let mainWindow = null
let gameFocused = true
let gameState = null
let sessionState = null
let librarianSettings = { apiKey: '', useDirectApi: false }
let demoMode = false
let lastWorkKeyTime = 0
let lastTickTime = 0
let lastSaveTime = 0
let notifications = []
let typingTimestamps = []
let deleteTimestamps = []
let librarianIsCalling = false
let librarianCallToken = 0
let lastLibrarianCallTime = 0
let nextLibrarianCallTime = 0
let librarianFailureCount = 0
let lastActionAvailability = ''

// 입력 내용이나 keycode는 절대 보관하지 않는다. 어떤 종류의 작업도 아닌 입력 시각만 쓴다.
const NON_INK_KEYS = new Set([
  UiohookKey.Backspace, UiohookKey.Delete,
  UiohookKey.Shift, UiohookKey.ShiftRight,
  UiohookKey.Ctrl, UiohookKey.CtrlRight,
  UiohookKey.Alt, UiohookKey.AltRight,
  UiohookKey.Meta, UiohookKey.MetaRight,
  UiohookKey.CapsLock, UiohookKey.Tab, UiohookKey.Escape,
  UiohookKey.ArrowUp, UiohookKey.ArrowDown,
  UiohookKey.ArrowLeft, UiohookKey.ArrowRight,
  UiohookKey.Home, UiohookKey.End, UiohookKey.PageUp, UiohookKey.PageDown,
])

function getTimeOfDay () {
  const cycleMs = timingFor(demoMode).cycleMs
  const progress = (gameState.cycleElapsedMs % cycleMs) / cycleMs
  if (progress < 0.25) return 'day'
  if (progress < 0.5) return 'afternoon'
  if (progress < 0.75) return 'sunset'
  return 'night'
}

function getAvailability () {
  const timeOfDay = getTimeOfDay()
  const craftBooks = Object.fromEntries(BOOK_CATALOG.map((tier) => [
    tier.id,
    {
      ...actions.craftBook.canExecute(gameState, timeOfDay, tier.id),
      cost: actions.craftBook.cost(gameState, tier.id),
    },
  ]))
  const inviteAnimals = {}
  const placeAnimals = {}
  for (const animal of ANIMALS) {
    if (animal.type === 'normal') {
      inviteAnimals[animal.id] = actions.inviteAnimal.canExecute(gameState, timeOfDay, animal.id)
    }
    placeAnimals[animal.id] = actions.placeAnimal.canExecute(gameState, timeOfDay, animal.id)
  }
  const shop = {
    alchemy: Object.fromEntries(SHOP_CATALOG.alchemy.map((item) => [
      item.id,
      actions.buyAlchemy.canExecute(gameState, timeOfDay, item.id),
    ])),
    buffs: Object.fromEntries(SHOP_CATALOG.buffs.map((item) => [
      item.id,
      actions.buyBuff.canExecute(gameState, timeOfDay, item.id),
    ])),
    upgrades: Object.fromEntries(SHOP_CATALOG.upgrades.map((item) => [
      item.id,
      {
        ...actions.buyUpgrade.canExecute(gameState, timeOfDay, item.id),
        cost: actions.buyUpgrade.cost(gameState, item.id),
      },
    ])),
  }
  return {
    craftBooks,
    expandShelf: actions.expandShelf.canExecute(gameState, timeOfDay),
    inviteAnimals,
    placeAnimals,
    shop,
  }
}

function librarianPhase () {
  return gameState.librarian.trustLevel >= LIBRARIAN_TRUST_FOR_PHASE_TWO ? 2 : 1
}

function librarianGoalMode () {
  return canUseCraftGoal(gameState.librarian.trustLevel, gameState.librarian.craftGoal)
}

function currentCraftGoalPlan () {
  const plan = planCraftGoal(gameState.books, gameState.librarian.craftGoal)
  if (plan.status !== 'craft') return plan

  const check = actions.craftBook.canExecute(gameState, getTimeOfDay(), plan.tierId)
  return check.ok
    ? plan
    : { ...plan, status: 'blocked', blockReason: check.reason }
}

function goalModeAvailableActions () {
  const plan = currentCraftGoalPlan()
  const available = [{
    id: 'wait',
    description: plan.status === 'complete'
      ? '맡긴 제작 목표가 완료되었음을 보고한다.'
      : `맡긴 제작 목표를 유지하며 기다린다.${plan.blockReason ? ` ${plan.blockReason}` : ''}`,
  }]

  if (plan.status === 'craft') {
    const tier = BOOK_BY_ID[plan.tierId]
    available.unshift({
      id: 'craftBook',
      args: { tierId: plan.tierId },
      description: `맡긴 목표를 위해 ${tier.name} 1권을 제작한다. ${bookCostText(actions.craftBook.cost(gameState, plan.tierId))}을 소모한다.`,
    })
  }
  return available
}

function getLibrarianAvailableActions () {
  if (librarianGoalMode()) return goalModeAvailableActions()

  const timeOfDay = getTimeOfDay()
  const available = []

  // 호출 직전에 모든 후보의 canExecute를 확인해 가능한 행동만 모델에 건넨다.
  if (actions.wait.canExecute(gameState, timeOfDay).ok) {
    available.push({ id: 'wait', description: '아무것도 하지 않고 조용히 기다린다.' })
  }
  if (actions.notify.canExecute(gameState, timeOfDay).ok) {
    available.push({ id: 'notify', description: '주인에게 짧은 알림이나 책 제작 제안을 하나 남긴다.' })
  }

  const craftAction = actions.craftBook
  const craftCheck = craftAction.canExecute(gameState, timeOfDay, 'basic')
  const phaseAllowsCrafting = librarianPhase() >= 2
  const trustAllowsCrafting = craftAction.requiredTrust <= gameState.librarian.trustLevel

  if (phaseAllowsCrafting && trustAllowsCrafting && craftCheck.ok) {
    available.push({
      id: 'craftBook',
      args: { tierId: 'basic' },
      description: `기초 마법장서 1권을 제작한다. ${bookCostText(craftAction.cost(gameState, 'basic'))}을 소모한다.`,
    })
  } else {
    const excludedReason = !phaseAllowsCrafting
      ? `사서 단계 ${librarianPhase()}에서는 직접 제작 권한이 없습니다.`
      : !trustAllowsCrafting
        ? '신뢰도가 부족합니다.'
        : craftCheck.reason
    console.log('[사서] 행동 필터', {
      id: craftAction.id,
      requiredTrust: craftAction.requiredTrust,
      trustLevel: gameState.librarian.trustLevel,
      canExecute: craftCheck,
      excludedReason,
    })
  }

  const expandAction = actions.expandShelf
  const expandCheck = expandAction.canExecute(gameState, timeOfDay)
  const next = stageStateFor(gameState.stage).next
  if (
    next &&
    expandAction.requiredTrust <= gameState.librarian.trustLevel &&
    expandCheck.ok
  ) {
    available.push({
      id: 'expandShelf',
      description: `${next.name}(으)로 확장한다. ${stageCostText(next.expandCost)}이 필요하다. 큰 자원이 드는 확장이다.`,
    })
  }

  if (actions.inviteAnimal.requiredTrust <= gameState.librarian.trustLevel) {
    for (const animal of ANIMALS.filter((candidate) => candidate.type === 'normal')) {
      const animalState = gameState.animals[animal.id]
      if (!['discovered', 'invited'].includes(animalState.status)) continue
      const inviteCheck = actions.inviteAnimal.canExecute(gameState, timeOfDay, animal.id)
      if (!inviteCheck.ok) continue
      available.push({
        id: 'inviteAnimal',
        args: { animalId: animal.id },
        description: `${animal.name}를 초대한다. ${inviteCostText(animal)}을(를) 소모한다.`,
      })
    }
  }
  return available
}

function librarianActionSignature (action) {
  if (action.args?.animalId) return `${action.id}(${action.args.animalId})`
  if (action.args?.tierId) return `${action.id}(${action.args.tierId})`
  return action.id
}

function trimTimestamps (timestamps, now = Date.now()) {
  const cutoff = now - RHYTHM_WINDOW_MS
  return timestamps.filter((timestamp) => timestamp >= cutoff)
}

function getRhythm () {
  const now = Date.now()
  typingTimestamps = trimTimestamps(typingTimestamps, now)
  deleteTimestamps = trimTimestamps(deleteTimestamps, now)
  const inputCount = typingTimestamps.length + deleteTimestamps.length
  const lastInputAt = lastWorkKeyTime || sessionState.sessionStartTime

  return {
    typingSpeed: Math.round(typingTimestamps.length / (RHYTHM_WINDOW_MS / 60000)),
    deleteRatio: inputCount ? Number((deleteTimestamps.length / inputCount).toFixed(2)) : 0,
    idleSeconds: Math.max(0, Math.floor((now - lastInputAt) / 1000)),
    sessionMinutes: Number(((now - sessionState.sessionStartTime) / 60000).toFixed(1)),
    timeOfDay: getTimeOfDay(),
  }
}

function addNotification (message) {
  notifications.push({ id: `${Date.now()}-${Math.random()}`, message })
  if (notifications.length > MAX_NOTIFICATIONS) notifications = notifications.slice(-MAX_NOTIFICATIONS)
}

function adjustLibrarianTrustProgress (amount) {
  const previousTrustLevel = gameState.librarian.trustLevel
  const changed = adjustLibrarianApprovalCount(gameState.librarian, amount)
  const goalCleared = clearDisallowedCraftGoal(gameState.librarian)
  if (changed && gameState.librarian.trustLevel > previousTrustLevel) {
    addNotification(`사서와의 신뢰가 ${gameState.librarian.trustLevel}단계가 되었습니다.`)
  }
  return changed || goalCleared
}

function recordLibrarianAchievement (actionId) {
  if (actionId === 'craftBook') {
    adjustLibrarianTrustProgress(TRUST_PROGRESS_CRAFT_BOOK)
  } else if (actionId === 'inviteAnimal') {
    adjustLibrarianTrustProgress(TRUST_PROGRESS_INVITE_ANIMAL)
  }
}

function addLibrarianReport (action, reason, status) {
  gameState.librarian.report.push({ at: Date.now(), action, reason, status, seen: false })
  if (gameState.librarian.report.length > MAX_REPORT_ENTRIES) {
    gameState.librarian.report = gameState.librarian.report.slice(-MAX_REPORT_ENTRIES)
  }
}

function markLibrarianReportAsRead () {
  let changed = false
  for (const entry of gameState.librarian.report) {
    if (!entry.seen) {
      entry.seen = true
      changed = true
    }
  }
  if (changed) saveCurrentGame()
  sendGameState()
}

function clearReadLibrarianReport () {
  const unreadEntries = gameState.librarian.report.filter((entry) => !entry.seen)
  if (unreadEntries.length !== gameState.librarian.report.length) {
    gameState.librarian.report = unreadEntries
    saveCurrentGame()
  }
  sendGameState()
}

function applyAutomaticRules () {
  for (const message of runAutomaticAnimalRules(gameState, getTimeOfDay())) addNotification(message)
}

function saveCurrentGame () {
  if (!gameState) return
  const stateToSave = demoMode
    ? {
        ...gameState,
        cycleElapsedMs: rescaleCycleElapsed(
          gameState.cycleElapsedMs,
          timingFor(true).cycleMs,
          NORMAL_TIMING.cycleMs,
        ),
      }
    : gameState
  saveGame(app.getPath('userData'), stateToSave)
}

function sendGameState () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('game-state', {
    ...gameState,
    timeOfDay: getTimeOfDay(),
    session: sessionState,
    availability: getAvailability(),
    stageInfo: stageStateFor(gameState.stage),
    bookCatalog: BOOK_CATALOG,
    shopCatalog: SHOP_CATALOG,
    demoMode,
    effectiveBuffDurationMs: timingFor(demoMode).buffDurationMs,
    animalCatalog: ANIMAL_CATALOG,
    notifications,
    librarianPhase: librarianPhase(),
    librarianTrustProgress: librarianTrustProgress(gameState.librarian),
    // 중계 서버가 기본 경로이므로 게임 내부 키가 없어도 사서는 활성 상태다.
    librarianEnabled: true,
    librarianUsesDirectApi: librarianSettings.useDirectApi === true && Boolean(librarianSettings.apiKey),
  })
}

function runAction (actionName, args = {}) {
  const action = actions[actionName]
  if (!action) return { success: false, message: '알 수 없는 행동입니다.' }

  const animalId = typeof args?.animalId === 'string' ? args.animalId : null
  const tierId = typeof args?.tierId === 'string' ? args.tierId : 'basic'
  const shopItemId = typeof args?.itemId === 'string' ? args.itemId : null
  const actionArgument = actionName === 'craftBook'
    ? tierId
    : ['buyAlchemy', 'buyBuff', 'buyUpgrade'].includes(actionName)
      ? shopItemId
      : animalId
  const actionOptions = actionName === 'buyBuff'
    ? { buffDurationMs: timingFor(demoMode).buffDurationMs }
    : undefined
  const result = action.execute(gameState, getTimeOfDay(), actionArgument, actionOptions)
  if (result.success) {
    addNotification(result.message)
    applyAutomaticRules()
    saveCurrentGame()
  }
  sendGameState()
  return result
}

function librarianPayload () {
  const stageInfo = stageStateFor(gameState.stage)
  const allowCraftGoal = craftGoalAllowed(gameState.librarian.trustLevel)
  const goalMode = allowCraftGoal && librarianGoalMode()
  const goalPlan = goalMode ? currentCraftGoalPlan() : null
  return {
    directive: gameState.librarian.directive,
    directivePolicy: { allowCraftGoal },
    craftGoal: allowCraftGoal ? gameState.librarian.craftGoal : null,
    goalMode,
    craftGoalPlan: goalPlan
      ? {
          status: goalPlan.status,
          tierId: goalPlan.tierId || null,
          required: goalPlan.required || null,
          blockReason: goalPlan.blockReason || null,
          willCompleteAfterNextCraft: goalPlan.willCompleteAfterNextCraft === true,
          goalText: craftGoalText(gameState.librarian.craftGoal),
        }
      : null,
    rhythm: getRhythm(),
    library: {
      ink: gameState.ink,
      feather: gameState.feather,
      candleSeconds: gameState.candleSeconds,
      books: { ...gameState.books },
      stage: gameState.stage,
    },
    stage: {
      current: stageInfo.current,
      next: stageInfo.next,
    },
    animals: Object.fromEntries(ANIMALS.map((definition) => [
      definition.id,
      {
        name: definition.name,
        type: definition.type,
        status: gameState.animals[definition.id].status,
        visits: gameState.animals[definition.id].visits,
        placed: gameState.animals[definition.id].placed,
      },
    ])),
    trustLevel: gameState.librarian.trustLevel,
    availableActions: getLibrarianAvailableActions(),
  }
}

function availabilitySignature () {
  const craftIsPossible = actions.craftBook.canExecute(gameState, getTimeOfDay(), 'basic').ok
  return `${getLibrarianAvailableActions().map(librarianActionSignature).join('|')}|proposal:${craftIsPossible}`
}

function recordLibrarianInput (isDelete) {
  const now = Date.now()
  if (isDelete) deleteTimestamps.push(now)
  else typingTimestamps.push(now)
  lastWorkKeyTime = now
}

function cleanLibrarianReason (decision) {
  return typeof decision?.reason === 'string' ? decision.reason.trim().slice(0, 500) : ''
}

function adoptCraftGoalFromDecision (decision) {
  if (!craftGoalAllowed(gameState.librarian.trustLevel)) return false
  const directive = gameState.librarian.directive.trim()
  if (!directive) return false
  if (gameState.librarian.craftGoal && gameState.librarian.craftGoalDirective === directive) return false
  const craftGoal = normalizeCraftGoal(decision?.craftGoal)
  if (!craftGoal || planCraftGoal(gameState.books, craftGoal).status === 'invalid') return false

  gameState.librarian.craftGoal = craftGoal
  gameState.librarian.craftGoalDirective = directive
  saveCurrentGame()
  return true
}

function completeCraftGoal (modelReason = '') {
  const goal = gameState.librarian.craftGoal
  const summary = craftGoalText(goal)
  const reason = /마쳤|준비했|준비했습니다/.test(modelReason)
    ? modelReason
    : `맡기신 일을 마쳤어요. ${summary}을 준비했습니다.`

  clearCompletedCraftGoal(gameState.librarian)
  addLibrarianReport('craftGoal', reason, 'completed')
  addNotification(reason)
  return reason
}

function goalProgressReason (modelReason) {
  return modelReason && !/마쳤/.test(modelReason)
    ? modelReason
    : '맡기신 일을 진행하고 있어요.'
}

function goalWaitingReason (modelReason) {
  return modelReason && /기다|모이|부족/.test(modelReason)
    ? modelReason
    : '맡기신 일을 이어가고 있어요. 재료가 모이길 기다리는 중이에요.'
}

function craftedBooksText (craftedBooks) {
  return BOOK_CATALOG
    .filter((tier) => craftedBooks[tier.id] > 0)
    .map((tier) => `${tier.name.replace(' 마법장서', '')} 장서 ${craftedBooks[tier.id]}권`)
    .join(', ')
}

function craftCostSnapshot (cost) {
  const snapshot = {}
  for (const [resource, amount] of Object.entries(cost || {})) {
    if (resource === 'trustLevel' || !Number.isFinite(amount) || amount <= 0) continue
    if (resource === 'books') continue
    snapshot[resource] = gameState[resource]
  }
  for (const [tierId, amount] of Object.entries(cost?.books || {})) {
    if (Number.isFinite(amount) && amount > 0) snapshot[`books:${tierId}`] = gameState.books[tierId]
  }
  return snapshot
}

function craftCostDecreased (snapshot) {
  return Object.entries(snapshot).some(([resource, before]) => {
    const after = resource.startsWith('books:')
      ? gameState.books[resource.slice('books:'.length)]
      : gameState[resource]
    return Number.isFinite(before) && Number.isFinite(after) && after < before
  })
}

function executeBatchCraftGoal () {
  const craftedBooks = Object.fromEntries(BOOK_CATALOG.map((tier) => [tier.id, 0]))
  let stopReason = 'limit'

  for (let count = 0; count < LIBRARIAN_BATCH_CRAFT_LIMIT; count += 1) {
    const plan = currentCraftGoalPlan()
    if (plan.status !== 'craft') {
      stopReason = plan.status
      break
    }

    const cost = actions.craftBook.cost(gameState, plan.tierId)
    const resourceSnapshot = craftCostSnapshot(cost)
    const result = actions.craftBook.execute(gameState, getTimeOfDay(), plan.tierId)
    if (!result.success) {
      stopReason = 'blocked'
      break
    }

    craftedBooks[plan.tierId] += 1
    if (!craftCostDecreased(resourceSnapshot)) {
      stopReason = 'no-resource-decrease'
      break
    }

    recordLibrarianAchievement('craftBook')
    applyAutomaticRules()
  }

  const finalPlan = currentCraftGoalPlan()
  const summary = craftedBooksText(craftedBooks)
  if (finalPlan.status === 'complete') {
    const reason = summary
      ? `맡기신 일을 마쳤어요. ${summary}을 준비했습니다.`
      : ''
    completeCraftGoal(reason)
  } else {
    const progress = summary ? `방금 ${summary}을 마련했어요. ` : ''
    const reason = stopReason === 'limit'
      ? `맡기신 일을 이어가고 있어요. ${progress}한 번에 처리할 수 있는 제작량에 도달해 다음 판단에서 계속하겠습니다.`
      : `맡기신 일을 이어가고 있어요. ${progress}재료가 더 모이면 계속하겠습니다.`
    addLibrarianReport(summary ? 'craftGoalBatch' : 'wait', reason, summary ? 'completed' : 'waiting')
    addNotification(reason)
  }
  saveCurrentGame()
  return true
}

function executeCraftGoalDecision (decision) {
  const plan = currentCraftGoalPlan()
  const modelReason = cleanLibrarianReason(decision)

  if (plan.status === 'invalid') {
    gameState.librarian.craftGoal = null
    gameState.librarian.craftGoalDirective = ''
    saveCurrentGame()
    return false
  }
  if (plan.status === 'complete') {
    completeCraftGoal(modelReason)
    saveCurrentGame()
    return true
  }
  if (plan.status === 'blocked') {
    const reason = goalWaitingReason(modelReason)
    actions.wait.execute(gameState, getTimeOfDay(), reason)
    addLibrarianReport('wait', reason, 'waiting')
    saveCurrentGame()
    return true
  }

  // 신뢰 4단계만 한 번의 모델 판단 안에서 코드가 목표 제작을 반복한다.
  // 3단계 이하는 아래의 기존 단일 제작 경로를 그대로 사용한다.
  if (gameState.librarian.trustLevel >= 4) return executeBatchCraftGoal()

  // LLM의 행동·등급 선택은 신뢰하지 않고 코드가 계산한 등급을 다시 검증한다.
  const canExecute = actions.craftBook.canExecute(gameState, getTimeOfDay(), plan.tierId)
  if (!canExecute.ok) {
    const reason = goalWaitingReason(modelReason)
    addLibrarianReport('wait', reason, 'waiting')
    saveCurrentGame()
    return true
  }

  const result = actions.craftBook.execute(gameState, getTimeOfDay(), plan.tierId)
  if (!result.success) {
    const reason = goalWaitingReason(modelReason)
    addLibrarianReport('wait', reason, 'waiting')
    saveCurrentGame()
    return true
  }

  recordLibrarianAchievement('craftBook')
  applyAutomaticRules()
  const nextPlan = planCraftGoal(gameState.books, gameState.librarian.craftGoal)
  if (nextPlan.status === 'complete') {
    completeCraftGoal(plan.willCompleteAfterNextCraft ? modelReason : '')
  } else {
    const reason = goalProgressReason(modelReason)
    addLibrarianReport(`craftBook:${plan.tierId}`, reason, 'completed')
    addNotification(reason)
  }
  saveCurrentGame()
  return true
}

function executeLibrarianDecision (decision) {
  if (!decision || typeof decision !== 'object' || typeof decision.action !== 'string' || typeof decision.reason !== 'string') return
  adoptCraftGoalFromDecision(decision)
  if (librarianGoalMode() && executeCraftGoalDecision(decision)) return

  const available = getLibrarianAvailableActions()
  const animalId = typeof decision.args?.animalId === 'string' ? decision.args.animalId : null
  const selectedAction = available.find((item) => (
    item.id === decision.action &&
    (item.args?.animalId || null) === animalId
  ))
  if (!selectedAction) return

  const action = actions[decision.action]
  if (!action || action.requiredTrust > gameState.librarian.trustLevel) return
  const canExecute = decision.action === 'inviteAnimal'
    ? action.canExecute(gameState, getTimeOfDay(), animalId)
    : decision.action === 'craftBook'
      ? action.canExecute(gameState, getTimeOfDay(), 'basic')
      : action.canExecute(gameState, getTimeOfDay())
  if (!canExecute.ok) return

  const reason = safeDirectiveReason({
    directive: gameState.librarian.directive,
    reason: decision.reason.trim().slice(0, 500),
    actionId: decision.action,
    trustLevel: gameState.librarian.trustLevel,
  })
  if (!reason) return

  if (decision.action === 'notify') {
    const proposalAction = decision.args?.proposalAction ?? null
    const craftCheck = actions.craftBook.canExecute(gameState, getTimeOfDay(), 'basic')
    if (librarianPhase() === 1 && proposalAction === 'craftBook' && craftCheck.ok && !gameState.librarian.pendingProposal) {
      gameState.librarian.pendingProposal = { action: 'craftBook', reason, at: Date.now() }
      addLibrarianReport('notify', reason, 'proposed')
      addNotification('사서가 책 제작을 제안했습니다. 보고서에서 수락하거나 거절할 수 있습니다.')
    } else {
      action.execute(gameState, getTimeOfDay(), reason)
      addLibrarianReport('notify', reason, 'completed')
      addNotification(reason)
    }
  } else if (decision.action === 'wait') {
    action.execute(gameState, getTimeOfDay(), reason)
    addLibrarianReport('wait', reason, 'completed')
  } else {
    const result = decision.action === 'inviteAnimal'
      ? action.execute(gameState, getTimeOfDay(), animalId)
      : decision.action === 'craftBook'
        ? action.execute(gameState, getTimeOfDay(), 'basic')
        : action.execute(gameState, getTimeOfDay())
    if (!result.success) return
    recordLibrarianAchievement(decision.action)
    addLibrarianReport(
      decision.action === 'inviteAnimal' ? `inviteAnimal:${animalId}` : decision.action,
      reason,
      'completed',
    )
    addNotification(reason)
    applyAutomaticRules()
  }
  saveCurrentGame()
}

async function maybeInvokeLibrarian (trigger = 'interval') {
  const now = Date.now()
  const timing = timingFor(demoMode)
  const due = now - lastLibrarianCallTime >= timing.librarianIntervalMs
  if (librarianIsCalling) {
    return
  }
  if (now < nextLibrarianCallTime) {
    return
  }
  if (now - lastLibrarianCallTime < timing.librarianMinGapMs) {
    return
  }
  if (!due && trigger !== 'availability') {
    return
  }

  librarianIsCalling = true
  const callToken = ++librarianCallToken
  lastLibrarianCallTime = now
  try {
    const payload = librarianPayload()
    console.log('[사서] 전송 payload', {
      directive: payload.directive,
      trustLevel: payload.trustLevel,
      availableActions: payload.availableActions.map(librarianActionSignature),
      ink: payload.library.ink,
    })
    const decision = await requestLibrarianDecision({
      apiKey: librarianSettings.apiKey,
      useDirectApi: librarianSettings.useDirectApi,
      model: LIBRARIAN_MODEL,
      reasoningEffort: LIBRARIAN_REASONING_EFFORT,
      payload,
    })
    if (callToken !== librarianCallToken) return
    executeLibrarianDecision(decision)
    librarianFailureCount = 0
  } catch (error) {
    if (callToken !== librarianCallToken) return
    console.error('[사서] 호출 오류', error)
    // API 오류는 게임 화면이나 보고서에 표시하지 않는다. 다음 시도만 천천히 늦춘다.
    librarianFailureCount += 1
    const delay = Math.min(timing.librarianMinGapMs * (2 ** librarianFailureCount), LIBRARIAN_BACKOFF_MAX_MS)
    nextLibrarianCallTime = Date.now() + delay
  } finally {
    if (callToken === librarianCallToken) {
      librarianIsCalling = false
      sendGameState()
    }
  }
}

function respondToProposal (accepted) {
  const proposal = gameState.librarian.pendingProposal
  if (!proposal) return { success: false, message: '처리할 사서 제안이 없습니다.' }
  gameState.librarian.pendingProposal = null

  if (!accepted) {
    adjustLibrarianTrustProgress(TRUST_PROGRESS_PROPOSAL_DECLINE)
    addLibrarianReport(proposal.action, proposal.reason, 'declined')
    addNotification('사서의 제안을 거절했습니다.')
    saveCurrentGame()
    sendGameState()
    return { success: true, message: '제안을 거절했습니다.' }
  }

  const action = actions[proposal.action]
  const canExecute = proposal.action === 'craftBook'
    ? action?.canExecute(gameState, getTimeOfDay(), 'basic')
    : action?.canExecute(gameState, getTimeOfDay())
  if (!action || !canExecute.ok) {
    addLibrarianReport(proposal.action, proposal.reason, 'unavailable')
    addNotification('제안을 실행할 수 없어 조용히 넘겼습니다.')
    saveCurrentGame()
    sendGameState()
    return { success: false, message: '현재는 제안을 실행할 수 없습니다.' }
  }

  const result = proposal.action === 'craftBook'
    ? action.execute(gameState, getTimeOfDay(), 'basic')
    : action.execute(gameState, getTimeOfDay())
  if (!result.success) return result
  const previousPhase = librarianPhase()
  adjustLibrarianTrustProgress(TRUST_PROGRESS_PROPOSAL_ACCEPT)
  addLibrarianReport(proposal.action, proposal.reason, 'approved')
  addNotification(result.message)
  if (previousPhase === 1 && librarianPhase() === 2) {
    addNotification('사서가 당신의 신뢰를 얻어 책 제작을 맡을 수 있게 되었습니다.')
  }
  applyAutomaticRules()
  saveCurrentGame()
  sendGameState()
  return result
}

function updateDirective (directive) {
  gameState.librarian.directive = typeof directive === 'string' ? directive.trim().slice(0, 500) : ''
  saveCurrentGame()
  sendGameState()
  return { success: true }
}

function updateAnimalPosition (animalId, position) {
  const animal = gameState.animals[animalId]
  if (!animal || animal.status !== 'collected') {
    return { success: false, message: '수집을 완료한 동물만 옮길 수 있습니다.' }
  }
  if (!Number.isFinite(position?.x) || !Number.isFinite(position?.y)) {
    return { success: false, message: '올바르지 않은 위치입니다.' }
  }
  animal.screenPosition = {
    x: Math.min(1, Math.max(0, position.x)),
    y: Math.min(1, Math.max(0, position.y)),
  }
  saveCurrentGame()
  sendGameState()
  return { success: true }
}

function updateApiKey (apiKey, useDirectApi) {
  librarianSettings = {
    apiKey: typeof apiKey === 'string' ? apiKey.trim() : '',
    useDirectApi: useDirectApi === true,
  }
  saveLibrarianSettings(app.getPath('userData'), librarianSettings)
  librarianFailureCount = 0
  nextLibrarianCallTime = 0
  sendGameState()
  return {
    success: true,
    hasApiKey: Boolean(librarianSettings.apiKey),
    usesDirectApi: librarianSettings.useDirectApi && Boolean(librarianSettings.apiKey),
  }
}

function updateBgmVolume (volume) {
  if (!Number.isFinite(volume)) return { success: false, message: '올바르지 않은 볼륨입니다.' }
  const changed = setBgmVolume(gameState, volume)
  if (changed) saveCurrentGame()
  sendGameState()
  return { success: true, volume: gameState.settings.bgmVolume }
}

function quitGame () {
  saveCurrentGame()
  app.quit()
  return { success: true }
}

function setDemoMode (enabled) {
  const nextDemoMode = enabled === true
  if (nextDemoMode === demoMode) return { success: true, demoMode }

  const previousTiming = timingFor(demoMode)
  const nextTiming = timingFor(nextDemoMode)
  gameState.cycleElapsedMs = rescaleCycleElapsed(
    gameState.cycleElapsedMs,
    previousTiming.cycleMs,
    nextTiming.cycleMs,
  )
  demoMode = nextDemoMode
  librarianFailureCount = 0
  nextLibrarianCallTime = 0
  lastLibrarianCallTime = Date.now()
  lastActionAvailability = availabilitySignature()
  sendGameState()
  return { success: true, demoMode }
}

function updateDemoState (patch) {
  if (!demoMode) return { success: false, message: '데모 모드에서만 상태를 조정할 수 있습니다.' }
  const changed = applyDemoStatePatch(gameState, patch)
  if (changed) saveCurrentGame()
  sendGameState()
  return { success: changed, message: changed ? '' : '적용할 수 있는 값이 없습니다.' }
}

function activateDemoBuff (buffId) {
  if (!demoMode) return { success: false, message: '데모 모드에서만 버프를 활성화할 수 있습니다.' }
  const buff = BUFF_BY_ID[buffId]
  if (!buff) return { success: false, message: '알 수 없는 버프입니다.' }
  gameState.shop.buffs[buffId] = Date.now() + timingFor(true).buffDurationMs
  saveCurrentGame()
  sendGameState()
  return { success: true }
}

function setDemoTimeOfDay (timeOfDay) {
  if (!demoMode) return { success: false, message: '데모 모드에서만 시간대를 조정할 수 있습니다.' }
  const elapsedMs = cycleElapsedForTimeOfDay(timeOfDay, timingFor(true).cycleMs)
  if (elapsedMs === null) return { success: false, message: '알 수 없는 시간대입니다.' }
  gameState.cycleElapsedMs = elapsedMs
  saveCurrentGame()
  sendGameState()
  return { success: true }
}

function resetDemoSave () {
  if (!demoMode) return { success: false, message: '데모 모드에서만 세이브를 초기화할 수 있습니다.' }
  gameState = createGameState()
  sessionState = createSessionState()
  notifications = []
  typingTimestamps = []
  deleteTimestamps = []
  lastWorkKeyTime = 0
  lastTickTime = Date.now()
  lastSaveTime = Date.now()
  librarianIsCalling = false
  librarianCallToken += 1
  librarianFailureCount = 0
  nextLibrarianCallTime = 0
  lastLibrarianCallTime = Date.now()
  lastActionAvailability = availabilitySignature()
  saveCurrentGame()
  sendGameState()
  return { success: true }
}

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 576,
    height: 1024,
    center: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile('index.html')
  mainWindow.webContents.on('did-finish-load', sendGameState)
  mainWindow.on('focus', () => { gameFocused = true })
  mainWindow.on('blur', () => { gameFocused = false })
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(() => {
  gameState = loadGame(app.getPath('userData'))
  gameState.cycleElapsedMs %= NORMAL_TIMING.cycleMs
  librarianSettings = loadLibrarianSettings(app.getPath('userData'))
  sessionState = createSessionState()
  lastTickTime = Date.now()
  lastSaveTime = Date.now()
  lastLibrarianCallTime = Date.now()
  lastActionAvailability = availabilitySignature()
  createWindow()

  ipcMain.handle('perform-action', (_event, actionName, args) => runAction(actionName, args))
  ipcMain.handle('update-animal-position', (_event, animalId, position) => updateAnimalPosition(animalId, position))
  ipcMain.handle('respond-to-librarian-proposal', (_event, accepted) => respondToProposal(accepted === true))
  ipcMain.handle('update-librarian-directive', (_event, directive) => updateDirective(directive))
  ipcMain.handle('save-librarian-api-key', (_event, apiKey, useDirectApi) => updateApiKey(apiKey, useDirectApi))
  ipcMain.handle('set-demo-mode', (_event, enabled) => setDemoMode(enabled))
  ipcMain.handle('update-demo-state', (_event, patch) => updateDemoState(patch))
  ipcMain.handle('activate-demo-buff', (_event, buffId) => activateDemoBuff(buffId))
  ipcMain.handle('set-demo-time-of-day', (_event, timeOfDay) => setDemoTimeOfDay(timeOfDay))
  ipcMain.handle('reset-demo-save', () => resetDemoSave())
  ipcMain.handle('set-bgm-volume', (_event, volume) => updateBgmVolume(volume))
  ipcMain.handle('quit-game', () => quitGame())
  ipcMain.handle('mark-librarian-report-read', () => markLibrarianReportAsRead())
  ipcMain.handle('clear-read-librarian-report', () => clearReadLibrarianReport())

  uIOhook.on('keydown', (event) => {
    if (gameFocused) return
    if (event.keycode === UiohookKey.Backspace || event.keycode === UiohookKey.Delete) {
      grantResource(gameState, 'feather', 1)
      recordLibrarianInput(true)
    } else if (!NON_INK_KEYS.has(event.keycode)) {
      sessionState.sessionInk += grantResource(gameState, 'ink', 1)
      recordLibrarianInput(false)
    } else {
      return
    }
  })
  uIOhook.start()

  setInterval(() => {
    const now = Date.now()
    const elapsed = now - lastTickTime
    lastTickTime = now
    const stillWorking = now - lastWorkKeyTime <= GRACE_MS

    // 시간은 창 포커스와 무관하게 흐르고, 자원 기록만 외부 작업 중일 때 한다.
    const cycleMs = timingFor(demoMode).cycleMs
    gameState.cycleElapsedMs = (gameState.cycleElapsedMs + elapsed) % cycleMs
    if (!gameFocused && stillWorking) {
      sessionState.sessionCandle += grantResource(gameState, 'candleSeconds', 1)
    }
    applyAutomaticRules()

    const currentAvailability = availabilitySignature()
    if (currentAvailability !== lastActionAvailability) {
      lastActionAvailability = currentAvailability
      void maybeInvokeLibrarian('availability')
    }
    void maybeInvokeLibrarian('interval')

    if (now - lastSaveTime >= SAVE_INTERVAL_MS) {
      saveCurrentGame()
      lastSaveTime = now
    }
    sendGameState()
  }, TICK_MS)
})

app.on('before-quit', saveCurrentGame)
app.on('window-all-closed', () => {
  uIOhook.stop()
  if (process.platform !== 'darwin') app.quit()
})
