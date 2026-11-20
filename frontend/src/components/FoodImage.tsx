import { useState } from 'react'
import Icon from './Icon'

export default function FoodImage({ src, alt, className = '', priority = false }: {
  src: string
  alt: string
  className?: string
  priority?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)

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
    </div>
  )
}
