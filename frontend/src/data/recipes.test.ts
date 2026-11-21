import { describe, expect, it } from 'vitest'
import catalog from '../../../backend/app/data/ingredients.json'
import { ingredientId, normalizeIngredient } from './ingredients'
import { recipes } from './recipes'

const addedRecipes = recipes.slice(3)
const byName = new Map(catalog.map((item) => [item.name, item]))
const seasoningIds = new Set([
  'tomato-paste', 'mayonnaise', 'soy-sauce', 'rosemary', 'garlic', 'basil',
  'salt', 'black-pepper', 'oil', 'water', 'chili', 'vinegar', 'sugar', 'spring-onion', 'ginger',
  'sesame-oil', 'oyster-sauce', 'cooking-wine', 'chili-bean-paste', 'miso', 'sesame-paste',
  'peanut-butter', 'ketchup', 'curry-powder', 'cumin', 'sichuan-pepper', 'star-anise',
  'cinnamon', 'bay-leaf', 'white-pepper', 'cornstarch', 'butter', 'cilantro',
])
const requiredById: Record<string, string[]> = {
  'salmon-bowl': ['熟米饭', '即食三文鱼', '毛豆', '黄瓜'],
  'lemon-chicken': ['鸡胸肉', '柠檬', '迷迭香'],
  'tomato-fusilli': ['螺旋面', '番茄', '番茄膏', '大蒜', '罗勒'],
  'tomato-egg-stir-fry': ['番茄', '鸡蛋'],
  'shiitake-bok-choy': ['小白菜', '香菇'],
  'winter-melon-tofu-soup': ['冬瓜', '豆腐'],
  'pumpkin-millet-porridge': ['南瓜', '小米'],
  'beef-celery-stir-fry': ['牛肉', '芹菜'],
  'potato-chicken-stew': ['鸡腿肉', '土豆', '洋葱'],
  'steamed-cod-tofu': ['鳕鱼', '豆腐'],
  'shrimp-asparagus': ['虾', '芦笋'],
  'cabbage-rice-noodles': ['干米粉', '卷心菜', '胡萝卜'],
  'sour-spicy-lotus-root': ['莲藕'],
  'spinach-sesame-noodles': ['面条', '菠菜'],
  'apple-oat-milk-bowl': ['原味燕麦片', '牛奶', '苹果', '核桃仁'],
}
const newRecipeExpectations: Record<string, {
  fallback: string
  minimumMinutes: number
  allergens: string[]
}> = {
  'tomato-egg-stir-fry': { fallback: 'protein', minimumMinutes: 20, allergens: ['鸡蛋'] },
  'shiitake-bok-choy': { fallback: 'vegetable', minimumMinutes: 18, allergens: ['过敏'] },
  'winter-melon-tofu-soup': { fallback: 'soup', minimumMinutes: 25, allergens: ['大豆'] },
  'pumpkin-millet-porridge': { fallback: 'bowl', minimumMinutes: 40, allergens: ['过敏'] },
  'beef-celery-stir-fry': { fallback: 'protein', minimumMinutes: 25, allergens: ['大豆', '小麦', '芹菜'] },
  'potato-chicken-stew': { fallback: 'protein', minimumMinutes: 35, allergens: ['大豆', '小麦'] },
  'steamed-cod-tofu': { fallback: 'protein', minimumMinutes: 25, allergens: ['鱼', '大豆', '芝麻', '小麦'] },
  'shrimp-asparagus': { fallback: 'protein', minimumMinutes: 20, allergens: ['甲壳类'] },
  'cabbage-rice-noodles': { fallback: 'noodles', minimumMinutes: 30, allergens: ['大豆', '小麦'] },
  'sour-spicy-lotus-root': { fallback: 'vegetable', minimumMinutes: 20, allergens: ['谷物', '标签'] },
  'spinach-sesame-noodles': { fallback: 'noodles', minimumMinutes: 20, allergens: ['小麦', '大豆', '芝麻', '鸡蛋', '花生'] },
  'apple-oat-milk-bowl': { fallback: 'bowl', minimumMinutes: 20, allergens: ['乳', '核桃', '麸质'] },
}
const foodTerms = new Map<string, string>()
for (const item of catalog) {
  for (const term of [item.name, ...item.aliases]) foodTerms.set(term, item.id)
}
for (const [term, id] of [
  ['米粉', 'rice-noodles'], ['燕麦', 'rolled-oats'], ['蒜末', 'garlic'],
  ['蛋液', 'egg'], ['蛋清', 'egg'], ['蛋黄', 'egg'], ['鸡腿', 'chicken-thigh'],
  ['淀粉汁', 'cornstarch'], ['油', 'oil'], ['米饭', 'cooked-rice'],
]) foodTerms.set(term, id)
const foodPattern = new RegExp([...foodTerms.keys()]
  .sort((a, b) => b.length - a.length)
  .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|'), 'gu')
const action = /切|洗|拌|打散|搅|煎|炒|煮|蒸|烤|焖|倒|加入|放入|盛|装|铺|压|沥|翻|处理/
const timing = /\d+(?:[–—~～-]\d+)?\s*(?:分钟|秒)/u

function fingerprint(value: unknown) {
  const text = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  }
  return (hash >>> 0).toString(16)
}

