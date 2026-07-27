const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('path')
const { uIOhook, UiohookKey } = require('uiohook-napi')
const { createSessionState } = require('./game/state')
const { actions, runAutomaticAnimalRules } = require('./game/actions')
const {
  ANIMALS,
  publicAnimalCatalog,
  inviteCostText,
  grantResource,
} = require('./game/animals')
const { stageStateFor, stageCostText } = require('./game/stages')
const { loadGame, saveGame } = require('./game/save')
const { loadLibrarianSettings, saveLibrarianSettings } = require('./game/settings')
const { requestLibrarianDecision } = require('./game/librarian')

// 사서 모델 설정은 나중에 한 곳에서만 조정하면 된다.
const LIBRARIAN_MODEL = 'gpt-5.6-terra'
const LIBRARIAN_REASONING_EFFORT = 'low'
const LIBRARIAN_TRUST_FOR_PHASE_TWO = 2
const CYCLE_MS = Number(process.env.MAGIC_LIBRARY_CYCLE_MS) > 0
  ? Number(process.env.MAGIC_LIBRARY_CYCLE_MS)
  : 40 * 1000
const IS_DEMO_MODE = CYCLE_MS <= 40 * 1000
const LIBRARIAN_INTERVAL_MS = Number(process.env.MAGIC_LIBRARY_LIBRARIAN_INTERVAL_MS) > 0
  ? Number(process.env.MAGIC_LIBRARY_LIBRARIAN_INTERVAL_MS)
  : IS_DEMO_MODE ? 20 * 1000 : 5 * 60 * 1000
const LIBRARIAN_MIN_GAP_MS = IS_DEMO_MODE ? 5 * 1000 : 60 * 1000
const LIBRARIAN_BACKOFF_MAX_MS = 30 * 60 * 1000
const TICK_MS = 1000
const SAVE_INTERVAL_MS = 30 * 1000
const GRACE_MS = 5000
const RHYTHM_WINDOW_MS = 5 * 60 * 1000
const MAX_NOTIFICATIONS = 5
const MAX_REPORT_ENTRIES = 50
const ANIMAL_CATALOG = publicAnimalCatalog()

let mainWindow = null
let gameFocused = true
let gameState = null
let sessionState = null
let librarianSettings = { apiKey: '', useDirectApi: false }
let lastWorkKeyTime = 0
let lastTickTime = 0
let lastSaveTime = 0
let notifications = []
let typingTimestamps = []
let deleteTimestamps = []
let librarianIsCalling = false
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
  const progress = (gameState.cycleElapsedMs % CYCLE_MS) / CYCLE_MS
  if (progress < 0.25) return 'day'
  if (progress < 0.5) return 'afternoon'
  if (progress < 0.75) return 'sunset'
  return 'night'
}

function getAvailability () {
  const timeOfDay = getTimeOfDay()
  const craftBookAvailability = actions.craftBook.canExecute(gameState, timeOfDay)
  const inviteAnimals = {}
  const placeAnimals = {}
  for (const animal of ANIMALS) {
    if (animal.type === 'normal') {
      inviteAnimals[animal.id] = actions.inviteAnimal.canExecute(gameState, timeOfDay, animal.id)
    }
    placeAnimals[animal.id] = actions.placeAnimal.canExecute(gameState, timeOfDay, animal.id)
  }
  return {
    craftBook: {
      ...craftBookAvailability,
      cost: actions.craftBook.cost(gameState),
    },
    expandShelf: actions.expandShelf.canExecute(gameState, timeOfDay),
    inviteAnimals,
    placeAnimals,
  }
}

function librarianPhase () {
  return gameState.librarian.trustLevel >= LIBRARIAN_TRUST_FOR_PHASE_TWO ? 2 : 1
}

