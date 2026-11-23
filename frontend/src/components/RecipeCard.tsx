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

export default function RecipeCard({ recipe, saved, onToggle, mode = 'cook', reasons, onReplace, replacing = false, replaceError = '' }: {
  recipe: Recipe
  saved: boolean
  onToggle: (id: string) => void
  mode?: DiningMode
  reasons?: string[]
  onReplace?: () => void
  replacing?: boolean
  replaceError?: string
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
        {replacing && <div className="swap-overlay" role="status"><span className="generation-progress" aria-hidden="true" /><span>正在换一道…</span></div>}
      </div>
      <div className="recipe-card-copy">
        <span className="recipe-kicker">{recipe.kicker}</span>
        <h3><a href={href}>{recipe.name}</a></h3>
        <div className="recipe-meta"><span><Icon name={mode === 'cook' ? 'clock' : 'dining'} size={14} />{mode === 'cook' ? `${recipe.minutes} 分钟` : recipe.dining.category}</span><span>{recipe.tastes[0]}</span></div>
        {reasons && recipe.generation && <p className="card-reason">{recipe.generation.recipe.recommendationReason}</p>}
        {reasons && !recipe.generation && <details className="card-reasons"><summary>为什么推荐</summary><p>{reasons.join('；')}</p></details>}
        {replaceError && <p className="swap-error" role="alert">{replaceError}</p>}
        {onReplace && (
          <button type="button" className="text-button swap-button" disabled={replacing} onClick={onReplace}>
            <Icon name="refresh" size={13} />{replacing ? '正在换一道…' : '换一道'}
          </button>
        )}
      </div>
    </article>
  )
}
