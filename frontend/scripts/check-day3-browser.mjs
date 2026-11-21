import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(root, process.env.TASTEAI_ARTIFACT_DIR || 'artifacts/day3-ui')
const profile = await mkdtemp(join(tmpdir(), 'tasteai-day3-'))
const base = process.env.TASTEAI_BASE_URL || 'http://127.0.0.1:5175'
await mkdir(output, { recursive: true })
const browser = spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
let sessionId
let onPageLoad
let nextId = 0
const pending = new Map()
const errors = []
const checks = []
const screenshots = []
try {
  const endpoint = await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 20000)
    browser.once('error', reject)
    browser.stderr.on('data', (chunk) => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timer); done(match[1]) }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Page.loadEventFired') onPageLoad?.()
    if (message.id && pending.has(message.id)) {
      const { done, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else done(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text)
  }
  function cdp(method, params = {}, target = sessionId) {
    return new Promise((done, reject) => {
      const id = ++nextId
      pending.set(id, { done, reject })
      socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }))
    })
  }
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  ;({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }))
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  async function waitFor(expression) {
    return evaluate(`new Promise((resolve, reject) => { const start = Date.now(); function check() { if (${expression}) return requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); if (Date.now()-start > 15000) return reject(new Error('Timed out: ' + ${JSON.stringify(expression)})); requestAnimationFrame(check); } check(); })`)
  }
  async function click(selector) {
    assert(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `Missing: ${selector}`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  async function input(selector, value) {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))')
  }
  async function reload() {
    let timer
    const loaded = new Promise((done, reject) => {
      onPageLoad = done
      timer = setTimeout(() => reject(new Error('Page reload timed out')), 15000)
    })
    try {
      await cdp('Page.reload')
      await loaded
    } finally {
      clearTimeout(timer)
      onPageLoad = undefined
    }
  }
  async function navigate(hash) {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`)
    await waitFor(`location.hash === ${JSON.stringify(hash)} && document.querySelector('main h1')`)
  }
  async function check(label, expression) { assert(await evaluate(expression), label); checks.push(label) }
  async function screenshot(name, width = 1280, height = 900) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await evaluate('document.fonts.ready')
    await evaluate("Promise.all([...document.images].map(img => { img.loading = 'eager'; return img.decode().catch(() => {}); }))")
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const dimensions = await evaluate('({ width: innerWidth, height: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth })')
    assert(dimensions.scrollWidth <= dimensions.width, `Overflow: ${name}`)
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: dimensions.height, scale: 1 } })
    const path = join(output, `${name}.png`)
    await writeFile(path, Buffer.from(data, 'base64'))
    screenshots.push({ path, ...dimensions })
  }
  async function generate() {
    await waitFor("document.querySelector('.generation-actions .primary-button') && !document.querySelector('.generation-actions .primary-button').disabled")
    await click('.generation-actions .primary-button')
    await waitFor("document.querySelector('.generation-result-note') && !document.querySelector('.generation-loading')")
    await check('No generation error', "!document.querySelector('.generation-error')")
  }

  await cdp('Page.navigate', { url: base })
  await waitFor("document.querySelector('.generation-disclosure')?.textContent.includes('Mock 测试模式')")
  await check('Offline seeds retain one hero and two cards', "document.querySelectorAll('.featured-card').length === 1 && document.querySelectorAll('.more-grid .recipe-card').length === 2")
  await screenshot('home-before-generation')
  await check('Original three photos and licensed credit links remain intact', "[...document.querySelectorAll('.featured-visual img, .more-grid img')].map(img => img.getAttribute('src')).join(',') === '/images/salmon-bowl.webp,/images/lemon-chicken.webp,/images/tomato-fusilli.webp' && document.querySelectorAll('.photo-credits a').length === 6 && !document.querySelector('.photo-credits a[href=\"\"]')")
  const curatedNames = new Set()
  for (let index = 0; index < 15; index += 1) {
    curatedNames.add(await evaluate("document.querySelector('.featured-name h3').textContent"))
    await check(`Curated rotation ${index + 1} retains one plus two`, "document.querySelectorAll('.featured-card').length === 1 && document.querySelectorAll('.more-grid .recipe-card').length === 2 && !document.querySelector('img[src=\"\"]')")
    await click('.shuffle-button')
  }
  assert.equal(curatedNames.size, 15, 'Fifteen distinct curated dishes are reachable')
  checks.push('All fifteen curated dishes are reachable without generation')
  for (let index = 0; index < 3; index += 1) await click('.shuffle-button')
  const curatedName = await evaluate("document.querySelector('.featured-name h3').textContent")
  await check('New curated recipe has truthful original placeholder', "document.querySelector('.featured-visual .generated-cover') && !document.querySelector('.featured-visual img')")
  await screenshot('curated-placeholder-1280')
  await click('.featured-card .save-button')
  await navigate('#saved')
  await waitFor("document.querySelector('.saved-grid h3 a')")
  await check('New curated dish is available from favorites', `document.querySelector('.saved-grid h3 a').textContent === ${JSON.stringify(curatedName)}`)
  await click('.saved-grid h3 a')
  await waitFor("document.querySelector('.steps-section')")
  await reload()
  await waitFor("document.querySelector('.steps-section')")
  await check('New curated favorite and full detail survive reload', `document.querySelector('h1').textContent === ${JSON.stringify(curatedName)} && document.querySelector('.detail-toolbar .save-button').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.steps-list li').length >= 3 && document.querySelector('.demo-explanation').textContent.includes('不是菜品实物照片')`)
  await screenshot('curated-detail-375', 375, 812)
  await click('.detail-toolbar .save-button')
  await navigate('#home')
  await waitFor("document.querySelector('.generation-disclosure')")
  await generate()
  await check('Generated recipe is novel and has a truthful placeholder', "document.querySelector('.featured-card .generated-cover') && !['三文鱼毛豆波奇碗','柠檬香草鸡排','番茄罗勒螺旋面'].includes(document.querySelector('.featured-name h3').textContent)")
  await check('Mock provenance is visible', "document.querySelector('.generation-result-note').textContent.includes('Mock 演示结果')")
  for (const [width, height] of [[1280, 900], [390, 844], [375, 812], [844, 390]]) await screenshot(`cook-${width}`, width, height)
  await click('.featured-card .save-button')
  const firstName = await evaluate("document.querySelector('.featured-name h3').textContent")
  await click('.featured-bottom .primary-button')
  await waitFor("document.querySelector('.steps-section')")
  await reload()
  await waitFor("document.querySelector('.steps-section')")
  await check('Complete favorite snapshot survives reload', `document.querySelector('h1').textContent === ${JSON.stringify(firstName)} && document.querySelectorAll('.steps-list li').length >= 2`)
  await screenshot('saved-detail-390', 390, 844)
  await navigate('#home')
  await waitFor("document.querySelector('input[name=\"dining-mode\"]')")
  await evaluate("document.querySelectorAll('input[name=\"dining-mode\"]')[1].click()")
  await waitFor("document.querySelector('select') && document.body.textContent.includes('预算偏好')")
  await generate()
  await screenshot('eat-out-1280')
  await click('.featured-card .save-button')
  await click('.featured-bottom .primary-button')
  await waitFor("document.querySelector('.dining-advice')")
  await check('Dining advice does not contain a cooking tutorial', "!document.querySelector('.steps-section') && !document.querySelector('.recipe-time')")
  await reload()
  await waitFor("document.querySelector('.dining-advice')")
  await check('Dining favorite retains its scene after reload', "!document.querySelector('.steps-section')")

  await navigate('#fridge')
  await waitFor("document.querySelector('#pantry-input')")
  await input('#pantry-input', '菠菜')
  await check('Expanded ingredient search finds spinach', "document.querySelector('.common-ingredients button')?.textContent.includes('菠菜')")
  await click('.common-ingredients button')
  await reload()
  await waitFor("document.querySelector('[aria-label=\"删除菠菜\"]')")
  await check('Expanded ingredient selection persists after reload', "document.querySelector('.ingredient-tokens').textContent.includes('菠菜')")
  await click('[aria-label="删除菠菜"]')
  await input('#pantry-input', '目录中不存在的食材')
  await check('Unknown expanded search stays explicit', "document.body.textContent.includes('没有对应的目录食材') && !document.querySelector('.common-ingredients button')")
  await input('#pantry-input', '西红柿、鸡蛋、土豆')
  await click('.ingredient-input-row button')
  await generate()
  await check('Fridge generates usable dishes from standardized ingredients', "document.querySelectorAll('.generated-fridge-grid .recipe-card').length > 0 && document.querySelector('.ingredient-tokens').textContent.includes('番茄')")
  await screenshot('fridge-1280')
  await screenshot('fridge-390', 390, 844)
  await evaluate("window.originalFetch = window.fetch; window.fetch = (url, options) => String(url).endsWith('/generate') ? Promise.resolve(new Response(JSON.stringify({ detail: { code: 'test_error', message: '浏览器验收模拟：生成服务暂时不可用，请重试。' } }), { status: 503, headers: { 'Content-Type': 'application/json' } })) : window.originalFetch(url, options)")
  await click('.generation-actions .primary-button')
  await waitFor("document.querySelector('.generation-error')")
  await check('Failed regeneration keeps last successful results and offers retry', "document.querySelectorAll('.generated-fridge-grid .recipe-card').length > 0 && document.querySelector('.generation-actions .primary-button').textContent.includes('重试')")
  await screenshot('error-retry-390', 390, 844)
  await evaluate('window.fetch = window.originalFetch')
  await generate()
  while (await evaluate("document.querySelectorAll('.ingredient-tokens button').length")) await click('.ingredient-tokens button')
  await waitFor("document.querySelectorAll('.ingredient-tokens button').length === 0")
  await input('#pantry-input', '盐')
  await click('.ingredient-input-row button')
  await generate()
  await check('Insufficient ingredients show no invented recipes', "document.querySelector('.pantry-empty')?.textContent.includes('没有合理的做法') && !document.querySelector('.generated-fridge-grid')")
  await screenshot('empty-fridge-390', 390, 844)
  assert.deepEqual(errors, [], 'Browser runtime errors')
  await writeFile(join(output, 'report.json'), JSON.stringify({ base, checks, errors, screenshots, apiMode: 'mock', realModelCalls: 0 }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, screenshots: screenshots.length, errors, report: join(output, 'report.json') }, null, 2))
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++nextId, method: 'Browser.close' }))
  socket?.close()
  if (browser.exitCode === null) await new Promise((done) => { browser.once('exit', done); setTimeout(done, 3000) })
  if (browser.exitCode === null) browser.kill()
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
}
