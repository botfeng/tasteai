import { describe, expect, it } from 'vitest'
import { commonIngredients, kitchenBasics, normalizeIngredient, parseIngredients } from './ingredients'
import { recipes as fullCatalog } from './recipes'

const recipes = fullCatalog.slice(0, 3)

const requiredById: Record<string, string[]> = {
  'salmon-bowl': ['熟米饭', '即食三文鱼', '毛豆', '黄瓜'],
  'lemon-chicken': ['鸡胸肉', '柠檬', '迷迭香'],
  'tomato-fusilli': ['螺旋面', '番茄', '番茄膏', '大蒜', '罗勒'],
}

function recipeById(id: string) {
  return recipes.find((recipe) => recipe.id === id)!
}

describe('explicit ingredient normalization', () => {
  it.each([
    ['西红柿', '番茄'], ['圣女果', '番茄'], ['小番茄', '番茄'], ['普通番茄', '番茄'],
    ['番茄膏', '番茄膏'], ['去壳毛豆', '毛豆'], ['毛豆仁', '毛豆'], ['干螺旋面', '螺旋面'],
    ['新鲜罗勒', '罗勒'], ['鸡胸', '鸡胸肉'], ['海苔丝', '海苔'], ['蒜瓣', '大蒜'],
    ['已熟米饭', '熟米饭'], ['即食三文鱼', '即食三文鱼'], ['食盐', '盐'], ['黑胡椒粉', '黑胡椒'],
    ['橄榄油', '食用油'], ['菜籽油', '食用油'], ['花生油', '食用油'], ['玉米油', '食用油'],
    ['清水', '水'], ['饮用水', '水'], ['　盐\t', '盐'], ['⽔', '水'],
  ])('normalizes %s to %s without fuzzy matching', (input, expected) => {
    expect(normalizeIngredient(input)).toBe(expected)
  })

  it.each([
    ['三文鱼', '鲜三文鱼'], ['鲜三文鱼', '鲜三文鱼'], ['生三文鱼', '鲜三文鱼'],
    ['大米', '生米'], ['生米', '生米'], ['米', '生米'],
    ['鸡蛋', '鸡蛋'], ['蘑菇', '蘑菇'], ['香菇', '香菇'], ['马铃薯', '土豆'],
  ])('recognizes %s independently as %s even without a recipe match', (input, expected) => {
    expect(normalizeIngredient(input)).toBe(expected)
  })

  it.each(['', '  ', '未知食材', '松露酱', '番茄炒蛋', '番茄膏汁', '香草', '刺身', '刺身级三文鱼', '鸡肉', '意面', '盐、黑胡椒', '番 茄', 'constructor', '__proto__'])('keeps ambiguous or unknown %j unmatched', (input) => {
    expect(normalizeIngredient(input)).toBeNull()
  })

  it('never confuses tomato, tomato paste, raw fish or raw rice with prepared ingredients', () => {
    expect(parseIngredients('西红柿 番茄膏 鲜三文鱼 即食三文鱼 生米 熟米饭').recognized)
      .toEqual(['番茄', '番茄膏', '鲜三文鱼', '即食三文鱼', '生米', '熟米饭'])
  })

  it('exports distinct canonical common ingredients including unmatched foods', () => {
    expect(commonIngredients).toEqual(expect.arrayContaining(['番茄', '鸡蛋', '鸡胸肉', '黄瓜', '毛豆', '蘑菇', '螺旋面', '熟米饭', '柠檬', '即食三文鱼']))
    expect(new Set(commonIngredients).size).toBe(commonIngredients.length)
    for (const ingredient of commonIngredients) expect(normalizeIngredient(ingredient)).toBe(ingredient)
  })

  it('limits kitchen assumptions to exactly four canonical basics', () => {
    expect(kitchenBasics).toEqual(['盐', '黑胡椒', '食用油', '水'])
    for (const ingredient of kitchenBasics) expect(normalizeIngredient(ingredient)).toBe(ingredient)
    expect(kitchenBasics).not.toContain('蛋黄酱')
    expect(kitchenBasics).not.toContain('酱油')
  })
})

