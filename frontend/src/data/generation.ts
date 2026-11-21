import { ingredientCatalog } from './ingredients'
import type { BudgetBand, Recipe } from './recipes'

export type Scene = 'cook' | 'eat_out' | 'fridge'
export type GenerationRequest = {
  scene: Scene
  ingredientIds: string[]
  tastePreferences: string[]
  todayTaste: string | null
  preferredCategories: string[]
  timeLimit: number | null
  budgetLevel: 'any' | BudgetBand | null
  servings: number
  strictIngredients: boolean
  assumeBasics: boolean
  maxRecipes?: number
}
export type GeneratedIngredient = { ingredientId: string; name: string; amount: string; role: 'main' | 'seasoning' }
export type GeneratedDish = {
  id: string
  name: string
  description: string
  ingredients: GeneratedIngredient[]
  cookingSteps: { title: string; body: string; ingredientIds: string[] }[]
  estimatedTime: number | null
  recommendationReason: string
  missingIngredients: GeneratedIngredient[]
  imageFallbackCategory: 'vegetable' | 'protein' | 'bowl' | 'soup' | 'noodles'
  diningCategory: string | null
  orderingTip: string | null
  matchedPreferences: string[]
}
export type GenerationResponse = {
  recipes: GeneratedDish[]
  source: 'mock' | 'ai'
  model: string | null
  scene: Scene
  servings: number
  notice: string
  warnings: string[]
}
export type GeneratedSnapshot = Pick<GenerationResponse, 'source' | 'model' | 'scene' | 'servings'> & {
  recipe: GeneratedDish
}
export type EngineStatus = { mode: 'disabled' | 'mock' | 'openai_compatible'; configured: boolean; source: 'mock' | 'ai' | null; model: string | null; message: string }

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max = 2000): value is string => typeof value === 'string' && value.length <= max
const strings = (value: unknown, max = 50): value is string[] => Array.isArray(value) && value.length <= max && value.every((item) => text(item, 500))
const oneOf = (value: unknown, options: string[]): value is string => typeof value === 'string' && options.includes(value)

function validIngredient(value: unknown): value is GeneratedIngredient {
  if (!object(value)) return false
  const entry = ingredientCatalog.find((item) => item.id === value.ingredientId)
  return !!entry && value.name === entry.name && value.role === entry.role && text(value.amount, 200)
}

function validDish(value: unknown): value is GeneratedDish {
  if (!object(value)) return false
  const ingredientIds = new Set(Array.isArray(value.ingredients) ? value.ingredients.filter(validIngredient).map((item) => item.ingredientId) : [])
  return text(value.id, 100) && /^[a-zA-Z0-9_-]+$/.test(value.id) && text(value.name, 100) && value.name.trim().length > 0 &&
    text(value.description) && text(value.recommendationReason) &&
    Array.isArray(value.ingredients) && value.ingredients.length > 0 && value.ingredients.length <= 40 && value.ingredients.every(validIngredient) &&
    Array.isArray(value.missingIngredients) && value.missingIngredients.length <= 40 && value.missingIngredients.every(validIngredient) &&
    Array.isArray(value.cookingSteps) && value.cookingSteps.length <= 20 && value.cookingSteps.every((step) => object(step) && text(step.title, 100) && text(step.body) && strings(step.ingredientIds, 40) && step.ingredientIds.every((id) => ingredientIds.has(id))) &&
    (value.estimatedTime === null || (Number.isInteger(value.estimatedTime) && Number(value.estimatedTime) > 0 && Number(value.estimatedTime) <= 240)) &&
    oneOf(value.imageFallbackCategory, ['vegetable', 'protein', 'bowl', 'soup', 'noodles']) &&
    (value.diningCategory === null || text(value.diningCategory, 100)) && (value.orderingTip === null || text(value.orderingTip)) && strings(value.matchedPreferences, 20)
}

export function validSnapshot(value: unknown): value is GeneratedSnapshot {
  if (!object(value) || !validDish(value.recipe)) return false
  return oneOf(value.source, ['mock', 'ai']) && oneOf(value.scene, ['cook', 'eat_out', 'fridge']) &&
    (value.model === null || text(value.model, 200)) && Number.isInteger(value.servings) && Number(value.servings) >= 1 && Number(value.servings) <= 6 &&
    (value.scene === 'eat_out' ? value.recipe.cookingSteps.length === 0 && value.recipe.estimatedTime === null : value.recipe.cookingSteps.length >= 2 && value.recipe.estimatedTime !== null)
}

