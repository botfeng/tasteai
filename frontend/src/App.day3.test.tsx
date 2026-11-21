import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import catalog from '../../backend/app/data/ingredients.json'
import App from './App'
import type { EngineStatus, GeneratedIngredient, GenerationRequest, GenerationResponse, Scene } from './data/generation'
import { pantryStorageKey } from './data/pantry'
import { emptyPreferences, storageKey } from './data/preferences'
import { recipes as seeds } from './data/recipes'

const statusUrl = '/api/recommendations/status'
const generateUrl = '/api/recommendations/generate'
const readyStatus: EngineStatus = {
  mode: 'mock', configured: true, source: 'mock', model: null, message: '测试生成服务已就绪。',
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})

function ingredient(id: string, amount: string): GeneratedIngredient {
  const entry = catalog.find((item) => item.id === id)
  if (!entry || (entry.role !== 'main' && entry.role !== 'seasoning')) throw new Error(`Invalid fixture ingredient: ${id}`)
  return { ingredientId: entry.id, name: entry.name, role: entry.role, amount }
}

function responseFor({ scene = 'cook', source = 'mock', batch = 'first', servings = 1 }: {
  scene?: Scene; source?: GenerationResponse['source']; batch?: string; servings?: number
} = {}): GenerationResponse {
  const isOut = scene === 'eat_out'
  return {
    source, model: source === 'ai' ? 'day3-test-model' : null, scene, servings,
    notice: '本批次是自动化测试夹具，不会调用模型。', warnings: ['请自行核对实际食材用量。'],
    recipes: ['番茄滑蛋小锅', '番茄蛋花暖汤', '番茄蒸蛋小盅'].map((name, index) => ({
      id: `${source}-day3-${batch}-${index}`,
      name: `${name}·${batch}`,
      description: `${name}的独立生成描述。`,
      ingredients: [ingredient('tomato', '200 克'), ingredient('egg', '2 个'), ingredient('salt', '少许'), ingredient('water', '150 毫升')],
      cookingSteps: isOut ? [] : [
        { title: '切配番茄并打散鸡蛋', body: '番茄洗净切块，鸡蛋打散备用。', ingredientIds: ['tomato', 'egg'] },
        { title: '加水煮至完全熟透', body: '加入水和盐，将番茄与蛋液加热至完全熟透。', ingredientIds: ['tomato', 'egg', 'water', 'salt'] },
      ],
      estimatedTime: isOut ? null : 12 + index,
      recommendationReason: `这是第 ${index + 1} 道符合本餐口味的独立建议。`,
      missingIngredients: scene === 'cook' ? [ingredient('salt', '少许')] : [],
      imageFallbackCategory: index === 1 ? 'soup' : 'bowl',
      diningCategory: isOut ? '家常蛋类 / 简餐' : null,
      orderingTip: isOut ? '点单前向商家确认鸡蛋熟度及调味料配方。' : null,
      matchedPreferences: ['咸鲜'],
    })),
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const statusFetch = vi.fn<() => Promise<Response>>()
const generationFetch = vi.fn<(request: GenerationRequest, signal?: AbortSignal | null) => Promise<Response>>()
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '#home')
  vi.stubGlobal('scrollTo', vi.fn())
  statusFetch.mockReset().mockImplementation(async () => json(readyStatus))
  generationFetch.mockReset().mockImplementation(async () => { throw new Error('Unexpected generation POST in test') })
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (url === statusUrl && (!init?.method || init.method === 'GET')) return statusFetch()
    if (url === generateUrl && init?.method === 'POST') return generationFetch(JSON.parse(String(init.body)) as GenerationRequest, init.signal)
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

function navigate(hash: string) {
  act(() => {
    window.history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
}

function panel() {
  return within(screen.getByRole('region', { name: 'AI 菜品生成' }))
}

async function generateButton() {
  const button = panel().getByRole('button', { name: /推荐|生成/ })
  await waitFor(() => expect(button).toBeEnabled())
  return button
}

async function generate() {
  fireEvent.click(await generateButton())
}

function add(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '添加你有的食材' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
}

function storePreferences() {
  const preferences = { ...emptyPreferences(), tastes: ['咸鲜', '酸甜'], ingredients: ['蔬菜', '蛋奶'], maxMinutes: 30, configured: true }
  localStorage.setItem(storageKey, JSON.stringify({ preferences, saved: [] }))
  return preferences
}

async function expectBatch(response: GenerationResponse) {
  for (const recipe of response.recipes) expect(await screen.findByRole('heading', { name: recipe.name })).toBeVisible()
  expect(panel().queryByRole('alert')).not.toBeInTheDocument()
}

function expectSeeds() {
  for (const seed of seeds.slice(0, 3)) expect(screen.getByRole('heading', { name: seed.name })).toBeVisible()
  expect(within(screen.getByRole('article', { name: '今日主推菜谱' })).getByRole('heading')).toHaveTextContent(seeds[0].name)
}

describe('Day 3 generation availability and results', () => {
  it.each<EngineStatus>([
    { mode: 'disabled', configured: false, source: null, model: null, message: '生成服务已停用。' },
    { mode: 'openai_compatible', configured: false, source: 'ai', model: null, message: '尚未配置模型。' },
  ])('preserves the original local recipes when the engine is $mode and unavailable', async (status) => {
    statusFetch.mockResolvedValue(json(status))
    render(<App />)
    await waitFor(() => expect(panel().getByText(status.message)).toBeVisible())
    const button = panel().getByRole('button', { name: /推荐/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(generationFetch).not.toHaveBeenCalled()
    expectSeeds()
    expect(screen.getByRole('img', { name: seeds[0].photoAlt })).toHaveAttribute('src', seeds[0].image)
    fireEvent.click(screen.getByRole('button', { name: `收藏${seeds[0].name}` }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).saved).toEqual([seeds[0].id])
    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    expect(within(screen.getByRole('article', { name: '今日主推菜谱' })).getByRole('heading')).toHaveTextContent(seeds[1].name)
    expect(generationFetch).not.toHaveBeenCalled()
  })

  it('does not enable generation before the status GET resolves', async () => {
    const pending = deferred<Response>()
    statusFetch.mockReturnValue(pending.promise)
    render(<App />)
    expect(panel().getByRole('button', { name: /推荐/ })).toBeDisabled()
    expectSeeds()
    expect(generationFetch).not.toHaveBeenCalled()
    await act(async () => { pending.resolve(json(readyStatus)) })
    expect(await generateButton()).toBeEnabled()
    expect(fetchMock).toHaveBeenCalledWith(statusUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('keeps seeds during a status failure and allows a fresh service check', async () => {
    statusFetch.mockRejectedValueOnce(new TypeError('offline'))
    render(<App />)
    await waitFor(() => expect(panel().getByText(/无法连接/)).toBeVisible())
    expect(panel().getByRole('button', { name: /推荐/ })).toBeDisabled()
    expectSeeds()
    fireEvent.click(panel().getByRole('button', { name: /检查服务/ }))
    expect(await generateButton()).toBeEnabled()
    expect(statusFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch).not.toHaveBeenCalled()
  })

  it.each(['mock', 'ai'] as const)('renders three novel %s dishes in the big-plus-two layout with honest placeholders', async (source) => {
    statusFetch.mockResolvedValue(json(source === 'mock' ? readyStatus : { ...readyStatus, mode: 'openai_compatible', source: 'ai', model: 'day3-test-model' }))
    const response = responseFor({ source })
    generationFetch.mockResolvedValue(json(response))
    const { container } = render(<App />)
    await generate()
    await expectBatch(response)
    expect(generationFetch).toHaveBeenCalledTimes(1)
    expect(container.querySelectorAll('.featured-card')).toHaveLength(1)
    expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(2)
    expect(within(screen.getByRole('article', { name: '今日主推菜谱' })).getByRole('heading')).toHaveTextContent(response.recipes[0].name)
    expect(screen.getAllByRole('article')).toHaveLength(3)
    for (const card of screen.getAllByRole('article')) {
      expect(card.querySelector('img')).toBeNull()
      expect(within(card).getByText(/分类插画.*非实物照片/)).toBeVisible()
    }
    expect(screen.getByRole('img', { name: new RegExp(`${response.recipes[0].name}.*占位.*非实物照片`) })).toBeVisible()
    expect(panel().getByText(source === 'mock' ? /Mock.*结果.*非真实 AI/ : /AI 生成结果.*未经人工审核/)).toBeVisible()
    expect(panel().getByText(response.notice)).toBeVisible()
    for (const warning of response.warnings) expect(panel().getByText(warning)).toBeVisible()
    for (const seed of seeds) expect(screen.queryByRole('heading', { name: seed.name })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '换一批' })).not.toBeInTheDocument()
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it.each((['cook', 'eat_out', 'fridge'] as const).flatMap((scene) => [1, 2].map((count) => ({ scene, count }))))('shows $count partial $scene results with warnings and supports regeneration', async ({ scene, count }) => {
    const response = responseFor({ scene })
    response.recipes = response.recipes.slice(0, count)
    response.warnings = [`已淘汰${3 - count}道候选：step_ingredient_reference。`]
    const next = responseFor({ scene, batch: 'next' })
    next.recipes = next.recipes.slice(0, 1)
    generationFetch.mockResolvedValueOnce(json(response)).mockResolvedValueOnce(json(next))
    if (scene === 'fridge') window.history.replaceState(null, '', '#fridge')
    const { container } = render(<App />)
    if (scene === 'eat_out') fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    if (scene === 'fridge') add('番茄、鸡蛋')
    await generate()
    await expectBatch(response)
    expect(screen.getAllByRole('article')).toHaveLength(count)
    expect(panel().getByText(response.warnings[0])).toBeVisible()
    if (scene !== 'fridge') {
      expect(container.querySelectorAll('.featured-card')).toHaveLength(1)
      expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(count - 1)
      if (count === 1) expect(screen.getByText(/本次仅返回这一道通过校验的候选/)).toBeVisible()
    }
    expect(screen.queryByRole('button', { name: '浏览本次候选' })).not.toBeInTheDocument()
    expect(generationFetch).toHaveBeenCalledTimes(1)
    await generate()
    await expectBatch(next)
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(panel().queryByText(response.warnings[0])).not.toBeInTheDocument()
    expect(generationFetch).toHaveBeenCalledTimes(2)
  })

  it('browses five generated candidates in the one-plus-two layout without another API call', async () => {
    const response = responseFor()
    response.recipes.push(...response.recipes.slice(0, 2).map((recipe, index) => ({ ...recipe, id: `extra-${index}`, name: `${recipe.name}第二组` })))
    generationFetch.mockImplementation(async () => json(response))
    const { container } = render(<App />)
    await generate()
    await screen.findByRole('heading', { name: response.recipes[0].name })
    expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '浏览本次候选' }))
    fireEvent.click(screen.getByRole('button', { name: '浏览本次候选' }))
    expect(screen.getByRole('heading', { name: response.recipes[4].name })).toBeVisible()
    expect(container.querySelectorAll('.featured-card')).toHaveLength(1)
    expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(2)
    expect(generationFetch).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('未再次请求 AI')
    await generate()
    await waitFor(() => expect(within(screen.getByRole('article', { name: '今日主推菜谱' })).getByRole('heading')).toHaveTextContent(response.recipes[0].name))
    expect(generationFetch).toHaveBeenCalledTimes(2)
  })

  it('posts again for regeneration and replaces the batch rather than rotating local dishes', async () => {
    const first = responseFor()
    const second = responseFor({ batch: 'second' })
    generationFetch.mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(second))
    render(<App />)
    await generate()
    await expectBatch(first)
    await generate()
    await expectBatch(second)
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch.mock.calls[1][0]).toEqual(generationFetch.mock.calls[0][0])
    for (const recipe of first.recipes) expect(screen.queryByRole('heading', { name: recipe.name })).not.toBeInTheDocument()
    for (const seed of seeds) expect(screen.queryByRole('heading', { name: seed.name })).not.toBeInTheDocument()
  })
})

describe('Day 3 generation requests and fridge constraints', () => {
  it.each(['cook', 'eat_out'] as const)('sends saved and current preferences with the %s request', async (scene) => {
    const preferences = storePreferences()
    const response = responseFor({ scene })
    generationFetch.mockResolvedValue(json(response))
    render(<App />)
    fireEvent.change(screen.getByRole('combobox', { name: '今天的口味' }), { target: { value: '清爽' } })
    fireEvent.click(screen.getByRole('button', { name: /15 分钟快手/ }))
    if (scene === 'eat_out') {
      fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
      fireEvent.change(screen.getByRole('combobox', { name: '预算偏好' }), { target: { value: 'economy' } })
    }
    await generate()
    await expectBatch(response)
    expect(generationFetch.mock.calls[0][0]).toEqual({
      scene, ingredientIds: [], tastePreferences: preferences.tastes, todayTaste: '清爽',
      preferredCategories: preferences.ingredients, timeLimit: scene === 'cook' ? 15 : null,
      budgetLevel: scene === 'eat_out' ? 'economy' : null, servings: 1, strictIngredients: true, assumeBasics: true,
    })
    expect(fetchMock).toHaveBeenCalledWith(generateUrl, expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: expect.any(AbortSignal),
    }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).preferences).toEqual(preferences)
  })

  it('submits only confirmed canonical IDs and sends strictness, basics, servings and taste controls', async () => {
    const preferences = storePreferences()
    const response = responseFor({ scene: 'fridge', servings: 3 })
    generationFetch.mockImplementation(async (request) => json({
      ...response,
      recipes: response.recipes.map((dish) => ({ ...dish, missingIngredients: request.assumeBasics ? [] : [ingredient('salt', '少许'), ingredient('water', '150 毫升')] })),
    }))
    window.history.replaceState(null, '', '#fridge')
    render(<App />)
    add('西红柿、番茄、鸡蛋、橄榄油、火星果')
    const selected = within(screen.getByRole('list', { name: '已选食材' }))
    expect(selected.getAllByRole('listitem')).toHaveLength(3)
    expect(selected.queryByText('火星果')).not.toBeInTheDocument()
    expect(screen.getByText(/未添加.*不会提交/)).toBeVisible()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '豆腐、尚未确认的草稿' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /仅使用现有主要食材/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /我有基础厨房材料/ }))
    fireEvent.change(screen.getByRole('combobox', { name: '用餐份量' }), { target: { value: '3' } })
    fireEvent.change(screen.getByRole('combobox', { name: '今天的口味' }), { target: { value: '酸辣' } })
    await generate()
    await expectBatch(response)
    expect(generationFetch.mock.calls[0][0]).toEqual({
      scene: 'fridge', ingredientIds: ['tomato', 'egg', 'oil'], tastePreferences: preferences.tastes,
      todayTaste: '酸辣', preferredCategories: preferences.ingredients, timeLimit: null, budgetLevel: null,
      servings: 3, strictIngredients: false, assumeBasics: false,
    })
    expect(JSON.stringify(generationFetch.mock.calls[0][0])).not.toMatch(/西红柿|番茄|火星果|豆腐|草稿/)
    fireEvent.click(screen.getByRole('checkbox', { name: /仅使用现有主要食材/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /我有基础厨房材料/ }))
    await generate()
    await expectBatch(response)
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch.mock.calls[1][0]).toEqual({ ...generationFetch.mock.calls[0][0], strictIngredients: true, assumeBasics: true })
    expect(screen.getByRole('textbox')).toHaveValue('豆腐、尚未确认的草稿')
  })

  it('filters legacy unknown pantry entries and keeps an unsubmitted draft out of the payload', async () => {
    localStorage.setItem(pantryStorageKey, JSON.stringify({ items: ['西红柿', '番茄', '火星果'], draft: '虾、未提交', assumeBasics: true }))
    const response = { ...responseFor({ scene: 'fridge' }), recipes: [] }
    generationFetch.mockResolvedValue(json(response))
    window.history.replaceState(null, '', '#fridge')
    render(<App />)
    await generate()
    await waitFor(() => expect(panel().getByText(response.notice)).toBeVisible())
    expect(generationFetch.mock.calls[0][0].ingredientIds).toEqual(['tomato'])
    expect(generationFetch.mock.calls[0][0]).not.toHaveProperty('draft')
    expect(JSON.stringify(generationFetch.mock.calls[0][0])).not.toMatch(/火星果|未提交|虾/)
  })

  it.each([{ items: [] }, { items: ['火星果'] }])('does not generate with no recognized selected ingredients: $items', async ({ items }) => {
    localStorage.setItem(pantryStorageKey, JSON.stringify({ items, draft: '番茄', assumeBasics: true }))
    window.history.replaceState(null, '', '#fridge')
    render(<App />)
    await waitFor(() => expect(panel().getByText(readyStatus.message)).toBeVisible())
    const button = panel().getByRole('button', { name: /生成菜谱/ })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(generationFetch).not.toHaveBeenCalled()
  })

  it('shows an honest empty generated fridge result instead of padding it with local recipes', async () => {
    const response = { ...responseFor({ scene: 'fridge' }), recipes: [], notice: '当前食材组合没有合适的生成结果。' }
    generationFetch.mockResolvedValue(json(response))
    window.history.replaceState(null, '', '#fridge')
    render(<App />)
    add('番茄')
    expect(screen.getByRole('article', { name: `${seeds[2].name}匹配结果` })).toBeVisible()
    await generate()
    await waitFor(() => expect(panel().getByText(response.notice)).toBeVisible())
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /暂时没有.*做法/ })).toBeVisible()
    expect(screen.getByText(/不.*编造菜谱/)).toBeVisible()
    expect(screen.getByText(/补充食材.*调整条件/)).toBeVisible()
    expect(screen.getByText(/0 道生成/)).toBeVisible()
    expect(panel().queryByRole('alert')).not.toBeInTheDocument()
    expect(await generateButton()).toBeEnabled()
  })
})

