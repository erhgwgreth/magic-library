const { bookCostText } = require('./books')

const STAGES = [
  {
    stage: 1,
    name: '작은 서가',
    background: 'assets/backgrounds/stage1.png',
    gainMultiplier: 1.0,
  },
  {
    stage: 2,
    name: '열람실',
    background: 'assets/backgrounds/stage2.png',
    gainMultiplier: 1.2,
    expandCost: { books: { basic: 5 }, ink: 1000 },
  },
  {
    stage: 3,
    name: '달빛 서재',
    background: 'assets/backgrounds/stage3.png',
    gainMultiplier: 1.5,
    expandCost: { books: { basic: 10, intermediate: 3 }, ink: 2000, feather: 100 },
  },
  {
    stage: 4,
    name: '별빛 서고',
    background: 'assets/backgrounds/stage4.png',
    gainMultiplier: 2.0,
    expandCost: { books: { intermediate: 10, advanced: 3 }, ink: 3000, feather: 200, candleSeconds: 500 },
  },
  {
    stage: 5,
    name: '대도서관',
    background: 'assets/backgrounds/stage5.png',
    gainMultiplier: 3.0,
    expandCost: { books: { advanced: 10, mythic: 1 }, ink: 4000, feather: 300, candleSeconds: 1000, trustLevel: 3 },
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
    gainMultiplier: stage.gainMultiplier,
    expandCost: stage.expandCost
      ? {
          ...stage.expandCost,
          ...(stage.expandCost.books ? { books: { ...stage.expandCost.books } } : {}),
        }
      : null,
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
  return bookCostText(cost)
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
