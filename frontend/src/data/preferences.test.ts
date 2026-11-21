import { describe, expect, it } from 'vitest'
import { emptyPreferences, matchingRecipes } from './preferences'
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