describe('ingredient text parsing', () => {
  it.each([',', '，', '、', ';', '；', '\n', '\r\n', ' ', '\t', '　', '； ,\n、'])('splits delimiter %j', (delimiter) => {
    expect(parseIngredients(`鸡胸肉${delimiter}番茄${delimiter}蘑菇`))
      .toEqual({ recognized: ['鸡胸肉', '番茄', '蘑菇'], unknown: [], duplicates: [] })
  })

  it('normalizes NFKC before splitting and preserves normalized unknown tokens', () => {
    expect(parseIngredients('　⽔，ＡＢＣ；\t番茄  ')).toEqual({ recognized: ['水', '番茄'], unknown: ['ABC'], duplicates: [] })
  })

  it('deduplicates aliases by canonical name and reports each duplicate once', () => {
    expect(parseIngredients('西红柿，番茄 圣女果;橄榄油 食用油 菜籽油 番茄膏 番茄膏'))
      .toEqual({ recognized: ['番茄', '食用油', '番茄膏'], unknown: [], duplicates: ['番茄', '食用油', '番茄膏'] })
  })

  it('keeps first-seen order independently for recognized, duplicate and unknown lists', () => {
    expect(parseIngredients('鸡蛋 番茄 外星菜 番茄 鸡蛋 蘑菇 外星菜 其他菜'))
      .toEqual({ recognized: ['鸡蛋', '番茄', '蘑菇'], unknown: ['外星菜', '其他菜'], duplicates: ['番茄', '鸡蛋'] })
  })

  it('does not claim repeated unknowns as recognized duplicates', () => {
    expect(parseIngredients('ＡＢＣ ABC ABC')).toEqual({ recognized: [], unknown: ['ABC'], duplicates: [] })
  })

  it.each(['', ' \t\n　', ',，、;； \n'])('returns empty lists for %j', (text) => {
    expect(parseIngredients(text)).toEqual({ recognized: [], unknown: [], duplicates: [] })
  })

  it('returns fresh deterministic arrays on each invocation', () => {
    const input = '番茄 西红柿 生米 水 未知'
    const expected = parseIngredients(input)
    const changed = parseIngredients(input)
    changed.recognized.push('篡改')
    changed.unknown.length = 0
    changed.duplicates.length = 0
    expect(parseIngredients(input)).toEqual(expected)
  })
})

