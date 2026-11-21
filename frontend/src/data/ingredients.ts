import catalog from '../../../backend/app/data/ingredients.json'

export const ingredientCatalog = catalog
const ingredientAliases = Object.fromEntries(catalog.map((item) => [item.name, item.aliases]))

export function ingredientId(name: string): string | undefined {
  return catalog.find((item) => item.name === normalizeIngredient(name))?.id
}

const canonicalByAlias = new Map<string, string>()
for (const [canonical, aliases] of Object.entries(ingredientAliases)) {
  for (const alias of [canonical, ...aliases]) canonicalByAlias.set(alias, canonical)
}

export const commonIngredients: string[] = [
  '番茄', '鸡蛋', '鸡胸肉', '黄瓜', '毛豆', '蘑菇', '螺旋面', '熟米饭', '柠檬', '即食三文鱼',
  '番茄膏', '大蒜', '罗勒', '迷迭香', '胡萝卜', '土豆', '豆腐',
]

export const kitchenBasics: string[] = catalog.filter((item) => item.basic).map((item) => item.name)

export function normalizeIngredient(value: string): string | null {
  return canonicalByAlias.get(value.normalize('NFKC').trim()) ?? null
}

export function parseIngredients(text: string): { recognized: string[]; unknown: string[]; duplicates: string[] } {
  const recognized = new Set<string>()
  const unknown = new Set<string>()
  const duplicates = new Set<string>()

  for (const token of text.normalize('NFKC').trim().split(/[,，、;；\s]+/u)) {
    if (!token) continue
    const canonical = normalizeIngredient(token)
    if (canonical === null) {
      unknown.add(token)
    } else if (recognized.has(canonical)) {
      duplicates.add(canonical)
    } else {
      recognized.add(canonical)
    }
  }

  // 三组均按首次出现顺序去重；duplicates 仅报告已识别食材的规范名。
  return { recognized: [...recognized], unknown: [...unknown], duplicates: [...duplicates] }
}
