import { beforeEach, describe, expect, it } from 'vitest'
import catalog from '../../../backend/app/data/ingredients.json'
import { emptyPreferences, matchingRecipes, readDemoState, storageKey } from './preferences'
import type { GeneratedIngredient } from './generation'
import { recipes } from './recipes'

describe('transparent Demo preference matching', () => {
  it('includes every recipe for unrestricted preferences', () => {
    expect(matchingRecipes(emptyPreferences())).toEqual(recipes)
  })

  it('combines time, any selected taste and any selected ingredient', () => {
    const preferences = { tastes: ['清爽', '浓郁'], ingredients: ['蔬菜', '面食'], maxMinutes: 30, configured: true }
    const expected = recipes.filter((recipe) => recipe.minutes <= 30 && recipe.tastes.some((taste) => preferences.tastes.includes(taste)) && recipe.categories.some((ingredient) => preferences.ingredients.includes(ingredient)))
    expect(matchingRecipes(preferences)).toEqual(expected)
  })

  it('does not silently relax an unmatched selection', () => {
    expect(matchingRecipes({ tastes: ['微辣'], ingredients: ['菌菇'], maxMinutes: 15, configured: true })).toEqual([])
  })

  it('ships complete, honestly illustrated and attributed Demo recipes', () => {
    expect(new Set(recipes.map((recipe) => recipe.id)).size).toBe(recipes.length)
    for (const recipe of recipes) {
      if (recipe.imageFallbackCategory) {
        expect(recipe.image).toBe('')
        expect(recipe.credit.sourceUrl).toBe('')
        expect(recipe.credit.licenseUrl).toBe('')
        expect(recipe.credit.license).toBe('项目原创')
      } else {
        expect(recipe.image).toMatch(/^\/images\/.*\.webp$/)
        expect(recipe.credit.sourceUrl).toMatch(/^https:\/\//)
        expect(recipe.credit.licenseUrl).toMatch(/^https:\/\//)
      }
      expect(recipe.credit.author.length).toBeGreaterThan(0)
      expect(recipe.ingredients.length).toBeGreaterThanOrEqual(3)
      expect(recipe.ingredients.some((item) => item.role === 'required')).toBe(true)
      expect(recipe.steps.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('stored snapshot photo compatibility', () => {
  beforeEach(() => localStorage.clear())

  const entry = (key: string): GeneratedIngredient => {
    const item = catalog.find((candidate) => candidate.id === key)
    if (!item || (item.role !== 'main' && item.role !== 'seasoning')) throw new Error(`Invalid fixture ingredient: ${key}`)
    return { ingredientId: item.id, name: item.name, amount: '适量', role: item.role }
  }
  const snapshot = {
    recipe: {
      id: 'stored-dish', name: '番茄炒蛋', description: 'stored 的描述。',
      ingredients: [entry('tomato'), entry('egg'), entry('salt')],
      cookingSteps: [{ title: '炒熟', body: '将番茄与鸡蛋充分加热炒熟。', ingredientIds: ['tomato', 'egg', 'salt'] }],
      estimatedTime: 12, recommendationReason: '测试推荐理由。', missingIngredients: [],
      imageFallbackCategory: 'bowl', diningCategory: null, orderingTip: null, matchedPreferences: ['咸鲜'],
    },
    source: 'mock', model: null, scene: 'cook', servings: 1,
  }
  const openversePhoto = {
    url: 'https://api.openverse.org/v1/images/0e1c4e2a-0000-4000-8000-000000000001/thumb/',
    alt: 'Stir fried tomato and egg', photographer: 'Test Photographer',
    photographerUrl: 'https://www.flickr.com/people/test-photographer/',
    pageUrl: 'https://www.flickr.com/photos/test-photographer/12345/',
    width: 1200, height: 800, license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', source: 'openverse',
  }
  const pexelsPhoto = {
    url: 'https://images.pexels.com/photos/12345/large.jpeg',
    alt: 'Stir fried tomato and egg', photographer: 'Test Photographer',
    photographerUrl: 'https://www.pexels.com/@test-photographer',
    pageUrl: 'https://www.pexels.com/photo/dish-12345/',
    width: 1200, height: 800, source: 'pexels',
  }

  function store(photo: unknown) {
    localStorage.setItem(storageKey, JSON.stringify({
      preferences: emptyPreferences(), saved: ['stored-dish'],
      generatedSnapshots: [{ ...snapshot, photo }],
    }))
  }

  it('keeps a legacy Pexels favorite but degrades its photo to the placeholder', () => {
    store(pexelsPhoto)
    const state = readDemoState()
    expect(state.saved).toEqual(['stored-dish'])
    expect(state.generatedSnapshots).toHaveLength(1)
    expect(state.generatedSnapshots![0].recipe.id).toBe('stored-dish')
    expect(state.generatedSnapshots![0].photo).toBeUndefined()
  })

  it('keeps a valid Openverse photo on the stored favorite', () => {
    store(openversePhoto)
    const state = readDemoState()
    expect(state.saved).toEqual(['stored-dish'])
    expect(state.generatedSnapshots![0].photo).toEqual(openversePhoto)
  })

  it('strips unsafe photo metadata without losing the favorite', () => {
    store({ ...openversePhoto, url: 'https://evil.example/x/thumb/' })
    const state = readDemoState()
    expect(state.saved).toEqual(['stored-dish'])
    expect(state.generatedSnapshots![0].photo).toBeUndefined()
  })

  it('still drops snapshots whose recipe itself is invalid', () => {
    localStorage.setItem(storageKey, JSON.stringify({
      preferences: emptyPreferences(), saved: ['stored-dish'],
      generatedSnapshots: [{ ...snapshot, recipe: { ...snapshot.recipe, name: '   ' }, photo: openversePhoto }],
    }))
    const state = readDemoState()
    expect(state.saved).toEqual([])
    expect(state.generatedSnapshots).toEqual([])
  })
})
