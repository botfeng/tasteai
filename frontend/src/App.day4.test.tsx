import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import catalog from '../../backend/app/data/ingredients.json'
import App from './App'
import type { DishPhoto, EngineStatus, GeneratedIngredient, GenerationRequest, GenerationResponse, Scene } from './data/generation'
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

function responseFor({ scene = 'cook', batch = 'first' }: { scene?: Scene; batch?: string } = {}): GenerationResponse {
  return {
    source: 'mock', model: null, scene, servings: 1,
    notice: '本批次是自动化测试夹具，不会调用模型。', warnings: ['请自行核对实际食材用量。'],
    recipes: ['番茄滑蛋小锅', '番茄蛋花暖汤', '番茄蒸蛋小盅'].map((name, index) => ({
      id: `mock-day4-${batch}-${index}`,
      name: `${name}·${batch}`,
      description: `${name}的独立生成描述。`,
      ingredients: [ingredient('tomato', '200 克'), ingredient('egg', '2 个'), ingredient('salt', '少许'), ingredient('water', '150 毫升')],
      cookingSteps: [
        { title: '切配番茄并打散鸡蛋', body: '番茄洗净切块，鸡蛋打散备用。', ingredientIds: ['tomato', 'egg'] },
        { title: '加水煮至完全熟透', body: '加入水和盐，将番茄与蛋液加热至完全熟透。', ingredientIds: ['tomato', 'egg', 'water', 'salt'] },
      ],
      estimatedTime: 12 + index,
      recommendationReason: `这是第 ${index + 1} 道符合本餐口味的独立建议。`,
      missingIngredients: [],
      imageFallbackCategory: index === 1 ? 'soup' : 'bowl',
      diningCategory: null, orderingTip: null,
      matchedPreferences: ['咸鲜'],
    })),
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

function photosResponse(body: PhotoRequestBody, photos: Record<string, DishPhoto | null>, configured = true) {
  return json({ configured, photos: body.dishes.map((dish) => ({ dishId: dish.id, photo: photos[dish.id] ?? null })) })
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
  photosFetch.mockReset().mockImplementation(async (body) => photosResponse(body, {}, false))
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (url === statusUrl && (!init?.method || init.method === 'GET')) return statusFetch()
    if (url === generateUrl && init?.method === 'POST') return generationFetch(JSON.parse(String(init.body)) as GenerationRequest, init.signal)
    if (url === photosUrl && init?.method === 'POST') return photosFetch(JSON.parse(String(init.body)) as PhotoRequestBody, init.signal)
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

async function expectBatch(response: GenerationResponse) {
  for (const recipe of response.recipes) expect(await screen.findByRole('heading', { name: recipe.name })).toBeVisible()
  expect(panel().queryByRole('alert')).not.toBeInTheDocument()
}

function hero() {
  return within(screen.getByRole('article', { name: '今日主推菜谱' }))
}

describe('Day 4 non-blocking photo display', () => {
  it('renders recipes immediately while photo search is pending, then fills only matched dishes', async () => {
    const response = responseFor()
    const pending = deferred<Response>()
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockReturnValue(pending.promise)
    const { container } = render(<App />)
    await generate()
    await expectBatch(response)
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(1))
    expect(container.querySelectorAll('.recipe-card img, .featured-card img')).toHaveLength(0)
    expect(hero().getByText(/分类插画.*非实物照片/)).toBeVisible()
    const photo = photoFor(12345)
    await act(async () => { pending.resolve(photosResponse(photosFetch.mock.calls[0][0], { [response.recipes[0].id]: photo })) })
    const image = await hero().findByRole('img', { name: `${response.recipes[0].name}的菜品示意图，非本菜谱实际成品` })
    expect(image).toHaveAttribute('src', photo.url)
    expect(hero().getByText('菜品示意图')).toBeVisible()
    expect(container.querySelectorAll('.more-grid .recipe-card img')).toHaveLength(0)
    expect(panel().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps honest placeholders when the photo service is unconfigured or returns no match', async () => {
    const response = responseFor()
    generationFetch.mockResolvedValue(json(response))
    const { container } = render(<App />)
    await generate()
    await expectBatch(response)
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(1))
    expect(container.querySelectorAll('.recipe-card img, .featured-card img')).toHaveLength(0)
    for (const card of screen.getAllByRole('article')) expect(within(card).getByText(/分类插画.*非实物照片/)).toBeVisible()
    expect(screen.queryByText('菜品示意图')).not.toBeInTheDocument()
  })

  it.each(['network', 'http-503', 'invalid-json'] as const)('keeps recommendations and placeholders after a %s photo failure', async (failure) => {
    const response = responseFor()
    generationFetch.mockResolvedValue(json(response))
    if (failure === 'network') photosFetch.mockRejectedValue(new TypeError('photo service offline'))
    if (failure === 'http-503') photosFetch.mockResolvedValue(json({ detail: { code: 'x', message: 'y' } }, 503))
    if (failure === 'invalid-json') photosFetch.mockResolvedValue(new Response('{broken'))
    const { container } = render(<App />)
    await generate()
    await expectBatch(response)
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(1))
    expect(container.querySelectorAll('.recipe-card img, .featured-card img')).toHaveLength(0)
    expect(panel().queryByRole('alert')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: `收藏${response.recipes[0].name}` }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).saved).toEqual([response.recipes[0].id])
  })

  it('falls back to the category placeholder when a matched image fails to load', async () => {
    const response = responseFor()
    const photo = photoFor(12345)
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockImplementation(async (body) => photosResponse(body, { [response.recipes[0].id]: photo }))
    render(<App />)
    await generate()
    await expectBatch(response)
    const image = await hero().findByRole('img', { name: /菜品示意图，非本菜谱实际成品/ })
    fireEvent.error(image)
    expect(hero().getByText(/分类插画.*非实物照片/)).toBeVisible()
    expect(hero().queryByText('菜品示意图')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: response.recipes[0].name })).toBeVisible()
  })

  it('shows the same photo and full Openverse attribution on the detail page', async () => {
    const response = responseFor()
    const photo = photoFor(12345)
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockImplementation(async (body) => photosResponse(body, { [response.recipes[0].id]: photo }))
    render(<App />)
    await generate()
    await expectBatch(response)
    await hero().findByRole('img', { name: /菜品示意图/ })
    navigate(`#recipe/${response.recipes[0].id}`)
    const main = within(screen.getByRole('main'))
    expect(main.getByRole('img', { name: `${response.recipes[0].name}的菜品示意图，非本菜谱实际成品` })).toHaveAttribute('src', photo.url)
    expect(main.getByText('菜品示意图')).toBeVisible()
    expect(main.getByRole('link', { name: photo.photographer })).toHaveAttribute('href', photo.photographerUrl)
    expect(main.getByRole('link', { name: '原始图片页' })).toHaveAttribute('href', photo.pageUrl)
    expect(main.getByRole('link', { name: 'CC BY 4.0' })).toHaveAttribute('href', photo.licenseUrl)
    expect(main.getByText(/照片是按菜名与食材匹配到的菜品示意图，不是本菜谱的实际成品/)).toBeVisible()
  })

  it('credits matched photos in the footer without claiming they are the actual finished dish', async () => {
    const response = responseFor()
    const photo = photoFor(12345)
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockImplementation(async (body) => photosResponse(body, { [response.recipes[0].id]: photo }))
    render(<App />)
    await generate()
    await expectBatch(response)
    await hero().findByRole('img', { name: /菜品示意图/ })
    const footer = within(screen.getByRole('contentinfo'))
    fireEvent.click(footer.getByText('摄影与素材来源'))
    expect(footer.getByText(`${response.recipes[0].name}（菜品示意图）：`)).toBeVisible()
    expect(footer.getByRole('link', { name: `${photo.photographer}（Openverse）` })).toHaveAttribute('href', photo.pageUrl)
    expect(footer.getByRole('link', { name: 'CC BY 4.0' })).toHaveAttribute('href', photo.licenseUrl)
    expect(footer.getByRole('link', { name: 'Openverse' })).toHaveAttribute('href', 'https://openverse.org')
    expect(footer.getByText(/不是对应菜谱的实际成品照片/)).toBeVisible()
    expect(footer.queryByText(`${response.recipes[1].name}（菜品示意图）：`)).not.toBeInTheDocument()
  })
})

