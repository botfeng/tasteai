import type { DiningMode, Recipe } from '../data/recipes'
import FoodImage from './FoodImage'
import Icon from './Icon'

export function SaveButton({ recipe, saved, onToggle, className = '' }: {
  recipe: Recipe
  saved: boolean
  onToggle: (id: string) => void
  className?: string
}) {
  return (
    <button type="button" className={`icon-button save-button ${saved ? 'is-saved' : ''} ${className}`} aria-label={`${saved ? '取消收藏' : '收藏'}${recipe.name}`} aria-pressed={saved} onClick={() => onToggle(recipe.id)}>
      <Icon name="heart" />
    </button>
  )
}

export default function RecipeCard({ recipe, saved, onToggle, mode = 'cook', reasons }: {
  recipe: Recipe
  saved: boolean
  onToggle: (id: string) => void
  mode?: DiningMode
  reasons?: string[]
}) {
  if (recipe.generation) mode = recipe.generation.scene === 'eat_out' ? 'out' : 'cook'
  const href = `#recipe/${recipe.id}${mode === 'out' ? '?mode=out' : ''}`
  return (
    <article className="recipe-card">
      <div className="recipe-card-visual">
        <a href={href} tabIndex={-1} aria-hidden="true">
          <FoodImage src={recipe.image} alt="" category={recipe.generation?.recipe.imageFallbackCategory ?? recipe.imageFallbackCategory} illustrative={!!recipe.generation?.photo} />
        </a>
        <SaveButton recipe={recipe} saved={saved} onToggle={onToggle} />
      </div>
      <div className="recipe-card-copy">
        <span className="recipe-kicker">{recipe.kicker}</span>
        <h3><a href={href}>{recipe.name}</a></h3>
        <div className="recipe-meta"><span><Icon name={mode === 'cook' ? 'clock' : 'dining'} size={14} />{mode === 'cook' ? `${recipe.minutes} 分钟` : recipe.dining.category}</span><span>{recipe.tastes[0]}</span></div>
        {reasons && <details className="card-reasons"><summary>为什么推荐</summary><p>{reasons.join('；')}</p></details>}
      </div>
    </article>
  )
}
