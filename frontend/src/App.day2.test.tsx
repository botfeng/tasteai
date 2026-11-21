import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { emptyPreferences, storageKey } from './data/preferences'
import { pantryStorageKey, readPantry } from './data/pantry'
import { recipes } from './data/recipes'
import { ingredientCatalog } from './data/ingredients'

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

function add(text: string) {
  fireEvent.change(screen.getByRole('textbox', { name: '添加你有的食材' }), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '添加' }))
}

function openFridge() {
  render(<App />)
  navigate('#fridge')
}

describe('Day 2 dining modes', () => {
  it('keeps the large card and two small cards and switches the actual display', () => {
    const { container } = render(<App />)
    expect(container.querySelectorAll('.featured-card')).toHaveLength(1)
    expect(container.querySelectorAll('.more-grid .recipe-card')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '15 分钟快手' }))
    fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    expect(screen.queryByRole('button', { name: '15 分钟快手' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '预算偏好' })).toBeVisible()
    expect(screen.getByRole('link', { name: '点餐建议' })).toBeVisible()
    expect(container.querySelector('.recipe-time')).not.toBeInTheDocument()
    for (const recipe of recipes.slice(0, 3)) expect(screen.getByRole('heading', { name: recipe.name })).toBeVisible()
    fireEvent.click(screen.getByRole('radio', { name: '自己做' }))
    expect(screen.getByRole('button', { name: '15 分钟快手' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('combobox', { name: '预算偏好' })).not.toBeInTheDocument()
  })

  it('does not apply a saved cooking limit or show it in the out-mode summary', () => {
    localStorage.setItem(storageKey, JSON.stringify({ preferences: { ...emptyPreferences(), maxMinutes: 15, configured: true }, saved: [] }))
    render(<App />)
    expect(screen.queryByRole('heading', { name: recipes[1].name })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    expect(screen.getByRole('heading', { name: recipes[1].name })).toBeVisible()
    expect(screen.queryByText(/15 分钟内/)).not.toBeInTheDocument()
  })

  it('changes actual recommendations by taste and relative budget without inventing prices', () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: '浓郁' }))
    const featured = screen.getByRole('article', { name: '今日主推菜谱' })
    expect(within(featured).getByRole('heading')).toHaveTextContent('番茄罗勒螺旋面')
    fireEvent.click(screen.getByRole('radio', { name: '全部' }))
    fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    fireEvent.change(screen.getByRole('combobox', { name: '预算偏好' }), { target: { value: 'balanced' } })
    expect(within(featured).getByRole('heading')).toHaveTextContent('柠檬香草鸡排')
    expect(screen.getByText(/预算为菜品相对成本/)).toHaveTextContent('不是商家报价')
    expect(document.body.textContent).not.toMatch(/[¥￥]\s*\d/)
  })

  it('opens dining advice without cooking tutorial and keeps the mode after returning', async () => {
    render(<App />)
    fireEvent.click(screen.getByRole('radio', { name: '在外面吃' }))
    fireEvent.click(screen.getByRole('link', { name: '点餐建议' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '点餐时，可以这样选' })).toBeVisible())
    expect(screen.queryByRole('heading', { name: '一步步，好好做' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /开始做这道菜/ })).not.toBeInTheDocument()
    expect(screen.queryByText('预计总用时')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: '返回菜谱列表' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: '在外面吃' })).toBeChecked())
  })

  it('keeps saved recipes usable and understands a direct dining detail link', () => {
    render(<App />)
    navigate('#recipe/lemon-chicken?mode=out')
    expect(screen.getByRole('heading', { name: '点餐时，可以这样选' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '收藏柠檬香草鸡排' }))
    navigate('#saved')
    expect(screen.getByRole('heading', { name: '柠檬香草鸡排' })).toBeVisible()
    navigate('#recipe/lemon-chicken')
    expect(screen.getByRole('heading', { name: '准备这些食材' })).toBeVisible()
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#saved')
  })
})

