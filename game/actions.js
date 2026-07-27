const {
  ANIMALS,
  ANIMAL_BY_ID,
  RESOURCE_NAMES,
  getBookInkCost,
} = require('./animals')
const { nextStage } = require('./stages')

// 조정할 수 있는 게임 수치는 동물·단계 데이터 파일에 모아 둔다.
const CRAFT_BOOK_INK_COST = 100

function fail (reason) {
  return { ok: false, reason }
}

function succeed () {
  return { ok: true, reason: '' }
}

function bookCost (state) {
  return getBookInkCost(state, CRAFT_BOOK_INK_COST)
}

function animalForInvite (animalId) {
  const animal = ANIMAL_BY_ID[animalId]
  return animal?.type === 'normal' ? animal : null
}

function expansionRequirementMessage (resource, amount) {
  if (resource === 'books') return `책 ${amount}권이 필요합니다.`
  if (resource === 'ink') return `마법 잉크가 ${amount} 필요합니다.`
  if (resource === 'candleSeconds') return `고요한 촛불이 ${amount}초 필요합니다.`
  if (resource === 'feather') return `교정 깃털이 ${amount} 필요합니다.`
  return `${RESOURCE_NAMES[resource] || resource} ${amount} 필요합니다.`
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
    cost: (state) => ({ ink: bookCost(state) }),
    canExecute: (state) => state.ink >= bookCost(state)
      ? succeed()
      : fail(`마법 잉크가 ${bookCost(state)} 필요합니다.`),
    execute: (state) => {
      const check = actions.craftBook.canExecute(state)
      if (!check.ok) return { success: false, message: check.reason }
      state.ink -= bookCost(state)
      state.books += 1
      return { success: true, message: '새 책 한 권을 만들었습니다.' }
    },
  },
  expandShelf: {
    id: 'expandShelf',
    requiredTrust: 3,
    canExecute: (state) => {
      const next = nextStage(state.stage)
      if (!next) return fail('이미 최고 단계입니다.')
      for (const [resource, amount] of Object.entries(next.expandCost)) {
        if (resource === 'trustLevel') {
          if (state.librarian.trustLevel < amount) {
            return fail(`사서와의 신뢰 단계 ${amount} 이상이 필요합니다.`)
          }
          continue
        }
        if ((state[resource] ?? 0) < amount) return fail(expansionRequirementMessage(resource, amount))
      }
      return succeed()
    },
    execute: (state) => {
      const check = actions.expandShelf.canExecute(state)
      if (!check.ok) return { success: false, message: check.reason }
      const next = nextStage(state.stage)
      for (const [resource, amount] of Object.entries(next.expandCost)) {
        if (resource !== 'trustLevel') state[resource] -= amount
      }
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
