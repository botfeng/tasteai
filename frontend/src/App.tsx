import { useEffect, useRef, useState } from 'react'
import type { DemoState, Preferences } from './data/preferences'
import { emptyPreferences, matchingRecipes, readDemoState, storageKey } from './data/preferences'
import { recipes } from './data/recipes'
import FoodImage from './components/FoodImage'
import Icon from './components/Icon'
import type { IconName } from './components/Icon'
import PreferencesPage from './components/PreferencesPage'
import RecipeCard, { SaveButton } from './components/RecipeCard'
import RecipePage from './components/RecipePage'
import ServiceStatus from './components/ServiceStatus'

const navigation: { href: string; label: string; icon: IconName }[] = [
  { href: '#home', label: '今日推荐', icon: 'bowl' },
  { href: '#saved', label: '我的收藏', icon: 'heart' },
  { href: '#preferences', label: '口味偏好', icon: 'sliders' },
]
const tasteFilters: { label: string; icon: IconName }[] = [
  { label: '全部', icon: 'spark' },
  { label: '清爽', icon: 'leaf' },
  { label: '浓郁', icon: 'bowl' },
]

function Navigation({ hash, count, mobile = false }: { hash: string; count: number; mobile?: boolean }) {
  return <nav className={mobile ? 'mobile-navigation' : 'desktop-navigation'} aria-label={mobile ? '底部导航' : '主导航'}>{navigation.map((item) => <a key={item.href} href={item.href} className={hash === item.href ? 'is-active' : ''} aria-current={hash === item.href ? 'page' : undefined}><Icon name={item.icon} size={mobile ? 22 : 18} /><span>{item.label}</span>{item.href === '#saved' && count > 0 && <span className="nav-count">{count}</span>}</a>)}</nav>
}

function PhotoCredits() {
  return <footer className="site-footer"><span>TasteAI <span className="footer-dot">·</span> 今天也要好好吃饭</span><span>本地 Demo 菜谱 · 非模型推荐</span><details className="photo-credits"><summary>摄影与素材来源</summary><div>{recipes.map((recipe) => <p key={recipe.id}><span>{recipe.name}：</span><a href={recipe.credit.sourceUrl} target="_blank" rel="noreferrer">{recipe.credit.author}</a><span> / </span><a href={recipe.credit.licenseUrl} target="_blank" rel="noreferrer">{recipe.credit.license}</a></p>)}<p>摄影为摆盘参考，示例配方由本项目独立编写。</p></div></details></footer>
}

