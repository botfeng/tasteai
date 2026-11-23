import { useEffect, useState } from 'react'
import { fetchEngineStatus } from '../data/generation'
import type { EngineStatus } from '../data/generation'
import type { useGeneration } from '../data/useGeneration'
import Icon from './Icon'

export default function GenerationPanel({ generation, label = 'AI 帮我推荐', disabledMessage = '', excludedRecipeNames = [] }: {
  generation: ReturnType<typeof useGeneration>
  label?: string
  disabledMessage?: string
  excludedRecipeNames?: string[]
}) {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [connectionError, setConnectionError] = useState('')
  const [check, setCheck] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let mounted = true
    const timer = window.setTimeout(() => controller.abort(), 5000)
    setStatus(null)
    setConnectionError('')
    fetchEngineStatus(controller.signal).then((value) => { if (!controller.signal.aborted) setStatus(value) }).catch(() => {
      if (mounted) setConnectionError('暂时无法连接生成服务；本地示例仍可使用。')
    }).finally(() => window.clearTimeout(timer))
    return () => { mounted = false; controller.abort(); window.clearTimeout(timer) }
  }, [check])
  const { loading, error, result, generate } = generation
  return <section className="generation-panel" aria-label="AI 菜品生成">
    <div className="generation-controls"><div><span className="small-eyebrow"><Icon name="spark" size={15} />为这一餐，多想一点</span><p>{connectionError || status?.message || '正在检查生成服务…'}</p>{status?.source === 'mock' && <p className="generation-disclosure">Mock 测试模式，不调用真实模型，不产生 API 费用。</p>}</div><div className="generation-actions"><button type="button" className="primary-button" disabled={loading || !status?.configured || !!disabledMessage} onClick={() => void generate(excludedRecipeNames)}><Icon name={loading ? 'clock' : 'spark'} size={18} />{loading ? '正在认真搭配…' : error ? '重试生成' : result ? '重新生成一批' : label}</button>{!loading && <button type="button" className="text-button" onClick={() => setCheck((value) => value + 1)}>检查服务<Icon name="refresh" size={15} /></button>}</div></div>
    {disabledMessage && <p className="generation-disclosure">{disabledMessage}</p>}
    {loading && <div className="generation-loading" role="status" aria-live="polite"><span className="generation-progress" /><p>正在组合食材、整理做法并检查限制。请稍候，不必重复点击。</p></div>}
    {error && <p className="generation-error" role="alert">{error}{result ? ' 下方保留的是上一次成功结果。' : ' 下方本地示例不是本次 AI 结果。'}</p>}
    {result && <div className="generation-result-note" aria-live="polite"><strong>{result.source === 'mock' ? 'Mock 演示结果 · 非真实 AI' : 'AI 生成结果 · 未经人工审核'}</strong><p>{result.notice}</p>{result.warnings.map((warning) => <p key={warning}>{warning}</p>)}<p>封面为原创分类占位视觉，非菜品实拍。开做前请核对食材及步骤。</p></div>}
  </section>
}
