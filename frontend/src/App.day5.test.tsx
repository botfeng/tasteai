import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import catalog from '../../backend/app/data/ingredients.json'
import App from './App'
import type { DishPhoto, EngineStatus, GeneratedDish, GeneratedIngredient, GenerationRequest, GenerationResponse, Scene } from './data/generation'
import { historyStorageKey } from './data/history'
import { emptyPreferences, storageKey } from './data/preferences'

const statusUrl = '/api/recommendations/status'
const generateUrl = '/api/recommendations/generate'
const photosUrl = '/api/photos/match'
const readyStatus: EngineStatus = {
  mode: 'mock', configured: true, source: 'mock', model: null, message: '测试生成服务已就绪。',
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
})

type PhotoRequestBody = { dishes: { id: string; name: string; scene: Scene; ingredientIds: string[]; diningCategory: string | null }[] }

function ingredient(id: string, amount: string): GeneratedIngredient {
  const entry = catalog.find((item) => item.id === id)
  if (!entry || (entry.role !== 'main' && entry.role !== 'seasoning')) throw new Error(`Invalid fixture ingredient: ${id}`)
  return { ingredientId: entry.id, name: entry.name, role: entry.role, amount }
}

function dishFor(id: string, name: string, index = 0): GeneratedDish {
  return {
    id, name,
    description: `${name}的独立生成描述。`,
    ingredients: [ingredient('tomato', '200 克'), ingredient('egg', '2 个'), ingredient('salt', '少许'), ingredient('water', '150 毫升')],
    cookingSteps: [
      { title: '切配番茄并打散鸡蛋', body: '番茄洗净切块，鸡蛋打散备用。', ingredientIds: ['tomato', 'egg'] },
      { title: '加水煮至完全熟透', body: '加入水和盐，将番茄与蛋液加热至完全熟透。', ingredientIds: ['tomato', 'egg', 'water', 'salt'] },
    ],
    estimatedTime: 12 + index,
    recommendationReason: `${name}贴合当前口味与时间条件。`,
    missingIngredients: [],
    imageFallbackCategory: index === 1 ? 'soup' : 'bowl',
    diningCategory: null, orderingTip: null,
    matchedPreferences: ['咸鲜'],
  }
}

function responseFor({ scene = 'cook', batch = 'first', count = 3, servings = 1 }: { scene?: Scene; batch?: string; count?: number; servings?: number } = {}): GenerationResponse {
  return {
    source: 'mock', model: null, scene, servings,
    notice: '本批次是自动化测试夹具，不会调用模型。', warnings: ['请自行核对实际食材用量。'],
    recipes: ['番茄滑蛋小锅', '番茄蛋花暖汤', '番茄蒸蛋小盅'].slice(0, count).map((name, index) => dishFor(`mock-day5-${batch}-${index}`, `${name}·${batch}`, index)),
  }
}

function swapResponse(id: string, name: string): GenerationResponse {
  return {
    source: 'mock', model: null, scene: 'cook', servings: 1,
    notice: '单道替换测试夹具。', warnings: [],
    recipes: [dishFor(id, name)],
  }
}

