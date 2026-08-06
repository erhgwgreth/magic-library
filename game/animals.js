const RESOURCE_NAMES = {
  ink: '마법 잉크',
  candleSeconds: '고요한 촛불',
  feather: '교정 깃털',
}

const { currentStage } = require('./stages')
const { upgradeBonusPercent, activeBuffMultiplier } = require('./shop')

const ANIMALS = [
  {
    id: 'cat',
    name: '책 읽는 고양이',
    type: 'normal',
    requiredStage: 2,
    emoji: '🐈',
    image: 'assets/animals/cat.png',
    discoverCondition: (state, timeOfDay) => (
      state.stage >= 2 &&
      state.ink >= 300 &&
      ['day', 'afternoon'].includes(timeOfDay)
    ),
    discoverMessage: '서가 근처에서 낯선 고양이를 발견했습니다.',
    inviteCondition: (state, timeOfDay) => {
      if (state.stage < 2) return '서가 2단계에서 고양이를 맞이할 수 있습니다.'
      if (!['day', 'afternoon'].includes(timeOfDay)) return '낮이나 오후에만 고양이를 맞이할 수 있습니다.'
      return ''
    },
    inviteCost: { ink: 150 },
    collectCondition: (state, animal) => animal.visits >= 2 && state.books.basic >= 3,
    collectMessage: '고양이가 이 서가의 동반자가 되었습니다.',
    visitMessage: (visits) => `고양이가 서가에 들렀습니다. (${visits}번째 방문)`,
    placeEffect: {
      description: '기초 마법장서 제작 비용이 마법 잉크 90으로 감소',
      basicBookInkCost: 90,
    },
  },
  {
    id: 'owl',
    name: '졸린 부엉이',
    type: 'normal',
    requiredStage: 3,
    emoji: '🦉',
    image: 'assets/animals/owl.png',
    discoverCondition: (state, timeOfDay) => (
      state.stage >= 3 &&
      state.candleSeconds >= 1800 &&
      timeOfDay === 'night'
    ),
    discoverMessage: '밤의 서가에서 졸린 부엉이를 발견했습니다.',
    inviteCost: { candleSeconds: 600 },
    collectCondition: (state, animal) => animal.visits >= 2 && state.books.advanced >= 3,
    collectMessage: '졸린 부엉이가 이 서가의 동반자가 되었습니다.',
    visitMessage: (visits) => `졸린 부엉이가 조용히 내려앉았습니다. (${visits}번째 방문)`,
    placeEffect: {
      description: '고요한 촛불 획득량 10% 증가',
      resourceBonusPercent: { candleSeconds: 10 },
    },
  },
  {
    id: 'crow',
    name: '오타 까마귀',
    type: 'normal',
    requiredStage: 4,
    emoji: '🐦‍⬛',
    image: 'assets/animals/crow.png',
    discoverCondition: (state) => state.stage >= 4 && state.feather >= 50,
    discoverMessage: '교정 깃털을 쫓아온 오타 까마귀를 발견했습니다.',
    inviteCost: { feather: 30 },
    collectCondition: (state, animal) => animal.visits >= 2 && state.books.intermediate >= 5,
    collectMessage: '오타 까마귀가 이 서가의 동반자가 되었습니다.',
    visitMessage: (visits) => `오타 까마귀가 깃털을 물고 찾아왔습니다. (${visits}번째 방문)`,
    placeEffect: {
      description: '교정 깃털 획득량 10% 증가',
      resourceBonusPercent: { feather: 10 },
    },
  },
  {
    id: 'dragon',
    name: '장서룡',
    type: 'legendary',
    requiredStage: 5,
    emoji: '🐉',
    image: 'assets/animals/dragon.png',
    unlockCondition: (state) => (
      state.stage >= 5 &&
      state.books.mythic >= 1 &&
      state.candleSeconds >= 3600 &&
      Object.entries(state.animals)
        .filter(([id, animal]) => id !== 'dragon' && animal.status === 'collected')
        .length >= 3
    ),
    unlockMessage: '전설의 장서룡이 도서관에 모습을 드러냈습니다.',
    placeEffect: {
      description: '마법 잉크·고요한 촛불·교정 깃털 획득량 10% 증가',
      resourceBonusPercent: { ink: 10, candleSeconds: 10, feather: 10 },
    },
  },
]

const ANIMAL_BY_ID = Object.fromEntries(ANIMALS.map((animal) => [animal.id, animal]))

function createAnimalStates () {
  return Object.fromEntries(ANIMALS.map((animal) => [
    animal.id,
    { status: 'unknown', visits: 0, placed: false, screenPosition: null },
  ]))
}

function publicAnimalCatalog () {
  return ANIMALS.map((animal) => ({
    id: animal.id,
    name: animal.name,
    type: animal.type,
    requiredStage: animal.requiredStage,
    emoji: animal.emoji,
    image: animal.image,
    placeEffect: animal.placeEffect.description,
  }))
}

function inviteCostText (animal) {
  return Object.entries(animal.inviteCost || {})
    .map(([resource, amount]) => `${RESOURCE_NAMES[resource] || resource} ${amount}`)
    .join(', ')
}

function getBasicBookInkCost (state, defaultCost) {
  const placedCosts = ANIMALS
    .filter((animal) => state.animals[animal.id]?.placed && Number.isFinite(animal.placeEffect?.basicBookInkCost))
    .map((animal) => animal.placeEffect.basicBookInkCost)
  return placedCosts.length ? Math.min(defaultCost, ...placedCosts) : defaultCost
}

function resourceBonusPercent (state, resource) {
  return ANIMALS.reduce((total, animal) => {
    if (!state.animals[animal.id]?.placed) return total
    return total + (animal.placeEffect?.resourceBonusPercent?.[resource] || 0)
  }, 0)
}

// 이미 계산된 기본 획득량에만 배율을 적용한다. 입력 내용이나 키 정보는 받지 않는다.
function grantResource (state, resource, baseAmount) {
  if (!Number.isFinite(baseAmount) || baseAmount <= 0 || !Number.isFinite(state[resource])) return 0
  if (!state.resourceGainRemainders || typeof state.resourceGainRemainders !== 'object') {
    state.resourceGainRemainders = { ink: 0, candleSeconds: 0, feather: 0 }
  }

  const bonusPercent = resourceBonusPercent(state, resource)
  const stageMultiplier = currentStage(state.stage).gainMultiplier
  const upgradePercent = upgradeBonusPercent(state, resource)
  const buffMultiplier = activeBuffMultiplier(state, resource)
  const previousRemainder = Number.isFinite(state.resourceGainRemainders[resource])
    ? state.resourceGainRemainders[resource]
    : 0
  // 모든 배율을 곱한 최종값에만 기존 100분율 remainder를 한 번 적용한다.
  const finalGain = baseAmount
    * (1 + (bonusPercent / 100))
    * stageMultiplier
    * (1 + (upgradePercent / 100))
    * buffMultiplier
  const scaledGain = (finalGain * 100) + previousRemainder
  const granted = Math.floor((scaledGain + 1e-9) / 100)
  const remainder = scaledGain - (granted * 100)
  state.resourceGainRemainders[resource] = remainder < 0 && remainder > -1e-8 ? 0 : remainder
  state[resource] += granted
  return granted
}

module.exports = {
  ANIMALS,
  ANIMAL_BY_ID,
  RESOURCE_NAMES,
  createAnimalStates,
  publicAnimalCatalog,
  inviteCostText,
  getBasicBookInkCost,
  grantResource,
}
