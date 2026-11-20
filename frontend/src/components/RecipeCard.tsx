import type { Recipe } from '../data/recipes'
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

export default function RecipeCard({ recipe, saved, onToggle }: {
  recipe: Recipe
  saved: boolean
  onToggle: (id: string) => void
}) {
  return (
    <article className="recipe-card">
      <div className="recipe-card-visual">
        <a href={`#recipe/${recipe.id}`} tabIndex={-1} aria-hidden="true">
          <FoodImage src={recipe.image} alt="" />
        </a>
        <SaveButton recipe={recipe} saved={saved} onToggle={onToggle} />
      </div>
      <div className="recipe-card-copy">
        <span className="recipe-kicker">{recipe.kicker}</span>
        <h3><a href={`#recipe/${recipe.id}`}>{recipe.name}</a></h3>
        <div className="recipe-meta"><span><Icon name="clock" size={14} />{recipe.minutes} 分钟</span><span>{recipe.tastes[0]}</span></div>
      </div>
    </article>
  )
}