describe('Day 4 favorites and photo persistence', () => {
  it('saves photo metadata with the favorite and restores the image after remount', async () => {
    const response = responseFor()
    const photo = photoFor(12345)
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockImplementation(async (body) => photosResponse(body, { [response.recipes[0].id]: photo }))
    const first = render(<App />)
    await generate()
    await expectBatch(response)
    await hero().findByRole('img', { name: /菜品示意图/ })
    fireEvent.click(screen.getByRole('button', { name: `收藏${response.recipes[0].name}` }))
    const stored = JSON.parse(localStorage.getItem(storageKey)!)
    expect(stored.saved).toEqual([response.recipes[0].id])
    expect(stored.generatedSnapshots[0].photo).toEqual(photo)
    first.unmount()
    window.history.replaceState(null, '', '#saved')
    render(<App />)
    expect(screen.getByRole('heading', { name: response.recipes[0].name })).toBeVisible()
    expect(screen.getByRole('article').querySelector('img')).toHaveAttribute('src', photo.url)
    fireEvent.click(screen.getByRole('link', { name: response.recipes[0].name }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(response.recipes[0].name))
    expect(within(screen.getByRole('main')).getByRole('img', { name: /菜品示意图/ })).toHaveAttribute('src', photo.url)
    expect(generationFetch).toHaveBeenCalledTimes(1)
    expect(photosFetch).toHaveBeenCalledTimes(1)
  })

  it('syncs a late-arriving photo into an already saved favorite', async () => {
    const response = responseFor()
    const photo = photoFor(12345)
    const pending = deferred<Response>()
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockReturnValue(pending.promise)
    const first = render(<App />)
    await generate()
    await expectBatch(response)
    fireEvent.click(screen.getByRole('button', { name: `收藏${response.recipes[0].name}` }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).generatedSnapshots[0].photo).toBeUndefined()
    await act(async () => { pending.resolve(photosResponse(photosFetch.mock.calls[0][0], { [response.recipes[0].id]: photo })) })
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey)!).generatedSnapshots[0].photo).toEqual(photo))
    first.unmount()
    window.history.replaceState(null, '', '#saved')
    render(<App />)
    expect(screen.getByRole('article').querySelector('img')).toHaveAttribute('src', photo.url)
  })

  it('keeps old favorites without photo metadata fully usable', async () => {
    const response = responseFor()
    const snapshot = { recipe: response.recipes[0], source: 'mock', model: null, scene: 'cook', servings: 1 }
    localStorage.setItem(storageKey, JSON.stringify({ preferences: emptyPreferences(), saved: [snapshot.recipe.id], generatedSnapshots: [snapshot] }))
    window.history.replaceState(null, '', '#saved')
    render(<App />)
    expect(screen.getByRole('heading', { name: snapshot.recipe.name })).toBeVisible()
    expect(screen.getByRole('article').querySelector('img')).toBeNull()
    expect(within(screen.getByRole('article')).getByText(/分类插画.*非实物照片/)).toBeVisible()
    navigate(`#recipe/${snapshot.recipe.id}`)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(snapshot.recipe.name)
    expect(screen.getByRole('main').querySelector('img')).toBeNull()
    expect(screen.getByRole('button', { name: `取消收藏${snapshot.recipe.name}` })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: `取消收藏${snapshot.recipe.name}` }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).generatedSnapshots).toEqual([])
    expect(photosFetch).not.toHaveBeenCalled()
  })
})

