import { useRef, useState } from 'react'
import { tasteOptions } from '../data/preferences'
import type { Preferences } from '../data/preferences'
import { snapshots, toRecipe } from '../data/generation'
import type { GenerationResponse } from '../data/generation'
import { attachPhoto } from '../data/photos'
import type { PhotoMap } from '../data/photos'
import { useGeneration } from '../data/useGeneration'
import GenerationPanel from './GenerationPanel'
import RecipeCard from './RecipeCard'
import { recipes } from '../data/recipes'
import { ingredientCatalog, ingredientId, kitchenBasics, normalizeIngredient, parseIngredients } from '../data/ingredients'
import { pantryDraftLimit, pantryItemLimit, pantryStorageKey, readPantry } from '../data/pantry'
import type { PantryState } from '../data/pantry'
import { recommendByIngredients } from '../data/recommendations'
import FoodImage from './FoodImage'
import Icon from './Icon'
import { SaveButton } from './RecipeCard'

const statusLabels = { ready: '主要食材齐全', almost: '还缺少少量材料', insufficient: '当前食材不足' }

export default function FridgePage({ preferences, saved, onToggle, onGenerated, photos }: {
  preferences: Preferences
  saved: string[]
  onToggle: (id: string) => void
  onGenerated: (response: GenerationResponse) => void
  photos: PhotoMap
}) {
  const [pantry, setPantry] = useState(readPantry)
  const [feedback, setFeedback] = useState('')
  const [storageError, setStorageError] = useState(false)
  const [strict, setStrict] = useState(true)
  const [servings, setServings] = useState(1)
  const [taste, setTaste] = useState('')
  const selectedIds = pantry.items.map(ingredientId).filter((id): id is string => !!id)
  const generation = useGeneration({ scene: 'fridge', ingredientIds: selectedIds, tastePreferences: preferences.tastes, todayTaste: taste || null, preferredCategories: preferences.ingredients, timeLimit: null, budgetLevel: null, servings, strictIngredients: strict, assumeBasics: pantry.assumeBasics }, onGenerated)
  const query = pantry.draft.normalize('NFKC').trim()
  const visibleIngredients = ingredientCatalog.filter((item) => !query || [item.name, ...item.aliases].some((name) => name.includes(query))).map((item) => item.name)
  const input = useRef<HTMLInputElement>(null)
  const results = recommendByIngredients(recipes, { ingredients: pantry.items, assumeBasics: pantry.assumeBasics, preferences, saved })
  const unknown = pantry.items.filter((item) => !normalizeIngredient(item))

  function update(next: PantryState) {
    setPantry(next)
    try {
      localStorage.setItem(pantryStorageKey, JSON.stringify(next))
      setStorageError(false)
    } catch {
      setStorageError(true)
    }
  }

  function addIngredients(text: string) {
    if (!text.trim()) {
      setFeedback('先写下一种食材，或从下方选择。')
      input.current?.focus()
      return
    }
    const parsed = parseIngredients(text)
    const names = [...parsed.recognized, ...parsed.unknown]
    const tooLong = names.filter((name) => name.length > 30)
    const additions = parsed.recognized.filter((name) => !pantry.items.includes(name))
    const combined = [...pantry.items, ...additions]
    const duplicates = [...new Set([...parsed.duplicates, ...names.filter((name) => pantry.items.includes(name))])]
    const messages = [
      additions.length ? `已添加 ${Math.min(additions.length, pantryItemLimit - pantry.items.length)} 种食材。` : '',
      duplicates.length ? `重复食材已合并：${duplicates.join('、')}。` : '',
      parsed.unknown.length ? `目录中暂未找到：${parsed.unknown.join('、')}。未添加，也不会提交给 AI；请从目录选择。` : '',
      tooLong.length ? '食材名称请控制在 30 字以内，过长名称未添加。' : '',
      combined.length > pantryItemLimit ? `最多保留 ${pantryItemLimit} 种，请先删除一些再添加。` : '',
    ]
    update({ ...pantry, items: combined.slice(0, pantryItemLimit), draft: parsed.unknown.length || tooLong.length || combined.length > pantryItemLimit ? text : '' })
    setFeedback(messages.filter(Boolean).join(' '))
    input.current?.focus()
  }

  function removeIngredient(name: string) {
    update({ ...pantry, items: pantry.items.filter((item) => item !== name) })
    setFeedback(`已移除${name}。`)
    input.current?.focus()
  }

  return <main id="main-content" className="home-page fridge-page page-enter">
    <section className="home-intro">
      <div><p className="greeting"><Icon name="fridge" size={17} />让手边的食材，好好相遇</p><h1 tabIndex={-1}>冰箱里有什么？</h1><p className="intro-subtitle">少买一点，也能认真做一餐。先看看你手边有什么。</p></div>
      <span className="local-note"><Icon name="leaf" size={16} />只保存在这台设备</span>
    </section>
    <div className="fridge-layout">
      <section className="pantry-panel" aria-labelledby="pantry-title">
        <div className="section-heading"><h2 id="pantry-title">我的食材篮</h2><span className="section-caption">{pantry.items.length} / {pantryItemLimit} 种</span></div>
        <form onSubmit={(event) => { event.preventDefault(); addIngredients(pantry.draft) }}>
          <label className="input-label" htmlFor="pantry-input">添加你有的食材</label>
          <div className="ingredient-input-row"><input ref={input} id="pantry-input" type="text" maxLength={pantryDraftLimit} value={pantry.draft} placeholder="例如：西红柿、鸡蛋、黄瓜" aria-describedby="pantry-input-hint pantry-feedback" onChange={(event) => update({ ...pantry, draft: event.target.value })} /><button className="primary-button" type="submit">添加<Icon name="arrow" size={17} /></button></div>
          <p id="pantry-input-hint" className="pantry-hint">搜索目录后点选，或输入标准名称点「添加」确认；西红柿会记作番茄。仅目录内食材可提交。</p>
          <p id="pantry-feedback" className="pantry-feedback" role="status" aria-live="polite">{feedback}</p>
        </form>
        {storageError && <p role="alert" className="pantry-warning">食材已在本次页面生效，但浏览器无法保存，刷新可能丢失。</p>}
        {pantry.items.length > 0 ? <ul className="ingredient-tokens" aria-label="已选食材">{pantry.items.map((name) => <li key={name} className={normalizeIngredient(name) ? '' : 'is-unknown'}><span>{name}{!normalizeIngredient(name) && <small>待识别</small>}</span><button type="button" aria-label={`删除${name}`} onClick={() => removeIngredient(name)}><Icon name="close" size={14} /></button></li>)}</ul> : <p className="basket-empty">食材篮还是空的。写下来，或轻点下方添加。</p>}
        <div className="section-heading pantry-subheading"><h3>常见食材</h3><span className="section-caption">轻点选择</span></div>
        <div role="group" aria-label="常见食材快捷选择"><div className="common-ingredients">{visibleIngredients.slice(0, 9).map((name) => <button type="button" key={name} aria-pressed={pantry.items.includes(name)} onClick={() => pantry.items.includes(name) ? removeIngredient(name) : addIngredients(name)}><span>{name}</span><Icon name={pantry.items.includes(name) ? 'check' : 'leaf'} size={15} /></button>)}</div><details className="more-ingredients"><summary>更多常见食材<Icon name="chevron" size={14} /></summary><div className="common-ingredients">{visibleIngredients.slice(9).map((name) => <button type="button" key={name} aria-pressed={pantry.items.includes(name)} onClick={() => pantry.items.includes(name) ? removeIngredient(name) : addIngredients(name)}><span>{name}</span><Icon name={pantry.items.includes(name) ? 'check' : 'leaf'} size={15} /></button>)}</div></details></div>
        <div className="pantry-basics"><label><input type="checkbox" checked={pantry.assumeBasics} onChange={(event) => update({ ...pantry, assumeBasics: event.target.checked })} /><span>我有基础厨房材料<strong>{kitchenBasics.join('、')}</strong></span></label><p>默认勾选，仅补齐这四种。酱油、蛋黄酱等仍逐项检查；取消勾选后，基础材料也需自己添加。</p></div>
        {!visibleIngredients.length && <p className="pantry-hint">没有对应的目录食材，请尝试其他名称。</p>}
        <div className="generation-options"><label><input type="checkbox" checked={strict} onChange={(event) => setStrict(event.target.checked)} />仅使用现有主要食材</label><p className="pantry-hint">严格模式下不会补充主要食材；额外调味料也必须明确列出。</p><label className="budget-select"><span>今天的口味</span><select value={taste} onChange={(event) => setTaste(event.target.value)}><option value="">不限制口味</option>{tasteOptions.map((item) => <option key={item.label}>{item.label}</option>)}</select></label><label className="budget-select"><span>用餐份量</span><select value={servings} onChange={(event) => setServings(Number(event.target.value))}>{[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count} 人</option>)}</select></label></div>
        <p className="pantry-hint">按食材种类匹配，不核算数量、保质期或过敏原安全。请在开做前核对详情。</p>
      </section>
      <section className="pantry-results" aria-labelledby="pantry-results-title">
        <GenerationPanel generation={generation} label="AI 生成菜谱" disabledMessage={!selectedIds.length ? '先从食材目录选择几样已有食材。' : ''} />
        <div className="section-heading"><h2 id="pantry-results-title">这一餐，有这些可能</h2><span className="section-caption">{generation.result ? generation.result.recipes.length : results.length} 道{generation.result ? '生成' : '匹配'}</span></div>
        {generation.result ? generation.result.recipes.length ? <div className="generated-fridge-grid">{snapshots(generation.result).map((snapshot) => <RecipeCard key={snapshot.recipe.id} recipe={toRecipe(attachPhoto(snapshot, photos))} saved={saved.includes(snapshot.recipe.id)} onToggle={onToggle} reasons={[snapshot.recipe.recommendationReason]} />)}</div> : <div className="empty-state pantry-empty"><Icon name="fridge" size={36} /><h3>这些食材，暂时没有合理的做法</h3><p>不为了凑数编造菜谱。可以补充食材或调整条件，再试一次。</p></div> : <>
        <p className="pantry-hint">本地规则示例：按必需食材覆盖率排序；覆盖率不是成功概率。</p>
        {unknown.length > 0 && <p className="pantry-warning">暂不认识：{unknown.join('、')}。这些名称未计入覆盖率。</p>}
        {results.length ? <div className="ingredient-results-list">{results.map((result) => <article key={result.recipe.id} className="ingredient-result" aria-label={`${result.recipe.name}匹配结果`}>
          <div className="ingredient-result-top"><a href={`#recipe/${result.recipe.id}`} className="ingredient-result-photo" tabIndex={-1} aria-hidden="true"><FoodImage src={result.recipe.image} alt="" category={result.recipe.imageFallbackCategory} /></a><div className="ingredient-result-heading"><span className={`match-status ${result.status}`}>{statusLabels[result.status]}</span><h3><a href={`#recipe/${result.recipe.id}`}>{result.recipe.name}</a></h3><div className="recipe-meta"><span><Icon name="clock" size={14} />{result.recipe.minutes} 分钟</span><span>必需食材 {Math.round(result.coverage * 100)}%</span></div></div><SaveButton recipe={result.recipe} saved={saved.includes(result.recipe.id)} onToggle={onToggle} /></div>
          <div className="coverage-track" role="meter" aria-label={`${result.recipe.name}必需食材覆盖率`} aria-valuenow={Math.round(result.coverage * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${result.coverage * 100}%` }} /></div>
          <dl className="match-ingredients"><div><dt>已有食材</dt><dd>{result.available.join('、') || '暂无'}</dd></div><div className={result.missingRequired.length ? 'missing-core' : ''}><dt>缺少必需</dt><dd>{result.missingRequired.join('、') || '主要食材已齐；仍需核对用量及调味料'}</dd></div><div><dt>缺少调味</dt><dd>{result.missingSeasonings.join('、') || '无；基础材料按已选假设处理'}</dd></div></dl>
          {result.missingRequired.length > 0 && <p className="core-warning">核心材料未齐，请补齐后再做。</p>}
          <details className="match-details"><summary>查看匹配依据与可选材料<Icon name="chevron" size={14} /></summary><p>{result.reasons.join('；')}</p><p>默认已有：{result.assumedBasics.join('、') || '无'}。</p><p>可选未备：{result.missingOptional.join('、') || '无'}；可省略，不计入必需食材覆盖率。</p></details>
          <a className="text-button match-link" href={`#recipe/${result.recipe.id}`}>查看食材与做法<Icon name="arrow" size={16} /></a>
        </article>)}</div> : <div className="empty-state pantry-empty"><span className="empty-icon"><Icon name="fridge" size={36} /></span><h2>{pantry.items.length ? '暂时还搭不成这一餐' : '打开冰箱，灵感就在里面'}</h2><p>{pantry.items.length ? `现有 ${recipes.length} 道示例菜谱，没有命中必需食材。可以添加其他食材；仅有调味料不会算作匹配。` : '添加几样食材，就能看到已有、缺少的材料和匹配顺序。没有的核心材料，我们不会替你略过。'}</p><button className="secondary-button" type="button" onClick={() => addIngredients('番茄、螺旋面、大蒜、番茄膏、罗勒')}>试试意面食材<Icon name="arrow" size={16} /></button></div>}
        </>}
      </section>
    </div>
  </main>
}
