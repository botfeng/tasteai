import { recipes } from './recipes'
import type { Recipe } from './recipes'
import type { IconName } from '../components/Icon'
import { validSnapshot } from './generation'
import type { GeneratedSnapshot } from './generation'

export const tasteOptions: { label: string; description: string; icon: IconName }[] = [
  { label: '清爽', description: '清新一点，刚刚好', icon: 'leaf' },
  { label: '微辣', description: '一点辣意，更开胃', icon: 'flame' },
  { label: '浓郁', description: '想吃一口满足', icon: 'bowl' },
  { label: '酸甜', description: '让味蕾醒过来', icon: 'lemon' },
  { label: '咸鲜', description: '熟悉的家常味道', icon: 'fish' },
  { label: '原味', description: '食材本来的好味道', icon: 'chef' },
  { label: '酸辣', description: '酸香微辣，更开胃', icon: 'flame' },
]

export const ingredientOptions: { label: string; icon: IconName }[] = [
  { label: '蔬菜', icon: 'leaf' },
  { label: '鸡肉', icon: 'chef' },
  { label: '鱼虾', icon: 'fish' },
  { label: '面食', icon: 'bowl' },
  { label: '蛋奶', icon: 'sun' },
  { label: '菌菇', icon: 'spark' },
]

export type Preferences = {
  tastes: string[]
  ingredients: string[]
  maxMinutes: number
  configured: boolean
}

export type DemoState = { preferences: Preferences; saved: string[]; generatedSnapshots?: GeneratedSnapshot[] }
export const storageKey = 'tasteai-demo-v1'
export const emptyPreferences = (): Preferences => ({ tastes: [], ingredients: [], maxMinutes: 0, configured: false })

export function readDemoState(): DemoState {
  const fallback = { preferences: emptyPreferences(), saved: [] }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null')
    if (!value || typeof value !== 'object') return fallback
    const stored = value as Record<string, unknown>
    const generatedSnapshots = Array.isArray(stored.generatedSnapshots) ? stored.generatedSnapshots.filter(validSnapshot).slice(0, 100) : []
    const saved = Array.isArray(stored.saved)
      ? [...new Set(stored.saved.filter((id): id is string => typeof id === 'string' && (recipes.some((recipe) => recipe.id === id) || generatedSnapshots.some((item) => item.recipe.id === id))))]
      : []
    const snapshots = generatedSnapshots.filter((item) => saved.includes(item.recipe.id))
    const p = stored.preferences
    if (!p || typeof p !== 'object') return { ...fallback, saved, generatedSnapshots: snapshots }
    const preference = p as Record<string, unknown>
    if (
      !Array.isArray(preference.tastes) || !preference.tastes.every((item) => tasteOptions.some((option) => option.label === item)) ||
      !Array.isArray(preference.ingredients) || !preference.ingredients.every((item) => ingredientOptions.some((option) => option.label === item)) ||
      ![0, 15, 30].includes(preference.maxMinutes as number) || typeof preference.configured !== 'boolean'
    ) return { ...fallback, saved, generatedSnapshots: snapshots }
    return { preferences: preference as Preferences, saved, generatedSnapshots: snapshots }
  } catch {
    return fallback
  }
}

export function matchingRecipes(preferences: Preferences): Recipe[] {
  return recipes.filter((recipe) =>
    (!preferences.maxMinutes || recipe.minutes <= preferences.maxMinutes) &&
    (!preferences.tastes.length || preferences.tastes.some((taste) => recipe.tastes.includes(taste))) &&
    (!preferences.ingredients.length || preferences.ingredients.some((ingredient) => recipe.categories.includes(ingredient))),
  )
}