function photoFor(id: number): DishPhoto {
  return {
    url: `https://api.openverse.org/v1/images/0e1c4e2a-0000-4000-8000-${String(id).padStart(12, '0')}/thumb/`,
    alt: `Tomato and egg dish ${id}`,
    photographer: `Photographer ${id}`,
    photographerUrl: `https://www.flickr.com/people/photographer-${id}/`,
    pageUrl: `https://www.flickr.com/photos/photographer-${id}/${id}/`,
    width: 1200, height: 800, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', source: 'openverse',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const statusFetch = vi.fn<() => Promise<Response>>()
const generationFetch = vi.fn<(request: GenerationRequest, signal?: AbortSignal | null) => Promise<Response>>()
const photosFetch = vi.fn<(body: PhotoRequestBody, signal?: AbortSignal | null) => Promise<Response>>()
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '#home')
  vi.stubGlobal('scrollTo', vi.fn())
  statusFetch.mockReset().mockImplementation(async () => json(readyStatus))
  generationFetch.mockReset().mockImplementation(async () => { throw new Error('Unexpected generation POST in test') })
  photosFetch.mockReset().mockImplementation(async (body) => json({ configured: false, photos: body.dishes.map((entry) => ({ dishId: entry.id, photo: null })) }))
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (url === statusUrl && (!init?.method || init.method === 'GET')) return statusFetch()
    if (url === generateUrl && init?.method === 'POST') return generationFetch(JSON.parse(String(init.body)) as GenerationRequest, init.signal)
    if (url === photosUrl && init?.method === 'POST') return photosFetch(JSON.parse(String(init.body)) as PhotoRequestBody, init.signal)
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

function panel() {
  return within(screen.getByRole('region', { name: 'AI 菜品生成' }))
}

async function generateButton() {
  const button = panel().getByRole('button', { name: /帮我决定|推荐|生成/ })
  await waitFor(() => expect(button).toBeEnabled())
  return button
}

async function generate() {
  fireEvent.click(await generateButton())
}

async function expectBatch(response: GenerationResponse) {
  for (const recipe of response.recipes) expect(await screen.findByRole('heading', { name: recipe.name })).toBeVisible()
  expect(panel().queryByRole('alert')).not.toBeInTheDocument()
}

function hero() {
  return within(screen.getByRole('article', { name: '今日主推菜谱' }))
}

function cardOf(name: string) {
  return within(screen.getByRole('heading', { name }).closest('article')!)
}

function swapButton(scope: ReturnType<typeof within>) {
  return scope.getByRole('button', { name: /换一道/ })
}

function storePreferences() {
  const preferences = { ...emptyPreferences(), tastes: ['咸鲜', '酸甜'], ingredients: ['蔬菜', '蛋奶'], maxMinutes: 30, configured: true }
  localStorage.setItem(storageKey, JSON.stringify({ preferences, saved: [] }))
  return preferences
}

describe('Day 5 quick decision flow', () => {
  it('defaults from the taste profile, never auto-generates, and decides with one click', async () => {
    const preferences = storePreferences()
    const response = responseFor({ servings: 2 })
    generationFetch.mockResolvedValue(json(response))
    const { container } = render(<App />)
    expect(screen.getByRole('button', { name: '30 分钟' })).toHaveAttribute('aria-pressed', 'true')
    expect(panel().getByRole('button', { name: '帮我决定' })).toBeDisabled()
    await waitFor(() => expect(panel().getByRole('button', { name: '帮我决定' })).toBeEnabled())
    fireEvent.change(screen.getByRole('combobox', { name: '今天的口味' }), { target: { value: '清爽' } })
    fireEvent.click(screen.getByRole('button', { name: '60 分钟' }))
    fireEvent.change(screen.getByRole('combobox', { name: '用餐人数' }), { target: { value: '2' } })
    expect(generationFetch).not.toHaveBeenCalled()
    fireEvent.click(panel().getByRole('button', { name: '帮我决定' }))
    await expectBatch(response)
    expect(generationFetch).toHaveBeenCalledTimes(1)
    expect(generationFetch.mock.calls[0][0]).toEqual({
      scene: 'cook', ingredientIds: [], tastePreferences: preferences.tastes, todayTaste: '清爽',
      preferredCategories: preferences.ingredients, timeLimit: 60, budgetLevel: null,
      servings: 2, strictIngredients: true, assumeBasics: true, maxRecipes: 3,
    })
    expect(container.querySelectorAll('.featured-card')).toHaveLength(1)
    expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(2)
    expect(screen.getAllByRole('article')).toHaveLength(3)
    expect(panel().getByRole('button', { name: '重新生成一批' })).toBeEnabled()
    expect(JSON.parse(localStorage.getItem(historyStorageKey)!)).toEqual(response.recipes.map((recipe) => recipe.name))
    expect(localStorage.getItem(storageKey)).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(storageKey)!).preferences).toEqual(preferences)
  })

  it('toggles time chips off and sends no limit when time is unrestricted', async () => {
    const response = responseFor()
    generationFetch.mockResolvedValue(json(response))
    render(<App />)
    const quick = screen.getByRole('button', { name: '15 分钟快手' })
    fireEvent.click(quick)
    expect(quick).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(quick)
    expect(quick).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '不限时间' })).toHaveAttribute('aria-pressed', 'true')
    await generate()
    await expectBatch(response)
    expect(generationFetch.mock.calls[0][0].timeLimit).toBeNull()
  })

  it.each([1, 2])('degrades honestly to %s dishes without padding or rotation', async (count) => {
    const response = responseFor({ count })
    generationFetch.mockResolvedValue(json(response))
    const { container } = render(<App />)
    await generate()
    await expectBatch(response)
    expect(screen.getAllByRole('article')).toHaveLength(count)
    expect(container.querySelectorAll('.featured-card')).toHaveLength(1)
    expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(count - 1)
    if (count === 1) expect(screen.getByText(/本次仅返回这一道通过校验的候选/)).toBeVisible()
    expect(screen.queryByRole('button', { name: '浏览本次候选' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '换一批' })).not.toBeInTheDocument()
    expect(generationFetch).toHaveBeenCalledTimes(1)
  })
})

