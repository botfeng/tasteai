import { describe, expect, it } from 'vitest'
import { kitchenBasics } from './ingredients'
import type { Preferences } from './preferences'
import { recipes as fullCatalog } from './recipes'
import type { BudgetBand, Recipe } from './recipes'
import { budgetOptions, recommendByIngredients, recommendByPreference } from './recommendations'
import type { IngredientRequest, PreferenceRequest } from './recommendations'

const recipes = fullCatalog.slice(0, 3)
const prefs = (overrides: Partial<Preferences> = {}): Preferences => ({ tastes: [], ingredients: [], maxMinutes: 0, configured: false, ...overrides })
const ingredient = (canonical: string, role: Recipe['ingredients'][number]['role'] = 'required'): Recipe['ingredients'][number] => ({ name: canonical, amount: '适量', canonical, role })
const dish = (id: string, overrides: Partial<Recipe> = {}): Recipe => ({ ...recipes[0], id, tastes: [], categories: [], ingredients: [ingredient('番茄')], ...overrides })
const ids = (results: { recipe: Recipe }[]) => results.map((result) => result.recipe.id)
const core = (recipe: Recipe) => recipe.ingredients.filter((item) => item.role === 'required').map((item) => item.canonical)
const [salmon, chicken, pasta] = recipes
const pantry = (ingredients: string[], overrides: Partial<IngredientRequest> = {}): IngredientRequest => ({ ingredients, assumeBasics: true, ...overrides })

function deepFreeze(value: object) {
  Object.freeze(value)
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') deepFreeze(child)
  }
}