describe('recipe data integrity and conservative core ingredients', () => {
  it('retains exactly the original recipe cards, names and order', () => {
    expect(recipes.map(({ id, name, image }) => ({ id, name, image }))).toEqual([
      { id: 'salmon-bowl', name: '三文鱼毛豆波奇碗', image: '/images/salmon-bowl.webp' },
      { id: 'lemon-chicken', name: '柠檬香草鸡排', image: '/images/lemon-chicken.webp' },
      { id: 'tomato-fusilli', name: '番茄罗勒螺旋面', image: '/images/tomato-fusilli.webp' },
    ])
  })

  it('retains the exact photography authors, sources and licensing', () => {
    expect(recipes.map((recipe) => recipe.credit)).toEqual([
      { author: 'David Foodphototasty', sourceUrl: 'https://unsplash.com/photos/green-and-orange-vegetable-on-white-ceramic-bowl-Sekm9_nC2BM', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
      { author: 'Mark DeYoung', sourceUrl: 'https://unsplash.com/photos/cooked-dish-mjcJ0FFgdWI', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
      { author: 'Aleksandra Tanasiienko', sourceUrl: 'https://unsplash.com/photos/pasta-with-sauce-on-white-ceramic-plate-0y6eMd8vevA', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
    ])
  })

  it.each(recipes)('provides complete typed metadata and recognized ingredients for $id', (recipe) => {
    expect(recipe.category.trim()).not.toBe('')
    expect(recipe.diningModes).toEqual(['cook', 'out'])
    expect(recipe.dining.category.trim()).not.toBe('')
    expect(recipe.dining.orderingTip).toContain('原创相对成本估计')
    expect(recipe.dining.orderingTip).toContain('非商家报价')
    expect(recipe.dining.orderingTip).not.toMatch(/[¥￥]|\d+\s*元|地址/)
    expect(recipe.steps).toHaveLength(4)
    expect(recipe.photoAlt.trim()).not.toBe('')
    for (const ingredient of recipe.ingredients) {
      expect(ingredient.name.trim()).not.toBe('')
      expect(ingredient.amount.trim()).not.toBe('')
      expect(['required', 'optional', 'seasoning']).toContain(ingredient.role)
      expect(normalizeIngredient(ingredient.canonical)).toBe(ingredient.canonical)
      expect(normalizeIngredient(ingredient.name)).toBe(ingredient.canonical)
    }
    expect(new Set(recipe.ingredients.map((ingredient) => ingredient.canonical)).size).toBe(recipe.ingredients.length)
    expect(recipe.ingredients.find((ingredient) => ingredient.canonical === '水')?.role).toBe('seasoning')
  })

  it.each(recipes)('requires every core ingredient, not an approximate substitute, for $id', (recipe) => {
    expect(recipe.ingredients.filter((ingredient) => ingredient.role === 'required').map((ingredient) => ingredient.canonical))
      .toEqual(requiredById[recipe.id])
  })

  it('uses original relative budget examples in ascending cost order', () => {
    expect(recipes.map((recipe) => [recipe.id, recipe.dining.budget])).toEqual([
      ['salmon-bowl', 'treat'], ['lemon-chicken', 'balanced'], ['tomato-fusilli', 'economy'],
    ])
  })

  it.each(['lemon-chicken', 'tomato-fusilli'])('splits basics and explicitly permits other cooking oils for %s', (id) => {
    const recipe = recipeById(id)
    const seasonings = recipe.ingredients.filter((ingredient) => ingredient.role === 'seasoning')
    expect(seasonings.map((ingredient) => ingredient.canonical).sort()).toEqual([...kitchenBasics].sort())
    expect(recipe.ingredients.some((ingredient) => ingredient.name === '盐、黑胡椒')).toBe(false)
    expect(seasonings.find((ingredient) => ingredient.name === '橄榄油')).toMatchObject({ canonical: '食用油', amount: '2 茶匙' })
    expect(recipe.steps.map((step) => step.body).join('')).toContain('可用其他食用油')
  })

  it('retains salmon handling, fully cooked edamame and time needed for the cooked alternative', () => {
    const recipe = recipeById('salmon-bowl')
    const steps = recipe.steps.map((step) => step.body).join('')
    for (const text of ['充分加热', '5–8 分钟', '完全熟透', '标签明确标注可直接食用', '普通鲜鱼不可直接生吃', '分开的刀板', '及时食用', '63°C', '另预留约 10 分钟']) expect(steps).toContain(text)
    expect(recipe.tip).toContain('生食鱼类存在额外食品安全风险')
    expect(recipe.ingredients.filter((ingredient) => ingredient.role === 'optional').map((ingredient) => ingredient.canonical))
      .toEqual(['即食海藻沙拉', '海苔'])
    expect(steps).toContain('即食海藻沙拉为可选配菜')
    expect(steps).toContain('海苔丝为可选点缀')
    for (const canonical of ['蛋黄酱', '酱油']) {
      expect(recipe.ingredients.find((ingredient) => ingredient.canonical === canonical)?.role).toBe('seasoning')
    }
  })

  it('makes all chicken vegetables optional in both ingredients and instructions while preserving rosemary and food safety', () => {
    const recipe = recipeById('lemon-chicken')
    expect(recipe.ingredients.filter((ingredient) => ingredient.role === 'optional').map((ingredient) => ingredient.canonical))
      .toEqual(['胡萝卜', '四季豆', '西葫芦', '彩椒'])
    const steps = recipe.steps.map((step) => step.body).join('')
    for (const text of ['均为可选配菜', '未选配菜可跳过本步', '若选四季豆', '若选胡萝卜', '若选西葫芦或彩椒', '没有配菜可直接装盘', '鸡排和迷迭香', '8–10 分钟', '74°C', '静置约 3 分钟', '不复用接触过生鸡肉的盘子']) expect(steps).toContain(text)
  })

  it('explicitly allows chopped ordinary tomatoes and retains pasta, paste, garlic and basil steps', () => {
    const recipe = recipeById('tomato-fusilli')
    const steps = recipe.steps.map((step) => step.body).join('')
    for (const text of ['可用普通番茄切块', '保留约半杯煮面水', '炒香蒜末', '加入番茄膏', '熟螺旋面翻拌约 2 分钟', '关火后加入撕碎的罗勒', '面包是摆盘配食']) expect(steps).toContain(text)
    expect(recipe.ingredients.filter((ingredient) => ingredient.role === 'optional')).toEqual([])
  })
})