describe('Day 4 isolation, dedup and request hygiene', () => {
  it('never cross-applies photos between dishes or from a stale batch', async () => {
    const first = responseFor({ batch: 'stale' })
    const second = responseFor({ batch: 'current' })
    const stalePhoto = photoFor(11111)
    const currentPhoto = photoFor(22222)
    const pending = deferred<Response>()
    generationFetch.mockResolvedValueOnce(json(first)).mockResolvedValueOnce(json(second))
    photosFetch.mockReturnValueOnce(pending.promise).mockImplementationOnce(async (body) => photosResponse(body, { [second.recipes[0].id]: currentPhoto }))
    const { container } = render(<App />)
    await generate()
    await expectBatch(first)
    await generate()
    await expectBatch(second)
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(2))
    await act(async () => { pending.resolve(photosResponse(photosFetch.mock.calls[0][0], { [first.recipes[0].id]: stalePhoto })) })
    const image = await hero().findByRole('img', { name: `${second.recipes[0].name}的菜品示意图，非本菜谱实际成品` })
    expect(image).toHaveAttribute('src', currentPhoto.url)
    expect(container.querySelector(`img[src="${stalePhoto.url}"]`)).toBeNull()
    expect(container.querySelectorAll('.more-grid .recipe-card img')).toHaveLength(0)
    for (const dish of first.recipes) expect(screen.queryByRole('heading', { name: dish.name })).not.toBeInTheDocument()
  })

  it('does not refetch photos when browsing candidates locally, only on regeneration', async () => {
    const response = responseFor()
    response.recipes.push(...response.recipes.slice(0, 2).map((recipe, index) => ({ ...recipe, id: `extra-${index}`, name: `${recipe.name}第二组` })))
    generationFetch.mockImplementation(async () => json(response))
    render(<App />)
    await generate()
    await screen.findByRole('heading', { name: response.recipes[0].name })
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '浏览本次候选' }))
    fireEvent.click(screen.getByRole('button', { name: '浏览本次候选' }))
    expect(photosFetch).toHaveBeenCalledTimes(1)
    await generate()
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(2))
    expect(generationFetch).toHaveBeenCalledTimes(2)
  })

  it('fills fridge generated cards with matched photos without changing the layout', async () => {
    const response = responseFor({ scene: 'fridge' })
    const photo = photoFor(12345)
    generationFetch.mockResolvedValue(json(response))
    photosFetch.mockImplementation(async (body) => photosResponse(body, { [response.recipes[0].id]: photo }))
    window.history.replaceState(null, '', '#fridge')
    const { container } = render(<App />)
    add('番茄、鸡蛋')
    await generate()
    await expectBatch(response)
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(1))
    expect(photosFetch.mock.calls[0][0].dishes.every((dish) => dish.scene === 'fridge')).toBe(true)
    const cards = container.querySelectorAll('.recipe-card')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    await waitFor(() => expect(cards[0].querySelector('img')).toHaveAttribute('src', photo.url))
    expect(within(cards[0] as HTMLElement).getByText('菜品示意图')).toBeVisible()
  })

  it('sends only structured dish data, never an API key or authorization header', async () => {
    const response = responseFor()
    generationFetch.mockResolvedValue(json(response))
    render(<App />)
    await generate()
    await expectBatch(response)
    await waitFor(() => expect(photosFetch).toHaveBeenCalledTimes(1))
    const expected = { dishes: response.recipes.map((dish) => ({
      id: dish.id, name: dish.name, scene: 'cook',
      ingredientIds: dish.ingredients.map((item) => item.ingredientId), diningCategory: null,
    })) }
    expect(photosFetch.mock.calls[0][0]).toEqual(expected)
    expect(fetchMock).toHaveBeenCalledWith(photosUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(expected), signal: expect.any(AbortSignal),
    })
    expect(JSON.stringify(expected)).not.toMatch(/key|authorization|token/i)
  })
})