describe('Day 2 pantry interaction', () => {
  it('has a first-level entry, empty input feedback, and an empty results state', async () => {
    render(<App />)
    fireEvent.click(within(screen.getByRole('navigation', { name: '主导航' })).getByRole('link', { name: '冰箱里有什么' }))
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('冰箱里有什么'))
    expect(screen.getByRole('heading', { name: '打开冰箱，灵感就在里面' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '添加' }))
    expect(screen.getByText('先写下一种食材，或从下方选择。')).toBeVisible()
    expect(screen.getByRole('textbox')).toHaveFocus()
  })

  it('normalizes aliases, merges duplicates, removes tags and keeps storage consistent', () => {
    openFridge()
    add('西红柿，番茄、黄瓜 鸡蛋')
    expect(within(screen.getByRole('list', { name: '已选食材' })).getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByRole('button', { name: '删除番茄' })).toBeVisible()
    expect(screen.queryByRole('button', { name: '删除西红柿' })).not.toBeInTheDocument()
    expect(screen.getByText(/重复食材已合并/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '删除黄瓜' }))
    expect(screen.queryByRole('button', { name: '删除黄瓜' })).not.toBeInTheDocument()
    expect(readPantry().items).toEqual(['番茄', '鸡蛋'])
    const quick = screen.getByRole('group', { name: '常见食材快捷选择' })
    fireEvent.click(within(quick).getByRole('button', { name: '黄瓜' }))
    expect(within(quick).getByRole('button', { name: '黄瓜' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(quick).getByRole('button', { name: '黄瓜' }))
    expect(within(quick).getByRole('button', { name: '黄瓜' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('retains input draft, selected ingredients and basics choice across remounts', () => {
    const view = render(<App />)
    navigate('#fridge')
    add('西红柿、螺旋面')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '还没提交的食材' } })
    fireEvent.click(screen.getByRole('checkbox', { name: /我有基础厨房材料/ }))
    view.unmount()
    render(<App />)
    expect(screen.getByRole('textbox')).toHaveValue('还没提交的食材')
    expect(screen.getByRole('button', { name: '删除番茄' })).toBeVisible()
    expect(screen.getByRole('checkbox', { name: /我有基础厨房材料/ })).not.toBeChecked()
  })

  it('marks unknown input and allows recognized but unmatched ingredients', () => {
    openFridge()
    add('火星果、白糖')
    expect(screen.queryByRole('button', { name: '删除火星果' })).not.toBeInTheDocument()
    expect(screen.getByText(/目录中暂未找到：火星果/)).toBeVisible()
    expect(readPantry().items).toEqual(['白糖'])
    expect(screen.getByRole('heading', { name: '暂时还搭不成这一餐' })).toBeVisible()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
  })

  it('shows missing core materials, three statuses and explicit basic assumptions', () => {
    openFridge()
    add('番茄')
    let result = screen.getByRole('article', { name: '番茄罗勒螺旋面匹配结果' })
    expect(within(result).getByText('当前食材不足')).toBeVisible()
    expect(within(result).getByText('核心材料未齐，请补齐后再做。')).toBeVisible()
    expect(within(result).getByRole('meter')).toHaveAttribute('aria-valuenow', '20')
    add('螺旋面、大蒜')
    result = screen.getByRole('article', { name: '番茄罗勒螺旋面匹配结果' })
    expect(within(result).getByText('还缺少少量材料')).toBeVisible()
    add('罗勒、番茄膏')
    expect(within(result).getByText('主要食材齐全')).toBeVisible()
    expect(within(result).getByRole('meter')).toHaveAttribute('aria-valuenow', '100')
    expect(within(result).queryByText('核心材料未齐，请补齐后再做。')).not.toBeInTheDocument()
    expect(screen.getByText(/默认勾选，仅补齐这四种/)).toBeVisible()
    fireEvent.click(screen.getByRole('checkbox', { name: /我有基础厨房材料/ }))
    const seasonings = within(result).getByText('缺少调味').parentElement!
    expect(seasonings).toHaveTextContent('盐')
    expect(seasonings).toHaveTextContent('食用油')
    expect(seasonings).toHaveTextContent('水')
  })

  it('sorts by coverage, opens the existing recipe and returns to restored fridge input', async () => {
    openFridge()
    add('番茄、螺旋面、大蒜、番茄膏、罗勒、鸡胸肉')
    expect(screen.getAllByRole('article')[0]).toHaveAttribute('aria-label', '番茄罗勒螺旋面匹配结果')
    fireEvent.click(screen.getByRole('link', { name: '番茄罗勒螺旋面' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '准备这些食材' })).toBeVisible())
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#fridge')
    const entry = window.history.state
    expect(entry.tasteaiReturnTo).toBe('#fridge')
    fireEvent.click(screen.getByRole('link', { name: '返回菜谱列表' }))
    await waitFor(() => expect(screen.getByRole('button', { name: '删除番茄' })).toBeVisible())
  })

  it('restores the fridge return link when reloading directly inside a recipe history entry', () => {
    localStorage.setItem(pantryStorageKey, JSON.stringify({ items: ['番茄'], draft: '', assumeBasics: true }))
    window.history.replaceState({ tasteaiRecipe: '#recipe/tomato-fusilli', tasteaiReturnTo: '#fridge' }, '', '#recipe/tomato-fusilli')
    render(<App />)
    expect(screen.getByRole('link', { name: '返回菜谱列表' })).toHaveAttribute('href', '#fridge')
    expect(screen.getByText(/核心食材覆盖率 20%/)).toBeVisible()
  })

  it('limits selected ingredients and keeps excess input editable', () => {
    openFridge()
    add(ingredientCatalog.slice(0, 41).map((item) => item.name).join('、'))
    expect(within(screen.getByRole('list', { name: '已选食材' })).getAllByRole('listitem')).toHaveLength(40)
    expect(screen.getByText(/最多保留 40 种/)).toBeVisible()
    expect(screen.getByRole('textbox')).not.toHaveValue('')
    expect(readPantry().items).toHaveLength(40)
  })

  it('keeps non-basic seasonings missing even when all core ingredients are present', () => {
    openFridge()
    add('即食三文鱼、熟米饭、毛豆、黄瓜')
    const result = screen.getByRole('article', { name: '三文鱼毛豆波奇碗匹配结果' })
    expect(within(result).getByText('主要食材齐全')).toBeVisible()
    expect(within(result).getByText('缺少调味').parentElement).toHaveTextContent('酱油')
    expect(within(result).getByText('缺少调味').parentElement).toHaveTextContent('蛋黄酱')
    expect(result).not.toHaveTextContent('可以直接做')
  })

  it('survives invalid storage and reports storage failure without losing current edits', () => {
    localStorage.setItem(pantryStorageKey, '{broken')
    openFridge()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Blocked') })
    add('番茄')
    expect(screen.getByRole('button', { name: '删除番茄' })).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器无法保存')
  })

  it('bounds malformed storage and rejects overly long ingredient names', () => {
    localStorage.setItem(pantryStorageKey, JSON.stringify({ items: ['西红柿', '番茄', null, '', 1], draft: 123, assumeBasics: 'yes' }))
    expect(readPantry()).toEqual({ items: ['番茄'], draft: '', assumeBasics: true })
    openFridge()
    add('长'.repeat(31))
    expect(screen.getByText(/过长名称未添加/)).toBeVisible()
    expect(readPantry().items).toEqual(['番茄'])
  })
})
