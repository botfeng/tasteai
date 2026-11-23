export const historyStorageKey = 'tasteai-recommendation-history-v1'
export const historyLimit = 20

// Mirrors the backend normalize_name: NFKC + casefold, letters and digits only.
export function normalizeDishName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function sanitize(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const name = item.trim()
    const key = normalizeDishName(name)
    if (!name || name.length > 100 || !key || seen.has(key)) continue
    seen.add(key)
    names.push(name)
    if (names.length >= historyLimit) break
  }
  return names
}

export function readHistory(): string[] {
  try {
    return sanitize(JSON.parse(localStorage.getItem(historyStorageKey) ?? 'null'))
  } catch {
    return []
  }
}

function writeHistory(names: string[]) {
  try {
    localStorage.setItem(historyStorageKey, JSON.stringify(names))
  } catch {
    // History is best-effort dedup; a blocked storage must not break recommendations.
  }
}

export function recordRecommendations(names: string[]): string[] {
  const next = sanitize([...names, ...readHistory()])
  writeHistory(next)
  return next
}

export function clearHistory(): string[] {
  try {
    localStorage.removeItem(historyStorageKey)
  } catch {
    // In-memory clearing still applies for this session.
  }
  return []
}

// Current batch names first, then recent history; capped to the backend limit.
export function exclusionNames(currentNames: string[], history: string[]): string[] {
  return sanitize([...currentNames, ...history])
}