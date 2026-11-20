import { useEffect, useState } from 'react'

type HealthState = 'checking' | 'connected' | 'unavailable'

const healthLabels: Record<HealthState, string> = {
  checking: '正在检查连接…',
  connected: '服务已连接',
  unavailable: '暂时无法连接',
}

const healthColors: Record<HealthState, string> = {
  checking: 'text-muted',
  connected: 'text-success-text',
  unavailable: 'text-error',
}

export default function ServiceStatus() {
  const [health, setHealth] = useState<HealthState>('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const timeout = window.setTimeout(() => controller.abort(), 5000)

    async function checkHealth() {
      try {
        const response = await fetch('/api/health', {
          signal: controller.signal,
          cache: 'no-store',
        })
        if (!response.ok) throw new Error('Health request failed')

        const data: unknown = await response.json()
        if (
          typeof data !== 'object' ||
          data === null ||
          !('status' in data) ||
          data.status !== 'ok' ||
          !('service' in data) ||
          data.service !== 'tasteai-api'
        ) {
          throw new Error('Unexpected health response')
        }

        if (active) setHealth('connected')
      } catch {
        if (active) setHealth('unavailable')
      } finally {
        window.clearTimeout(timeout)
      }
    }

    void checkHealth()
    return () => {
      active = false
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [attempt])

  return (
    <div className="mx-auto flex min-h-svh max-w-5xl flex-col px-6 sm:px-10">
      <header className="flex items-center gap-3 py-7 sm:py-9">
        <img src="/favicon.svg" alt="" className="size-10" />
        <span className="text-xl font-bold tracking-tight">TasteAI</span>
        <span className="ml-auto text-sm text-muted">好好吃饭，慢慢来</span>
      </header>

      <main className="grid flex-1 content-center gap-9 py-9 md:grid-cols-2 md:items-center md:gap-14 md:py-16">
        <section aria-labelledby="welcome-title">
          <p className="mb-5 text-sm font-semibold text-accent-text">工程初始化 · Day 0</p>
          <h1 id="welcome-title" className="text-4xl leading-snug font-bold tracking-tight sm:text-5xl">
            先把厨房<br />准备好。
          </h1>
          <p className="mt-5 max-w-sm text-base leading-8 text-muted">
            从「今天吃什么」开始，让每一餐都刚刚好。
            TasteAI 的第一步，是搭好一个可靠、轻盈的小厨房。
          </p>
          <p className="mt-6 inline-block rounded-chip bg-primary-soft px-4 py-2 text-sm text-accent-text">
            目前仅完成工程骨架
          </p>
        </section>

        <section aria-labelledby="connection-title" className="rounded-card border border-border bg-surface p-6 shadow-card sm:p-8">
          <p className="text-sm text-muted">开餐前的小检查</p>
          <h2 id="connection-title" className="mt-2 text-2xl font-semibold">连接准备好了吗？</h2>
          <dl className="mt-7 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted">前端页面</dt>
              <dd className="font-medium text-success-text">已启动</dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-5">
              <dt className="text-muted">后端服务</dt>
              <dd role="status" aria-live="polite" className={`font-medium ${healthColors[health]}`}>
                {healthLabels[health]}
              </dd>
            </div>
          </dl>
          <p className="mt-5 min-h-12 text-sm leading-6 text-muted">
            {health === 'unavailable'
              ? '请确认本机后端已在 8000 端口启动，然后重新检查。'
              : '这里检查真实服务连接，不代表菜谱、数据库或推荐算法已经就绪。'}
          </p>
          <button
            type="button"
            disabled={health === 'checking'}
            onClick={() => {
              setHealth('checking')
              setAttempt((value) => value + 1)
            }}
            className="mt-6 min-h-12 w-full cursor-pointer rounded-button bg-primary px-5 py-3 font-semibold text-foreground transition-colors duration-200 hover:bg-primary-hover active:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus disabled:cursor-wait disabled:bg-primary-soft disabled:text-muted motion-reduce:transition-none"
          >
            {health === 'checking' ? '正在检查…' : '重新检查连接'}
          </button>
        </section>
      </main>

      <footer className="border-t border-border py-6 text-sm leading-6 text-muted">
        菜谱、口味偏好与个性化推荐，将在后续阶段逐步加入。
      </footer>
    </div>
  )
}