function getLibrarianAvailableActions () {
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
  const craftCheck = craftAction.canExecute(gameState, timeOfDay)
  const phaseAllowsCrafting = librarianPhase() >= 2
  const trustAllowsCrafting = craftAction.requiredTrust <= gameState.librarian.trustLevel

  if (phaseAllowsCrafting && trustAllowsCrafting && craftCheck.ok) {
    available.push({
      id: 'craftBook',
      description: `책 1권을 제작한다. 마법 잉크 ${craftAction.cost(gameState).ink}을 소모한다.`,
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
  return action.args?.animalId ? `${action.id}(${action.args.animalId})` : action.id
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
  if (gameState) saveGame(app.getPath('userData'), gameState)
}

function sendGameState () {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('game-state', {
    ...gameState,
    timeOfDay: getTimeOfDay(),
    session: sessionState,
    availability: getAvailability(),
    stageInfo: stageStateFor(gameState.stage),
    animalCatalog: ANIMAL_CATALOG,
    notifications,
    librarianPhase: librarianPhase(),
    // 중계 서버가 기본 경로이므로 게임 내부 키가 없어도 사서는 활성 상태다.
    librarianEnabled: true,
    librarianUsesDirectApi: librarianSettings.useDirectApi === true && Boolean(librarianSettings.apiKey),
  })
}

function runAction (actionName, args = {}) {
  const action = actions[actionName]
  if (!action) return { success: false, message: '알 수 없는 행동입니다.' }

  const animalId = typeof args?.animalId === 'string' ? args.animalId : null
  const result = action.execute(gameState, getTimeOfDay(), animalId)
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
  return {
    directive: gameState.librarian.directive,
    rhythm: getRhythm(),
    library: {
      ink: gameState.ink,
      feather: gameState.feather,
      candleSeconds: gameState.candleSeconds,
      books: gameState.books,
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
  const craftIsPossible = actions.craftBook.canExecute(gameState, getTimeOfDay()).ok
  return `${getLibrarianAvailableActions().map(librarianActionSignature).join('|')}|proposal:${craftIsPossible}`
}

function recordLibrarianInput (isDelete) {
  const now = Date.now()
  if (isDelete) deleteTimestamps.push(now)
  else typingTimestamps.push(now)
  lastWorkKeyTime = now
}

function executeLibrarianDecision (decision) {
  if (!decision || typeof decision !== 'object' || typeof decision.action !== 'string' || typeof decision.reason !== 'string') return
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
    : action.canExecute(gameState, getTimeOfDay())
  if (!canExecute.ok) return

  const reason = decision.reason.trim().slice(0, 500)
  if (!reason) return

  if (decision.action === 'notify') {
    const proposalAction = decision.args?.proposalAction ?? null
    const craftCheck = actions.craftBook.canExecute(gameState, getTimeOfDay())
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
      : action.execute(gameState, getTimeOfDay())
    if (!result.success) return
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
  const due = now - lastLibrarianCallTime >= LIBRARIAN_INTERVAL_MS
  if (librarianIsCalling) {
    return
  }
  if (now < nextLibrarianCallTime) {
    return
  }
  if (now - lastLibrarianCallTime < LIBRARIAN_MIN_GAP_MS) {
    return
  }
  if (!due && trigger !== 'availability') {
    return
  }

  librarianIsCalling = true
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
    executeLibrarianDecision(decision)
    librarianFailureCount = 0
  } catch (error) {
    console.error('[사서] 호출 오류', error)
    // API 오류는 게임 화면이나 보고서에 표시하지 않는다. 다음 시도만 천천히 늦춘다.
    librarianFailureCount += 1
    const delay = Math.min(LIBRARIAN_MIN_GAP_MS * (2 ** librarianFailureCount), LIBRARIAN_BACKOFF_MAX_MS)
    nextLibrarianCallTime = Date.now() + delay
  } finally {
    librarianIsCalling = false
    sendGameState()
  }
}

function respondToProposal (accepted) {
  const proposal = gameState.librarian.pendingProposal
  if (!proposal) return { success: false, message: '처리할 사서 제안이 없습니다.' }
  gameState.librarian.pendingProposal = null

  if (!accepted) {
    gameState.librarian.trustLevel = Math.max(0, gameState.librarian.trustLevel - 1)
    addLibrarianReport(proposal.action, proposal.reason, 'declined')
    addNotification('사서의 제안을 거절했습니다.')
    saveCurrentGame()
    sendGameState()
    return { success: true, message: '제안을 거절했습니다.' }
  }

  const action = actions[proposal.action]
  const canExecute = action?.canExecute(gameState, getTimeOfDay())
  if (!action || !canExecute.ok) {
    addLibrarianReport(proposal.action, proposal.reason, 'unavailable')
    addNotification('제안을 실행할 수 없어 조용히 넘겼습니다.')
    saveCurrentGame()
    sendGameState()
    return { success: false, message: '현재는 제안을 실행할 수 없습니다.' }
  }

  const result = action.execute(gameState, getTimeOfDay())
  if (!result.success) return result
  const previousPhase = librarianPhase()
  gameState.librarian.trustLevel += 1
  gameState.librarian.approvalCount += 1
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
  gameState.cycleElapsedMs %= CYCLE_MS
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
    gameState.cycleElapsedMs = (gameState.cycleElapsedMs + elapsed) % CYCLE_MS
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
