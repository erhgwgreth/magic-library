const STAGES = [
  {
    stage: 1,
    name: '작은 서가',
    background: 'assets/backgrounds/stage1.png',
  },
  {
    stage: 2,
    name: '열람실',
    background: 'assets/backgrounds/stage2.png',
    expandCost: { books: 5, ink: 1000 },
  },
  {
    stage: 3,
    name: '달빛 서재',
    background: 'assets/backgrounds/stage3.png',
    expandCost: { books: 15, ink: 2000, candleSeconds: 1000 },
  },
  {
    stage: 4,
    name: '별빛 서고',
    background: 'assets/backgrounds/stage4.png',
    expandCost: { books: 30, ink: 3000, candleSeconds: 1500, feather: 100 },
  },
  {
    stage: 5,
    name: '대도서관',
    background: 'assets/backgrounds/stage5.png',
    expandCost: { books: 50, ink: 4000, candleSeconds: 2500, feather: 200, trustLevel: 3 },
  },
]

const STAGE_BY_NUMBER = Object.fromEntries(STAGES.map((stage) => [stage.stage, stage]))
const MAX_STAGE = Math.max(...STAGES.map((stage) => stage.stage))
const FALLBACK_BACKGROUND = 'assets/background.png'

function currentStage (stageNumber) {
  return STAGE_BY_NUMBER[stageNumber] || STAGE_BY_NUMBER[1]
}

function nextStage (stageNumber) {
  return STAGE_BY_NUMBER[stageNumber + 1] || null
}

function publicStage (stage) {
  if (!stage) return null
  return {
    stage: stage.stage,
    name: stage.name,
    background: stage.background,
    expandCost: stage.expandCost ? { ...stage.expandCost } : null,
  }
}

function stageStateFor (stageNumber) {
  return {
    current: publicStage(currentStage(stageNumber)),
    next: publicStage(nextStage(stageNumber)),
    fallbackBackground: FALLBACK_BACKGROUND,
  }
}

function stageCostText (cost) {
  if (!cost) return ''
  const labels = {
    books: ['책', '권'],
    ink: ['마법 잉크', ''],
    candleSeconds: ['고요한 촛불', '초'],
    feather: ['교정 깃털', ''],
    trustLevel: ['사서 신뢰', ''],
  }
  return Object.entries(cost)
    .map(([resource, amount]) => {
      const [label, unit] = labels[resource] || [resource, '']
      return `${label} ${amount}${unit}`
    })
    .join(', ')
}

module.exports = {
  STAGES,
  STAGE_BY_NUMBER,
  MAX_STAGE,
  FALLBACK_BACKGROUND,
  currentStage,
  nextStage,
  stageStateFor,
  stageCostText,
}
