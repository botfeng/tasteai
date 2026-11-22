import { beforeEach, describe, expect, it, vi } from 'vitest'
import catalog from '../../../backend/app/data/ingredients.json'
import { attachPhoto, matchDishPhotos } from './photos'
import type { DishPhoto, GeneratedDish, GeneratedIngredient, GeneratedSnapshot } from './generation'

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

const photo: DishPhoto = {
  url: 'https://api.openverse.org/v1/images/0e1c4e2a-0000-4000-8000-000000000001/thumb/',
  alt: 'Stir fried tomato and egg',
  photographer: 'Test Photographer',
  photographerUrl: 'https://www.flickr.com/people/test-photographer/',
  pageUrl: 'https://www.flickr.com/photos/test-photographer/12345/',
  width: 1200, height: 800, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', source: 'openverse',
}

function dish(id: string, name = '番茄炒蛋'): GeneratedDish {
  const entry = (key: string): GeneratedIngredient => {
    const item = catalog.find((candidate) => candidate.id === key)
    if (!item || (item.role !== 'main' && item.role !== 'seasoning')) throw new Error(`Invalid fixture ingredient: ${key}`)
    return { ingredientId: item.id, name: item.name, amount: '适量', role: item.role }
  }
  return {
    id, name, description: `${name}的测试描述。`,
    ingredients: [entry('tomato'), entry('egg'), entry('salt')],
    cookingSteps: [{ title: '炒熟', body: '将番茄与鸡蛋充分加热炒熟。', ingredientIds: ['tomato', 'egg', 'salt'] }],
    estimatedTime: 12, recommendationReason: '测试推荐理由。', missingIngredients: [],
    imageFallbackCategory: 'bowl', diningCategory: null, orderingTip: null, matchedPreferences: ['咸鲜'],
  }
}

function snapshot(id: string): GeneratedSnapshot {
  return { recipe: dish(id), source: 'mock', model: null, scene: 'cook', servings: 1 }
}

describe('attachPhoto', () => {
  it('returns the same snapshot when no photo is pending for it', () => {
    const original = snapshot('dish-a')
    expect(attachPhoto(original, {})).toBe(original)
    expect(attachPhoto(original, { 'dish-b': photo })).toBe(original)
  })

  it('attaches only the photo keyed by the dish id', () => {
    const original = snapshot('dish-a')
    const enriched = attachPhoto(original, { 'dish-a': photo, 'dish-b': { ...photo, url: 'https://api.openverse.org/v1/images/0e1c4e2a-0000-4000-8000-000000000999/thumb/' } })
    expect(enriched.photo).toEqual(photo)
    expect(enriched.recipe).toBe(original.recipe)
    expect(original.photo).toBeUndefined()
  })
})

describe('matchDishPhotos', () => {
  it('posts the structured dish list with scene and signal, then maps valid results', async () => {
    const dishes = [dish('dish-a'), dish('dish-b', '番茄蛋花汤')]
    fetchMock.mockResolvedValue(json({ configured: true, photos: [{ dishId: 'dish-a', photo }, { dishId: 'dish-b', photo: null }] }))
    const controller = new AbortController()
    const found = await matchDishPhotos(dishes, 'cook', controller.signal)
    expect(found).toEqual({ 'dish-a': photo })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/photos/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dishes: dishes.map((item) => ({
        id: item.id, name: item.name, scene: 'cook',
        ingredientIds: item.ingredients.map((ingredient) => ingredient.ingredientId),
        diningCategory: item.diningCategory,
      })) }),
      signal: controller.signal,
    })
  })

  it('skips the request entirely for an empty dish list', async () => {
    await expect(matchDishPhotos([], 'cook', new AbortController().signal)).resolves.toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores unknown dish ids, null photos and unsafe photo metadata', async () => {
    fetchMock.mockResolvedValue(json({ configured: true, photos: [
      { dishId: 'dish-a', photo: { ...photo, url: 'https://evil.example/x.jpeg' } },
      { dishId: 'dish-b', photo: null },
      { dishId: 'not-requested', photo },
      null,
      { dishId: 'dish-a', photo: { ...photo, source: 'scraper' } },
    ] }))
    await expect(matchDishPhotos([dish('dish-a'), dish('dish-b')], 'cook', new AbortController().signal)).resolves.toEqual({})
  })

  it.each([
    { label: 'network failure', respond: () => Promise.reject(new TypeError('offline')) },
    { label: 'abort', respond: () => Promise.reject(new DOMException('Aborted', 'AbortError')) },
    { label: 'http 503', respond: () => Promise.resolve(json({ detail: { code: 'x', message: 'y' } }, 503)) },
    { label: 'invalid json', respond: () => Promise.resolve(new Response('{broken')) },
    { label: 'missing photos array', respond: () => Promise.resolve(json({ configured: true })) },
    { label: 'null body', respond: () => Promise.resolve(json(null)) },
  ])('resolves to an empty map on $label so placeholders stay', async ({ respond }) => {
    fetchMock.mockImplementation(respond)
    await expect(matchDishPhotos([dish('dish-a')], 'cook', new AbortController().signal)).resolves.toEqual({})
  })
})