describe('Day 3 generated favorites and reload', () => {
  it.each((['cook', 'eat_out', 'fridge'] as const).flatMap((scene) => [1, 2, 3].map((count) => ({ scene, count }))))('persists the full $scene DTO from $count results and opens saved details after remount', async ({ scene, count }) => {
    const response = responseFor({ scene, source: 'ai', servings: scene === 'fridge' ? 3 : 1 })
    response.recipes = response.recipes.slice(0, count)
    statusFetch.mockImplementation(async () => json({ ...readyStatus, mode: 'openai_compatible', source: 'ai', model: response.model }))
    const dish = response.recipes[0]
    generationFetch.mockResolvedValue(json(response))
    if (scene === 'fridge') window.history.replaceState(null, '', '#fridge')
    const first = render(<App />)
    if (scene === 'eat_out') fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    if (scene === 'fridge') {
      add('番茄、鸡蛋')
      fireEvent.change(screen.getByRole('combobox', { name: '用餐份量' }), { target: { value: '3' } })
    }
    await generate()
    await expectBatch(response)
    fireEvent.click(screen.getByRole('button', { name: `收藏${dish.name}` }))
    const stored = JSON.parse(localStorage.getItem(storageKey)!)
    expect(stored.saved).toEqual([dish.id])
    expect(stored.generatedSnapshots).toEqual([{
      recipe: dish, source: response.source, model: response.model, scene, servings: response.servings,
    }])
    first.unmount()
    window.history.replaceState(null, '', '#saved')
    const savedView = render(<App />)
    expect(screen.getByRole('heading', { name: dish.name })).toBeVisible()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    fireEvent.click(screen.getByRole('link', { name: dish.name }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(dish.name))
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#saved')
    // A direct URL without mode hints must still use the saved DTO's scene.
    navigate(`#recipe/${dish.id}`)
    savedView.unmount()
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(dish.name)
    expect(screen.getByText(dish.description)).toBeVisible()
    expect(screen.getByText(dish.recommendationReason)).toBeVisible()
    expect(screen.getByRole('button', { name: `取消收藏${dish.name}` })).toHaveAttribute('aria-pressed', 'true')
    expect(within(screen.getByRole('main')).getByRole('img', { name: /分类插画占位.*非实物照片/ })).toBeVisible()
    expect(screen.getByRole('main').querySelector('img')).toBeNull()
    if (scene === 'eat_out') {
      expect(screen.getByRole('region', { name: /点餐/ })).toHaveTextContent(dish.orderingTip!)
      expect(screen.queryByRole('heading', { name: /一步步/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: /准备.*食材/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /开始做/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
      expect(screen.queryByText(/预计总用时/)).not.toBeInTheDocument()
    } else {
      expect(screen.getAllByText(`${response.servings} 人份`).length).toBeGreaterThan(0)
      expect(screen.getByText(`${dish.estimatedTime} 分钟`)).toBeVisible()
      const ingredients = within(screen.getByRole('region', { name: /准备.*食材/ }))
      expect(ingredients.getAllByRole('checkbox')).toHaveLength(dish.ingredients.length)
      for (const item of dish.ingredients) {
        const checkbox = ingredients.getByRole('checkbox', { name: new RegExp(item.name) })
        expect(checkbox.closest('label')).toHaveTextContent(item.amount)
        expect(checkbox.closest('label')).toHaveTextContent(item.role === 'main' ? '必需' : '调味')
      }
      for (const item of dish.missingIngredients) expect(ingredients.getByText(/需额外准备/)).toHaveTextContent(`${item.name}（${item.amount}）`)
      for (const step of dish.cookingSteps) {
        expect(screen.getByRole('heading', { name: step.title })).toBeVisible()
        expect(screen.getByText(step.body)).toBeVisible()
      }
    }
    expect(generationFetch).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: `取消收藏${dish.name}` }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).generatedSnapshots).toEqual([])
  })

  it.each(['{broken', 'null', JSON.stringify({ generatedSnapshots: { recipe: 'invalid' }, saved: ['mock-day3-missing'] })])('recovers from corrupted generated storage: %s', async (raw) => {
    localStorage.setItem(storageKey, raw)
    render(<App />)
    await generateButton()
    expectSeeds()
    navigate('#saved')
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    navigate('#recipe/mock-day3-missing')
    expect(screen.queryByRole('button', { name: /开始做/ })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /今日推荐/ })).toHaveAttribute('href', '#home')
  })

  it('discards invalid generated snapshots while preserving valid generated and seed favorites', () => {
    const response = responseFor()
    const valid = { recipe: response.recipes[0], source: response.source, model: response.model, scene: response.scene, servings: response.servings }
    const invalid = { ...valid, recipe: { ...response.recipes[1], ingredients: [{ ingredientId: 'unknown', name: '伪造食材', amount: '1', role: 'main' }] } }
    localStorage.setItem(storageKey, JSON.stringify({
      preferences: emptyPreferences(), saved: [seeds[0].id, valid.recipe.id, invalid.recipe.id, 'missing'],
      generatedSnapshots: [null, { recipe: null }, invalid, valid],
    }))
    window.history.replaceState(null, '', '#saved')
    render(<App />)
    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(screen.getByRole('heading', { name: seeds[0].name })).toBeVisible()
    expect(screen.getByRole('heading', { name: valid.recipe.name })).toBeVisible()
    expect(screen.queryByRole('heading', { name: invalid.recipe.name })).not.toBeInTheDocument()
    navigate(`#recipe/${invalid.recipe.id}`)
    expect(screen.queryByText('伪造食材')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /开始做/ })).not.toBeInTheDocument()
    expect(generationFetch).not.toHaveBeenCalled()
  })

  it('keeps a generated favorite usable in memory when storage writes are blocked', async () => {
    const response = responseFor()
    generationFetch.mockResolvedValue(json(response))
    render(<App />)
    await generate()
    await expectBatch(response)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    fireEvent.click(screen.getByRole('button', { name: `收藏${response.recipes[0].name}` }))
    expect(screen.getByRole('status')).toHaveTextContent(/浏览器无法保存/)
    navigate('#saved')
    expect(screen.getByRole('heading', { name: response.recipes[0].name })).toBeVisible()
    navigate(`#recipe/${response.recipes[0].id}`)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(response.recipes[0].name)
    expect(screen.getByRole('button', { name: `取消收藏${response.recipes[0].name}` })).toHaveAttribute('aria-pressed', 'true')
  })

  it('still renders local seeds when storage reads are blocked', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    render(<App />)
    await generateButton()
    expectSeeds()
  })
})

