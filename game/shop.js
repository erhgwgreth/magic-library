const BUFF_DURATION_MS = 30 * 60 * 1000

const ALCHEMY = [
  { id: 'ink_to_candle', name: '잉크 정제', from: { ink: 100 }, to: { candleSeconds: 4 } },
  { id: 'candle_to_ink', name: '촛불 응결', from: { candleSeconds: 10 }, to: { ink: 150 } },
  { id: 'ink_to_feather', name: '잉크 가공', from: { ink: 100 }, to: { feather: 8 } },
  { id: 'feather_to_ink', name: '깃털 분해', from: { feather: 10 }, to: { ink: 80 } },
]

const BUFFS = [
  {
    id: 'focus_flame',
    name: '집중의 불꽃',
    cost: { books: { intermediate: 3 } },
    effect: { resource: 'ink', multiplier: 2 },
    durationMs: BUFF_DURATION_MS,
  },
  {
    id: 'midnight_candle',
    name: '밤샘의 초',
    cost: { books: { intermediate: 3 } },
    effect: { resource: 'candleSeconds', multiplier: 2 },
    durationMs: BUFF_DURATION_MS,
  },
  {
    id: 'proof_seal',
    name: '교정의 인장',
    cost: { books: { intermediate: 3 } },
    effect: { resource: 'feather', multiplier: 2 },
    durationMs: BUFF_DURATION_MS,
  },
  {
    id: 'inspiration_wave',
    name: '영감의 물결',
    cost: { books: { advanced: 3 } },
    effect: { resource: 'all', multiplier: 2 },
    durationMs: BUFF_DURATION_MS,
  },
]

const UPGRADES = [
  {
    id: 'infinite_inkwell',
    name: '무한 잉크병',
    resource: 'ink',
    effectPerLevel: 10,
    baseCost: { ink: 3000 },
    costMultiplier: 1.5,
    mythicPerLevel: 1,
  },
  {
    id: 'wax_wick',
    name: '밀랍 심지',
    resource: 'candleSeconds',
    effectPerLevel: 10,
    baseCost: { candleSeconds: 800 },
    costMultiplier: 1.5,
    mythicPerLevel: 1,
  },
  {
    id: 'silver_quill',
    name: '은빛 깃대',
    resource: 'feather',
    effectPerLevel: 10,
    baseCost: { feather: 200 },
    costMultiplier: 1.5,
    mythicPerLevel: 1,
  },
]

const ALCHEMY_BY_ID = Object.fromEntries(ALCHEMY.map((item) => [item.id, item]))
const BUFF_BY_ID = Object.fromEntries(BUFFS.map((item) => [item.id, item]))
const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((item) => [item.id, item]))

function createShopState () {
  return {
    buffs: {},
    upgrades: Object.fromEntries(UPGRADES.map((upgrade) => [upgrade.id, 0])),
  }
}

function normalizeShopState (savedShop) {
  const shop = createShopState()
  if (!savedShop || typeof savedShop !== 'object' || Array.isArray(savedShop)) return shop

  for (const buff of BUFFS) {
    const expiresAt = savedShop.buffs?.[buff.id]
    if (Number.isFinite(expiresAt) && expiresAt > 0) shop.buffs[buff.id] = expiresAt
  }
  for (const upgrade of UPGRADES) {
    const level = savedShop.upgrades?.[upgrade.id]
    if (Number.isFinite(level) && level >= 0) shop.upgrades[upgrade.id] = Math.floor(level)
  }
  return shop
}

function ensureShopState (state) {
  if (!state.shop || typeof state.shop !== 'object') state.shop = createShopState()
  if (!state.shop.buffs || typeof state.shop.buffs !== 'object') state.shop.buffs = {}
  if (!state.shop.upgrades || typeof state.shop.upgrades !== 'object') {
    state.shop.upgrades = createShopState().upgrades
  }
  for (const upgrade of UPGRADES) {
    const level = state.shop.upgrades[upgrade.id]
    if (!Number.isFinite(level) || level < 0) state.shop.upgrades[upgrade.id] = 0
  }
  return state.shop
}

function upgradeCost (state, upgradeId) {
  const upgrade = UPGRADE_BY_ID[upgradeId]
  if (!upgrade) return null
  const shop = ensureShopState(state)
  const level = Number.isFinite(shop.upgrades[upgradeId]) ? Math.max(0, Math.floor(shop.upgrades[upgradeId])) : 0
  const cost = { books: { mythic: upgrade.mythicPerLevel } }
  for (const [resource, baseAmount] of Object.entries(upgrade.baseCost)) {
    cost[resource] = Math.round(baseAmount * (upgrade.costMultiplier ** level))
  }
  return cost
}

function upgradeBonusPercent (state, resource) {
  const shop = ensureShopState(state)
  return UPGRADES.reduce((total, upgrade) => {
    if (upgrade.resource !== resource) return total
    const level = Number.isFinite(shop.upgrades[upgrade.id]) ? Math.max(0, Math.floor(shop.upgrades[upgrade.id])) : 0
    return total + (level * upgrade.effectPerLevel)
  }, 0)
}

function activeBuffMultiplier (state, resource, now = Date.now()) {
  const shop = ensureShopState(state)
  let strongestMultiplier = 1

  for (const buff of BUFFS) {
    const expiresAt = shop.buffs[buff.id]
    if (!Number.isFinite(expiresAt)) continue
    if (now >= expiresAt) {
      delete shop.buffs[buff.id]
      continue
    }
    if (buff.effect.resource !== resource && buff.effect.resource !== 'all') continue
    strongestMultiplier = Math.max(strongestMultiplier, buff.effect.multiplier)
  }
  return strongestMultiplier
}

function cloneCost (cost) {
  return {
    ...cost,
    ...(cost.books ? { books: { ...cost.books } } : {}),
  }
}

function publicShopCatalog () {
  return {
    alchemy: ALCHEMY.map((item) => ({ ...item, from: { ...item.from }, to: { ...item.to } })),
    buffs: BUFFS.map((item) => ({
      ...item,
      cost: cloneCost(item.cost),
      effect: { ...item.effect },
    })),
    upgrades: UPGRADES.map((item) => ({
      ...item,
      baseCost: { ...item.baseCost },
    })),
  }
}

module.exports = {
  BUFF_DURATION_MS,
  ALCHEMY,
  BUFFS,
  UPGRADES,
  ALCHEMY_BY_ID,
  BUFF_BY_ID,
  UPGRADE_BY_ID,
  createShopState,
  normalizeShopState,
  ensureShopState,
  upgradeCost,
  upgradeBonusPercent,
  activeBuffMultiplier,
  publicShopCatalog,
}
