import { normalizeIngredient } from './ingredients'

export type PantryState = { items: string[]; draft: string; assumeBasics: boolean }
export const pantryStorageKey = 'tasteai-pantry-v1'
export const pantryItemLimit = 40
export const pantryDraftLimit = 500

export function readPantry(): PantryState {
  const fallback: PantryState = { items: [], draft: '', assumeBasics: true }
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pantryStorageKey) ?? 'null')
    if (!value || typeof value !== 'object') return fallback
    const stored = value as Record<string, unknown>
    return {
      items: Array.isArray(stored.items) ? [...new Set(stored.items
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.trim().length <= 30)
        .map((item) => normalizeIngredient(item) ?? item.trim()))].slice(0, pantryItemLimit) : [],
      draft: typeof stored.draft === 'string' ? stored.draft.slice(0, pantryDraftLimit) : '',
      assumeBasics: typeof stored.assumeBasics === 'boolean' ? stored.assumeBasics : true,
    }
  } catch {
    return fallback
  }
}