function foodIds(text: string) {
  const normalized = text.normalize('NFKC').replace(/厘米|毫米|毫升|水分|口水/gu, '')
  return new Set([...normalized.matchAll(foodPattern)].map((match) => foodTerms.get(match[0])!))
}

function sorted(values: Iterable<string>) {
  return [...values].sort()
}

describe('150条食材目录内容质量', () => {
  it('恰好150条，保留原44条内容及顺序', () => {
    expect(catalog).toHaveLength(150)
    expect(fingerprint(catalog.slice(0, 44)))
      .toBe('870c37a5')
  })

  it('编号、规范名和所有别名归一化后均唯一且非空', () => {
    expect(new Set(catalog.map((item) => item.id)).size).toBe(150)
    const names = new Set<string>()
    for (const item of catalog) {
      expect(item.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      expect(Object.keys(item).sort()).toEqual(['aliases', 'basic', 'id', 'name', 'role'])
      for (const name of [item.name, ...item.aliases]) {
        const normalized = name.normalize('NFKC').trim()
        expect(normalized, item.id).not.toBe('')
        expect(name).toBe(normalized)
        expect(names.has(normalized), `${item.id}：${name}重复`).toBe(false)
        names.add(normalized)
        expect(normalizeIngredient(name)).toBe(item.name)
        expect(ingredientId(name)).toBe(item.id)
      }
    }
  })

  it('仅四项基础调味默认存在，不把主材归为调味料', () => {
    expect(catalog.filter((item) => item.basic).map((item) => item.id))
      .toEqual(['salt', 'black-pepper', 'oil', 'water'])
    expect(catalog.filter((item) => item.role === 'main')).toHaveLength(117)
    expect(catalog.filter((item) => item.role === 'seasoning')).toHaveLength(33)
    for (const item of catalog) {
      expect(item.role, item.name).toBe(seasoningIds.has(item.id) ? 'seasoning' : 'main')
      expect(typeof item.basic).toBe('boolean')
    }
    expect(sorted(catalog.filter((item) => item.role === 'seasoning').map((item) => item.id)))
      .toEqual(sorted(seasoningIds))
  })

  it.each([
    ['三文鱼', 'raw-salmon'], ['即食三文鱼', 'ready-salmon'],
    ['大米', 'raw-rice'], ['熟米饭', 'cooked-rice'],
    ['番茄', 'tomato'], ['番茄膏', 'tomato-paste'], ['番茄酱', 'ketchup'],
    ['玉米', 'fresh-corn'], ['玉米面', 'cornmeal'], ['玉米淀粉', 'cornstarch'],
    ['毛豆', 'edamame'], ['黄豆', 'soybean'], ['黄豆芽', 'soybean-sprout'],
    ['燕麦米', 'oat-groats'], ['燕麦片', 'rolled-oats'],
    ['干黑木耳', 'dried-wood-ear'], ['即饮豆浆', 'soy-milk'],
  ])('区分原料状态和加工形式：%s', (name, id) => {
    expect(ingredientId(name)).toBe(id)
  })

  it.each(['熟鸡腿肉', '即食虾仁', '熟鳕鱼', '熟米粉', '泡发木耳', '生豆浆', '熟糙米'])
  ('不把未经声明的熟制或泡发状态映射为现有原料：%s', (name) => {
    expect(normalizeIngredient(name)).toBeNull()
  })
})

describe('15道静态精选的结构和原内容保护', () => {
  it('恰好15道，编号与菜名唯一且主材组合不重复', () => {
    expect(recipes).toHaveLength(15)
    expect(addedRecipes).toHaveLength(12)
    expect(new Set(recipes.map((recipe) => recipe.id)).size).toBe(15)
    expect(new Set(recipes.map((recipe) => recipe.name.normalize('NFKC').trim())).size).toBe(15)
    expect(recipes.map((recipe) => recipe.id)).toEqual(Object.keys(requiredById))
    const signatures = recipes.map((recipe) => sorted(recipe.ingredients
      .filter((item) => byName.get(item.canonical)?.role === 'main')
      .map((item) => item.canonical)).join('|'))
    expect(new Set(signatures).size).toBe(15)
  })

  it('原3道菜全部内容不变，包含安全说明、图片描述和授权链接', () => {
    expect(fingerprint(recipes.slice(0, 3)))
      .toBe('c48dee8c')
  })

  it('仅原3道使用照片，保留原始摄影授权', () => {
    expect(recipes.filter((recipe) => recipe.image).map((recipe) => [recipe.id, recipe.image]))
      .toEqual([
        ['salmon-bowl', '/images/salmon-bowl.webp'],
        ['lemon-chicken', '/images/lemon-chicken.webp'],
        ['tomato-fusilli', '/images/tomato-fusilli.webp'],
      ])
    expect(recipes.slice(0, 3).map((recipe) => recipe.credit)).toEqual([
      { author: 'David Foodphototasty', sourceUrl: 'https://unsplash.com/photos/green-and-orange-vegetable-on-white-ceramic-bowl-Sekm9_nC2BM', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
      { author: 'Mark DeYoung', sourceUrl: 'https://unsplash.com/photos/cooked-dish-mjcJ0FFgdWI', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
      { author: 'Aleksandra Tanasiienko', sourceUrl: 'https://unsplash.com/photos/pasta-with-sauce-on-white-ceramic-plate-0y6eMd8vevA', license: 'Unsplash License', licenseUrl: 'https://unsplash.com/license' },
    ])
  })

  it.each(recipes)('$name：材料规范名、显示名和身份对应，主材不可伪装调味料', (recipe) => {
    expect(recipe.id).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
    expect(recipe.ingredients.length).toBeGreaterThanOrEqual(3)
    expect(new Set(recipe.ingredients.map((item) => item.canonical)).size).toBe(recipe.ingredients.length)
    expect(recipe.ingredients.filter((item) => item.role === 'required').map((item) => item.canonical))
      .toEqual(requiredById[recipe.id])
    for (const item of recipe.ingredients) {
      const entry = byName.get(item.canonical)
      expect(entry, item.canonical).toBeDefined()
      expect(entry!.name).toBe(item.canonical)
      expect([entry!.name, ...entry!.aliases]).toContain(item.name)
      expect(normalizeIngredient(item.name)).toBe(item.canonical)
      expect(item.amount.trim()).not.toBe('')
      expect(['required', 'optional', 'seasoning']).toContain(item.role)
      if (entry!.role === 'main') expect(item.role, item.name).not.toBe('seasoning')
      if (entry!.basic) expect(item.role).toBe('seasoning')
      if (addedRecipes.includes(recipe) && entry!.role === 'seasoning') expect(item.role).toBe('seasoning')
    }
    expect(recipe.ingredients.some((item) => item.role === 'required' && byName.get(item.canonical)?.role === 'main')).toBe(true)
  })

  it.each(recipes)('$name：步骤具体且有时长，口味类别和点餐信息完整', (recipe) => {
    expect(Number.isInteger(recipe.minutes)).toBe(true)
    expect(recipe.minutes).toBeGreaterThan(0)
    expect(recipe.steps.length).toBeGreaterThanOrEqual(3)
    expect(new Set(recipe.steps.map((step) => step.title)).size).toBe(recipe.steps.length)
    for (const step of recipe.steps) {
      expect(step.title.trim().length).toBeGreaterThan(2)
      expect(step.body.length).toBeGreaterThan(18)
      expect(step.body).toMatch(action)
    }
    expect(recipe.steps.map((step) => step.body).join('\n')).toMatch(timing)
    expect(recipe.tastes.length).toBeGreaterThan(0)
    expect(recipe.categories.length).toBeGreaterThan(0)
    for (const taste of recipe.tastes) expect(['清爽', '微辣', '浓郁', '酸甜', '咸鲜', '原味', '酸辣']).toContain(taste)
    for (const category of recipe.categories) expect(['蔬菜', '鸡肉', '鱼虾', '面食', '蛋奶', '菌菇']).toContain(category)
    for (const text of [recipe.name, recipe.kicker, recipe.description, recipe.difficulty, recipe.category, recipe.reason, recipe.allergens, recipe.tip]) {
      expect(text.trim()).not.toBe('')
    }
    expect(recipe.diningModes).toEqual(['cook', 'out'])
    expect(recipe.dining.category.trim()).not.toBe('')
    expect(['economy', 'balanced', 'treat']).toContain(recipe.dining.budget)
    expect(recipe.dining.orderingTip).toContain('原创相对成本估计')
    expect(recipe.dining.orderingTip).toContain('非商家报价')
    expect(recipe.dining.orderingTip).toMatch(/确认|核对/)
    expect(recipe.dining.orderingTip).not.toMatch(/https?:|[¥￥]|\d+\s*元|地址|营业时间|评分/)
  })
})

describe('新增12道菜的份量、插画与用料一致性', () => {
  it('新增菜全部有独立的内容审核预期', () => {
    expect(addedRecipes.map((recipe) => recipe.id)).toEqual(Object.keys(newRecipeExpectations))
  })

  it.each(addedRecipes)('$name：只有分类插画占位，不借用照片', (recipe) => {
    expect(recipe.image).toBe('')
    expect(recipe.imageFallbackCategory).toBe(newRecipeExpectations[recipe.id].fallback)
    expect(['vegetable', 'protein', 'bowl', 'soup', 'noodles']).toContain(recipe.imageFallbackCategory)
    expect(recipe.photoAlt).toContain('分类插画占位')
    expect(recipe.photoAlt).toContain(`非${recipe.name}实拍`)
    expect(recipe.credit).toEqual({ author: 'TasteAI 原创分类占位视觉', sourceUrl: '', license: '项目原创', licenseUrl: '' })
  })

  it.each(addedRecipes)('$name：中文1人份、定量材料和现实时间，不虚构营养或安全保证', (recipe) => {
    const expected = newRecipeExpectations[recipe.id]
    expect(recipe.description).toMatch(/1\s*人份/)
    expect(recipe.minutes).toBeGreaterThanOrEqual(expected.minimumMinutes)
    for (const item of recipe.ingredients) {
      expect(item.amount, item.name).toMatch(/^\d+(?:\.\d+)?\s*(克|毫升|个)/)
      expect(parseFloat(item.amount)).toBeGreaterThan(0)
    }
    const copy = [recipe.name, recipe.kicker, recipe.description, recipe.difficulty, recipe.category,
      recipe.reason, recipe.photoAlt, recipe.allergens, recipe.tip, recipe.dining.category, recipe.dining.orderingTip,
      ...recipe.tastes, ...recipe.categories,
      ...recipe.ingredients.flatMap((item) => [item.name, item.canonical, item.amount]),
      ...recipe.steps.flatMap((step) => [step.title, step.body])].join('\n')
    expect(copy).not.toMatch(/[a-z]/i)
    expect(copy).not.toMatch(/低卡|低脂|高蛋白|减脂|减肥|降糖|排毒|富含|保证安全|绝对安全|零风险|不会过敏|\d+\s*(千卡|大卡)/)
    for (const allergen of expected.allergens) expect(recipe.allergens).toContain(allergen)
  })

  it.each(addedRecipes)('$name：包括水油在内的全部材料都用到，步骤不暗加目录内材料', (recipe) => {
    const declared = new Set(recipe.ingredients.map((item) => byName.get(item.canonical)!.id))
    const covered = new Set<string>()
    for (const step of recipe.steps) {
      const mentioned = foodIds(`${step.title}\n${step.body}`)
      for (const id of mentioned) {
        expect(declared.has(id), `${recipe.name}的“${step.title}”未声明${id}`).toBe(true)
        covered.add(id)
      }
    }
    expect(sorted(covered)).toEqual(sorted(declared))
    const introduction = foodIds([recipe.name, recipe.description, recipe.reason].join('\n'))
    for (const id of introduction) expect(declared.has(id), `${recipe.name}的介绍未声明${id}`).toBe(true)
    expect(recipe.steps.map((step) => step.body).join('\n')).not.toMatch(/高汤|鸡精|味精|蜂蜜|奶油|培根|火腿|香肠/)
  })

  it('用最长词匹配区分近名食材，不把单位中的米或加工品中的原料重复计入', () => {
    expect(sorted(foodIds('鸡腿肉切2厘米，玉米淀粉加20毫升水，米粉另煮，芝麻油调味。')))
      .toEqual(sorted(['chicken-thigh', 'cornstarch', 'water', 'rice-noodles', 'sesame-oil']))
    expect(sorted(foodIds('卷心菜、干米粉、豆腐千张、熟米饭、黄豆芽、小米和小白菜。')))
      .toEqual(sorted(['cabbage', 'rice-noodles', 'tofu-sheet', 'cooked-rice', 'soybean-sprout', 'millet', 'bok-choy']))
    const recipe = addedRecipes.find((item) => item.id === 'tomato-egg-stir-fry')!
    const declared = new Set(recipe.ingredients.map((item) => byName.get(item.canonical)!.id))
    expect([...foodIds('加入黄油和牛奶翻炒')].filter((id) => !declared.has(id)))
      .toEqual(['butter', 'milk'])
    expect([...declared].filter((id) => !foodIds('番茄、食用油、盐和水煮熟').has(id)))
      .toEqual(['egg'])
  })

  it.each([
    ['beef-celery-stir-fry', '71 摄氏度'],
    ['potato-chicken-stew', '74 摄氏度'],
    ['steamed-cod-tofu', '63 摄氏度'],
    ['shrimp-asparagus', '63 摄氏度'],
  ])('%s：肉禽水产给出熟度判断而不只看颜色', (id, temperature) => {
    const recipe = recipes.find((item) => item.id === id)!
    const steps = recipe.steps.map((step) => step.body).join('\n')
    expect(steps).toContain('食品温度计')
    expect(steps).toContain(temperature)
    expect(steps).toMatch(/单独刀板|分开的刀板|独立刀板/)
  })

  it('慢煮菜留足时间，解冻与包装等待条件明确', () => {
    expect(recipes.find((recipe) => recipe.id === 'pumpkin-millet-porridge')!.minutes).toBeGreaterThanOrEqual(40)
    expect(recipes.find((recipe) => recipe.id === 'potato-chicken-stew')!.minutes).toBeGreaterThanOrEqual(40)
    for (const id of ['steamed-cod-tofu', 'shrimp-asparagus']) {
      expect(recipes.find((recipe) => recipe.id === id)!.tip).toMatch(/不包含.*解冻/)
    }
    expect(recipes.find((recipe) => recipe.id === 'cabbage-rice-noodles')!.tip).toContain('另预留等待时间')
    expect(recipes.find((recipe) => recipe.id === 'potato-chicken-stew')!.tip).toContain('不能承诺完全去除酒精')
  })
})