describe('preference recommendations: hard constraints', () => {
  it.each(['cook', 'out'] as const)('keeps the original three-card order with default %s settings and zero scores', (mode) => {
    const result = recommendByPreference(recipes, { mode, preferences: prefs() })
    expect(ids(result)).toEqual(recipes.map((recipe) => recipe.id))
    expect(result.map((item) => item.score)).toEqual([0, 0, 0])
    expect(result.every((item) => item.reasons.includes('同分按菜谱库顺序'))).toBe(true)
  })

  it.each(['cook', 'out'] as const)('strictly filters diningModes for %s', (mode) => {
    const catalog = [dish('cook-only', { diningModes: ['cook'] }), dish('out-only', { diningModes: ['out'] }), dish('both'), dish('neither', { diningModes: [] })]
    expect(ids(recommendByPreference(catalog, { mode, preferences: prefs() }))).toEqual([`${mode}-only`, 'both'])
  })

  it('uses the current taste as an exact hard filter', () => {
    expect(ids(recommendByPreference(recipes, { mode: 'cook', preferences: prefs(), taste: '清爽' }))).toEqual([salmon.id, chicken.id])
    expect(recommendByPreference(recipes, { mode: 'cook', preferences: prefs(), taste: '清' })).toEqual([])
  })

  it.each([undefined, '', '全部'])('treats current taste %j as unrestricted without a taste bonus', (taste) => {
    const result = recommendByPreference(recipes, { mode: 'cook', preferences: prefs(), taste })
    expect(ids(result)).toEqual(recipes.map((recipe) => recipe.id))
    expect(result.map((item) => item.score)).toEqual([0, 0, 0])
    expect(result.every((item) => !item.reasons.some((reason) => reason.includes('当天口味')))).toBe(true)
  })

  it('accepts any archived taste, but does not relax the archive when current taste is all', () => {
    expect(ids(recommendByPreference(recipes, { mode: 'cook', preferences: prefs({ tastes: ['原味', '酸甜'] }), taste: '全部' }))).toEqual([salmon.id, pasta.id])
    expect(recommendByPreference(recipes, { mode: 'cook', preferences: prefs({ tastes: ['微辣'] }), taste: '全部' })).toEqual([])
  })

  it('accepts any archived ingredient category, not ingredient names or display categories', () => {
    expect(ids(recommendByPreference(recipes, { mode: 'out', preferences: prefs({ ingredients: ['鱼虾', '面食'] }) }))).toEqual([salmon.id, pasta.id])
    expect(recommendByPreference(recipes, { mode: 'out', preferences: prefs({ ingredients: ['番茄'] }) })).toEqual([])
    expect(recommendByPreference([salmon], { mode: 'out', preferences: prefs({ ingredients: [salmon.category] }) })).toEqual([])
  })

  it('combines current taste, archived taste, category and time using AND', () => {
    const request: PreferenceRequest = { mode: 'cook', taste: '清爽', maxMinutes: 30, preferences: prefs({ tastes: ['咸鲜', '原味'], ingredients: ['鸡肉', '面食'], maxMinutes: 30 }) }
    expect(ids(recommendByPreference(recipes, request))).toEqual([chicken.id])
    expect(recommendByPreference(recipes, { ...request, maxMinutes: 15 })).toEqual([])
    expect(recommendByPreference(recipes, { ...request, taste: '酸甜' })).toEqual([])
  })

  it('does not use favorites or budget matches to override hard filters', () => {
    const result = recommendByPreference(recipes, { mode: 'out', preferences: prefs({ tastes: ['微辣'], ingredients: ['菌菇'] }), budget: 'treat', saved: recipes.map((recipe) => recipe.id) })
    expect(result).toEqual([])
  })

  it.each([
    [undefined, 0, ['salmon-bowl', 'lemon-chicken', 'tomato-fusilli']],
    [0, 0, ['salmon-bowl', 'lemon-chicken', 'tomato-fusilli']],
    [undefined, 15, ['salmon-bowl']],
    [0, 15, ['salmon-bowl']],
    [30, 15, ['salmon-bowl']],
    [15, 30, ['salmon-bowl']],
    [25, 30, ['salmon-bowl', 'tomato-fusilli']],
    [30, 25, ['salmon-bowl', 'tomato-fusilli']],
    [30, 0, ['salmon-bowl', 'tomato-fusilli', 'lemon-chicken']],
    [0, 30, ['salmon-bowl', 'tomato-fusilli', 'lemon-chicken']],
    [14, 30, []],
  ] as const)('uses the smaller nonzero cook limit: current %s, archive %s', (maxMinutes, storedMinutes, expected) => {
    expect(ids(recommendByPreference(recipes, { mode: 'cook', maxMinutes, preferences: prefs({ maxMinutes: storedMinutes }) }))).toEqual(expected)
  })

  it('includes a recipe at the exact time boundary, with zero time bonus', () => {
    const result = recommendByPreference([chicken], { mode: 'cook', maxMinutes: 30, preferences: prefs() })
    expect(result).toHaveLength(1)
    expect(result[0].score).toBe(0)
    expect(result[0].reasons.join('')).toContain('不超过 30 分钟限制')
  })

  it('rejects a recipe just beyond the cook limit', () => {
    expect(recommendByPreference([dish('over', { minutes: 30.01 })], { mode: 'cook', maxMinutes: 30, preferences: prefs() })).toEqual([])
  })

  it('ignores both time limits and all time bonuses when eating out', () => {
    const result = recommendByPreference(recipes, { mode: 'out', maxMinutes: 1, preferences: prefs({ maxMinutes: 1 }) })
    expect(ids(result)).toEqual(recipes.map((recipe) => recipe.id))
    expect(result.map((item) => item.score)).toEqual([0, 0, 0])
    expect(result.every((item) => !item.reasons.join('').includes('分钟'))).toBe(true)
  })
})

