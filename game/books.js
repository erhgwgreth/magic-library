const BOOK_TIERS = [
  {
    id: 'basic',
    name: '기초 마법장서',
    cost: { ink: 100 },
  },
  {
    id: 'intermediate',
    name: '중급 마법장서',
    cost: { ink: 200, feather: 30, books: { basic: 3 } },
  },
  {
    id: 'advanced',
    name: '고급 마법장서',
    cost: { ink: 400, feather: 50, candleSeconds: 300, books: { intermediate: 3 } },
  },
  {
    id: 'mythic',
    name: '신화급 마법장서',
    cost: { ink: 800, feather: 100, candleSeconds: 600, books: { advanced: 3 } },
  },
]

const BOOK_BY_ID = Object.fromEntries(BOOK_TIERS.map((tier) => [tier.id, tier]))

function createBookInventory () {
  return Object.fromEntries(BOOK_TIERS.map((tier) => [tier.id, 0]))
}

function normalizeBookInventory (savedBooks) {
  const books = createBookInventory()

  // 예전 세이브의 단일 장서는 모두 기초 마법장서로 이어받는다.
  if (Number.isFinite(savedBooks) && savedBooks >= 0) {
    books.basic = Math.floor(savedBooks)
    return books
  }
  if (!savedBooks || typeof savedBooks !== 'object' || Array.isArray(savedBooks)) return books

  for (const tier of BOOK_TIERS) {
    const amount = savedBooks[tier.id]
    if (Number.isFinite(amount) && amount >= 0) books[tier.id] = Math.floor(amount)
  }
  return books
}

function cloneBookCost (cost) {
  return {
    ...cost,
    ...(cost.books ? { books: { ...cost.books } } : {}),
  }
}

function publicBookCatalog () {
  return BOOK_TIERS.map((tier) => ({
    id: tier.id,
    name: tier.name,
    cost: cloneBookCost(tier.cost),
  }))
}

function bookAmountText (bookId, amount) {
  return `${BOOK_BY_ID[bookId]?.name || bookId} ${amount}권`
}

function bookCostText (cost) {
  if (!cost) return ''
  const resourceLabels = {
    ink: ['마법 잉크', ''],
    candleSeconds: ['고요한 촛불', ''],
    feather: ['교정 깃털', ''],
    trustLevel: ['사서 신뢰', ''],
  }
  const parts = []
  for (const [resource, amount] of Object.entries(cost)) {
    if (resource === 'books') {
      for (const [bookId, bookAmount] of Object.entries(amount || {})) {
        parts.push(bookAmountText(bookId, bookAmount))
      }
      continue
    }
    const [label, unit] = resourceLabels[resource] || [resource, '']
    parts.push(`${label} ${amount}${unit}`)
  }
  return parts.join(', ')
}

module.exports = {
  BOOK_TIERS,
  BOOK_BY_ID,
  createBookInventory,
  normalizeBookInventory,
  cloneBookCost,
  publicBookCatalog,
  bookAmountText,
  bookCostText,
}