describe('Day 3 failures, retry and concurrent requests', () => {
  it.each(['network', 'backend', 'invalid-json', 'invalid-contract'] as const)('retains seeds after %s failure and retries with a fresh POST', async (failure) => {
    const good = responseFor({ batch: 'retry' })
    if (failure === 'network') generationFetch.mockRejectedValueOnce(new TypeError('Network unavailable'))
    if (failure === 'backend') generationFetch.mockResolvedValueOnce(json({ detail: { message: '测试服务暂不可用，请重试。' } }, 503))
    if (failure === 'invalid-json') generationFetch.mockResolvedValueOnce(new Response('{broken', { status: 200 }))
    if (failure === 'invalid-contract') {
      const bad = responseFor({ batch: 'rejected' })
      bad.recipes[2].ingredients[0].ingredientId = 'not-in-catalog'
      generationFetch.mockResolvedValueOnce(json(bad))
    }
    generationFetch.mockResolvedValueOnce(json(good))
    render(<App />)
    await generate()
    expect(await panel().findByRole('alert')).toBeVisible()
    expect(panel().getByRole('alert')).toHaveTextContent(/本地示例.*不是.*AI/)
    if (failure === 'backend') expect(panel().getByRole('alert')).toHaveTextContent('测试服务暂不可用')
    expectSeeds()
    expect(screen.queryByRole('heading', { name: /rejected/ })).not.toBeInTheDocument()
    expect(localStorage.getItem(storageKey)).toBeNull()
    await generate()
    await expectBatch(good)
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch.mock.calls[1][0]).toEqual(generationFetch.mock.calls[0][0])
  })

  it('does not register even valid-looking dishes from a partially malformed batch', async () => {
    const bad = responseFor({ batch: 'unvalidated' })
    bad.recipes[2].ingredients[0].role = 'seasoning'
    generationFetch.mockResolvedValue(json(bad))
    render(<App />)
    await generate()
    await panel().findByRole('alert')
    for (const dish of bad.recipes) {
      expect(screen.queryByRole('heading', { name: dish.name })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: `收藏${dish.name}` })).not.toBeInTheDocument()
    }
    navigate(`#recipe/${bad.recipes[0].id}`)
    expect(screen.queryByRole('heading', { name: bad.recipes[0].name })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /开始做/ })).not.toBeInTheDocument()
  })

  it('preserves the last successful generated batch on failure and labels it as previous output', async () => {
    const good = responseFor()
    generationFetch.mockResolvedValueOnce(json(good)).mockResolvedValueOnce(json({ detail: { message: '稍后重试。' } }, 502))
    render(<App />)
    await generate()
    await expectBatch(good)
    await generate()
    expect(await panel().findByRole('alert')).toHaveTextContent(/上一次.*成功/)
    for (const dish of good.recipes) expect(screen.getByRole('heading', { name: dish.name })).toBeVisible()
    for (const seed of seeds) expect(screen.queryByRole('heading', { name: seed.name })).not.toBeInTheDocument()
    expect(await generateButton()).toBeEnabled()
  })

  it('aborts a timed-out generation and offers an explicit retry', async () => {
    generationFetch.mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    render(<App />)
    const button = await generateButton()
    vi.useFakeTimers()
    try {
      fireEvent.click(button)
      await act(async () => { await vi.advanceTimersByTimeAsync(95000) })
      expect(panel().getByRole('alert')).toHaveTextContent('生成超时')
      expect(panel().getByRole('button', { name: /重试生成/ })).toBeEnabled()
      expect(generationFetch.mock.calls[0][1]?.aborted).toBe(true)
      expectSeeds()
    } finally {
      vi.useRealTimers()
    }
  })

  it('deduplicates rapid clicks while busy and enables another POST after completion', async () => {
    const pending = deferred<Response>()
    const first = responseFor()
    const second = responseFor({ batch: 'after-busy' })
    generationFetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json(second))
    render(<App />)
    const button = await generateButton()
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(button).toBeDisabled()
    expect(panel().getByRole('status')).toBeVisible()
    expect(generationFetch).toHaveBeenCalledTimes(1)
    expectSeeds()
    await act(async () => { pending.resolve(json(first)) })
    await expectBatch(first)
    expect(panel().queryByRole('status')).not.toBeInTheDocument()
    await generate()
    await expectBatch(second)
    expect(generationFetch).toHaveBeenCalledTimes(2)
  })

  it.each(['taste', 'mode', 'time', 'fridge-servings', 'fridge-strict', 'fridge-basics', 'fridge-ingredients'] as const)('ignores a late response after changing %s, even when fetch ignores abort', async (control) => {
    const fridge = control.startsWith('fridge-')
    const old = responseFor({ scene: fridge ? 'fridge' : 'cook', batch: 'stale' })
    const current = responseFor({ scene: control === 'mode' ? 'eat_out' : fridge ? 'fridge' : 'cook', servings: control === 'fridge-servings' ? 3 : 1, batch: 'current' })
    const pending = deferred<Response>()
    generationFetch.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json(current))
    if (fridge) {
      localStorage.setItem(pantryStorageKey, JSON.stringify({ items: ['番茄', '鸡蛋'], draft: '', assumeBasics: true }))
      window.history.replaceState(null, '', '#fridge')
    }
    render(<App />)
    await generate()
    const oldSignal = generationFetch.mock.calls[0][1]
    if (control === 'taste') fireEvent.change(screen.getByRole('combobox', { name: '今天的口味' }), { target: { value: '酸甜' } })
    if (control === 'mode') fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    if (control === 'time') fireEvent.click(screen.getByRole('button', { name: /15 分钟快手/ }))
    if (control === 'fridge-servings') fireEvent.change(screen.getByRole('combobox', { name: '用餐份量' }), { target: { value: '3' } })
    if (control === 'fridge-strict') fireEvent.click(screen.getByRole('checkbox', { name: /仅使用现有主要食材/ }))
    if (control === 'fridge-basics') fireEvent.click(screen.getByRole('checkbox', { name: /我有基础厨房材料/ }))
    if (control === 'fridge-ingredients') add('盐')
    expect(oldSignal?.aborted).toBe(true)
    await generate()
    await expectBatch(current)
    await act(async () => { pending.resolve(json(old)) })
    await expectBatch(current)
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch.mock.calls[1][0]).not.toEqual(generationFetch.mock.calls[0][0])
    for (const dish of old.recipes) expect(screen.queryByRole('heading', { name: dish.name })).not.toBeInTheDocument()
    navigate(`#recipe/${old.recipes[0].id}`)
    expect(screen.queryByRole('heading', { name: old.recipes[0].name })).not.toBeInTheDocument()
  })

  it('does not clear a newer busy state when an older cancelled POST completes', async () => {
    const old = deferred<Response>()
    const current = deferred<Response>()
    const currentResponse = responseFor({ batch: 'newer-pending' })
    generationFetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    render(<App />)
    await generate()
    fireEvent.click(screen.getByRole('radio', { name: '清爽' }))
    await generate()
    await act(async () => { old.resolve(json(responseFor({ batch: 'older-pending' }))) })
    expect(panel().getByRole('button', { name: /搭配/ })).toBeDisabled()
    expect(panel().getByRole('status')).toBeVisible()
    expect(screen.queryByRole('heading', { name: /older-pending/ })).not.toBeInTheDocument()
    await act(async () => { current.resolve(json(currentResponse)) })
    await expectBatch(currentResponse)
  })

  it.each(['cook', 'fridge'] as const)('discards a pending %s response when leaving its page', async (scene) => {
    const pending = deferred<Response>()
    const response = responseFor({ scene, batch: 'left-page' })
    generationFetch.mockReturnValue(pending.promise)
    if (scene === 'fridge') {
      localStorage.setItem(pantryStorageKey, JSON.stringify({ items: ['番茄'], draft: '', assumeBasics: true }))
      window.history.replaceState(null, '', '#fridge')
    }
    render(<App />)
    await generate()
    const signal = generationFetch.mock.calls[0][1]
    navigate('#saved')
    expect(signal?.aborted).toBe(true)
    await act(async () => { pending.resolve(json(response)) })
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    navigate(`#recipe/${response.recipes[0].id}`)
    expect(screen.queryByRole('heading', { name: response.recipes[0].name })).not.toBeInTheDocument()
  })
})
