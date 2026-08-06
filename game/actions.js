const {
  ANIMALS,
  ANIMAL_BY_ID,
  RESOURCE_NAMES,
  getBasicBookInkCost,
} = require('./animals')
const { BOOK_BY_ID, cloneBookCost, bookAmountText } = require('./books')
const { nextStage } = require('./stages')
const {
  ALCHEMY_BY_ID,
  BUFF_BY_ID,
  UPGRADE_BY_ID,
  ensureShopState,
  upgradeCost,
} = require('./shop')

function fail (reason) {
  return { ok: false, reason }
}

function succeed () {
  return { ok: true, reason: '' }
}

function craftBookCost (state, tierId = 'basic') {
  const tier = BOOK_BY_ID[tierId]
  if (!tier) return null
  const cost = cloneBookCost(tier.cost)
  if (tierId === 'basic') cost.ink = getBasicBookInkCost(state, cost.ink)
  return cost
}

function animalForInvite (animalId) {
  const animal = ANIMAL_BY_ID[animalId]
  return animal?.type === 'normal' ? animal : null
}

function resourceRequirementMessage (resource, amount) {
  if (resource === 'ink') return `마법 잉크가 ${amount} 필요합니다.`
  if (resource === 'candleSeconds') return `고요한 촛불이 ${amount} 필요합니다.`
  if (resource === 'feather') return `교정 깃털이 ${amount} 필요합니다.`
  return `${RESOURCE_NAMES[resource] || resource} ${amount} 필요합니다.`
}

function checkCost (state, cost) {
  for (const [resource, amount] of Object.entries(cost || {})) {
    if (resource === 'books') {
      for (const [bookId, bookAmount] of Object.entries(amount || {})) {
        if ((state.books[bookId] ?? 0) < bookAmount) {
          return fail(`${bookAmountText(bookId, bookAmount)}이 필요합니다.`)
        }
      }
      continue
    }
    if (resource === 'trustLevel') {
      if (state.librarian.trustLevel < amount) return fail(`사서와의 신뢰 단계 ${amount} 이상이 필요합니다.`)
      continue
    }
    if ((state[resource] ?? 0) < amount) return fail(resourceRequirementMessage(resource, amount))
  }
  return succeed()
}

function spendCost (state, cost) {
  for (const [resource, amount] of Object.entries(cost || {})) {
    if (resource === 'trustLevel') continue
    if (resource === 'books') {
      for (const [bookId, bookAmount] of Object.entries(amount || {})) {
        state.books[bookId] -= bookAmount
      }
      continue
    }
    state[resource] -= amount
  }
}

function inviteAnimalCheck (state, timeOfDay, animalId) {
  const definition = animalForInvite(animalId)
  if (!definition) return fail('초대할 수 없는 동물입니다.')

  const conditionFailure = definition.inviteCondition?.(state, timeOfDay)
  if (conditionFailure) return fail(conditionFailure)

  for (const [resource, amount] of Object.entries(definition.inviteCost || {})) {
    if (state[resource] < amount) {
      const particle = resource === 'ink' ? '가' : '이'
      return fail(`${RESOURCE_NAMES[resource] || resource}${particle} ${amount} 필요합니다.`)
    }
  }

  const animal = state.animals[animalId]
  if (!animal || !['discovered', 'invited'].includes(animal.status)) {
    return fail(`먼저 ${definition.name}를 발견해야 합니다.`)
  }
  return succeed()
}