describe('preference recommendations: exact scores and truthful explanations', () => {
  it('exposes the agreed relative-budget labels', () => {
    expect(budgetOptions).toEqual([
      { value: 'any', label: '不限' }, { value: 'economy', label: '经济一点' },
      { value: 'balanced', label: '日常适中' }, { value: 'treat', label: '丰盛一点' },
    ])
  })

  it('adds exactly 40 for the current taste, independently of archive tastes', () => {
    const [result] = recommendByPreference([salmon], { mode: 'cook', preferences: prefs(), taste: '清爽' })
    expect(result.score).toBe(40)
    expect(result.reasons).toContain('当天口味命中 清爽')
    expect(result.reasons.join('')).not.toContain('存档口味命中')
  })

  it.each([
    [['原味'], 30], [['原味', '微辣'], 15], [['原味', '清爽', '微辣'], 20],
  ] as const)('weights the archived taste hit ratio for %j at %s', (tastes, expected) => {
    const [result] = recommendByPreference([salmon], { mode: 'cook', preferences: prefs({ tastes: [...tastes] }) })
    expect(result.score).toBeCloseTo(expected)
    expect(result.reasons.join('')).toContain('存档口味命中')
  })

  it.each([
    [['鱼虾'], 20], [['鱼虾', '面食'], 10], [['鱼虾', '蛋奶', '面食'], 40 / 3],
  ] as const)('weights the archived category hit ratio for %j at %s', (ingredients, expected) => {
    const [result] = recommendByPreference([salmon], { mode: 'cook', preferences: prefs({ ingredients: [...ingredients] }) })
    expect(result.score).toBeCloseTo(expected)
    expect(result.reasons.join('')).toContain('存档食材类别命中')
  })

  it('deduplicates archived preferences before calculating ratios', () => {
    const [result] = recommendByPreference([salmon], { mode: 'cook', preferences: prefs({ tastes: ['原味', '原味', '微辣'], ingredients: ['鱼虾', '鱼虾', '面食'] }) })
    expect(result.score).toBe(25)
    expect(result.reasons.join('')).toContain('原味（1/2）')
    expect(result.reasons.join('')).toContain('鱼虾（1/2）')
  })

  it('adds exactly 5 for a saved id, without double-counting duplicate or unknown ids', () => {
    const result = recommendByPreference(recipes, { mode: 'cook', preferences: prefs(), saved: [pasta.id, pasta.id, 'unknown'] })
    expect(ids(result)).toEqual([pasta.id, salmon.id, chicken.id])
    expect(result.map((item) => item.score)).toEqual([5, 0, 0])
    expect(result[0].reasons).toContain('已收藏这道菜，收藏加分')
    expect(result[1].reasons.join('')).not.toContain('已收藏')
  })

  it.each(['economy', 'balanced', 'treat'] as const)('adds 10 only for an exact out budget match: %s, never filters others', (budget) => {
    const result = recommendByPreference(recipes, { mode: 'out', preferences: prefs(), budget })
    expect(result).toHaveLength(3)
    expect(result[0].recipe.dining.budget).toBe(budget)
    expect(result.map((item) => item.score)).toEqual([10, 0, 0])
    expect(result[0].reasons.join('')).toContain('原创成本估计，非商家报价，仅用于软排序')
    expect(result.slice(1).every((item) => !item.reasons.join('').includes('预算档吻合'))).toBe(true)
  })

  it.each([undefined, 'any'] as const)('adds no budget bonus for %s', (budget) => {
    expect(recommendByPreference(recipes, { mode: 'out', preferences: prefs(), budget }).map((item) => item.score)).toEqual([0, 0, 0])
  })

  it('completely ignores relative budget during cook recommendations', () => {
    const result = recommendByPreference(recipes, { mode: 'cook', preferences: prefs(), budget: 'economy' })
    expect(result.map((item) => item.score)).toEqual([0, 0, 0])
    expect(result.every((item) => !item.reasons.join('').includes('预算'))).toBe(true)
  })

  it('computes the cook time bonus from the effective smaller limit, without rounding', () => {
    const [result] = recommendByPreference([salmon], { mode: 'cook', preferences: prefs({ maxMinutes: 25 }), maxMinutes: 30 })
    expect(result.score).toBe(5 * (25 - 15) / 25)
    expect(result.reasons.join('')).toContain('25 分钟限制')
  })

  it.each(['cook', 'out'] as const)('adds all applicable factors and no inapplicable ones for %s', (mode) => {
    const [result] = recommendByPreference([salmon], { mode, taste: '清爽', maxMinutes: 30, budget: 'treat', saved: [salmon.id], preferences: prefs({ tastes: ['清爽', '微辣'], ingredients: ['鱼虾', '面食'], maxMinutes: 30 }) })
    expect(result.score).toBe(40 + 15 + 10 + 5 + (mode === 'out' ? 10 : 2.5))
    const reasons = result.reasons.join('')
    for (const text of ['当天口味命中 清爽', '存档口味命中 清爽（1/2）', '存档食材类别命中 鱼虾（1/2）', '已收藏', '同分按菜谱库顺序']) expect(reasons).toContain(text)
    expect(reasons.includes('预算档吻合')).toBe(mode === 'out')
    expect(reasons.includes('30 分钟限制')).toBe(mode === 'cook')
  })

  it('does not invent taste, category, favorite, time, budget or likes reasons with defaults', () => {
    const [result] = recommendByPreference([salmon], { mode: 'cook', preferences: prefs({ configured: true }) })
    expect(result.reasons).toEqual(['适用于在家做饭', '同分按菜谱库顺序'])
    expect(Object.keys(result).sort()).toEqual(['recipe', 'score', 'reasons'].sort())
  })

  it('resolves equal scores by supplied catalog order, not id or global recipe order', () => {
    const reversed = [...recipes].reverse()
    expect(ids(recommendByPreference(reversed, { mode: 'out', preferences: prefs(), saved: reversed.map((recipe) => recipe.id) }))).toEqual(reversed.map((recipe) => recipe.id))
  })

  it('returns an empty result for an empty catalog', () => {
    expect(recommendByPreference([], { mode: 'cook', preferences: prefs() })).toEqual([])
  })
})

