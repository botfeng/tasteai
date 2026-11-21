import { kitchenBasics, normalizeIngredient } from './ingredients'
import type { Preferences } from './preferences'
import type { BudgetBand, DiningMode, Recipe } from './recipes'

export const budgetOptions: { value: 'any' | BudgetBand; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'economy', label: '经济一点' },
  { value: 'balanced', label: '日常适中' },
  { value: 'treat', label: '丰盛一点' },
]

export type PreferenceRequest = {
  mode: DiningMode
  preferences: Preferences
  taste?: string
  maxMinutes?: number
  budget?: 'any' | BudgetBand
  saved?: string[]
}

export type PreferenceRecommendation = { recipe: Recipe; score: number; reasons: string[] }

export type IngredientRequest = {
  ingredients: string[]
  assumeBasics: boolean
  preferences?: Preferences
  saved?: string[]
}

export type IngredientRecommendation = {
  recipe: Recipe
  coverage: number
  available: string[]
  missingRequired: string[]
  missingOptional: string[]
  missingSeasonings: string[]
  assumedBasics: string[]
  status: 'ready' | 'almost' | 'insufficient'
  reasons: string[]
}

function preferenceFactors(recipe: Recipe, preferences?: Preferences, saved: string[] = []) {
  const tastes = [...new Set(preferences?.tastes ?? [])]
  const categories = [...new Set(preferences?.ingredients ?? [])]
  const tasteMatches = tastes.filter((taste) => recipe.tastes.includes(taste))
  const categoryMatches = categories.filter((category) => recipe.categories.includes(category))
  const reasons: string[] = []
  let score = 0

  if (tasteMatches.length) {
    score += tasteMatches.length / tastes.length * 30
    reasons.push(`存档口味命中 ${tasteMatches.join('、')}（${tasteMatches.length}/${tastes.length}）`)
  }
  if (categoryMatches.length) {
    score += categoryMatches.length / categories.length * 20
    reasons.push(`存档食材类别命中 ${categoryMatches.join('、')}（${categoryMatches.length}/${categories.length}）`)
  }
  if (saved.includes(recipe.id)) {
    score += 5
    reasons.push('已收藏这道菜，收藏加分')
  }

  return { score, reasons, tasteMatches, categoryMatches }
}

export function recommendByPreference(catalog: Recipe[], request: PreferenceRequest): PreferenceRecommendation[] {
  const limits = [request.maxMinutes, request.preferences.maxMinutes]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
  const limit = request.mode === 'cook' && limits.length ? Math.min(...limits) : 0
  const taste = request.taste && request.taste !== '全部' ? request.taste : undefined
  const ranked: (PreferenceRecommendation & { index: number })[] = []

  catalog.forEach((recipe, index) => {
    const factors = preferenceFactors(recipe, request.preferences, request.saved)
    if (
      !recipe.diningModes.includes(request.mode) ||
      (taste && !recipe.tastes.includes(taste)) ||
      (request.preferences.tastes.length > 0 && !factors.tasteMatches.length) ||
      (request.preferences.ingredients.length > 0 && !factors.categoryMatches.length) ||
      (limit > 0 && recipe.minutes > limit)
    ) return

    let score = factors.score
    const reasons = [`适用于${request.mode === 'cook' ? '在家做饭' : '外出就餐'}`]
    if (taste) {
      score += 40
      reasons.push(`当天口味命中 ${taste}`)
    }
    reasons.push(...factors.reasons)
    if (request.mode === 'out' && request.budget && request.budget !== 'any' && recipe.dining.budget === request.budget) {
      score += 10
      const label = budgetOptions.find((option) => option.value === request.budget)!.label
      reasons.push(`相对预算档吻合「${label}」：原创成本估计，非商家报价，仅用于软排序`)
    }
    if (limit > 0) {
      score += 5 * (limit - recipe.minutes) / limit
      reasons.push(`做饭用时 ${recipe.minutes} 分钟，不超过 ${limit} 分钟限制；用时越短加分越多`)
    }
    reasons.push('同分按菜谱库顺序')
    ranked.push({ recipe, score, reasons, index })
  })

  return ranked.sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ recipe, score, reasons }) => ({ recipe, score, reasons }))
}

export function recommendByIngredients(catalog: Recipe[], request: IngredientRequest): IngredientRecommendation[] {
  const supplied = new Set(request.ingredients.map(normalizeIngredient).filter((value): value is string => value !== null))
  const ranked: (IngredientRecommendation & { preferenceScore: number; index: number })[] = []

  catalog.forEach((recipe, index) => {
    if (!recipe.diningModes.includes('cook')) return
    const all = [...new Set(recipe.ingredients.map((ingredient) => ingredient.canonical))]
    const byRole = (role: Recipe['ingredients'][number]['role']) => [...new Set(recipe.ingredients
      .filter((ingredient) => ingredient.role === role).map((ingredient) => ingredient.canonical))]
    const required = byRole('required')
    // 基础材料假设不能凭空产生候选；至少一种核心食材必须来自真实输入。
    if (!required.some((canonical) => supplied.has(canonical))) return

    const available = all.filter((canonical) => supplied.has(canonical))
    const assumedBasics = request.assumeBasics
      ? all.filter((canonical) => kitchenBasics.includes(canonical) && !supplied.has(canonical))
      : []
    const effective = new Set([...available, ...assumedBasics])
    const missingRequired = required.filter((canonical) => !effective.has(canonical))
    const missingOptional = byRole('optional').filter((canonical) => !effective.has(canonical))
    const missingSeasonings = byRole('seasoning').filter((canonical) => !effective.has(canonical))
    const coverage = (required.length - missingRequired.length) / required.length
    const status = missingRequired.length === 0 ? 'ready'
      : coverage >= 0.5 && missingRequired.length <= 2 ? 'almost' : 'insufficient'
    const factors = preferenceFactors(recipe, request.preferences, request.saved)
    const reasons = [
      `核心食材覆盖率 ${Math.round(coverage * 100)}%（${required.length - missingRequired.length}/${required.length} 种）`,
      missingRequired.length ? `核心食材仍缺：${missingRequired.join('、')}` : '主要食材齐全，仍需核对调味料、用量和安全步骤',
    ]
    if (missingSeasonings.length) reasons.push(`调味料未齐（含基础材料）：${missingSeasonings.join('、')}`)
    if (missingOptional.length) reasons.push(`可选配菜 / 点缀未备：${missingOptional.join('、')}，可省略`)
    if (assumedBasics.length) reasons.push(`假设已有本菜基础材料：${assumedBasics.join('、')}，不计入真实输入`)
    reasons.push(...factors.reasons.map((reason) => `仅在覆盖率及缺失数量相同时参与排序：${reason}`))
    reasons.push('同覆盖率先按缺少核心食材种数升序，再按缺少调味料种数升序，再按存档偏好与收藏软分降序；仍同分按菜谱库顺序')
    ranked.push({
      recipe, coverage, available, missingRequired, missingOptional, missingSeasonings, assumedBasics, status, reasons,
      preferenceScore: factors.score, index,
    })
  })

  return ranked.sort((a, b) => b.coverage - a.coverage ||
    a.missingRequired.length - b.missingRequired.length ||
    a.missingSeasonings.length - b.missingSeasonings.length ||
    b.preferenceScore - a.preferenceScore || a.index - b.index)
    .map(({ recipe, coverage, available, missingRequired, missingOptional, missingSeasonings, assumedBasics, status, reasons }) => ({
      recipe, coverage, available, missingRequired, missingOptional, missingSeasonings, assumedBasics, status, reasons,
    }))
}
