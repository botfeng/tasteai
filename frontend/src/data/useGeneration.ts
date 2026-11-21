import { useEffect, useRef, useState } from 'react'
import { generateRecipes } from './generation'
import type { GenerationRequest, GenerationResponse } from './generation'

export function useGeneration(request: GenerationRequest, onResult: (result: GenerationResponse) => void, active = true) {
  const key = JSON.stringify(request)
  const currentKey = useRef(key)
  currentKey.current = key
  const pending = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [stored, setStored] = useState<{ key: string; response: GenerationResponse } | null>(null)

  useEffect(() => {
    pending.current?.abort()
    pending.current = null
    setLoading(false)
    setError('')
    return () => { pending.current?.abort(); pending.current = null }
  }, [key, active])

  async function generate() {
    if (pending.current || !active) return
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError('')
    let timedOut = false
    const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 95000)
    try {
      const response = await generateRecipes(request, controller.signal)
      if (controller.signal.aborted || currentKey.current !== key) return
      onResult(response)
      setStored({ key, response })
    } catch (reason) {
      if (pending.current !== controller) return
      if (timedOut) setError('生成超时，请稍后重试。未展示未经检查的结果。')
      else if (!controller.signal.aborted) setError(reason instanceof Error && reason.message ? reason.message : '网络连接失败，请稍后重试。')
    } finally {
      window.clearTimeout(timer)
      if (pending.current === controller) { pending.current = null; setLoading(false) }
    }
  }

  return { loading, error, result: stored?.key === key ? stored.response : null, generate }
}
