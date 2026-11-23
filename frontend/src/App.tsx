import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DemoState, Preferences } from './data/preferences'
import { emptyPreferences, readDemoState, storageKey, tasteOptions } from './data/preferences'
import { snapshots, toRecipe } from './data/generation'
import type { GeneratedSnapshot, GenerationResponse } from './data/generation'
import { attachPhoto, matchDishPhotos } from './data/photos'
import type { PhotoMap } from './data/photos'
import { useGeneration } from './data/useGeneration'
import { clearHistory, exclusionNames, readHistory, recordRecommendations } from './data/history'
import GenerationPanel from './components/GenerationPanel'
import { recipes } from './data/recipes'
import type { BudgetBand, DiningMode, Recipe } from './data/recipes'
import { budgetOptions, recommendByIngredients, recommendByPreference } from './data/recommendations'
import { readPantry } from './data/pantry'
import FridgePage from './components/FridgePage'
import FoodImage from './components/FoodImage'
import Icon from './components/Icon'
import type { IconName } from './components/Icon'
import PreferencesPage from './components/PreferencesPage'
import RecipeCard, { SaveButton } from './components/RecipeCard'
import RecipePage from './components/RecipePage'
import ServiceStatus from './components/ServiceStatus'

const navigation: { href: string; label: string; mobileLabel?: string; icon: IconName }[] = [
  { href: '#home', label: '今天吃什么', icon: 'bowl' },
  { href: '#fridge', label: '冰箱里有什么', mobileLabel: '冰箱食材', icon: 'fridge' },
  { href: '#saved', label: '我的收藏', icon: 'heart' },
  { href: '#preferences', label: '口味偏好', icon: 'sliders' },
]
const tasteFilters: { label: string; icon: IconName }[] = [
  { label: '全部', icon: 'spark' },
  { label: '清爽', icon: 'leaf' },
  { label: '浓郁', icon: 'bowl' },
]

function Navigation({ hash, count, mobile = false }: { hash: string; count: number; mobile?: boolean }) {
  return <nav className={mobile ? 'mobile-navigation' : 'desktop-navigation'} aria-label={mobile ? '底部导航' : '主导航'}>{navigation.map((item) => <a key={item.href} href={item.href} className={hash === item.href ? 'is-active' : ''} aria-current={hash === item.href ? 'page' : undefined} aria-label={item.label}><Icon name={item.icon} size={mobile ? 22 : 18} /><span>{mobile ? item.mobileLabel ?? item.label : item.label}</span>{item.href === '#saved' && count > 0 && <span className="nav-count">{count}</span>}</a>)}</nav>
}

