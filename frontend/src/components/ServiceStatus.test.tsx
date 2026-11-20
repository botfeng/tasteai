import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './ServiceStatus'

const healthyResponse = () =>
  new Response(JSON.stringify({ status: 'ok', service: 'tasteai-api' }), {
    headers: { 'Content-Type': 'application/json' },
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('Day 0 service connection', () => {
  it('renders the Chinese shell and checks the real API contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue(healthyResponse())
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('先把厨房准备好。')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('服务已连接'))
    expect(fetchMock).toHaveBeenCalledWith('/api/health', {
      signal: expect.any(AbortSignal),
      cache: 'no-store',
    })
    expect(screen.getByText('目前仅完成工程骨架')).toBeVisible()
  })

  it('disables the button while the request is pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<App />)

    expect(screen.getByRole('button', { name: '正在检查…' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('正在检查连接…')
  })

  it('explains a network failure and allows retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Network unavailable'))
      .mockResolvedValueOnce(healthyResponse())
    vi.stubGlobal('fetch', fetchMock)
    render(<App />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('暂时无法连接'))
    expect(screen.getByText(/8000 端口/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: '重新检查连接' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('服务已连接'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['HTTP error', () => new Response('', { status: 503 })],
    ['invalid JSON', () => new Response('<html>not JSON</html>')],
    ['wrong service', () => new Response(JSON.stringify({ status: 'ok', service: 'other-api' }))],
    ['null response', () => new Response('null')],
  ])('does not report a healthy backend for %s', async (_, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))
    render(<App />)

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('暂时无法连接'))
  })

  it('times out instead of leaving a permanent loading state', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url, { signal }: RequestInit) => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    render(<App />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByRole('status')).toHaveTextContent('暂时无法连接')
    expect(screen.getByRole('button', { name: '重新检查连接' })).toBeEnabled()
  })

  it('aborts pending requests when the page unmounts', () => {
    let requestSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn((_url, { signal }: RequestInit) => {
      requestSignal = signal
      return new Promise(() => {})
    }))
    const { unmount } = render(<App />)

    unmount()
    expect(requestSignal?.aborted).toBe(true)
  })
})