describe('Day 5 swap one dish', () => {
  it('replaces only the featured card, keeps other cards and favorites, and requests one new dish', async () => {
    const batch = responseFor()
    const fresh = swapResponse('mock-day5-swap-0', '丝瓜虾仁快炒·新')
    generationFetch.mockResolvedValueOnce(json(batch)).mockResolvedValueOnce(json(fresh))
    render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(screen.getByRole('button', { name: `收藏${batch.recipes[1].name}` }))
    const batchRequest = generationFetch.mock.calls[0][0]
    fireEvent.click(swapButton(hero()))
    await waitFor(() => expect(hero().getByRole('heading')).toHaveTextContent(fresh.recipes[0].name))
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch.mock.calls[1][0]).toEqual({
      ...batchRequest, maxRecipes: 1,
      excludedRecipeNames: batch.recipes.map((recipe) => recipe.name),
    })
    expect(screen.getByRole('heading', { name: batch.recipes[1].name })).toBeVisible()
    expect(screen.getByRole('heading', { name: batch.recipes[2].name })).toBeVisible()
    expect(screen.queryByRole('heading', { name: batch.recipes[0].name })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: `取消收藏${batch.recipes[1].name}` })).toHaveAttribute('aria-pressed', 'true')
    expect(JSON.parse(localStorage.getItem(storageKey)!).saved).toEqual([batch.recipes[1].id])
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(2))
    expect(photosFetch.mock.calls[1][0].dishes.map((entry) => entry.id)).toEqual([fresh.recipes[0].id])
    expect(JSON.parse(localStorage.getItem(historyStorageKey)!)[0]).toBe(fresh.recipes[0].name)
    expect(hero().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('replaces a small card without touching the featured card', async () => {
    const batch = responseFor()
    const fresh = swapResponse('mock-day5-swap-1', '凉拌秋葵·新')
    generationFetch.mockResolvedValueOnce(json(batch)).mockResolvedValueOnce(json(fresh))
    render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(swapButton(cardOf(batch.recipes[1].name)))
    await waitFor(() => expect(screen.getByRole('heading', { name: fresh.recipes[0].name })).toBeVisible())
    expect(hero().getByRole('heading')).toHaveTextContent(batch.recipes[0].name)
    expect(screen.getByRole('heading', { name: batch.recipes[2].name })).toBeVisible()
    expect(screen.queryByRole('heading', { name: batch.recipes[1].name })).not.toBeInTheDocument()
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(generationFetch.mock.calls[1][0].maxRecipes).toBe(1)
  })

  it('reports a duplicate-only swap explicitly and keeps the original dish', async () => {
    const batch = responseFor()
    const duplicate = swapResponse('mock-day5-swap-dup', '番茄蛋花暖汤 · first！')
    generationFetch.mockResolvedValueOnce(json(batch)).mockResolvedValueOnce(json(duplicate))
    render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(swapButton(hero()))
    expect(await hero().findByRole('alert')).toHaveTextContent('本次没有生成不重复的新菜，已保留原推荐')
    expect(hero().getByRole('heading')).toHaveTextContent(batch.recipes[0].name)
    expect(screen.queryByRole('heading', { name: duplicate.recipes[0].name })).not.toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(historyStorageKey)!)).toEqual(batch.recipes.map((recipe) => recipe.name))
    expect(swapButton(hero())).toBeEnabled()
  })

  it('keeps the original dish on swap failure and supports a successful retry', async () => {
    const batch = responseFor()
    const fresh = swapResponse('mock-day5-swap-retry', '蒜蓉西兰花·新')
    generationFetch.mockResolvedValueOnce(json(batch)).mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json(fresh))
    render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(swapButton(hero()))
    expect(await hero().findByRole('alert')).toHaveTextContent('已保留原推荐')
    expect(hero().getByRole('heading')).toHaveTextContent(batch.recipes[0].name)
    expect(swapButton(hero())).toBeEnabled()
    fireEvent.click(swapButton(hero()))
    await waitFor(() => expect(hero().getByRole('heading')).toHaveTextContent(fresh.recipes[0].name))
    expect(hero().queryByRole('alert')).not.toBeInTheDocument()
    expect(generationFetch).toHaveBeenCalledTimes(3)
  })

  it('never fires concurrent swap requests from repeated clicks', async () => {
    const batch = responseFor()
    const fresh = swapResponse('mock-day5-swap-busy', '清炒豆芽·新')
    const pending = deferred<Response>()
    generationFetch.mockResolvedValueOnce(json(batch)).mockReturnValueOnce(pending.promise)
    render(<App />)
    await generate()
    await expectBatch(batch)
    const button = swapButton(hero())
    act(() => {
      fireEvent.click(button)
      fireEvent.click(button)
      fireEvent.click(button)
    })
    expect(generationFetch).toHaveBeenCalledTimes(2)
    expect(swapButton(hero())).toBeDisabled()
    expect(hero().getByRole('status')).toHaveTextContent('正在换一道…')
    expect(hero().getByRole('heading')).toHaveTextContent(batch.recipes[0].name)
    expect(cardOf(batch.recipes[1].name).getByRole('button', { name: '换一道' })).toBeEnabled()
    await act(async () => { pending.resolve(json(fresh)) })
    await waitFor(() => expect(hero().getByRole('heading')).toHaveTextContent(fresh.recipes[0].name))
    expect(hero().queryByRole('status')).not.toBeInTheDocument()
    expect(swapButton(hero())).toBeEnabled()
  })

  it('discards a stale swap after conditions change, even when fetch ignores abort', async () => {
    const batch = responseFor()
    const stale = swapResponse('mock-day5-swap-stale', '过期替换菜·旧')
    const pending = deferred<Response>()
    generationFetch.mockResolvedValueOnce(json(batch)).mockReturnValueOnce(pending.promise)
    render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(swapButton(hero()))
    const swapSignal = generationFetch.mock.calls[1][1]
    fireEvent.change(screen.getByRole('combobox', { name: '今天的口味' }), { target: { value: '酸甜' } })
    expect(swapSignal?.aborted).toBe(true)
    await act(async () => { pending.resolve(json(stale)) })
    expect(screen.queryByRole('heading', { name: stale.recipes[0].name })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /换一道/ })).not.toBeInTheDocument()
    expect(generationFetch).toHaveBeenCalledTimes(2)
  })

  it('discards a stale swap when a newer batch arrives under the same conditions', async () => {
    const batch = responseFor()
    const next = responseFor({ batch: 'second' })
    const stale = swapResponse('mock-day5-swap-late', '迟到替换菜·旧')
    const pending = deferred<Response>()
    generationFetch.mockResolvedValueOnce(json(batch)).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(json(next))
    render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(swapButton(hero()))
    await generate()
    await expectBatch(next)
    await act(async () => { pending.resolve(json(stale)) })
    expect(hero().getByRole('heading')).toHaveTextContent(next.recipes[0].name)
    expect(screen.queryByRole('heading', { name: stale.recipes[0].name })).not.toBeInTheDocument()
    for (const recipe of next.recipes) expect(screen.getByRole('heading', { name: recipe.name })).toBeVisible()
    expect(generationFetch).toHaveBeenCalledTimes(3)
  })

  it('hides swap actions while a new batch is generating', async () => {
    const batch = responseFor()
    const pending = deferred<Response>()
    generationFetch.mockResolvedValueOnce(json(batch)).mockReturnValueOnce(pending.promise)
    render(<App />)
    await generate()
    await expectBatch(batch)
    expect(screen.getAllByRole('button', { name: '换一道' })).toHaveLength(3)
    fireEvent.click(panel().getByRole('button', { name: '重新生成一批' }))
    expect(screen.queryByRole('button', { name: /换一道/ })).not.toBeInTheDocument()
    await act(async () => { pending.resolve(json(responseFor({ batch: 'later' }))) })
    await waitFor(() => expect(screen.getAllByRole('button', { name: '换一道' })).toHaveLength(3))
  })
})