describe('ingredient recommendations: coverage, missing groups and status', () => {
  it.each([
    [], ['盐', '黑胡椒', '橄榄油', '水'], ['蛋黄酱', '酱油'], ['未知', '外星菜'],
    ['鸡蛋', '蘑菇', '豆腐'], ['即食海藻沙拉', '海苔', '胡萝卜', '四季豆'], ['鲜三文鱼', '生米'],
  ])('returns no candidates without a real core hit: %j', (...ingredients) => {
    expect(recommendByIngredients(recipes, pantry(ingredients))).toEqual([])
    expect(recommendByIngredients(recipes, pantry(ingredients, { assumeBasics: false }))).toEqual([])
  })

  it('returns no candidates even with every preference and favorite but no input', () => {
    expect(recommendByIngredients(recipes, pantry([], { preferences: prefs({ tastes: ['清爽'], ingredients: ['蔬菜'] }), saved: recipes.map((recipe) => recipe.id) }))).toEqual([])
  })

  it('returns no candidates for an empty catalog', () => {
    expect(recommendByIngredients([], pantry(['番茄']))).toEqual([])
  })

  it('never offers an out-only dish as something to cook from pantry ingredients', () => {
    const catalog = [dish('out-only', { diningModes: ['out'] }), dish('cook-only', { diningModes: ['cook'] })]
    expect(ids(recommendByIngredients(catalog, pantry(['番茄'])))).toEqual(['cook-only'])
  })

  it.each(recipes)('uses only unique required canonicals as the denominator for $id', (recipe) => {
    const [result] = recommendByIngredients([recipe], pantry([core(recipe)[0], '未知食材', '鸡蛋']))
    expect(result.coverage).toBe(1 / core(recipe).length)
    expect(result.available).toEqual([core(recipe)[0]])
    expect(result.missingRequired).toEqual(core(recipe).slice(1))
    expect(result.coverage).toBeGreaterThanOrEqual(0)
    expect(result.coverage).toBeLessThanOrEqual(1)
  })

  it('does not count repeated ingredients, aliases, optional ingredients, seasonings or unknowns toward core coverage', () => {
    const duplicate = { ...pasta, ingredients: [...pasta.ingredients, { ...pasta.ingredients[1], name: '西红柿' }] }
    const [result] = recommendByIngredients([duplicate], pantry(['西红柿', '番茄', '圣女果', '番茄', '水', '盐', '未知']))
    expect(result.coverage).toBe(1 / 5)
    expect(result.available).toEqual(['番茄', '盐', '水'])
    expect(result.missingRequired).toEqual(['螺旋面', '番茄膏', '大蒜', '罗勒'])
  })

  it('does not let raw fish and uncooked rice satisfy prepared salmon bowl cores', () => {
    const [result] = recommendByIngredients([salmon], pantry(['鲜三文鱼', '三文鱼', '生米', '大米', '毛豆', '黄瓜']))
    expect(result.coverage).toBe(0.5)
    expect(result.available).toEqual(['毛豆', '黄瓜'])
    expect(result.missingRequired).toEqual(['熟米饭', '即食三文鱼'])
    expect(result.status).toBe('almost')
    expect(result.reasons.join('')).toContain('核心食材仍缺：熟米饭、即食三文鱼')
  })

  it.each([
    [salmon, '即食三文鱼'], [salmon, '熟米饭'], [salmon, '毛豆'], [salmon, '黄瓜'],
    [chicken, '鸡胸肉'], [chicken, '柠檬'], [chicken, '迷迭香'],
    [pasta, '螺旋面'], [pasta, '番茄'], [pasta, '番茄膏'], [pasta, '大蒜'], [pasta, '罗勒'],
  ] as const)('never claims ready when $0.id lacks core $1', (recipe, missing) => {
    const [result] = recommendByIngredients([recipe], pantry(core(recipe).filter((canonical) => canonical !== missing)))
    expect(result.status).not.toBe('ready')
    expect(result.missingRequired).toEqual([missing])
    expect(result.reasons.join('')).toContain(`核心食材仍缺：${missing}`)
    expect(result.reasons.join('')).not.toContain('主要食材齐全')
  })

  it('does not merge tomato with tomato paste or generic herbs with rosemary', () => {
    const [tomato] = recommendByIngredients([pasta], pantry(['西红柿']))
    expect(tomato.missingRequired).toContain('番茄膏')
    const [paste] = recommendByIngredients([pasta], pantry(['番茄膏']))
    expect(paste.missingRequired).toContain('番茄')
    const [herbs] = recommendByIngredients([chicken], pantry(['鸡胸肉', '柠檬', '香草', '罗勒']))
    expect(herbs.missingRequired).toEqual(['迷迭香'])
  })

  it.each(recipes)('uses ready only for complete cores, even when seasonings or sides are missing: $id', (recipe) => {
    const [result] = recommendByIngredients([recipe], pantry(core(recipe), { assumeBasics: false }))
    expect(result.status).toBe('ready')
    expect(result.coverage).toBe(1)
    expect(result.missingRequired).toEqual([])
    expect(result.missingSeasonings.length).toBeGreaterThan(0)
    expect(result.missingOptional).toEqual(recipe.ingredients.filter((item) => item.role === 'optional').map((item) => item.canonical))
    expect(result.reasons.join('')).toContain('主要食材齐全，仍需核对调味料、用量和安全步骤')
    expect(result.reasons.join('')).toContain('调味料未齐')
    expect(result.reasons.join('')).not.toMatch(/直接可以做|马上开做/)
  })

  it.each([
    [salmon, ['熟米饭'], 0.25, 'insufficient'],
    [salmon, ['熟米饭', '黄瓜'], 0.5, 'almost'],
    [chicken, ['鸡胸肉'], 1 / 3, 'insufficient'],
    [chicken, ['鸡胸肉', '柠檬'], 2 / 3, 'almost'],
    [pasta, ['番茄', '番茄膏'], 0.4, 'insufficient'],
    [pasta, ['番茄', '番茄膏', '大蒜'], 0.6, 'almost'],
  ] as const)('assigns conservative status for $0.id with $1', (recipe, ingredients, coverage, status) => {
    const [result] = recommendByIngredients([recipe], pantry([...ingredients]))
    expect(result.coverage).toBeCloseTo(coverage)
    expect(result.status).toBe(status)
  })

  it('still marks 50% coverage insufficient when three core ingredients are missing', () => {
    const recipe = dish('six-cores', { ingredients: ['番茄', '番茄膏', '大蒜', '罗勒', '鸡胸肉', '柠檬'].map((name) => ingredient(name)) })
    const [result] = recommendByIngredients([recipe], pantry(['番茄', '番茄膏', '大蒜']))
    expect(result.coverage).toBe(0.5)
    expect(result.missingRequired).toHaveLength(3)
    expect(result.status).toBe('insufficient')
  })

  it('keeps missing optional sides distinct from missing cores and seasonings', () => {
    const [result] = recommendByIngredients([chicken], pantry(['鸡胸肉', '柠檬', '迷迭香', '胡萝卜', '食盐', '橄榄油']))
    expect(result.missingRequired).toEqual([])
    expect(result.missingOptional).toEqual(['四季豆', '西葫芦', '彩椒'])
    expect(result.missingSeasonings).toEqual([])
    expect(result.available).toEqual(['鸡胸肉', '胡萝卜', '柠檬', '迷迭香', '食用油', '盐'])
    expect(result.assumedBasics).toEqual(['黑胡椒', '水'])
    expect(result.reasons.join('')).toContain('可选配菜 / 点缀未备：四季豆、西葫芦、彩椒，可省略')
  })
})

