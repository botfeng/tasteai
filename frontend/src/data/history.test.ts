import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearHistory, exclusionNames, historyLimit, historyStorageKey, normalizeDishName, readHistory, recordRecommendations } from './history'

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('dish name normalization', () => {
  it.each([
    ['番茄滑蛋', '番茄滑蛋'],
    [' 番茄 滑蛋·小锅 ', '番茄滑蛋小锅'],
    ['Ｔｏｍａｔｏ　Ｅｇｇ', 'tomatoegg'],
    ['Tomato-Egg!', 'tomatoegg'],
    ['番茄（滑蛋）', '番茄滑蛋'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeDishName(input)).toBe(expected)
  })

  it('treats punctuation and width variants as the same dish', () => {
    expect(normalizeDishName('番茄滑蛋·小锅')).toBe(normalizeDishName('番茄滑蛋 小锅！'))
  })
})

describe('recommendation history storage', () => {
  it('records newest names first, dedupes by normalized name and persists', () => {
    recordRecommendations(['番茄滑蛋', '蛋花汤'])
    const next = recordRecommendations(['蛋花汤！', '青菜煲'])
    expect(next).toEqual(['蛋花汤！', '青菜煲', '番茄滑蛋'])
    expect(JSON.parse(localStorage.getItem(historyStorageKey)!)).toEqual(next)
    expect(readHistory()).toEqual(next)
  })

  it('caps stored history at twenty names', () => {
    const names = Array.from({ length: 30 }, (_, index) => `菜${index}`)
    expect(recordRecommendations(names)).toHaveLength(historyLimit)
    expect(readHistory()).toEqual(names.slice(0, historyLimit))
    recordRecommendations(['新菜'])
    expect(readHistory()[0]).toBe('新菜')
    expect(readHistory()).toHaveLength(historyLimit)
  })

  it.each(['{broken', 'null', '"text"', JSON.stringify({ names: [] }), JSON.stringify([1, null, '', '   ', 'x'.repeat(101), '有效菜名', '有效菜名！'])])('recovers from invalid storage: %s', (raw) => {
    localStorage.setItem(historyStorageKey, raw)
    const history = readHistory()
    expect(history.every((name) => typeof name === 'string' && name.length <= 100)).toBe(true)
    if (raw.includes('有效菜名')) expect(history).toEqual(['有效菜名'])
    else expect(history).toEqual([])
  })

  it('clears history and keeps working when storage is blocked', () => {
    recordRecommendations(['番茄滑蛋'])
    expect(clearHistory()).toEqual([])
    expect(localStorage.getItem(historyStorageKey)).toBeNull()
    expect(readHistory()).toEqual([])
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    expect(recordRecommendations(['新菜'])).toEqual(['新菜'])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Blocked', 'SecurityError') })
    expect(readHistory()).toEqual([])
    expect(clearHistory()).toEqual([])
  })
})

describe('exclusion list for generation requests', () => {
  it('puts current batch names first and dedupes against history', () => {
    const history = recordRecommendations(['旧菜A', '旧菜B'])
    expect(exclusionNames(['本批菜', '旧菜A！'], history)).toEqual(['本批菜', '旧菜A！', '旧菜B'])
  })

  it('never exceeds the backend limit of twenty names', () => {
    const history = Array.from({ length: 20 }, (_, index) => `历史菜${index}`)
    const exclusions = exclusionNames(['本批1', '本批2', '本批3'], history)
    expect(exclusions).toHaveLength(20)
    expect(exclusions.slice(0, 3)).toEqual(['本批1', '本批2', '本批3'])
  })
})