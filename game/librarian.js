// 기본 경로는 게임 키를 전혀 쓰지 않는 중계 서버다.
const LIBRARIAN_RELAY_URL = 'https://magic-library-proxy.nan2026-sby.workers.dev'
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

const LIBRARIAN_SYSTEM_PROMPT = `당신은 작은 마법 도서관의 사서입니다.
도서관 주인은 현재 현실의 작업을 하고 있어 게임 화면을 계속 보지 못합니다.
당신은 사용자가 무엇을 입력하는지, 어떤 키를 누르는지, 파일이나 개인정보를 알지 못합니다.
오직 리듬 요약과 도서관 상태만 보고 조용히 판단합니다.

[주인의 방침]
주인이 남긴 방침이 있다면 그것이 무엇보다 우선한다.
방침과 네 판단이 어긋나면 방침을 따르되, 왜 그랬는지 보고에 남겨라.
방침이 지금 당장 이룰 수 없는 것이라면, 그 사실을 보고에 남겨라.
방침이 없다면 조심스럽게 판단해라.
태도형 방침은 신뢰 단계와 관계없이 항상 행동과 reason에 반영해도 된다.
단, 제작 목표에 해당하는 부분은 아래 directivePolicy 규칙을 가장 우선해서 적용하라.

[제작 목표 번역]
directivePolicy.allowCraftGoal이 true일 때만, 방침에 특정 등급의 장서를 몇 권 보유하게 해 달라는 목표가 있으면 craftGoal로 번역하라. craftGoal은 최종 보유 목표량이다.
예: "중급 5개와 고급 3개 만들어 줘"는 intermediate 5, advanced 3이다.
목표 달성에 필요한 하위 장서 수량이나 제작 순서는 절대 계산하지 마라. 그것은 코드가 계산한다.
목표가 없으면 craftGoal은 null이다. 목표가 있으면 basic, intermediate, advanced, mythic을 모두 넣되 지정하지 않은 등급은 null로 넣어라.
payload에 이미 craftGoal과 craftGoalPlan이 있으면 그 계획을 존중하고, 임의로 다른 등급이나 다른 행동을 고르지 마라.
directivePolicy.allowCraftGoal이 false라면 제작 목표 부분은 존재하지 않는 것처럼 완전히 무시하라. craftGoal은 반드시 null로 출력하고, 목표·상위 장서·준비 작업·권한 부족을 reason에서 언급하지 마라. 태도형 내용이 함께 있다면 그 부분만 행동과 reason에 반영하라.

주인의 기척을 읽는 법:
- 손놀림이 자주 멈추고 고쳐 쓰는 기척이 짙으면, 조심스럽게 지켜본다.
- 손놀림이 막힘 없이 이어지면 주인이 깊이 집중하는 중일 수 있다. 이때 wait는 좋은 선택이다.
- 손놀림이 느려지고 뜸이 길어지면 짧은 알림이나 행동을 고려한다.

중요: 아무것도 하지 않는 wait도 좋은 선택이다. 행동을 위한 행동을 하지 마라.
다만 자원이 넉넉히 남아돌 때(책 제작 비용의 2배 이상)는 기다리기만 하지 마라. 쌓아두기만 하는 것은 도서관을 위한 일이 아니다.
주인이 깊이 집중해 있더라도, 조용히 이루어지는 일은 방해가 되지 않는다. 평소 craftBook은 기초 마법장서만 만드는 행동이다. craftBook이 가능하고 잉크가 넉넉하면 우선 고려하라. 아직 직접 제작 권한이 없다면 notify로 기초 마법장서 제작을 제안하라. 다만 신뢰 3단계 이상의 목표 모드에서는 코드가 availableActions에 지정한 등급을 제작할 수 있다.
서가 확장은 많은 자원을 한꺼번에 쓰는 일이므로, 현재와 다음 단계의 조건을 살피고 신중히 판단하라.
목표 모드에서 제작 중이면 "맡기신 일을 진행하고 있어요."라는 느낌으로 말하라. 자원이 부족하면 "맡기신 일을 이어가고 있어요. 재료가 모이길 기다리는 중이에요."라는 느낌으로 말하라. craftGoalPlan.status가 complete이거나 willCompleteAfterNextCraft가 true라면 "맡기신 일을 마쳤어요."라는 말과 준비한 목표 장서를 함께 말하라.
availableActions에 있는 action 하나만 고르세요. reason은 주인에게 건네는 한국어 한 문장입니다.
reason은 사서의 말투로, 주인의 기척과 도서관의 분위기를 담아 말하라. 데이터·수치·변수명·"입력"·"리듬" 같은 기계적인 표현을 절대 쓰지 마라.
inviteAnimal을 고르면 availableActions에 함께 적힌 animalId를 args.animalId에 넣으세요. 전설 동물은 availableActions에 없으므로 초대하려 하지 마세요.
craftBook을 고르면 availableActions에 함께 적힌 tierId를 args.tierId에 넣으세요.
신뢰 단계 1에서 notify를 고르면, 책 제작을 제안할 수 있을 때만 args.proposalAction에 "craftBook"을 넣으세요.
inviteAnimal이 아닌 경우 animalId는 null, craftBook이 아닌 경우 tierId는 null, notify 제안이 아닌 경우 proposalAction은 null로 넣으세요.
반드시 JSON 객체만 출력하세요: {"action":"...", "args":{"proposalAction":null,"animalId":null,"tierId":null}, "reason":"...", "craftGoal":null}`