describe('ingredient recommendations: explicit pantry assumptions', () => {
  it('assumes only basics used by this recipe, never soy sauce or mayonnaise', () => {
    const [result] = recommendByIngredients([salmon], pantry(core(salmon)))
    expect(result.assumedBasics).toEqual(['水'])
    expect(result.available).toEqual(core(salmon))
    expect(result.missingSeasonings).toEqual(['蛋黄酱', '酱油'])
    expect(result.reasons.join('')).toContain('假设已有本菜基础材料：水，不计入真实输入')
    expect(result.reasons.join('')).toContain('调味料未齐（含基础材料）：蛋黄酱、酱油')
  })

  it.each([chicken, pasta])('checks every missing basic when assumeBasics is false: $id', (recipe) => {
    const [result] = recommendByIngredients([recipe], pantry(core(recipe), { assumeBasics: false }))
    expect([...result.missingSeasonings].sort()).toEqual([...kitchenBasics].sort())
    expect(result.assumedBasics).toEqual([])
    expect(result.available).toEqual(core(recipe))
    expect(result.reasons.join('')).not.toContain('假设已有')
  })

  it('checks non-basic condiments with and without assumptions', () => {
    for (const assumeBasics of [true, false]) {
      const [result] = recommendByIngredients([salmon], pantry(core(salmon), { assumeBasics }))
      expect(result.missingSeasonings).toEqual(assumeBasics ? ['蛋黄酱', '酱油'] : ['蛋黄酱', '酱油', '水'])
    }
  })

  it('lists real seasoning and optional inputs in available, never double-lists assumptions', () => {
    const [result] = recommendByIngredients([salmon], pantry(['即食三文鱼', '水', '酱油', '海苔丝', '盐']))
    expect(result.available).toEqual(['即食三文鱼', '海苔', '酱油', '水'])
    expect(result.assumedBasics).toEqual([])
    expect(result.missingSeasonings).toEqual(['蛋黄酱'])
    expect(result.missingOptional).toEqual(['即食海藻沙拉'])
    expect(result.available).not.toContain('盐')
  })

  it.each(recipes)('produces no missing items or assumed basics when all ingredients are actually supplied: $id', (recipe) => {
    const [result] = recommendByIngredients([recipe], pantry(recipe.ingredients.map((item) => item.name)))
    expect(result.coverage).toBe(1)
    expect(result.status).toBe('ready')
    expect(result.missingRequired).toEqual([])
    expect(result.missingOptional).toEqual([])
    expect(result.missingSeasonings).toEqual([])
    expect(result.assumedBasics).toEqual([])
    expect(result.available).toEqual(recipe.ingredients.map((item) => item.canonical))
    expect(result.reasons.join('')).not.toContain('调味料未齐')
  })

  it('ignores recipes without required ingredients rather than dividing by zero', () => {
    const recipe = dish('no-core', { ingredients: [ingredient('水', 'seasoning'), ingredient('海苔', 'optional')] })
    expect(recommendByIngredients([recipe], pantry(['水', '海苔']))).toEqual([])
  })
})