export default function App() {
  const [hash, setHash] = useState(() => window.location.hash || '#home')
  const [state, setState] = useState<DemoState>(readDemoState)
  const [tasteFilter, setTasteFilter] = useState('全部')
  const [quickTime, setQuickTime] = useState(false)
  const [batch, setBatch] = useState(0)
  const [notice, setNotice] = useState<{ text: string } | null>(null)
  const returnTo = useRef('#home')
  const previousHash = useRef(window.location.hash || '#home')
  const restoreSavedFocus = useRef(false)
  const isPreferences = hash === '#preferences'
  const isSaved = hash === '#saved'
  const isDetail = hash.startsWith('#recipe/')
  const recipe = isDetail ? recipes.find((item) => item.id === hash.slice('#recipe/'.length)) : undefined

  useEffect(() => {
    const onHashChange = () => {
      const next = window.location.hash || '#home'
      if (next.startsWith('#recipe/')) {
        const entry = window.history.state
        const storedOrigin = entry?.tasteaiRecipe === next && ['#home', '#saved'].includes(entry?.tasteaiReturnTo) ? entry.tasteaiReturnTo : null
        returnTo.current = storedOrigin ?? (previousHash.current === '#saved' ? '#saved' : previousHash.current.startsWith('#recipe/') ? returnTo.current : '#home')
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
    document.title = `${isPreferences ? '认识你的口味' : recipe?.name ?? (isSaved ? '我的收藏' : '今天吃点喜欢的')} · TasteAI`
    document.querySelector<HTMLHeadingElement>('main h1')?.focus({ preventScroll: true })
  }, [hash, isPreferences, isSaved, recipe])

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
    persist({ ...state, saved: exists ? state.saved.filter((item) => item !== id) : [...state.saved, id] }, exists ? '已取消收藏' : '已放进收藏，想吃的时候再来找它。')
  }

  function completePreferences(preferences: Preferences) {
    persist({ ...state, preferences }, '口味已记下，来看看这一餐的灵感。')
    setTasteFilter('全部')
    setQuickTime(false)
    setBatch(0)
    window.location.hash = '#home'
  }

  const matching = matchingRecipes(state.preferences)
  const filtered = matching.filter((item) =>
    (tasteFilter === '全部' || item.tastes.includes(tasteFilter)) && (!quickTime || item.minutes <= 15),
  )
  const offset = filtered.length ? batch % filtered.length : 0
  const ordered = [...filtered.slice(offset), ...filtered.slice(0, offset)]
  const featured = ordered[0]
  const savedRecipes = recipes.filter((item) => state.saved.includes(item.id))
  const preferenceSummary = [...state.preferences.tastes, ...state.preferences.ingredients, ...(state.preferences.maxMinutes ? [`${state.preferences.maxMinutes} 分钟内`] : [])].join(' · ') || '不设限，什么好吃就吃什么'

  if (hash === '#service') return <ServiceStatus />

  return (
    <div className={`app-shell ${isDetail ? 'view-detail' : ''} ${isPreferences ? 'view-preferences' : ''}`}>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); document.querySelector<HTMLHeadingElement>('main h1')?.focus() }}>跳到主要内容</a>
      <header className="site-header">
        <a className="brand" href="#home" aria-label="TasteAI 首页"><span className="brand-mark"><Icon name="bowl" size={23} /></span><span>Taste<span className="brand-ai">AI</span></span><small>一餐一味，刚好是你</small></a>
        <Navigation hash={isDetail ? '' : isPreferences || isSaved ? hash : '#home'} count={state.saved.length} />
        <a className="header-preferences" href="#preferences" aria-label="调整口味偏好"><Icon name="sliders" size={16} /><span>调整口味</span><Icon name="chevron" size={14} /></a>
      </header>

      {isPreferences ? <PreferencesPage preferences={state.preferences} onComplete={completePreferences} /> : isDetail ? recipe ? <RecipePage key={recipe.id} recipe={recipe} saved={state.saved.includes(recipe.id)} onToggle={toggleSave} returnTo={returnTo.current} /> : <main className="not-found"><Icon name="book" size={44} /><h1 tabIndex={-1}>这道菜暂时不在小厨房</h1><p>回到首页，再挑一道喜欢的吧。</p><a className="primary-button" href="#home">看看今日推荐<Icon name="arrow" /></a></main> : (
        <main id="main-content" className="home-page page-enter">
          <section className="home-intro">
            <div><p className="greeting"><Icon name="sun" size={17} />把今天，过得有滋有味</p><h1 tabIndex={-1}>{isSaved ? '喜欢的味道，留给下一餐' : '今天，吃点喜欢的。'}</h1><p className="intro-subtitle">{isSaved ? `${savedRecipes.length} 道心动菜谱，只存在你的浏览器里。` : '不必纠结，一顿好饭的灵感就在这里。'}</p></div>
            <a className="taste-profile" href="#preferences"><Icon name="sliders" size={16} /><span>调整口味</span><Icon name="chevron" size={14} /></a>
          </section>

          {isSaved ? savedRecipes.length ? <section className="saved-grid" aria-label="已收藏菜谱">{savedRecipes.map((item) => <RecipeCard key={item.id} recipe={item} saved onToggle={toggleSave} />)}</section> : <section className="empty-state"><span className="empty-icon"><Icon name="heart" size={36} /></span><h2>把想吃的，先收好</h2><p>遇到喜欢的菜谱，点一下爱心。<br />下一餐的灵感，就不会溜走了。</p><a href="#home" className="primary-button">去找一道喜欢的<Icon name="arrow" size={18} /></a></section> : <>
            <div className="quick-filters" role="group" aria-label="快速筛选">
              <fieldset className="taste-segments">
                <legend className="sr-only">口味筛选</legend>
                {tasteFilters.map((filter) => <label key={filter.label}>
                  <input className="sr-only" type="radio" name="quick-taste" value={filter.label} checked={tasteFilter === filter.label} onChange={() => { setTasteFilter(filter.label); setBatch(0) }} />
                  <span className="taste-segment"><Icon name={filter.icon} size={16} />{filter.label}</span>
                </label>)}
              </fieldset>
              <button type="button" className="time-filter" aria-pressed={quickTime} onClick={() => { setQuickTime((current) => !current); setBatch(0) }}><Icon name={quickTime ? 'check' : 'clock'} size={16} />15 分钟快手</button>
            </div>
            {state.preferences.configured && <p className="filter-summary">按口味档案筛选：{preferenceSummary}<a href="#preferences">调整</a></p>}
            {featured ? <div className="home-layout">
              <section className="featured-section" aria-labelledby="featured-title">
                <div className="section-heading"><div><span className="section-dot" /><h2 id="featured-title">今天，就吃这道吧</h2></div><button className="text-button shuffle-button" type="button" disabled={ordered.length < 2} onClick={() => { setBatch((current) => current + 1); setNotice({ text: `已切换主推，当前共有 ${ordered.length} 道匹配的 Demo 菜谱。` }) }}><Icon name="refresh" size={15} />换一批</button></div>
                <article className="featured-card" aria-label="今日主推菜谱">
                  <div className="featured-visual"><a href={`#recipe/${featured.id}`} aria-label={`查看${featured.name}做法`}><FoodImage key={featured.id} src={featured.image} alt={featured.photoAlt} priority /></a><span className="featured-badge"><Icon name="spark" size={14} />今日主推</span><SaveButton recipe={featured} saved={state.saved.includes(featured.id)} onToggle={toggleSave} /><span className="image-note">一人食，也要认真吃</span></div>
                  <div className="featured-copy"><div className="featured-name"><div><span className="recipe-kicker">{featured.kicker}</span><h3>{featured.name}</h3></div><span className="recipe-time"><Icon name="clock" size={17} /><strong>{featured.minutes}</strong> 分钟</span></div><p className="featured-reason"><Icon name="spark" size={15} />{featured.reason}</p><div className="featured-bottom"><div className="tag-row">{featured.tastes.slice(0, 2).map((taste) => <span key={taste}>{taste}</span>)}<span>{featured.difficulty}</span></div><a className="primary-button" href={`#recipe/${featured.id}`}>看看做法<Icon name="arrow" size={17} /></a></div></div>
                </article>
              </section>
              <aside className="more-section">
                <div className="section-heading"><h2>再来一点灵感</h2><span className="section-caption">{ordered.length > 1 ? '换个口味，也不错' : '慢慢找到喜欢的'}</span></div>
                {ordered.length > 1 ? <div className="more-grid">{ordered.slice(1).map((item) => <RecipeCard key={item.id} recipe={item} saved={state.saved.includes(item.id)} onToggle={toggleSave} />)}</div> : <p className="single-match">目前只有这道 Demo 菜谱符合选择。<a href="#preferences">调整口味</a>，看看其他灵感。</p>}
                <a className="preference-note" href="#preferences"><span className="note-icon"><Icon name="leaf" size={26} /></span><div><span className="small-eyebrow">每一口，都更懂你一点</span><h3>你的口味，你说了算</h3><p>清爽或浓郁，快手或慢慢做。<br />下一顿，从你喜欢的开始。</p><span className="note-link">{state.preferences.configured ? '调整我的口味' : '定制我的口味'}<Icon name="arrow" size={16} /></span></div><Icon name="leaf" size={98} /></a>
                <div className="quiet-note"><Icon name="bowl" size={18} /><span>好好吃饭，是照顾自己的小事。</span></div>
              </aside>
            </div> : <section className="empty-state"><span className="empty-icon"><Icon name="bowl" size={36} /></span><h2>这个口味，还在准备中</h2><p>目前只有 {recipes.length} 道 Demo 菜谱，没有符合全部条件的选择。<br />可以调整口味，或清除筛选查看全部。</p><div className="empty-actions"><a href="#preferences" className="secondary-button">调整口味</a><button type="button" className="primary-button" onClick={() => { setTasteFilter('全部'); setQuickTime(false); setBatch(0); persist({ ...state, preferences: emptyPreferences() }, '已清除筛选，显示全部 Demo 菜谱。') }}>查看全部菜谱<Icon name="arrow" size={17} /></button></div></section>}
          </>}
        </main>
      )}
      {!isPreferences && <PhotoCredits />}
      {!isDetail && !isPreferences && <Navigation hash={isSaved ? '#saved' : '#home'} count={state.saved.length} mobile />}
      <div className={`toast ${notice ? 'is-visible' : ''}`} role="status" aria-live="polite">{notice && <><Icon name="check" size={18} /><span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={15} /></button></>}</div>
    </div>
  )
}
