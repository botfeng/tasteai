import { useState } from 'react'
import type { DiningMode, Recipe } from '../data/recipes'
import { budgetOptions } from '../data/recommendations'
import FoodImage from './FoodImage'
import Icon from './Icon'
import { SaveButton } from './RecipeCard'

export default function RecipePage({ recipe, saved, onToggle, returnTo, mode = 'cook', reasons }: {
  recipe: Recipe
  saved: boolean
  onToggle: (id: string) => void
  returnTo: string
  mode?: DiningMode
  reasons?: string[]
}) {
  const [prepared, setPrepared] = useState<string[]>([])
  const generated = recipe.generation
  const isOut = generated ? generated.scene === 'eat_out' : mode === 'out'
  const servings = generated?.servings ?? 1

  function startCooking() {
    const steps = document.getElementById('recipe-steps')
    steps?.focus({ preventScroll: true })
    steps?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
  }

  return (
    <main id="main-content" className={`detail-page page-enter ${isOut ? 'dining-detail' : ''}`}>
      <div className="detail-toolbar"><a className="icon-button" href={returnTo} aria-label="返回菜谱列表"><Icon name="back" /></a><span>{isOut ? '今天的点餐灵感' : '今日的好味道'}</span><SaveButton recipe={recipe} saved={saved} onToggle={onToggle} /></div>
      <div className="detail-top">
        <div className="detail-photo"><div className="detail-photo-frame"><FoodImage src={recipe.image} alt={recipe.photoAlt} category={generated?.recipe.imageFallbackCategory ?? recipe.imageFallbackCategory} priority illustrative={!!generated?.photo} /><span className="photo-caption"><Icon name="leaf" size={14} />把一餐，过成喜欢的样子</span></div>{generated?.photo && <p className="photo-attribution">菜品示意图，非本菜谱实拍 · 摄影：<a href={generated.photo.photographerUrl} target="_blank" rel="noreferrer">{generated.photo.photographer}</a> · <a href={generated.photo.pageUrl} target="_blank" rel="noreferrer">原始图片页</a> · <a href={generated.photo.licenseUrl} target="_blank" rel="noreferrer">{generated.photo.license}</a></p>}</div>
        <section className="detail-intro">
          <div className="detail-eyebrow"><span>{recipe.kicker}</span><span>{generated ? generated.source === 'mock' ? 'Mock 演示 · 非真实 AI' : 'AI 生成 · 未经人工审核' : 'Demo 菜谱'}</span></div>
          <h1 tabIndex={-1}>{recipe.name}</h1>
          <p className="detail-description">{generated ? recipe.description : isOut ? `想吃${recipe.tastes.join('、')}的味道时，可以把${recipe.dining.category}作为今天的点餐方向。以下是菜品层面的建议，不代表任何商家菜单。` : recipe.description}</p>
          {isOut ? <div className="detail-facts dining-facts"><div><Icon name="dining" /><span><strong>{recipe.dining.category}</strong><small>餐饮类别</small></span></div><div><Icon name="bowl" /><span><strong>{generated ? '类别与组合建议' : budgetOptions.find((option) => option.value === recipe.dining.budget)?.label}</strong><small>相对成本示例，非报价</small></span></div></div> : <div className="detail-facts"><div><Icon name="clock" /><span><strong>{recipe.minutes} 分钟</strong><small>预计总用时</small></span></div><div><Icon name="chef" /><span><strong>{recipe.difficulty}</strong><small>制作难度</small></span></div><div><Icon name="portion" /><span><strong>{servings} 人份</strong><small>刚好一餐</small></span></div></div>}
          <div className="reason-note"><Icon name="spark" size={19} /><div><strong>{reasons?.length ? '今天推荐它的理由' : '这道菜的风味'}</strong><p>{reasons?.join('；') || (isOut ? `${recipe.tastes.join('、')}风味，${recipe.dining.category}类菜品。` : recipe.reason)}</p></div></div>
          <div className="tag-row">{recipe.tastes.map((taste) => <span key={taste}>{taste}</span>)}<span>{recipe.category}</span></div>
          {!isOut && <button type="button" className="primary-button desktop-cook" onClick={startCooking}>开始做这道菜<Icon name="arrow" size={18} /></button>}
        </section>
      </div>
      {isOut ? <section className="dining-advice" aria-labelledby="ordering-title"><div><span className="small-eyebrow">不赶着下厨，慢慢选一餐</span><h2 id="ordering-title">点餐时，可以这样选</h2><p>{recipe.dining.orderingTip}</p><p>可向商家确认酱汁能否分开放、口味能否调整；实际配料、价格、供应情况以商家说明为准。</p></div><div className="dining-safety"><Icon name="leaf" size={22} /><h3>先问清楚，再放心选择</h3><p>{recipe.allergens}</p><p>示例配方与餐厅成分不一定一致。有食物过敏时，请向商家核实配料和交叉接触风险。</p>{recipe.categories.includes('鱼虾') && <p>生食鱼类存在额外风险，孕期、幼儿、老年人及免疫力较弱者应选择充分加热的菜品。</p>}</div></section> : <div className="detail-content">
        <section className="ingredients-section" aria-labelledby="ingredients-title">
          <div className="section-heading"><h2 id="ingredients-title">准备这些食材</h2><span className="section-caption">{servings} 人份</span></div>
          <p className="section-description">勾选已备好的食材；可选配菜可省略，必需食材不能跳过。</p>
          {generated && <p className={generated.recipe.missingIngredients.length ? 'pantry-warning' : 'pantry-hint'}>需额外准备：{generated.recipe.missingIngredients.map((item) => `${item.name}（${item.amount}）`).join('、') || (generated.scene === 'fridge' ? '无；仍需核对用量和已勾选的基础材料假设。' : '请按下方完整食材清单准备。')}</p>}
          <ul className="ingredient-list">{recipe.ingredients.map((ingredient) => <li key={ingredient.name}><label className={prepared.includes(ingredient.name) ? 'is-prepared' : ''}><input type="checkbox" checked={prepared.includes(ingredient.name)} onChange={() => setPrepared((current) => current.includes(ingredient.name) ? current.filter((name) => name !== ingredient.name) : [...current, ingredient.name])} /><span>{ingredient.name}<small className="ingredient-role">{ingredient.role === 'required' ? '必需' : ingredient.role === 'optional' ? '可选' : '调味 / 基础'}</small></span><span>{ingredient.amount}</span></label></li>)}</ul>
          <p className="allergen-note"><strong>食材提醒</strong>{recipe.allergens}请核对调味料包装；此页面不提供过敏原安全保证。</p>
        </section>
        <section className="steps-section" aria-labelledby="recipe-steps">
          <div className="section-heading"><h2 id="recipe-steps" tabIndex={-1}>一步步，好好做</h2><span className="section-caption">{recipe.steps.length} 个步骤</span></div>
          <ol className="steps-list">{recipe.steps.map((step, index) => <li key={`${index}-${step.title}`}><span className="step-number">{String(index + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>)}</ol>
          <div className="cooking-tip"><Icon name="chef" size={21} /><div><strong>厨房里的小贴士</strong><p>{recipe.tip}</p></div></div>
          <p className="demo-explanation">{generated ? `${generated.source === 'mock' ? 'Mock 测试菜谱，非真实 AI 输出' : 'AI 生成菜谱，未经人工审核'}；${generated.photo ? '照片是按菜名与食材匹配到的菜品示意图，不是本菜谱的实际成品' : '分类插画不是实物照片'}。收藏会在本机保存完整菜谱快照。` : recipe.imageFallbackCategory ? '本地 Demo 原创示例菜谱，分类插画是项目原创占位视觉，不是菜品实物照片。' : '本地 Demo 原创示例菜谱，摄影仅作摆盘参考；不是摄影作者提供或验证的配方。'}</p>
        </section>
      </div>}
      <div className="mobile-cook"><button type="button" className={`secondary-button ${saved ? 'is-saved' : ''}`} aria-pressed={saved} onClick={() => onToggle(recipe.id)}><Icon name="heart" size={19} />{saved ? '已收藏' : '收藏'}</button>{isOut ? <a className="primary-button" href={returnTo}>返回点餐灵感<Icon name="back" size={18} /></a> : <button type="button" className="primary-button" onClick={startCooking}>开始做这道菜<Icon name="arrow" size={18} /></button>}</div>
    </main>
  )
}