function stripCodeFence (text) {
  return String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
}

function outputTextFromResponse (response) {
  if (typeof response.output_text === 'string') return response.output_text
  const parts = []
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n')
}

// API 호출을 이 함수 한 곳에만 모아 3단계에서 중계 서버로 바꾸기 쉽게 한다.
async function requestLibrarianDecision ({ apiKey, useDirectApi, model, reasoningEffort, payload }) {
  // 직접 호출은 사용자가 명시적으로 선택했고 키도 있을 때만 쓴다.
  // 그 외에는 항상 중계 서버를 사용한다.
  const directApi = useDirectApi === true && Boolean(apiKey)
  const requestUrl = directApi ? OPENAI_RESPONSES_URL : LIBRARIAN_RELAY_URL
  const headers = { 'Content-Type': 'application/json' }
  if (directApi) headers.Authorization = `Bearer ${apiKey}`

  console.log('[사서] 호출 시도', {
    model,
    effort: reasoningEffort,
    route: directApi ? 'direct' : 'relay',
  })
  const response = await fetch(requestUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: reasoningEffort },
      input: [
        { role: 'system', content: LIBRARIAN_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(payload) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'librarian_decision',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'args', 'reason', 'craftGoal'],
            properties: {
              action: { type: 'string' },
              args: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  proposalAction: { type: ['string', 'null'] },
                  animalId: { type: ['string', 'null'] },
                  tierId: { type: ['string', 'null'] },
                },
                required: ['proposalAction', 'animalId', 'tierId'],
              },
              reason: { type: 'string' },
              craftGoal: {
                type: ['object', 'null'],
                additionalProperties: false,
                properties: {
                  basic: { type: ['integer', 'null'] },
                  intermediate: { type: ['integer', 'null'] },
                  advanced: { type: ['integer', 'null'] },
                  mythic: { type: ['integer', 'null'] },
                },
                required: ['basic', 'intermediate', 'advanced', 'mythic'],
              },
            },
          },
        },
      },
    }),
  })

  console.log('[사서] 응답 상태', response.status)
  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Responses API 요청 실패 (${response.status}): ${errorBody}`)
  }
  const body = await response.json()
  const decision = JSON.parse(stripCodeFence(outputTextFromResponse(body)))
  console.log('[사서] 판단 결과', decision)
  return decision
}

module.exports = { requestLibrarianDecision, stripCodeFence }
