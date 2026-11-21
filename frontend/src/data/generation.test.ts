import { beforeEach, describe, expect, it, vi } from 'vitest'
import catalog from '../../../backend/app/data/ingredients.json'
import { fetchEngineStatus, generateRecipes, parseGeneration, snapshots, toRecipe, validSnapshot } from './generation'
import type { EngineStatus, GeneratedDish, GeneratedIngredient, GenerationRequest, GenerationResponse, Scene } from './generation'

const statusUrl = '/api/recommendations/status'
const generateUrl = '/api/recommendations/generate'
const readyStatus: EngineStatus = { mode: 'mock', configured: true, source: 'mock', model: null, message: '测试模式已就绪。' }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const fetchMock = vi.fn<typeof fetch>()
const statusFetch = vi.fn<() => Promise<Response>>()
const postFetch = vi.fn<() => Promise<Response>>()

beforeEach(() => {
  statusFetch.mockReset().mockImplementation(async () => json(readyStatus))
  postFetch.mockReset().mockImplementation(async () => { throw new Error('Unexpected generation POST in test') })
  fetchMock.mockReset().mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
    if (url === statusUrl && (!init?.method || init.method === 'GET')) return statusFetch()
    if (url === generateUrl && init?.method === 'POST') return postFetch()
    throw new Error(`Unexpected fetch: ${init?.method ?? 'GET'} ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
})

function ingredient(id: string, amount: string): GeneratedIngredient {
  const entry = catalog.find((item) => item.id === id)
  if (!entry || (entry.role !== 'main' && entry.role !== 'seasoning')) throw new Error(`Invalid fixture ingredient: ${id}`)
  return { ingredientId: entry.id, name: entry.name, amount, role: entry.role }
}

function responseFor(scene: Scene = 'cook'): GenerationResponse {
  return {
    source: 'mock', model: null, scene, servings: 2, notice: '自动化测试的独立菜谱。', warnings: ['请核对用量。'],
    recipes: ['菌菇豆腐清汤', '菌菇豆腐焖锅', '菌菇豆腐蒸盅'].map((name, index) => ({
      id: `mock-contract-mushroom-tofu-${index}`, name, description: `${name}，不同于内置示例。`,
      ingredients: [ingredient('mushroom', '100 克'), ingredient('tofu', '200 克'), ingredient('water', '300 毫升'), ingredient('salt', '少许')],
      cookingSteps: scene === 'eat_out' ? [] : [
        { title: '洗净并切配', body: '蘑菇洗净切片，豆腐切块。', ingredientIds: ['mushroom', 'tofu'] },
        { title: '加水煮熟', body: '加水和盐，将所有食材充分加热。', ingredientIds: ['mushroom', 'tofu', 'water', 'salt'] },
      ],
      estimatedTime: scene === 'eat_out' ? null : 18,
      recommendationReason: '适合偏好原味的这一餐。', missingIngredients: [], imageFallbackCategory: 'soup',
      diningCategory: scene === 'eat_out' ? '菌菇豆腐 / 家常菜' : null,
      orderingTip: scene === 'eat_out' ? '确认配料及酱汁后再点单。' : null,
      matchedPreferences: ['原味'],
    })),
  }
}

function requestFor(scene: Scene = 'cook'): GenerationRequest {
  return {
    scene, ingredientIds: scene === 'fridge' ? ['mushroom', 'tofu'] : [],
    tastePreferences: ['原味'], todayTaste: '咸鲜', preferredCategories: ['菌菇', '蛋奶'],
    timeLimit: scene === 'cook' ? 30 : null, budgetLevel: scene === 'eat_out' ? 'economy' : null,
    servings: 2, strictIngredients: true, assumeBasics: true,
  }
}

function withDish(response: GenerationResponse, patch: Record<string, unknown>) {
  return { ...response, recipes: [{ ...response.recipes[0], ...patch }, ...response.recipes.slice(1)] }
}

describe('Day 3 API transport', () => {
  it.each<EngineStatus>([
    readyStatus,
    { mode: 'disabled', configured: false, source: null, model: null, message: '已停用。' },
    { mode: 'openai_compatible', configured: false, source: 'ai', model: null, message: '尚未配置。' },
    { mode: 'openai_compatible', configured: true, source: 'ai', model: 'test-model-only', message: '已配置。' },
  ])('reads the $mode engine status with a cancellable GET', async (status) => {
    statusFetch.mockResolvedValue(json(status))
    const signal = new AbortController().signal
    await expect(fetchEngineStatus(signal)).resolves.toEqual(status)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(statusUrl, { signal })
    expect(postFetch).not.toHaveBeenCalled()
  })

  it.each(['cook', 'eat_out', 'fridge'] as const)('posts the exact %s request as JSON and preserves the validated DTO', async (scene) => {
    const request = requestFor(scene)
    const response = responseFor(scene)
    const signal = new AbortController().signal
    postFetch.mockResolvedValue(json(response))
    await expect(generateRecipes(request, signal)).resolves.toEqual(response)
    expect(fetchMock).toHaveBeenCalledWith(generateUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each(['cook', 'eat_out', 'fridge'] as const)('enforces requested maxRecipes for %s without padding partial results', async (scene) => {
    const response = responseFor(scene)
    response.recipes.push({ ...response.recipes[0], id: 'extra-dish', name: '额外一道菜' })
    postFetch.mockImplementation(async () => json(response))
    await expect(generateRecipes({ ...requestFor(scene), maxRecipes: 3 }, new AbortController().signal)).rejects.toThrow()
    response.recipes = response.recipes.slice(0, 2)
    response.warnings = ['已淘汰1道候选：step_ingredient_reference。']
    await expect(generateRecipes({ ...requestFor(scene), maxRecipes: 3 }, new AbortController().signal)).resolves.toEqual(response)
  })

  it('uses a backend error message without accepting the error body as a result', async () => {
    postFetch.mockResolvedValue(json({ detail: { code: 'provider_unavailable', message: '测试上游不可用，请重试。' }, recipes: responseFor().recipes }, 503))
    await expect(generateRecipes(requestFor(), new AbortController().signal)).rejects.toThrow('测试上游不可用')
  })

  it('uses a safe error when a non-success response has no valid message', async () => {
    postFetch.mockResolvedValue(json({ detail: { message: { unsafe: 'not a string' } } }, 502))
    await expect(generateRecipes(requestFor(), new AbortController().signal)).rejects.toThrow(/失败|重试/)
  })

  it.each(['network', 'invalid-json', 'abort'] as const)('rejects %s rather than manufacturing fallback generated data', async (failure) => {
    if (failure === 'network') postFetch.mockRejectedValue(new TypeError('offline'))
    if (failure === 'invalid-json') postFetch.mockResolvedValue(new Response('{invalid'))
    if (failure === 'abort') postFetch.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    const controller = new AbortController()
    if (failure === 'abort') controller.abort()
    await expect(generateRecipes(requestFor(), controller.signal)).rejects.toMatchObject({ message: expect.any(String) })
  })

  it.each(['scene', 'servings'] as const)('rejects a valid response for a different requested %s', async (field) => {
    const response = responseFor(field === 'scene' ? 'eat_out' : 'cook')
    if (field === 'servings') response.servings = 3
    postFetch.mockResolvedValue(json(response))
    await expect(generateRecipes(requestFor(), new AbortController().signal)).rejects.toThrow(/条件.*不一致/)
  })

  it.each([
    { label: 'invalid mode', value: { ...readyStatus, mode: 'other' } },
    { label: 'non-boolean configured', value: { ...readyStatus, configured: 'true' } },
    { label: 'non-string message', value: { ...readyStatus, message: null } },
    { label: 'unknown source', value: { ...readyStatus, source: 'seed' } },
    { label: 'non-string model', value: { ...readyStatus, model: { name: 'bad' } } },
    { label: 'missing source and model', value: { mode: 'mock', configured: true, message: 'test' } },
  ])('rejects a malformed status DTO: $label', async ({ value }) => {
    statusFetch.mockResolvedValue(json(value))
    await expect(fetchEngineStatus(new AbortController().signal)).rejects.toThrow()
  })
})

describe('Day 3 generated DTO validation', () => {
  it.each(['cook', 'eat_out', 'fridge'] as const)('accepts complete novel %s recipes with catalog IDs and roles', (scene) => {
    const response = responseFor(scene)
    expect(parseGeneration(response)).toEqual(response)
    for (const snapshot of snapshots(response)) expect(validSnapshot(snapshot)).toBe(true)
    for (const dish of response.recipes) {
      expect(dish.id).toMatch(/^mock-/)
      for (const item of dish.ingredients) {
        expect(catalog).toContainEqual(expect.objectContaining({ id: item.ingredientId, name: item.name, role: item.role }))
      }
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each((['cook', 'eat_out', 'fridge'] as const).flatMap((scene) => [1, 2, 3, 4, 5].map((count) => ({ scene, count }))))('accepts $count valid $scene results', ({ scene, count }) => {
    const response = responseFor(scene)
    response.recipes = Array.from({ length: count }, (_, i) => ({ ...response.recipes[i % 3], id: `partial-${i}`, name: `候选菜${i}` }))
    expect(parseGeneration(response)).toEqual(response)
  })

  it.each([0, 1, 2])('accepts an honest fridge result with only %i recipes', (count) => {
    const response = responseFor('fridge')
    response.recipes = response.recipes.slice(0, count)
    expect(parseGeneration(response)).toEqual(response)
  })

  it('preserves an AI source, model and the entire recipe snapshot without substituting a seed photo', () => {
    const response = responseFor()
    response.source = 'ai'
    response.model = 'test-model-only'
    response.recipes = response.recipes.map((dish) => ({ ...dish, id: dish.id.replace(/^mock-/, 'ai-'), missingIngredients: [ingredient('salt', '少许')] }))
    const parsed = parseGeneration(response)
    const saved = snapshots(parsed)
    expect(saved).toEqual(response.recipes.map((recipe) => ({ recipe, source: 'ai', model: response.model, scene: 'cook', servings: 2 })))
    const recipe = toRecipe(saved[0])
    expect(recipe.generation).toEqual(saved[0])
    expect(recipe.image).toBe('')
    expect(recipe.photoAlt).toMatch(/占位.*非实物照片/)
    expect(recipe.ingredients).toEqual(response.recipes[0].ingredients.map((item) => ({
      name: item.name, canonical: item.name, amount: item.amount, role: item.role === 'main' ? 'required' : 'seasoning',
    })))
  })

  it('maps eat_out snapshots to dining advice without creating cooking steps or a photo', () => {
    const snapshot = snapshots(responseFor('eat_out'))[0]
    const recipe = toRecipe(snapshot)
    expect(recipe.diningModes).toEqual(['out'])
    expect(recipe.steps).toEqual([])
    expect(recipe.dining.category).toBe(snapshot.recipe.diningCategory)
    expect(recipe.dining.orderingTip).toBe(snapshot.recipe.orderingTip)
    expect(recipe.image).toBe('')
    expect(recipe.generation?.recipe.estimatedTime).toBeNull()
  })

  const invalidEnvelopes: { label: string; change: (response: GenerationResponse) => unknown }[] = [
    { label: 'null', change: () => null },
    { label: 'array envelope', change: (value) => [value] },
    { label: 'missing recipes', change: (value) => ({ ...value, recipes: undefined }) },
    { label: 'empty cook batch', change: (value) => ({ ...value, recipes: [] }) },
    { label: 'empty eat_out batch', change: (value) => ({ ...value, scene: 'eat_out', recipes: [] }) },
    { label: 'more than five dishes', change: (value) => ({ ...value, recipes: Array.from({ length: 6 }, (_, i) => ({ ...value.recipes[0], id: `mock-too-many-${i}` })) }) },
    { label: 'duplicate IDs', change: (value) => ({ ...value, recipes: [value.recipes[0], value.recipes[0], value.recipes[2]] }) },
    { label: 'duplicate normalized names', change: (value) => ({ ...value, recipes: value.recipes.map((dish, index) => index === 1 ? { ...dish, name: ` ${value.recipes[0].name} ` } : dish) }) },
    { label: 'unknown source', change: (value) => ({ ...value, source: 'seed' }) },
    { label: 'array instead of source enum', change: (value) => ({ ...value, source: ['mock'] }) },
    { label: 'unknown scene', change: (value) => ({ ...value, scene: 'out' }) },
    { label: 'array instead of scene enum', change: (value) => ({ ...value, scene: ['cook'] }) },
    { label: 'invalid model', change: (value) => ({ ...value, model: {} }) },
    { label: 'zero servings', change: (value) => ({ ...value, servings: 0 }) },
    { label: 'too many servings', change: (value) => ({ ...value, servings: 7 }) },
    { label: 'fractional servings', change: (value) => ({ ...value, servings: 1.5 }) },
    { label: 'missing notice', change: (value) => ({ ...value, notice: undefined }) },
    { label: 'non-string warning', change: (value) => ({ ...value, warnings: [null] }) },
  ]

  it.each(invalidEnvelopes)('rejects the whole malformed response: $label', ({ change }) => {
    expect(() => parseGeneration(change(responseFor()))).toThrow()
  })

  const invalidDishes: { label: string; patch: (dish: GeneratedDish) => Record<string, unknown> }[] = [
    { label: 'unsafe recipe slug', patch: () => ({ id: '../mock-unsafe' }) },
    { label: 'blank name', patch: () => ({ name: '   ' }) },
    { label: 'missing description', patch: () => ({ description: undefined }) },
    { label: 'no ingredients', patch: () => ({ ingredients: [] }) },
    { label: 'unknown ingredient ID', patch: (dish) => ({ ingredients: [{ ...dish.ingredients[0], ingredientId: 'unknown-food' }] }) },
    { label: 'ingredient alias instead of canonical name', patch: () => ({ ingredients: [{ ingredientId: 'tomato', name: '西红柿', role: 'main', amount: '1 个' }] }) },
    { label: 'incorrect main ingredient role', patch: (dish) => ({ ingredients: [{ ...dish.ingredients[0], role: 'seasoning' }] }) },
    { label: 'incorrect seasoning role', patch: () => ({ ingredients: [{ ...ingredient('garlic', '1 瓣'), role: 'main' }] }) },
    { label: 'non-string amount', patch: (dish) => ({ ingredients: [{ ...dish.ingredients[0], amount: 200 }] }) },
    { label: 'unknown missing ingredient', patch: () => ({ missingIngredients: [{ ingredientId: 'unknown', name: '未知', role: 'main', amount: '1' }] }) },
    { label: 'only one cooking step', patch: (dish) => ({ cookingSteps: dish.cookingSteps.slice(0, 1) }) },
    { label: 'step missing its body', patch: (dish) => ({ cookingSteps: [{ ...dish.cookingSteps[0], body: undefined }, dish.cookingSteps[1]] }) },
    { label: 'unknown step ingredient ID', patch: (dish) => ({ cookingSteps: [{ ...dish.cookingSteps[0], ingredientIds: ['unknown-food'] }, dish.cookingSteps[1]] }) },
    { label: 'step ingredient not in the recipe', patch: (dish) => ({ cookingSteps: [{ ...dish.cookingSteps[0], ingredientIds: ['chicken-breast'] }, dish.cookingSteps[1]] }) },
    { label: 'null cooking time', patch: () => ({ estimatedTime: null }) },
    { label: 'non-integer cooking time', patch: () => ({ estimatedTime: 1.5 }) },
    { label: 'excessive cooking time', patch: () => ({ estimatedTime: 241 }) },
    { label: 'unknown image category', patch: () => ({ imageFallbackCategory: 'seed-photo' }) },
    { label: 'array instead of image category', patch: () => ({ imageFallbackCategory: ['soup'] }) },
    { label: 'malformed matched preferences', patch: () => ({ matchedPreferences: [null] }) },
    { label: 'missing ordering tip field', patch: () => ({ orderingTip: undefined }) },
  ]

  it.each(invalidDishes)('rejects a malformed dish both from API output and stored snapshots: $label', ({ patch }) => {
    const response = responseFor()
    const malformed = withDish(response, patch(response.recipes[0]))
    expect(() => parseGeneration(malformed)).toThrow()
    expect(validSnapshot({ recipe: malformed.recipes[0], source: response.source, model: response.model, scene: response.scene, servings: response.servings })).toBe(false)
  })

  it.each(['steps', 'time'] as const)('rejects eat_out output that contains cooking %s', (field) => {
    const response = responseFor('eat_out')
    if (field === 'steps') response.recipes[0].cookingSteps = responseFor().recipes[0].cookingSteps
    if (field === 'time') response.recipes[0].estimatedTime = 20
    expect(() => parseGeneration(response)).toThrow()
    expect(validSnapshot(snapshots(response)[0])).toBe(false)
  })
})