export function parseGeneration(value: unknown, maxRecipes = 5): GenerationResponse {
  if (!object(value) || !Array.isArray(value.recipes) || value.recipes.length > Math.min(maxRecipes, 5) || !text(value.notice) || !strings(value.warnings, 20) ||
    !oneOf(value.scene, ['cook', 'eat_out', 'fridge']) || !oneOf(value.source, ['mock', 'ai']) ||
    !(value.model === null || text(value.model, 200)) || !Number.isInteger(value.servings) || Number(value.servings) < 1 || Number(value.servings) > 6 ||
    !value.recipes.every((recipe) => validSnapshot({ ...value, recipe })) ||
    new Set(value.recipes.map((recipe: GeneratedDish) => recipe.id)).size !== value.recipes.length ||
    new Set(value.recipes.map((recipe: GeneratedDish) => recipe.name.normalize('NFKC').trim().toLowerCase())).size !== value.recipes.length ||
    (value.scene !== 'fridge' && value.recipes.length === 0)) throw new Error('服务返回的数据不完整，未展示该批结果，请重试。')
  return value as GenerationResponse
}

export function snapshots(response: GenerationResponse): GeneratedSnapshot[] {
  return response.recipes.map((recipe) => ({ recipe, source: response.source, model: response.model, scene: response.scene, servings: response.servings }))
}

export function toRecipe(snapshot: GeneratedSnapshot): Recipe {
  const dish = snapshot.recipe
  const isOut = snapshot.scene === 'eat_out'
  return {
    id: dish.id, name: dish.name, description: dish.description,
    kicker: snapshot.source === 'mock' ? 'Mock 演示 · 非真实 AI' : 'AI 生成 · 未经人工审核',
    minutes: dish.estimatedTime ?? 0, difficulty: '按步骤尝试', tastes: dish.matchedPreferences,
    categories: [], category: isOut ? dish.diningCategory ?? '点餐灵感' : '生成菜谱', diningModes: [isOut ? 'out' : 'cook'],
    dining: { category: dish.diningCategory ?? '菜品建议', budget: 'balanced', orderingTip: dish.orderingTip ?? '' },
    image: '', photoAlt: `${dish.name}的分类插画占位，非实物照片`, reason: dish.recommendationReason,
    ingredients: dish.ingredients.map((item) => ({ name: item.name, canonical: item.name, amount: item.amount, role: item.role === 'main' ? 'required' : 'seasoning' })),
    steps: dish.cookingSteps.map((step) => ({ title: step.title, body: step.body })),
    allergens: '生成内容未经人工审核；请自行核对食材新鲜度、用量、过敏原和充分加热要求。',
    tip: '预计时间仅供参考，请结合器具、份量和实际熟度调整；不提供营养数值或食品安全保证。',
    credit: { author: 'TasteAI 原创分类占位视觉', sourceUrl: '', license: '项目原创', licenseUrl: '' },
    generation: snapshot,
  }
}

export async function fetchEngineStatus(signal: AbortSignal): Promise<EngineStatus> {
  const response = await fetch('/api/recommendations/status', { signal })
  const value: unknown = await response.json()
  if (!response.ok || !object(value) || typeof value.configured !== 'boolean' || !oneOf(value.mode, ['disabled', 'mock', 'openai_compatible']) || !(value.source === null || oneOf(value.source, ['mock', 'ai'])) || !(value.model === null || text(value.model, 200)) || !text(value.message)) throw new Error('暂时无法连接生成服务；本地示例仍可使用。')
  return value as EngineStatus
}

export async function generateRecipes(request: GenerationRequest, signal: AbortSignal): Promise<GenerationResponse> {
  let response: Response
  try {
    response = await fetch('/api/recommendations/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal })
  } catch (error) {
    if (signal.aborted) throw error
    throw new Error('无法连接生成服务，请检查网络或后端后重试。')
  }
  let value: unknown
  try { value = await response.json() } catch { throw new Error('生成服务返回了无法读取的数据，请稍后重试。') }
  if (!response.ok) {
    const message = object(value) && object(value.detail) && text(value.detail.message) ? value.detail.message : '生成请求失败，请检查服务配置后重试。'
    throw new Error(message)
  }
  const parsed = parseGeneration(value, request.maxRecipes)
  if (parsed.scene !== request.scene || parsed.servings !== request.servings) throw new Error('返回结果与当前条件不一致，未展示该批结果。')
  return parsed
}