describe('ingredient recommendations: strict lexicographic ranking', () => {
  it('ranks coverage ahead of all preferences, favorites and seasoning completeness', () => {
    const high = dish('higher', { ingredients: [ingredient('番茄'), ingredient('酱油', 'seasoning')] })
    const low = dish('lower', { tastes: ['清爽'], categories: ['蔬菜'], ingredients: [ingredient('番茄'), ingredient('大蒜')] })
    const result = recommendByIngredients([low, high], pantry(['番茄'], { preferences: prefs({ tastes: ['清爽'], ingredients: ['蔬菜'] }), saved: [low.id] }))
    expect(ids(result)).toEqual(['higher', 'lower'])
    expect(result.map((item) => item.coverage)).toEqual([1, 0.5])
  })

  it('ranks fewer missing cores before seasonings and soft scores at equal coverage', () => {
    const fewer = dish('fewer', { ingredients: [ingredient('番茄'), ingredient('大蒜'), ingredient('酱油', 'seasoning')] })
    const more = dish('more', { tastes: ['清爽'], categories: ['蔬菜'], ingredients: ['番茄', '鸡胸肉', '大蒜', '罗勒'].map((name) => ingredient(name)) })
    const result = recommendByIngredients([more, fewer], pantry(['番茄', '鸡胸肉'], { preferences: prefs({ tastes: ['清爽'], ingredients: ['蔬菜'] }), saved: [more.id] }))
    expect(result.map((item) => item.coverage)).toEqual([0.5, 0.5])
    expect(ids(result)).toEqual(['fewer', 'more'])
    expect(result.map((item) => item.missingRequired.length)).toEqual([1, 2])
  })

  it('ranks fewer missing seasonings before all preference and favorite points', () => {
    const fewer = dish('fewer', { ingredients: [ingredient('番茄'), ingredient('酱油', 'seasoning')] })
    const more = dish('more', { tastes: ['清爽'], categories: ['蔬菜'], ingredients: [ingredient('番茄'), ingredient('酱油', 'seasoning'), ingredient('蛋黄酱', 'seasoning')] })
    const result = recommendByIngredients([more, fewer], pantry(['番茄'], { preferences: prefs({ tastes: ['清爽'], ingredients: ['蔬菜'] }), saved: [more.id] }))
    expect(ids(result)).toEqual(['fewer', 'more'])
  })

  it('counts duplicate missing seasoning canonicals only once in ranking', () => {
    const one = dish('one', { ingredients: [ingredient('番茄'), ingredient('酱油', 'seasoning'), ingredient('酱油', 'seasoning')] })
    const two = dish('two', { ingredients: [ingredient('番茄'), ingredient('酱油', 'seasoning'), ingredient('蛋黄酱', 'seasoning')] })
    const result = recommendByIngredients([two, one], pantry(['番茄']))
    expect(ids(result)).toEqual(['one', 'two'])
    expect(result[0].missingSeasonings).toEqual(['酱油'])
  })

  it('lets the basics checkbox affect seasoning tie-breaks without altering coverage', () => {
    const basic = dish('basic', { ingredients: [ingredient('番茄'), ingredient('盐', 'seasoning'), ingredient('水', 'seasoning')] })
    const nonBasic = dish('non-basic', { ingredients: [ingredient('番茄'), ingredient('酱油', 'seasoning')] })
    const assumed = recommendByIngredients([nonBasic, basic], pantry(['番茄']))
    const checked = recommendByIngredients([nonBasic, basic], pantry(['番茄'], { assumeBasics: false }))
    expect(ids(assumed)).toEqual(['basic', 'non-basic'])
    expect(ids(checked)).toEqual(['non-basic', 'basic'])
    expect([...assumed, ...checked].every((item) => item.coverage === 1)).toBe(true)
  })

  it('uses exactly taste 30, category 20 and saved 5 as soft tie-breaks', () => {
    const catalog = [
      dish('zero'),
      dish('taste-half', { tastes: ['清爽'] }),
      dish('category-full', { categories: ['蔬菜', '鸡肉'] }),
      dish('taste-full', { tastes: ['清爽', '咸鲜'] }),
      dish('saved'),
      dish('taste-half-saved', { tastes: ['清爽'] }),
      dish('both-half', { tastes: ['清爽'], categories: ['蔬菜'] }),
    ]
    const result = recommendByIngredients(catalog, pantry(['番茄'], { preferences: prefs({ tastes: ['清爽', '咸鲜'], ingredients: ['蔬菜', '鸡肉'] }), saved: ['saved', 'taste-half-saved', 'saved'] }))
    // Scores: 0, 15, 20, 30, 5, 20, 25. The 20-point tie must retain input order.
    expect(ids(result)).toEqual(['taste-full', 'both-half', 'category-full', 'taste-half-saved', 'taste-half', 'saved', 'zero'])
    expect(result.find((item) => item.recipe.id === 'both-half')?.reasons.join('')).toContain('存档口味命中 清爽（1/2）')
    expect(result.find((item) => item.recipe.id === 'both-half')?.reasons.join('')).toContain('存档食材类别命中 蔬菜（1/2）')
  })

  it('uses preference hit proportions rather than hit counts for ingredient tie-breaks', () => {
    const category = dish('category', { categories: ['蔬菜'] })
    const taste = dish('taste', { tastes: ['清爽'] })
    const result = recommendByIngredients([taste, category], pantry(['番茄'], { preferences: prefs({ tastes: ['清爽', '原味', '浓郁'], ingredients: ['蔬菜'] }) }))
    expect(ids(result)).toEqual(['category', 'taste']) // 20 > 30/3
  })

  it('ignores archived time and treats archived tastes and categories as soft, never hard filters', () => {
    const result = recommendByIngredients(recipes, pantry(['熟米饭', '鸡胸肉', '番茄'], { preferences: prefs({ tastes: ['微辣'], ingredients: ['菌菇'], maxMinutes: 1 }) }))
    expect(new Set(ids(result))).toEqual(new Set(recipes.map((recipe) => recipe.id)))
    for (const item of result) expect(item.reasons.join('')).not.toMatch(/分钟|存档口味命中|存档食材类别命中|已收藏/)
  })

  it('does not consider optional missing counts, time or budget in tie-breaks', () => {
    const catalog = [
      dish('first', { minutes: 999, ingredients: [ingredient('番茄'), ingredient('海苔', 'optional')], dining: { ...salmon.dining, budget: 'treat' } }),
      dish('second', { minutes: 1, dining: { ...salmon.dining, budget: 'economy' } }),
    ]
    expect(ids(recommendByIngredients(catalog, pantry(['番茄'])))).toEqual(['first', 'second'])
  })

  it('uses input order as the final fallback and always explains the same-coverage hierarchy', () => {
    const catalog = [dish('z'), dish('a'), dish('m')]
    const result = recommendByIngredients(catalog, pantry(['番茄']))
    expect(ids(result)).toEqual(['z', 'a', 'm'])
    for (const item of result) {
      expect(item.reasons).toContain('同覆盖率先按缺少核心食材种数升序，再按缺少调味料种数升序，再按存档偏好与收藏软分降序；仍同分按菜谱库顺序')
      expect(item.reasons.join('')).not.toMatch(/存档口味命中|存档食材类别命中|已收藏/)
      expect(Object.keys(item).sort()).toEqual(['recipe', 'coverage', 'available', 'missingRequired', 'missingOptional', 'missingSeasonings', 'assumedBasics', 'status', 'reasons'].sort())
    }
  })
})