function PhotoCredits({ generated = false, photoRecipes = [] }: { generated?: boolean; photoRecipes?: Recipe[] }) {
  return <footer className="site-footer"><span>TasteAI <span className="footer-dot">·</span> 今天也要好好吃饭</span><span>{generated ? '本地示例与生成内容均标明来源' : '本地 Demo 菜谱 · 非模型推荐'}</span><details className="photo-credits"><summary>摄影与素材来源</summary><div>{recipes.filter((recipe) => recipe.image).map((recipe) => <p key={recipe.id}><span>{recipe.name}：</span><a href={recipe.credit.sourceUrl} target="_blank" rel="noreferrer">{recipe.credit.author}</a><span> / </span><a href={recipe.credit.licenseUrl} target="_blank" rel="noreferrer">{recipe.credit.license}</a></p>)}{photoRecipes.map((recipe) => <p key={recipe.id}><span>{recipe.name}（菜品示意图）：</span><a href={recipe.credit.sourceUrl} target="_blank" rel="noreferrer">{recipe.credit.author}</a><span> / </span><a href={recipe.credit.licenseUrl} target="_blank" rel="noreferrer">{recipe.credit.license}</a></p>)}{photoRecipes.length > 0 && <p>菜品示意图照片来自 <a href="https://openverse.org" target="_blank" rel="noreferrer">Openverse</a>（仅 CC0 / 公有领域标记 / CC BY 素材），按菜名与主要食材的关键词证据匹配，不是对应菜谱的实际成品照片；署名与授权链接见上方各条目。</p>}<p>摄影为摆盘参考，示例配方由本项目独立编写。其余菜品使用项目原创分类占位视觉，不是实物照片。</p></div></details></footer>
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash || '#home')
  const [state, setState] = useState<DemoState>(readDemoState)
  const [tasteFilter, setTasteFilter] = useState('全部')
  const [timeChoice, setTimeChoice] = useState(() => state.preferences.maxMinutes)
  const [servings, setServings] = useState(1)
  const [history, setHistory] = useState(readHistory)
  const [mode, setMode] = useState<DiningMode>('cook')
  const [budget, setBudget] = useState<'any' | BudgetBand>('any')
  const [batch, setBatch] = useState(0)
  const [notice, setNotice] = useState<{ text: string } | null>(null)
  const [generated, setGenerated] = useState<GeneratedSnapshot[]>([])
  const [photos, setPhotos] = useState<PhotoMap>({})
  const photoPending = useRef(new Set<string>())
  const stateRef = useRef(state)
  stateRef.current = state
  const requestPhotos = useCallback((response: GenerationResponse) => {
    const dishes = response.recipes.filter((dish) => !photoPending.current.has(dish.id))
    if (!dishes.length) return
    dishes.forEach((dish) => photoPending.current.add(dish.id))
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 10000)
    void matchDishPhotos(dishes, response.scene, controller.signal).then((found) => {
      window.clearTimeout(timer)
      dishes.forEach((dish) => photoPending.current.delete(dish.id))
      if (!Object.keys(found).length) return
      setPhotos((current) => ({ ...current, ...found }))
      const current = stateRef.current
      const stored = current.generatedSnapshots ?? []
      const next = stored.map((item) => found[item.recipe.id] && !item.photo ? { ...item, photo: found[item.recipe.id] } : item)
      if (next.some((item, index) => item !== stored[index])) {
        const nextState = { ...current, generatedSnapshots: next }
        setState(nextState)
        try { localStorage.setItem(storageKey, JSON.stringify(nextState)) } catch { setNotice({ text: '图片信息已生效，但浏览器无法保存；刷新后收藏可能回到占位图。' }) }
      }
    })
  }, [])
  const registerGenerated = useCallback((response: GenerationResponse) => {
    setGenerated((current) => [...current, ...snapshots(response)].slice(-100))
    setBatch(0)
    if (response.scene === 'cook') setHistory(recordRecommendations(response.recipes.map((dish) => dish.name)))
    requestPhotos(response)
  }, [requestPhotos])
  const registerReplacement = useCallback((response: GenerationResponse) => {
    setGenerated((current) => [...current, ...snapshots(response)].slice(-100))
    setHistory(recordRecommendations(response.recipes.map((dish) => dish.name)))
    requestPhotos(response)
  }, [requestPhotos])
  const allRecipes = useMemo(() => [...recipes, ...new Map([...(state.generatedSnapshots ?? []), ...generated].map((item) => [item.recipe.id, toRecipe(attachPhoto(item, photos))])).values()], [state.generatedSnapshots, generated, photos])
  const returnTo = useRef(window.history.state?.tasteaiRecipe === window.location.hash && ['#home', '#saved', '#fridge'].includes(window.history.state?.tasteaiReturnTo) ? window.history.state.tasteaiReturnTo as string : '#home')
  const previousHash = useRef(window.location.hash || '#home')
  const restoreSavedFocus = useRef(false)
  const isPreferences = hash === '#preferences'
  const isSaved = hash === '#saved'
  const isFridge = hash === '#fridge'
  const isDetail = hash.startsWith('#recipe/')
  const recipe = isDetail ? allRecipes.find((item) => item.id === hash.slice('#recipe/'.length).split('?')[0]) : undefined
  const detailMode: DiningMode = recipe?.generation ? recipe.generation.scene === 'eat_out' ? 'out' : 'cook' : new URLSearchParams(hash.split('?')[1]).get('mode') === 'out' ? 'out' : 'cook'
  const generation = useGeneration({ scene: mode === 'out' ? 'eat_out' : 'cook', ingredientIds: [], tastePreferences: state.preferences.tastes, todayTaste: tasteFilter === '全部' ? null : tasteFilter, preferredCategories: state.preferences.ingredients, timeLimit: mode === 'cook' ? (timeChoice || null) : null, budgetLevel: mode === 'out' ? budget : null, servings, strictIngredients: true, assumeBasics: true, maxRecipes: mode === 'cook' ? 3 : undefined }, registerGenerated, !isDetail && !isSaved && !isPreferences && !isFridge, registerReplacement)
  const recipeHref = (id: string) => `#recipe/${id}${mode === 'out' ? '?mode=out' : ''}`

  useEffect(() => {
    const onHashChange = () => {
      const next = window.location.hash || '#home'
      if (next.startsWith('#recipe/')) {
        const entry = window.history.state
        const storedOrigin = entry?.tasteaiRecipe === next && ['#home', '#saved', '#fridge'].includes(entry?.tasteaiReturnTo) ? entry.tasteaiReturnTo : null
        returnTo.current = storedOrigin ?? (['#saved', '#fridge'].includes(previousHash.current) ? previousHash.current : previousHash.current.startsWith('#recipe/') ? returnTo.current : '#home')
        if (new URLSearchParams(next.split('?')[1]).get('mode') === 'out') setMode('out')
        window.history.replaceState({ tasteaiRecipe: next, tasteaiReturnTo: returnTo.current }, '', window.location.href)
      } else {
        window.history.replaceState(null, '', window.location.href)
      }
      previousHash.current = next
      setHash(next)
      window.scrollTo({ top: 0, behavior: 'instant' })
    }
    onHashChange()
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    document.title = `${isPreferences ? '认识你的口味' : recipe?.name ?? (isSaved ? '我的收藏' : isFridge ? '冰箱里有什么' : '今天吃点喜欢的')} · TasteAI`
    document.querySelector<HTMLHeadingElement>('main h1')?.focus({ preventScroll: true })
  }, [hash, isPreferences, isSaved, isFridge, recipe])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    if (!restoreSavedFocus.current || !isSaved) return
    restoreSavedFocus.current = false
    const target = document.querySelector<HTMLElement>('.saved-grid .save-button') ?? document.querySelector<HTMLElement>('main h1')
    target?.focus({ preventScroll: true })
  }, [state.saved, isSaved])

  function persist(next: DemoState, message: string) {
    setState(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
      setNotice({ text: message })
    } catch {
      setNotice({ text: '本次更改已生效，但浏览器无法保存；刷新后可能丢失。' })
    }
  }

  function toggleSave(id: string) {
    const exists = state.saved.includes(id)
    restoreSavedFocus.current = exists && isSaved
    const snapshot = allRecipes.find((item) => item.id === id)?.generation
    const storedSnapshots = state.generatedSnapshots ?? []
    if (!exists && snapshot && storedSnapshots.length >= 100) { setNotice({ text: '最多收藏 100 道生成菜谱，请先移除一些收藏。' }); return }
    persist({ ...state, saved: exists ? state.saved.filter((item) => item !== id) : [...state.saved, id], generatedSnapshots: exists ? storedSnapshots.filter((item) => item.recipe.id !== id) : snapshot ? [...storedSnapshots, snapshot] : storedSnapshots }, exists ? '已取消收藏' : '已放进收藏，想吃的时候再来找它。')
  }

  function completePreferences(preferences: Preferences) {
    persist({ ...state, preferences }, '口味已记下，来看看这一餐的灵感。')
    setTasteFilter('全部')
    setTimeChoice(preferences.maxMinutes)
    setBatch(0)
    window.location.hash = '#home'
  }

  const recommendations = generation.result ? snapshots(generation.result).map((item) => ({ recipe: toRecipe(attachPhoto(item, photos)), reasons: [item.recipe.recommendationReason] })) : recommendByPreference(recipes, { mode, preferences: state.preferences, taste: tasteFilter, maxMinutes: timeChoice, budget, saved: state.saved })
  const offset = recommendations.length ? batch % recommendations.length : 0
  const ordered = [...recommendations.slice(offset), ...recommendations.slice(0, offset)]
  const featuredResult = ordered[0]
  const featured = featuredResult?.recipe
  const canReplace = mode === 'cook' && !!generation.result && !generation.loading
  const replaceExclusions = generation.result ? exclusionNames(generation.result.recipes.map((dish) => dish.name), history) : []
  const savedRecipes = allRecipes.filter((item) => state.saved.includes(item.id))
  const preferenceSummary = [...state.preferences.tastes, ...state.preferences.ingredients, ...(mode === 'cook' && state.preferences.maxMinutes ? [`${state.preferences.maxMinutes} 分钟内`] : [])].join(' · ') || '不设限，什么好吃就吃什么'
  const pantry = isDetail && returnTo.current === '#fridge' ? readPantry() : null
  const detailReasons = pantry ? recommendByIngredients(recipes, { ingredients: pantry.items, assumeBasics: pantry.assumeBasics, preferences: state.preferences, saved: state.saved }).find((item) => item.recipe.id === recipe?.id)?.reasons : recommendByPreference(recipes, { mode: detailMode, preferences: state.preferences, taste: tasteFilter, maxMinutes: timeChoice, budget, saved: state.saved }).find((item) => item.recipe.id === recipe?.id)?.reasons

  if (hash === '#service') return <ServiceStatus />

  return (
    <div className={`app-shell ${isDetail ? 'view-detail' : ''} ${isPreferences ? 'view-preferences' : ''}`}>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.querySelector<HTMLHeadingElement>('main h1')?.focus() }}>跳到主要内容</a>
      <header className="site-header">
        <a className="brand" href="#home" aria-label="TasteAI 首页"><span className="brand-mark"><Icon name="bowl" size={23} /></span><span>Taste<span className="brand-ai">AI</span></span><small>一餐一味，刚好是你</small></a>
        <Navigation hash={isDetail ? '' : isPreferences || isSaved || isFridge ? hash : '#home'} count={state.saved.length} />
        <a className="header-preferences" href="#preferences" aria-label="调整口味偏好"><Icon name="sliders" size={16} /><span>调整口味</span><Icon name="chevron" size={14} /></a>
      </header>

      {isPreferences ? <PreferencesPage preferences={state.preferences} onComplete={completePreferences} /> : isFridge ? <FridgePage preferences={state.preferences} saved={state.saved} onToggle={toggleSave} onGenerated={registerGenerated} photos={photos} /> : isDetail ? recipe ? <RecipePage key={`${recipe.id}-${detailMode}`} recipe={recipe} mode={detailMode} reasons={recipe.generation ? [recipe.reason] : detailReasons} saved={state.saved.includes(recipe.id)} onToggle={toggleSave} returnTo={returnTo.current} /> : <main className="not-found"><Icon name="book" size={44} /><h1 tabIndex={-1}>这道菜暂时不在小厨房</h1><p>回到首页，再挑一道喜欢的吧。</p><a className="primary-button" href="#home">看看今日推荐<Icon name="arrow" /></a></main> : (
        <main id="main-content" className="home-page page-enter">
          <section className="home-intro">
            <div><p className="greeting"><Icon name="sun" size={17} />把今天，过得有滋有味</p><h1 tabIndex={-1}>{isSaved ? '喜欢的味道，留给下一餐' : '今天，吃点喜欢的。'}</h1><p className="intro-subtitle">{isSaved ? `${savedRecipes.length} 道心动菜谱，只存在你的浏览器里。` : '不必纠结，一顿好饭的灵感就在这里。'}</p></div>
            <a className="taste-profile" href="#preferences"><Icon name="sliders" size={16} /><span>调整口味</span><Icon name="chevron" size={14} /></a>
          </section>

          {isSaved ? savedRecipes.length ? <section className="saved-grid" aria-label="已收藏菜谱">{savedRecipes.map((item) => <RecipeCard key={item.id} recipe={item} saved onToggle={toggleSave} />)}</section> : <section className="empty-state"><span className="empty-icon"><Icon name="heart" size={36} /></span><h2>把想吃的，先收好</h2><p>遇到喜欢的菜谱，点一下爱心。<br />下一餐的灵感，就不会溜走了。</p><a href="#home" className="primary-button">去找一道喜欢的<Icon name="arrow" size={18} /></a></section> : <>
            <div className="meal-controls">
              <fieldset className="taste-segments dining-segments"><legend className="sr-only">用餐方式</legend>{([{ value: 'cook', label: '自己做', icon: 'chef' }, { value: 'out', label: '在外面吃', icon: 'dining' }] as const).map((option) => <label key={option.value}><input className="sr-only" type="radio" name="dining-mode" checked={mode === option.value} onChange={() => { setMode(option.value); setBatch(0) }} /><span className="taste-segment"><Icon name={option.icon} size={18} />{option.label}</span></label>)}</fieldset>
              <p className="meal-context">{mode === 'cook' ? '为自己下厨，让喜欢的味道上桌。' : '今天不下厨，找一道合口味的菜。'}</p>
            </div>
            <div className="quick-filters" role="group" aria-label="快速筛选">
              <fieldset className="taste-segments">
                <legend className="sr-only">口味筛选</legend>
                {tasteFilters.map((filter) => <label key={filter.label}>
                  <input className="sr-only" type="radio" name="quick-taste" value={filter.label} checked={tasteFilter === filter.label} onChange={() => { setTasteFilter(filter.label); setBatch(0) }} />
                  <span className="taste-segment"><Icon name={filter.icon} size={16} />{filter.label}</span>
                </label>)}
              </fieldset>
              <label className="budget-select"><span>更多口味</span><select aria-label="今天的口味" value={tasteFilter} onChange={(event) => { setTasteFilter(event.target.value); setBatch(0) }}><option value="全部">不限制口味</option>{tasteOptions.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}</select></label>
              {mode === 'cook' ? <div className="time-choices" role="group" aria-label="可接受用时">{([{ value: 0, label: '不限时间' }, { value: 15, label: '15 分钟快手' }, { value: 30, label: '30 分钟' }, { value: 60, label: '60 分钟' }] as const).map((option) => <button key={option.value} type="button" className="time-filter" aria-pressed={timeChoice === option.value} onClick={() => { setTimeChoice((current) => option.value !== 0 && current === option.value ? 0 : option.value); setBatch(0) }}><Icon name={option.value !== 0 && timeChoice === option.value ? 'check' : 'clock'} size={16} />{option.label}</button>)}</div> : <label className="budget-select"><span>预算偏好</span><select aria-label="预算偏好" value={budget} onChange={(event) => { setBudget(event.target.value as typeof budget); setBatch(0) }}>{budgetOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>}
            </div>
            {mode === 'cook' && <details className="more-conditions">
              <summary><Icon name="sliders" size={15} />更多条件<span className="more-conditions-hint">用餐人数 · 推荐历史</span></summary>
              <div className="more-conditions-body">
                <label className="budget-select"><span>用餐人数</span><select aria-label="用餐人数" value={servings} onChange={(event) => { setServings(Number(event.target.value)); setBatch(0) }}>{[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count} 人</option>)}</select></label>
                <div className="history-note">
                  <p>{history.length ? `已记住最近 ${history.length} 道推荐菜名，「帮我决定」和「换一道」会尽量避开它们。` : '生成后会自动记住最近推荐的菜名（最多 20 道，仅存本机），新推荐尽量不重复。'}</p>
                  <button type="button" className="text-button" disabled={!history.length} onClick={() => { setHistory(clearHistory()); setNotice({ text: '已清除推荐历史，之后的推荐不再避开旧菜名。' }) }}><Icon name="close" size={14} />清除推荐历史</button>
                </div>
              </div>
            </details>}
            {mode === 'out' && <p className="mode-disclaimer">预算为菜品相对成本的示例估计，仅影响推荐顺序，不是商家报价。这里只推荐菜品，不提供餐厅、位置或营业信息。</p>}
            {state.preferences.configured && <p className="filter-summary">按口味档案筛选：{preferenceSummary}<a href="#preferences">调整</a></p>}
            <GenerationPanel generation={generation} label={mode === 'cook' ? '帮我决定' : 'AI 帮我推荐'} excludedRecipeNames={mode === 'cook' ? history : []} />
            {featured ? <div className="home-layout">
              <section className="featured-section" aria-labelledby="featured-title">
                <div className="section-heading"><div><span className="section-dot" /><h2 id="featured-title">今天，就吃这道吧</h2></div>{(!generation.result || ordered.length > 3) && <button className="text-button shuffle-button" type="button" disabled={ordered.length < 2} onClick={() => { setBatch((current) => current + 1); setNotice({ text: generation.result ? `已切换本次候选，共 ${ordered.length} 道；未再次请求 AI。` : `已切换主推，当前共有 ${ordered.length} 道匹配的 Demo 菜谱。` }) }}><Icon name="refresh" size={15} />{generation.result ? '浏览本次候选' : '换一批'}</button>}</div>
                <article className="featured-card" aria-label="今日主推菜谱">
                  <div className="featured-visual"><a href={recipeHref(featured.id)} aria-label={`查看${featured.name}${mode === 'cook' ? '做法' : '点餐建议'}`}><FoodImage key={featured.id} src={featured.image} alt={featured.photoAlt} category={featured.generation?.recipe.imageFallbackCategory ?? featured.imageFallbackCategory} priority illustrative={!!featured.generation?.photo} /></a><span className="featured-badge"><Icon name="spark" size={14} />{mode === 'cook' ? '今日主推' : '今日点餐灵感'}</span><SaveButton recipe={featured} saved={state.saved.includes(featured.id)} onToggle={toggleSave} /><span className="image-note">{servings === 1 ? '一人食，也要认真吃' : `${servings} 人份，也要认真吃`}</span>{canReplace && generation.replacing.includes(featured.id) && <div className="swap-overlay" role="status"><span className="generation-progress" aria-hidden="true" /><span>正在换一道…</span></div>}</div>
                  <div className="featured-copy"><div className="featured-name"><div><span className="recipe-kicker">{featured.kicker}</span><h3>{featured.name}</h3></div>{mode === 'cook' ? <span className="recipe-time"><Icon name="clock" size={17} /><strong>{featured.minutes}</strong> 分钟</span> : <span className="dining-category"><Icon name="dining" size={17} />{featured.dining.category}</span>}</div><p className="featured-reason"><Icon name="spark" size={15} />{featuredResult.reasons.join('；')}</p>{mode === 'out' && <p className="ordering-preview">{featured.dining.orderingTip}</p>}{canReplace && generation.replaceErrors[featured.id] && <p className="swap-error" role="alert">{generation.replaceErrors[featured.id]}</p>}<div className="featured-bottom"><div className="tag-row">{featured.tastes.slice(0, 2).map((taste) => <span key={taste}>{taste}</span>)}<span>{mode === 'cook' ? featured.difficulty : '菜品灵感'}</span></div><div className="featured-actions">{canReplace && <button type="button" className="text-button swap-button" disabled={generation.replacing.includes(featured.id)} onClick={() => void generation.replaceRecipe(featured.id, replaceExclusions)}><Icon name="refresh" size={14} />{generation.replacing.includes(featured.id) ? '正在换一道…' : '换一道'}</button>}<a className="primary-button" href={recipeHref(featured.id)}>{mode === 'cook' ? '看看做法' : '点餐建议'}<Icon name="arrow" size={17} /></a></div></div></div>
                </article>
                <p className="ranking-note">{generation.result ? `本次生成 ${recommendations.length} 道菜品；「重新生成一批」会重新请求后端，「换一道」只替换对应卡片，同样各计一次请求。` : `按规则得分排序，同分按菜谱库顺序。换一批按此顺序轮换主推，不生成新菜；当前第 ${offset + 1} / ${recommendations.length} 道。`}</p>
              </section>
              <aside className="more-section">
                <div className="section-heading"><h2>再来一点灵感</h2><span className="section-caption">{ordered.length > 1 ? '换个口味，也不错' : '慢慢找到喜欢的'}</span></div>
                {ordered.length > 1 ? <div className="more-grid">{ordered.slice(1, 3).map((item) => <RecipeCard key={item.recipe.id} recipe={item.recipe} mode={mode} reasons={item.reasons} saved={state.saved.includes(item.recipe.id)} onToggle={toggleSave} onReplace={canReplace ? () => void generation.replaceRecipe(item.recipe.id, replaceExclusions) : undefined} replacing={generation.replacing.includes(item.recipe.id)} replaceError={generation.replaceErrors[item.recipe.id] ?? ''} />)}</div> : <p className="single-match">{generation.result ? '本次仅返回这一道通过校验的候选。' : '目前只有这道 Demo 菜谱符合选择。'}<a href="#preferences">调整口味</a>，看看其他灵感。</p>}
                <a className="preference-note" href="#preferences"><span className="note-icon"><Icon name="leaf" size={26} /></span><div><span className="small-eyebrow">每一口，都更懂你一点</span><h3>你的口味，你说了算</h3><p>清爽或浓郁，快手或慢慢做。<br />下一顿，从你喜欢的开始。</p><span className="note-link">{state.preferences.configured ? '调整我的口味' : '定制我的口味'}<Icon name="arrow" size={16} /></span></div><Icon name="leaf" size={98} /></a>
                <div className="quiet-note"><Icon name="bowl" size={18} /><span>好好吃饭，是照顾自己的小事。</span></div>
              </aside>
            </div> : <section className="empty-state"><span className="empty-icon"><Icon name="bowl" size={36} /></span><h2>这个口味，还在准备中</h2><p>目前只有 {recipes.length} 道 Demo 菜谱，没有符合全部条件的选择。<br />可以调整口味，或清除筛选查看全部。</p><div className="empty-actions"><a href="#preferences" className="secondary-button">调整口味</a><button type="button" className="primary-button" onClick={() => { setTasteFilter('全部'); setTimeChoice(0); setBudget('any'); setBatch(0); persist({ ...state, preferences: emptyPreferences() }, '已清除筛选，显示全部 Demo 菜谱。') }}>查看全部菜谱<Icon name="arrow" size={17} /></button></div></section>}
          </>}
        </main>
      )}
      {!isPreferences && <PhotoCredits generated={generated.length > 0 || !!state.generatedSnapshots?.length} photoRecipes={allRecipes.filter((item) => item.generation?.photo)} />}
      {!isDetail && !isPreferences && <Navigation hash={isSaved ? '#saved' : isFridge ? '#fridge' : '#home'} count={state.saved.length} mobile />}
      <div className={`toast ${notice ? 'is-visible' : ''}`} role="status" aria-live="polite">{notice && <><Icon name="check" size={18} /><span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></>}</div>
    </div>
  )
}