describe('Day 5 recommendation history', () => {
  it('excludes recent names on regeneration and clears history on demand', async () => {
    const first = responseFor()
    const second = responseFor({ batch: 'second' })
    const third = responseFor({ batch: 'third' })
    generationFetch.mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(second)).mockResolvedValueOnce(json(third))
    render(<App />)
    await generate()
    await expectBatch(first)
    expect(JSON.parse(localStorage.getItem(historyStorageKey)!)).toEqual(first.recipes.map((recipe) => recipe.name))
    await generate()
    await expectBatch(second)
    expect(generationFetch.mock.calls[1][0].excludedRecipeNames).toEqual(first.recipes.map((recipe) => recipe.name))
    expect(JSON.parse(localStorage.getItem(historyStorageKey)!)).toEqual([
      ...second.recipes.map((recipe) => recipe.name), ...first.recipes.map((recipe) => recipe.name),
    ])
    const clear = screen.getByRole('button', { name: '清除推荐历史' })
    expect(clear).toBeEnabled()
    fireEvent.click(clear)
    expect(localStorage.getItem(historyStorageKey)).toBeNull()
    expect(screen.getByRole('button', { name: '清除推荐历史' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('已清除推荐历史')
    await generate()
    await expectBatch(third)
    expect(generationFetch.mock.calls[2][0]).not.toHaveProperty('excludedRecipeNames')
  })

  it('restores a swapped-in favorite with its photo and detail after remount', async () => {
    const batch = responseFor()
    const fresh = swapResponse('mock-day5-swap-fav', '香煎豆腐煲·新')
    const photo = photoFor(54321)
    generationFetch.mockResolvedValueOnce(json(batch)).mockResolvedValueOnce(json(fresh))
    photosFetch.mockImplementation(async (body) => json({
      configured: true, photos: body.dishes.map((entry) => ({ dishId: entry.id, photo: entry.id === fresh.recipes[0].id ? photo : null })),
    }))
    const first = render(<App />)
    await generate()
    await expectBatch(batch)
    fireEvent.click(swapButton(hero()))
    await waitFor(() => expect(hero().getByRole('heading')).toHaveTextContent(fresh.recipes[0].name))
    const image = await hero().findByRole('img', { name: `${fresh.recipes[0].name}的菜品示意图，非本菜谱实际成品` })
    expect(image).toHaveAttribute('src', photo.url)
    fireEvent.click(screen.getByRole('button', { name: `收藏${fresh.recipes[0].name}` }))
    const stored = JSON.parse(localStorage.getItem(storageKey)!)
    expect(stored.saved).toEqual([fresh.recipes[0].id])
    expect(stored.generatedSnapshots[0].photo).toEqual(photo)
    first.unmount()
    window.history.replaceState(null, '', '#saved')
    render(<App />)
    expect(screen.getByRole('heading', { name: fresh.recipes[0].name })).toBeVisible()
    expect(screen.getByRole('article').querySelector('img')).toHaveAttribute('src', photo.url)
    fireEvent.click(screen.getByRole('link', { name: fresh.recipes[0].name }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(fresh.recipes[0].name))
    expect(screen.getByText(fresh.recipes[0].description)).toBeVisible()
    expect(screen.getByRole('button', { name: `取消收藏${fresh.recipes[0].name}` })).toHaveAttribute('aria-pressed', 'true')
    expect(generationFetch).toHaveBeenCalledTimes(2)
  })
})

describe('Day 5 other scenes stay unchanged', () => {
  it('keeps the eat-out flow without swap, exclusions or a cook recipe cap', async () => {
    const response = responseFor({ scene: 'eat_out' })
    response.recipes = response.recipes.map((recipe) => ({ ...recipe, cookingSteps: [], estimatedTime: null, diningCategory: '家常蛋类 / 简餐', orderingTip: '点单前确认熟度。' }))
    generationFetch.mockResolvedValue(json(response))
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    expect(screen.queryByRole('button', { name: /换一道/ })).not.toBeInTheDocument()
    expect(screen.queryByText('更多条件')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '15 分钟快手' })).not.toBeInTheDocument()
    await generate()
    await expectBatch(response)
    expect(generationFetch.mock.calls[0][0].scene).toBe('eat_out')
    expect(generationFetch.mock.calls[0][0]).not.toHaveProperty('maxRecipes')
    expect(generationFetch.mock.calls[0][0]).not.toHaveProperty('excludedRecipeNames')
    expect(screen.queryByRole('button', { name: /换一道/ })).not.toBeInTheDocument()
    expect(panel().getByRole('button', { name: '重新生成一批' })).toBeEnabled()
  })

  it('keeps the fridge flow without swap or cook-only parameters', async () => {
    const response = responseFor({ scene: 'fridge' })
    generationFetch.mockResolvedValue(json(response))
    window.history.replaceState(null, '', '#fridge')
    render(<App />)
    fireEvent.change(screen.getByRole('textbox', { name: '添加你有的食材' }), { target: { value: '番茄、鸡蛋' } })
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    await generate()
    await expectBatch(response)
    expect(generationFetch.mock.calls[0][0].scene).toBe('fridge')
    expect(generationFetch.mock.calls[0][0]).not.toHaveProperty('maxRecipes')
    expect(generationFetch.mock.calls[0][0]).not.toHaveProperty('excludedRecipeNames')
    expect(screen.queryByRole('button', { name: /换一道/ })).not.toBeInTheDocument()
    expect(localStorage.getItem(historyStorageKey)).toBeNull()
  })
})