describe('pure deterministic recommendation interfaces', () => {
  it('accepts frozen inputs and returns identical results without mutations', () => {
    const catalog = structuredClone(recipes)
    const preferenceRequest: PreferenceRequest = { mode: 'out', preferences: prefs({ tastes: ['清爽'], ingredients: ['蔬菜'] }), budget: 'balanced' as BudgetBand, saved: [chicken.id] }
    const ingredientRequest = pantry(['熟米饭', '即食三文鱼', '鸡胸肉', '番茄', '盐'], { preferences: prefs({ tastes: ['清爽'] }), saved: [chicken.id] })
    const before = JSON.stringify({ catalog, preferenceRequest, ingredientRequest })
    deepFreeze(catalog)
    deepFreeze(preferenceRequest)
    deepFreeze(ingredientRequest)
    const preferenceResults = recommendByPreference(catalog, preferenceRequest)
    const ingredientResults = recommendByIngredients(catalog, ingredientRequest)
    for (let iteration = 0; iteration < 5; iteration++) {
      expect(recommendByPreference(catalog, preferenceRequest)).toEqual(preferenceResults)
      expect(recommendByIngredients(catalog, ingredientRequest)).toEqual(ingredientResults)
    }
    expect(JSON.stringify({ catalog, preferenceRequest, ingredientRequest })).toBe(before)
    expect(preferenceResults[0].recipe).toBe(catalog[1])
  })

  it('returns fresh result metadata, not shared mutable missing or explanation lists', () => {
    const request = pantry(['鸡胸肉'])
    const expected = recommendByIngredients([chicken], request)
    const mutated = recommendByIngredients([chicken], request)
    mutated[0].missingRequired.length = 0
    mutated[0].available.push('未知')
    mutated[0].reasons.length = 0
    expect(recommendByIngredients([chicken], request)).toEqual(expected)
    const preferenceRequest: PreferenceRequest = { mode: 'cook', preferences: prefs() }
    const first = recommendByPreference(recipes, preferenceRequest)
    first[0].reasons.length = 0
    expect(recommendByPreference(recipes, preferenceRequest)[0].reasons).toContain('同分按菜谱库顺序')
  })
})
