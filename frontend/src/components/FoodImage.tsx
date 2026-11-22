import { useEffect, useState } from 'react'
import Icon from './Icon'

export default function FoodImage({ src, alt, className = '', priority = false, category, illustrative = false }: {
  src: string
  alt: string
  className?: string
  priority?: boolean
  category?: string
  illustrative?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => { setFailed(false); setLoaded(false) }, [src])

  if (category && (!src || failed)) return <div className={`food-image generated-cover cover-${category} ${className}`} role="img" aria-label={alt || '分类插画占位，非实物照片'}><div className="cover-orbit"><Icon name={category === 'vegetable' ? 'leaf' : category === 'protein' ? 'chef' : 'bowl'} size={60} /></div><span>一餐新灵感</span><small>分类插画 · 非实物照片</small></div>

  return (
    <div className={`food-image ${className} ${loaded ? 'is-loaded' : ''}`}>
      {failed ? (
        <div className="image-fallback" role="img" aria-label={`${alt}，图片暂时无法加载`}>
          <Icon name="bowl" size={44} />
          <span>图片暂时没端上来</span>
          <small>好味道，依然可以照着做</small>
        </div>
      ) : (
        <img
          src={src}
          alt={alt}
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'auto'}
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
      {illustrative && src && !failed && <span className="photo-badge">菜品示意图</span>}
    </div>
  )
}