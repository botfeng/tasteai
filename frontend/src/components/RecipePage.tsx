import { useState } from 'react'
import type { Recipe } from '../data/recipes'
import FoodImage from './FoodImage'
import Icon from './Icon'
import { SaveButton } from './RecipeCard'

export default function RecipePage({ recipe, saved, onToggle, returnTo }: {
  recipe: Recipe
  saved: boolean
  onToggle: (id: string) => void
  returnTo: string
}) {
  const [prepared, setPrepared] = useState<string[]>([])

  function startCooking() {
    const steps = document.getElementById('recipe-steps')
    steps?.focus({ preventScroll: true })
    steps?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' })
  }

  return (
    <main className="detail-page page-enter">
      <div className="detail-toolbar"><a className="icon-button" href={returnTo} aria-label="返回菜谱列表"><Icon name="back" /></a><span>今日的好味道</span><SaveButton recipe={recipe} saved={saved} onToggle={onToggle} /></div>
      <div className="detail-top">
        <div className="detail-photo"><FoodImage src={recipe.image} alt={recipe.photoAlt} priority /><span className="photo-caption"><Icon name="leaf" size={14} />把一餐，过成喜欢的样子</span></div>
        <section className="detail-intro">
          <div className="detail-eyebrow"><span>{recipe.kicker}</span><span>Demo 菜谱</span></div>
          <h1 tabIndex={-1}>{recipe.name}</h1>
          <p className="detail-description">{recipe.description}</p>
          <div className="detail-facts"><div><Icon name="clock" /><span><strong>{recipe.minutes} 分钟</strong><small>预计总用时</small></span></div><div><Icon name="chef" /><span><strong>{recipe.difficulty}</strong><small>制作难度</small></span></div><div><Icon name="portion" /><span><strong>1 人份</strong><small>刚好一餐</small></span></div></div>
          <div className="reason-note"><Icon name="spark" size={19} /><div><strong>今天推荐它的理由</strong><p>{recipe.reason}</p></div></div>
          <div className="tag-row">{recipe.tastes.map((taste) => <span key={taste}>{taste}</span>)}<span>{recipe.categories.join(' · ')}</span></div>
          <button type="button" className="primary-button desktop-cook" onClick={startCooking}>开始做这道菜<Icon name="arrow" size={18} /></button>
        </section>
      </div>
      <div className="detail-content">
        <section className="ingredients-section" aria-labelledby="ingredients-title">
          <div className="section-heading"><h2 id="ingredients-title">准备这些食材</h2><span className="section-caption">1 人份</span></div>
          <p className="section-description">勾选已备好的食材，开做前不慌忙。</p>
          <ul className="ingredient-list">{recipe.ingredients.map((ingredient) => <li key={ingredient.name}><label className={prepared.includes(ingredient.name) ? 'is-prepared' : ''}><input type="checkbox" checked={prepared.includes(ingredient.name)} onChange={() => setPrepared((current) => current.includes(ingredient.name) ? current.filter((name) => name !== ingredient.name) : [...current, ingredient.name])} /><span>{ingredient.name}</span><span>{ingredient.amount}</span></label></li>)}</ul>
          <p className="allergen-note"><strong>食材提醒</strong>{recipe.allergens}请核对调味料包装；此页面不提供过敏原安全保证。</p>
        </section>
        <section className="steps-section" aria-labelledby="recipe-steps">
          <div className="section-heading"><h2 id="recipe-steps" tabIndex={-1}>一步步，好好做</h2><span className="section-caption">{recipe.steps.length} 个步骤</span></div>
          <ol className="steps-list">{recipe.steps.map((step, index) => <li key={step.title}><span className="step-number">{String(index + 1).padStart(2, '0')}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></li>)}</ol>
          <div className="cooking-tip"><Icon name="chef" size={21} /><div><strong>厨房里的小贴士</strong><p>{recipe.tip}</p></div></div>
          <p className="demo-explanation">本地 Demo 原创示例菜谱，摄影仅作摆盘参考；不是摄影作者提供或验证的配方。</p>
        </section>
      </div>
      <div className="mobile-cook"><button type="button" className={`secondary-button ${saved ? 'is-saved' : ''}`} aria-pressed={saved} onClick={() => onToggle(recipe.id)}><Icon name="heart" size={19} />{saved ? '已收藏' : '收藏'}</button><button type="button" className="primary-button" onClick={startCooking}>开始做这道菜<Icon name="arrow" size={18} /></button></div>
    </main>
  )
}
