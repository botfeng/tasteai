import { validPhoto } from './generation'
import type { DishPhoto, GeneratedDish, GeneratedSnapshot, Scene } from './generation'

export type PhotoMap = Record<string, DishPhoto>

export function attachPhoto(snapshot: GeneratedSnapshot, photos: PhotoMap): GeneratedSnapshot {
  const photo = photos[snapshot.recipe.id]
  return photo ? { ...snapshot, photo } : snapshot
}

// Fail-soft: any network, timeout or DTO problem resolves to {} so placeholders stay.
export async function matchDishPhotos(dishes: GeneratedDish[], scene: Scene, signal: AbortSignal): Promise<PhotoMap> {
  if (!dishes.length) return {}
  const body = {
    dishes: dishes.map((dish) => ({
      id: dish.id, name: dish.name, scene,
      ingredientIds: dish.ingredients.map((item) => item.ingredientId),
      diningCategory: dish.diningCategory,
    })),
  }
  let value: unknown
  try {
    const response = await fetch('/api/photos/match', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    })
    if (!response.ok) return {}
    value = await response.json()
  } catch {
    return {}
  }
  if (!value || typeof value !== 'object' || !Array.isArray((value as Record<string, unknown>).photos)) return {}
  const found: PhotoMap = {}
  for (const entry of (value as { photos: unknown[] }).photos) {
    if (!entry || typeof entry !== 'object') continue
    const { dishId, photo } = entry as { dishId?: unknown; photo?: unknown }
    if (typeof dishId === 'string' && dishes.some((dish) => dish.id === dishId) && validPhoto(photo)) found[dishId] = photo
  }
  return found
}