const actions = {
  craftBook: {
    id: 'craftBook',
    requiredTrust: 2,
    cost: craftBookCost,
    canExecute: (state, _timeOfDay, tierId = 'basic') => {
      const cost = craftBookCost(state, tierId)
      if (!cost) return fail('알 수 없는 장서입니다.')
      return checkCost(state, cost)
    },
    execute: (state, timeOfDay, tierId = 'basic') => {
      const check = actions.craftBook.canExecute(state, timeOfDay, tierId)
      if (!check.ok) return { success: false, message: check.reason }
      const tier = BOOK_BY_ID[tierId]
      spendCost(state, craftBookCost(state, tierId))
      state.books[tierId] += 1
      return { success: true, message: `${tier.name} 한 권을 만들었습니다.` }
    },
  },
  expandShelf: {
    id: 'expandShelf',
    requiredTrust: 3,
    canExecute: (state) => {
      const next = nextStage(state.stage)
      if (!next) return fail('이미 최고 단계입니다.')
      return checkCost(state, next.expandCost)
    },
    execute: (state) => {
      const check = actions.expandShelf.canExecute(state)
      if (!check.ok) return { success: false, message: check.reason }
      const next = nextStage(state.stage)
      // 확장 자원과 등급별 장서는 소모하고, 신뢰 단계는 조건으로만 확인한다.
      spendCost(state, next.expandCost)
      state.stage = next.stage
      return { success: true, message: `${next.name}(으)로 확장했습니다.` }
    },
  },
  inviteAnimal: {
    id: 'inviteAnimal',
    requiredTrust: 3,
    canExecute: inviteAnimalCheck,
    execute: (state, timeOfDay, animalId) => {
      const check = inviteAnimalCheck(state, timeOfDay, animalId)
      if (!check.ok) return { success: false, message: check.reason }

      const definition = ANIMAL_BY_ID[animalId]
      for (const [resource, amount] of Object.entries(definition.inviteCost)) {
        state[resource] -= amount
      }
      state.animals[animalId].status = 'invited'
      state.animals[animalId].visits += 1
      return {
        success: true,
        message: definition.visitMessage(state.animals[animalId].visits),
      }
    },
  },
  placeAnimal: {
    id: 'placeAnimal',
    requiredTrust: 3,
    // 이번 단계에서는 플레이어 버튼만 이 행동을 노출한다.
    availableToLibrarian: false,
    canExecute: (state, _timeOfDay, animalId) => {
      const definition = ANIMAL_BY_ID[animalId]
      if (!definition || !state.animals[animalId]) return fail('배치할 수 없는 동물입니다.')
      if (state.animals[animalId].status !== 'collected') return fail('동반자가 된 뒤에 배치할 수 있습니다.')
      return succeed()
    },
    execute: (state, timeOfDay, animalId) => {
      const check = actions.placeAnimal.canExecute(state, timeOfDay, animalId)
      if (!check.ok) return { success: false, message: check.reason }
      const animal = state.animals[animalId]
      animal.placed = !animal.placed
      return {
        success: true,
        message: animal.placed
          ? `${ANIMAL_BY_ID[animalId].name} 배치를 완료했습니다.`
          : `${ANIMAL_BY_ID[animalId].name} 배치를 해제했습니다.`,
      }
    },
  },
  buyAlchemy: {
    id: 'buyAlchemy',
    requiredTrust: 0,
    availableToLibrarian: false,
    cost: (_state, itemId) => ALCHEMY_BY_ID[itemId]?.from || null,
    canExecute: (state, _timeOfDay, itemId) => {
      const item = ALCHEMY_BY_ID[itemId]
      if (!item) return fail('알 수 없는 연금술입니다.')
      return checkCost(state, item.from)
    },
    execute: (state, timeOfDay, itemId) => {
      const check = actions.buyAlchemy.canExecute(state, timeOfDay, itemId)
      if (!check.ok) return { success: false, message: check.reason }
      const item = ALCHEMY_BY_ID[itemId]
      spendCost(state, item.from)
      for (const [resource, amount] of Object.entries(item.to)) state[resource] += amount
      return { success: true, message: `${item.name}을 완료했습니다.` }
    },
  },
  buyBuff: {
    id: 'buyBuff',
    requiredTrust: 0,
    availableToLibrarian: false,
    cost: (_state, itemId) => {
      const item = BUFF_BY_ID[itemId]
      return item ? cloneBookCost(item.cost) : null
    },
    canExecute: (state, _timeOfDay, itemId) => {
      const item = BUFF_BY_ID[itemId]
      if (!item) return fail('알 수 없는 버프입니다.')
      return checkCost(state, item.cost)
    },
    execute: (state, timeOfDay, itemId, options = {}) => {
      const check = actions.buyBuff.canExecute(state, timeOfDay, itemId)
      if (!check.ok) return { success: false, message: check.reason }
      const item = BUFF_BY_ID[itemId]
      spendCost(state, item.cost)
      const shop = ensureShopState(state)
      const now = Date.now()
      const currentExpiry = Number.isFinite(shop.buffs[itemId]) ? shop.buffs[itemId] : 0
      const wasActive = currentExpiry > now
      const durationMs = Number.isFinite(options.buffDurationMs) && options.buffDurationMs > 0
        ? options.buffDurationMs
        : item.durationMs
      shop.buffs[itemId] = Math.max(now, currentExpiry) + durationMs
      return {
        success: true,
        message: wasActive ? `${item.name} 효과가 연장되었습니다.` : `${item.name} 효과가 활성화되었습니다.`,
      }
    },
  },
  buyUpgrade: {
    id: 'buyUpgrade',
    requiredTrust: 0,
    availableToLibrarian: false,
    cost: (state, itemId) => upgradeCost(state, itemId),
    canExecute: (state, _timeOfDay, itemId) => {
      if (!UPGRADE_BY_ID[itemId]) return fail('알 수 없는 영구 강화입니다.')
      return checkCost(state, upgradeCost(state, itemId))
    },
    execute: (state, timeOfDay, itemId) => {
      const check = actions.buyUpgrade.canExecute(state, timeOfDay, itemId)
      if (!check.ok) return { success: false, message: check.reason }
      const upgrade = UPGRADE_BY_ID[itemId]
      spendCost(state, upgradeCost(state, itemId))
      const shop = ensureShopState(state)
      shop.upgrades[itemId] += 1
      return { success: true, message: `${upgrade.name}이(가) ${shop.upgrades[itemId]}레벨이 되었습니다.` }
    },
  },
  wait: {
    id: 'wait',
    requiredTrust: 1,
    canExecute: () => succeed(),
    execute: (_state, _timeOfDay, reason = '조용히 기다립니다.') => ({ success: true, message: reason }),
  },
  notify: {
    id: 'notify',
    requiredTrust: 1,
    canExecute: () => succeed(),
    execute: (_state, _timeOfDay, message = '새 알림이 있습니다.') => ({ success: true, message }),
  },
}

function runAutomaticAnimalRules (state, timeOfDay) {
  const messages = []

  for (const definition of ANIMALS.filter((animal) => animal.type === 'normal')) {
    const animal = state.animals[definition.id]
    if (animal.status === 'unknown' && definition.discoverCondition(state, timeOfDay)) {
      animal.status = 'discovered'
      messages.push(definition.discoverMessage)
    }
    if (animal.status === 'invited' && definition.collectCondition(state, animal)) {
      animal.status = 'collected'
      messages.push(definition.collectMessage)
    }
  }

  for (const definition of ANIMALS.filter((animal) => animal.type === 'legendary')) {
    const animal = state.animals[definition.id]
    if (animal.status === 'unknown' && definition.unlockCondition(state, timeOfDay)) {
      animal.status = 'collected'
      messages.push(definition.unlockMessage)
    }
  }
  return messages
}

module.exports = { actions, runAutomaticAnimalRules }
