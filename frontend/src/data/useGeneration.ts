import { useEffect, useRef, useState } from 'react'
import { generateRecipes } from './generation'
import type { GenerationRequest, GenerationResponse } from './generation'
import { normalizeDishName } from './history'

export function useGeneration(request: GenerationRequest, onResult: (result: GenerationResponse) => void, active = true,
                              onReplace?: (result: GenerationResponse, replacedId: string) => void) {
  const key = JSON.stringify(request)
  const currentKey = useRef(key)
  currentKey.current = key
  const pending = useRef<AbortController | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [stored, setStored] = useState<{ key: string; seq: number; response: GenerationResponse } | null>(null)
  const storedRef = useRef(stored)
  storedRef.current = stored
  const batchSeq = useRef(0)
  const [replacing, setReplacing] = useState<string[]>([])
  const replacingRef = useRef(new Set<string>())
  const replaceControllers = useRef(new Map<string, AbortController>())
  const [replaceErrors, setReplaceErrors] = useState<Record<string, string>>({})

  function commitStored(next: { key: string; seq: number; response: GenerationResponse } | null) {
    storedRef.current = next
    setStored(next)
  }

  function abortReplacements() {
    replaceControllers.current.forEach((controller) => controller.abort())
    replaceControllers.current.clear()
    replacingRef.current.clear()
    setReplacing([])
    setReplaceErrors({})
  }

  useEffect(() => {
    pending.current?.abort()
    pending.current = null
    abortReplacements()
    setLoading(false)
    setError('')
    return () => { pending.current?.abort(); pending.current = null; abortReplacements() }
  }, [key, active])

  async function generate(excludedRecipeNames: string[] = []) {
    if (pending.current || !active) return
    const controller = new AbortController()
    pending.current = controller
    setLoading(true)
    setError('')
    let timedOut = false
    const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 95000)
    try {
      const body: GenerationRequest = excludedRecipeNames.length ? { ...request, excludedRecipeNames } : request
      const response = await generateRecipes(body, controller.signal)
      if (controller.signal.aborted || currentKey.current !== key) return
      onResult(response)
      batchSeq.current += 1
      commitStored({ key, seq: batchSeq.current, response })
    } catch (reason) {
      if (pending.current !== controller) return
      if (timedOut) setError('生成超时，请稍后重试。未展示未经检查的结果。')
      else if (!controller.signal.aborted) setError(reason instanceof Error && reason.message ? reason.message : '网络连接失败，请稍后重试。')
    } finally {
      window.clearTimeout(timer)
      if (pending.current === controller) { pending.current = null; setLoading(false) }
    }
  }

  async function replaceRecipe(oldId: string, excludedRecipeNames: string[]) {
    const base = storedRef.current
    if (!active || pending.current || !base || base.key !== currentKey.current) return
    if (replacingRef.current.has(oldId) || !base.response.recipes.some((recipe) => recipe.id === oldId)) return
    const controller = new AbortController()
    replacingRef.current.add(oldId)
    replaceControllers.current.set(oldId, controller)
    setReplacing([...replacingRef.current])
    setReplaceErrors((current) => { const next = { ...current }; delete next[oldId]; return next })
    let timedOut = false
    const timer = window.setTimeout(() => { timedOut = true; controller.abort() }, 95000)
    try {
      const response = await generateRecipes({ ...request, maxRecipes: 1, excludedRecipeNames }, controller.signal)
      const latest = storedRef.current
      // A new batch, changed conditions or an already-replaced card makes this result stale.
      if (currentKey.current !== base.key || !latest || latest.key !== base.key || latest.seq !== base.seq) return
      if (!latest.response.recipes.some((recipe) => recipe.id === oldId)) return
      const dish = response.recipes[0]
      const otherNames = new Set(latest.response.recipes.filter((recipe) => recipe.id !== oldId).map((recipe) => normalizeDishName(recipe.name)))
      if (!dish || otherNames.has(normalizeDishName(dish.name))) {
        setReplaceErrors((current) => ({ ...current, [oldId]: '本次没有生成不重复的新菜，已保留原推荐，可稍后再试。' }))
        return
      }
      commitStored({ ...latest, response: { ...latest.response, recipes: latest.response.recipes.map((recipe) => recipe.id === oldId ? dish : recipe) } })
      onReplace?.(response, oldId)
    } catch (reason) {
      if (replaceControllers.current.get(oldId) !== controller) return
      const base = timedOut ? '换一道超时，请稍后重试。'
        : reason instanceof Error && reason.message ? reason.message : '网络连接失败，请稍后重试。'
      const message = base.includes('保留') ? base : `${base.replace(/。$/, '')}，已保留原推荐。`
      setReplaceErrors((current) => ({ ...current, [oldId]: message }))
    } finally {
      window.clearTimeout(timer)
      if (replaceControllers.current.get(oldId) === controller) {
        replaceControllers.current.delete(oldId)
        replacingRef.current.delete(oldId)
        setReplacing([...replacingRef.current])
      }
    }
  }

  return { loading, error, result: stored?.key === key ? stored.response : null, generate, replaceRecipe, replacing, replaceErrors }
}