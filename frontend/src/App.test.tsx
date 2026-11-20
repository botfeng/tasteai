import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { emptyPreferences, matchingRecipes, storageKey } from './data/preferences'
import { recipes } from './data/recipes'

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, '', '#home')
  vi.stubGlobal('scrollTo', vi.fn())
})

function navigate(hash: string) {
  act(() => {
    window.history.replaceState(null, '', hash)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
  })
}

function savePreference(preferences = emptyPreferences()) {
  localStorage.setItem(storageKey, JSON.stringify({ preferences, saved: [] }))
}

describe('TasteAI recipe experience', () => {
  it('opens the food-first Chinese homepage with explicit Demo disclosure and no API dependency', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今天，吃点喜欢的。')
    expect(screen.getByRole('img', { name: recipes[0].photoAlt })).toHaveAttribute('fetchpriority', 'high')
    expect(screen.getByRole('link', { name: /看看做法/ })).toHaveAttribute('href', `#recipe/${recipes[0].id}`)
    expect(screen.getByText('本地 Demo 菜谱 · 非模型推荐')).toBeVisible()
    expect(screen.queryByText(/工程初始化/)).not.toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rotates the main dish without claiming to fetch new recipes', () => {
    render(<App />)
    const featured = screen.getByRole('article', { name: '今日主推菜谱' })
    expect(within(featured).getByRole('heading')).toHaveTextContent(recipes[0].name)
    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    expect(within(featured).getByRole('heading')).toHaveTextContent(recipes[1].name)
    expect(screen.getByRole('status')).toHaveTextContent(`${recipes.length} 道匹配的 Demo 菜谱`)
  })

  it('opens a recipe by its CTA and exposes ingredients and complete cooking steps', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('link', { name: /看看做法/ }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(recipes[0].name))
    expect(screen.getAllByRole('checkbox')).toHaveLength(recipes[0].ingredients.length)
    for (const step of recipes[0].steps) expect(screen.getByRole('heading', { name: step.title })).toBeVisible()
    const ingredient = screen.getAllByRole('checkbox')[0]
    fireEvent.click(ingredient)
    expect(ingredient).toBeChecked()
    fireEvent.click(ingredient)
    expect(ingredient).not.toBeChecked()
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#home')
  })

  it('saves and unsaves a dish and persists it across remounts', () => {
    const first = render(<App />)
    fireEvent.click(screen.getByRole('button', { name: `收藏${recipes[0].name}` }))
    expect(JSON.parse(localStorage.getItem(storageKey)!).saved).toEqual([recipes[0].id])
    first.unmount()
    const second = render(<App />)
    navigate('#saved')
    expect(screen.getByRole('heading', { name: recipes[0].name })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: `取消收藏${recipes[0].name}` }))
    expect(screen.getByRole('heading', { name: '把想吃的，先收好' })).toBeVisible()
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus()
    expect(JSON.parse(localStorage.getItem(storageKey)!).saved).toEqual([])
    second.unmount()
  })

  it('returns from a saved recipe to the saved list', () => {
    localStorage.setItem(storageKey, JSON.stringify({ preferences: emptyPreferences(), saved: [recipes[0].id] }))
    render(<App />)
    navigate('#saved')
    navigate(`#recipe/${recipes[0].id}`)
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#saved')
  })

  it('retains the originating list in each recipe history entry', () => {
    render(<App />)
    navigate('#saved')
    navigate(`#recipe/${recipes[0].id}`)
    const recipeEntry = window.history.state
    expect(recipeEntry.tasteaiReturnTo).toBe('#saved')
    navigate('#home')
    act(() => {
      window.history.replaceState(recipeEntry, '', `#recipe/${recipes[0].id}`)
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#saved')
  })

  it('supports multi-select preferences, previous step, time choice and actual matching', async () => {
    render(<App />)
    navigate('#preferences')
    fireEvent.click(screen.getByRole('button', { name: /清爽清新一点/ }))
    fireEvent.click(screen.getByRole('button', { name: /浓郁想吃一口/ }))
    expect(screen.getByRole('button', { name: /清爽清新一点/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '蔬菜' }))
    fireEvent.click(screen.getByRole('button', { name: '上一步' }))
    expect(screen.getByRole('button', { name: /浓郁想吃一口/ })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    expect(screen.getByRole('button', { name: '蔬菜' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('radio', { name: /30 分钟内/ }))
    fireEvent.click(screen.getByRole('button', { name: /看看我的推荐/ }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今天，吃点喜欢的。'))
    const stored = JSON.parse(localStorage.getItem(storageKey)!)
    expect(stored.preferences).toEqual({ tastes: ['清爽', '浓郁'], ingredients: ['蔬菜'], maxMinutes: 30, configured: true })
    expect(screen.getByText(/按口味档案筛选/)).toBeVisible()
    for (const recipe of matchingRecipes(stored.preferences)) expect(screen.getByRole('heading', { name: recipe.name })).toBeVisible()
  })

  it('does not save an incomplete draft when skipping', async () => {
    savePreference({ ...emptyPreferences(), tastes: ['原味'], configured: true })
    render(<App />)
    navigate('#preferences')
    fireEvent.click(screen.getByRole('button', { name: /清爽清新一点/ }))
    fireEvent.click(screen.getByRole('link', { name: '跳过' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今天，吃点喜欢的。'))
    expect(JSON.parse(localStorage.getItem(storageKey)!).preferences.tastes).toEqual(['原味'])
  })

  it('shows an honest empty result and can clear filters', () => {
    savePreference({ tastes: ['微辣'], ingredients: ['菌菇'], maxMinutes: 15, configured: true })
    render(<App />)
    expect(screen.getByRole('heading', { name: '这个口味，还在准备中' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /查看全部菜谱/ }))
    expect(screen.getByRole('article', { name: '今日主推菜谱' })).toBeVisible()
    expect(JSON.parse(localStorage.getItem(storageKey)!).preferences).toEqual(emptyPreferences())
  })

  it('applies a quick filter without changing stored preferences', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: /15 分钟快手/ }))
    expect(screen.getByRole('button', { name: /15 分钟快手/ })).toHaveAttribute('aria-pressed', 'true')
    for (const recipe of recipes.filter((item) => item.minutes > 15)) expect(screen.queryByRole('heading', { name: recipe.name })).not.toBeInTheDocument()
    expect(localStorage.getItem(storageKey)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /15 分钟快手/ }))
    expect(screen.getByRole('button', { name: /15 分钟快手/ })).toHaveAttribute('aria-pressed', 'false')
    for (const recipe of recipes) expect(screen.getByRole('heading', { name: recipe.name })).toBeVisible()
  })

  it('combines the taste segment with the independent time toggle in either order', () => {
    render(<App />)
    const tastes = screen.getByRole('group', { name: '口味筛选' })
    const time = screen.getByRole('button', { name: '15 分钟快手' })
    expect(within(tastes).getAllByRole('radio')).toHaveLength(3)
    expect(within(tastes).getByRole('radio', { name: '全部' })).toBeChecked()
    fireEvent.click(within(tastes).getByRole('radio', { name: '清爽' }))
    expect(screen.getByRole('heading', { name: recipes[1].name })).toBeVisible()
    expect(screen.queryByRole('heading', { name: recipes[2].name })).not.toBeInTheDocument()
    fireEvent.click(time)
    expect(within(tastes).getByRole('radio', { name: '清爽' })).toBeChecked()
    expect(screen.queryByRole('heading', { name: recipes[1].name })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '换一批' })).toBeDisabled()
    fireEvent.click(within(tastes).getByRole('radio', { name: '浓郁' }))
    expect(time).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: '这个口味，还在准备中' })).toBeVisible()
    fireEvent.click(time)
    expect(within(tastes).getByRole('radio', { name: '浓郁' })).toBeChecked()
    expect(within(tastes).getByRole('radio', { name: '清爽' })).not.toBeChecked()
    expect(screen.getByRole('heading', { name: recipes[2].name })).toBeVisible()
    expect(localStorage.getItem(storageKey)).toBeNull()
  })

  it('clears both quick filters from an empty combination', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: '浓郁' }))
    fireEvent.click(screen.getByRole('button', { name: '15 分钟快手' }))
    fireEvent.click(screen.getByRole('button', { name: /查看全部菜谱/ }))
    expect(screen.getByRole('radio', { name: '全部' })).toBeChecked()
    expect(screen.getByRole('button', { name: '15 分钟快手' })).toHaveAttribute('aria-pressed', 'false')
    for (const recipe of recipes) expect(screen.getByRole('heading', { name: recipe.name })).toBeVisible()
  })

  it('keeps saved preferences authoritative and resets rotation when a quick filter changes', () => {
    savePreference({ ...emptyPreferences(), tastes: ['清爽'], configured: true })
    const stored = localStorage.getItem(storageKey)
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    const featured = screen.getByRole('article', { name: '今日主推菜谱' })
    expect(within(featured).getByRole('heading')).toHaveTextContent(recipes[1].name)
    fireEvent.click(screen.getByRole('radio', { name: '清爽' }))
    expect(within(featured).getByRole('heading')).toHaveTextContent(recipes[0].name)
    fireEvent.click(screen.getByRole('button', { name: '15 分钟快手' }))
    expect(screen.queryByRole('heading', { name: recipes[1].name })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '全部' }))
    expect(screen.getByRole('button', { name: '15 分钟快手' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: '15 分钟快手' }))
    expect(screen.getByRole('heading', { name: recipes[1].name })).toBeVisible()
    expect(screen.queryByRole('heading', { name: recipes[2].name })).not.toBeInTheDocument()
    expect(localStorage.getItem(storageKey)).toBe(stored)
  })

  it('keeps navigation semantics and opens the existing preference flow from the compact entry', async () => {
    render(<App />)
    const navigation = screen.getByRole('navigation', { name: '主导航' })
    expect(within(navigation).getByRole('link', { name: '今日推荐' })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(within(navigation).getByRole('link', { name: '我的收藏' }))
    await waitFor(() => expect(within(navigation).getByRole('link', { name: '我的收藏' })).toHaveAttribute('aria-current', 'page'))
    fireEvent.click(within(navigation).getByRole('link', { name: '今日推荐' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('今天，吃点喜欢的。'))
    fireEvent.click(screen.getByRole('radio', { name: '浓郁' }))
    fireEvent.click(screen.getByRole('button', { name: '15 分钟快手' }))
    fireEvent.click(screen.getByRole('link', { name: '调整口味偏好' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('先聊聊，你喜欢的味道'))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: '下一步' }))
    fireEvent.click(screen.getByRole('button', { name: /看看我的推荐/ }))
    await waitFor(() => expect(screen.getByRole('radio', { name: '全部' })).toBeChecked())
    expect(screen.getByRole('button', { name: '15 分钟快手' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('reserves an image fallback while keeping the recipe usable', () => {
    render(<App />)
    fireEvent.error(screen.getByRole('img', { name: recipes[0].photoAlt }))
    expect(screen.getByRole('img', { name: /图片暂时无法加载/ })).toBeVisible()
    expect(screen.getByRole('link', { name: /看看做法/ })).toHaveAttribute('href', `#recipe/${recipes[0].id}`)
    fireEvent.click(screen.getByRole('button', { name: '换一批' }))
    expect(screen.queryByText('图片暂时没端上来')).not.toBeInTheDocument()
    expect(screen.getByRole('img', { name: recipes[1].photoAlt })).toBeVisible()
  })

  it.each(['{invalid', JSON.stringify({ preferences: { tastes: 'bad' }, saved: ['unknown'] }), 'null'])('recovers from invalid local data: %s', (value) => {
    localStorage.setItem(storageKey, value)
    render(<App />)
    expect(screen.getByRole('article', { name: '今日主推菜谱' })).toBeVisible()
  })

  it('continues in-memory and explains when browser storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError') })
    render(<App />)
    fireEvent.click(screen.getByRole('button', { name: `收藏${recipes[0].name}` }))
    expect(screen.getByRole('button', { name: `取消收藏${recipes[0].name}` })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('浏览器无法保存')
  })

  it('supports direct links and recovers from an unknown recipe', () => {
    render(<App />)
    navigate('#recipe/not-a-recipe')
    expect(screen.getByRole('heading', { name: '这道菜暂时不在小厨房' })).toBeVisible()
    navigate(`#recipe/${recipes[1].id}`)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(recipes[1].name)
    expect(document.title).toContain(recipes[1].name)
  })
})
