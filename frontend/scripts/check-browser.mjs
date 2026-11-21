import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../../', import.meta.url))
const output = resolve(root, process.env.TASTEAI_ARTIFACT_DIR || 'artifacts/day2-ui')
const profile = await mkdtemp(join(tmpdir(), 'tasteai-day2-'))
const base = process.env.TASTEAI_BASE_URL || 'http://127.0.0.1:5174'
const executable = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
await mkdir(output, { recursive: true })
const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let socket
const errors = []
const checks = []
const screenshots = []
let nextId = 0
let sessionId
let onPageLoad
const pending = new Map()

try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser startup timed out')), 20000)
    browser.once('error', reject)
    browser.stderr.on('data', (chunk) => {
      const match = chunk.toString().match(/DevTools listening on (ws:\/\/\S+)/)
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]) }
    })
  })
  socket = new WebSocket(endpoint)
  await new Promise((ready, reject) => { socket.onopen = ready; socket.onerror = reject })
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data)
    if (message.method === 'Page.loadEventFired') onPageLoad?.()
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else done(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + (message.params.exceptionDetails.exception?.description || ''))
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text)
  }
  function cdp(method, params = {}, target = sessionId) {
    return new Promise((done, reject) => {
      const id = ++nextId
      pending.set(id, { resolve: done, reject })
      socket.send(JSON.stringify({ id, method, params, ...(target ? { sessionId: target } : {}) }))
    })
  }
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
  ;({ sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true }))
  await cdp('Page.enable')
  await cdp('Runtime.enable')
  await cdp('Log.enable')
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })

  async function evaluate(expression) {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
  async function waitFor(expression) {
    return evaluate(`new Promise((resolve, reject) => { const start = Date.now(); function check() { if (${expression}) return requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))); if(Date.now()-start > 8000) return reject(new Error('Page condition timed out: '+${JSON.stringify(expression)})); requestAnimationFrame(check); } check(); })`)
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
  async function click(selector) {
    assert(await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`), `Missing control: ${selector}`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  async function input(selector, value) {
    await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); const prototype = element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }
  async function check(label, expression) {
    assert(await evaluate(expression), label)
    checks.push(label)
  }
  async function screenshot(name) {
    await evaluate('document.fonts.ready')
    await evaluate("Promise.all([...document.images].map(image => { image.loading = 'eager'; return image.decode(); }))")
    await waitFor("[...document.images].every(image => image.complete && image.naturalWidth > 0)")
    const dimensions = await evaluate('({ width: innerWidth, height: document.documentElement.scrollHeight, scrollWidth: document.documentElement.scrollWidth })')
    assert(dimensions.scrollWidth <= dimensions.width, `Horizontal overflow on ${name}: ${JSON.stringify(dimensions)}`)
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: dimensions.width, height: dimensions.height, scale: 1 } })
    const path = join(output, `${name}.png`)
    await writeFile(path, Buffer.from(data, 'base64'))
    screenshots.push({ name, ...dimensions, path })
  }

  await cdp('Page.navigate', { url: base })
  await waitFor("document.querySelector('.featured-card')")
  await evaluate('localStorage.clear()')
  await reload()
  await waitFor("document.querySelector('.featured-card')")
  for (const width of [360, 390, 768, 1280]) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1, mobile: false })
    await navigate('#home')
    await click('input[name="dining-mode"]:first-of-type')
    await evaluate("document.querySelectorAll('input[name=\"dining-mode\"]')[0].click()")
    await waitFor("document.querySelector('.time-filter')")
    await check(`${width}: homepage retains one hero plus two cards`, "document.querySelectorAll('.featured-card').length === 1 && document.querySelectorAll('.more-grid .recipe-card').length === 2")
    if (width >= 768) await check(`${width}: desktop asymmetric layout`, "document.querySelector('.featured-section').getBoundingClientRect().right < document.querySelector('.more-section').getBoundingClientRect().left")
    await screenshot(`home-cook-${width}`)
    await evaluate("document.querySelectorAll('input[name=\"dining-mode\"]')[1].click()")
    await waitFor("document.querySelector('select[aria-label=\"预算偏好\"]')")
    await check(`${width}: outside mode has no cooking filter or cooking CTA`, "!document.querySelector('.time-filter') && !document.querySelector('.recipe-time') && document.querySelector('.featured-bottom a').textContent.includes('点餐建议')")
    await screenshot(`home-out-${width}`)
    await navigate('#fridge')
    await waitFor("document.querySelector('#pantry-input')")
    if (width === 360) {
      await screenshot('fridge-empty-360')
      await input('#pantry-input', '西红柿，番茄、螺旋面、大蒜、番茄膏、罗勒、鸡胸肉、火星果')
      await click('.ingredient-input-row button')
    }
    await waitFor("document.querySelector('.ingredient-result')")
    await check(`${width}: canonical tags and coverage ranking`, "!!document.querySelector('[aria-label=\"删除番茄\"]') && !document.querySelector('[aria-label=\"删除西红柿\"]') && document.querySelector('.ingredient-result h3').textContent.includes('番茄罗勒螺旋面')")
    await screenshot(`fridge-results-${width}`)
  }

  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await click('.ingredient-result h3 a')
  await waitFor("document.querySelector('#recipe-steps')")
  await check('Fridge details retain return origin', "document.querySelector('[aria-label=\"返回菜谱列表\"]').getAttribute('href') === '#fridge'")
  await reload()
  await waitFor("document.querySelector('#recipe-steps')")
  await check('Detail refresh preserves the fridge history origin', "document.querySelector('[aria-label=\"返回菜谱列表\"]').getAttribute('href') === '#fridge'")
  await click('.ingredient-list input')
  await check('Cooking ingredient checklist is interactive', "document.querySelector('.ingredient-list input').checked")
  await screenshot('recipe-cook-390')
  await click('[aria-label="返回菜谱列表"]')
  await waitFor("document.querySelector('#pantry-input')")
  await input('#pantry-input', '未提交的草稿')
  await reload()
  await waitFor("document.querySelector('#pantry-input')")
  await check('Refresh restores tags and draft', "document.querySelector('#pantry-input').value === '未提交的草稿' && !!document.querySelector('[aria-label=\"删除番茄\"]')")
  await click('[aria-label="删除罗勒"]')
  await check('Core omission is never ready', "document.querySelector('.ingredient-result').textContent.includes('核心材料未齐') && !document.querySelector('.ingredient-result').textContent.includes('主要食材齐全')")
  await click('.pantry-basics input')
  await check('Unchecked basics become explicit missing ingredients', "document.querySelector('.match-ingredients').textContent.includes('食用油') && document.querySelector('.match-ingredients').textContent.includes('盐')")
  await screenshot('fridge-missing-core-390')
  await evaluate(`localStorage.setItem('tasteai-pantry-v1', JSON.stringify({ items: ['白糖','火星果'], draft: '', assumeBasics: true }))`)
  await reload()
  await waitFor("document.querySelector('.pantry-empty')")
  await check('Unknown and no-match states are explicit', "document.querySelector('.pantry-results').textContent.includes('暂不认识') && document.querySelector('.pantry-empty').textContent.includes('暂时还搭不成')")
  await screenshot('fridge-no-match-390')

  await navigate('#home')
  await waitFor("document.querySelector('input[name=\"dining-mode\"]')")
  await click('input[value="浓郁"]')
  await check('Taste actually changes the dish', "document.querySelector('.featured-name h3').textContent === '番茄罗勒螺旋面'")
  await click('input[value="全部"]')
  await evaluate("document.querySelectorAll('input[name=\"dining-mode\"]')[1].click()")
  await waitFor("document.querySelector('select[aria-label=\"预算偏好\"]')")
  await input('select[aria-label=\"预算偏好\"]', 'balanced')
  await check('Budget preference deterministically reranks', "document.querySelector('.featured-name h3').textContent === '柠檬香草鸡排'")
  await cdp('Emulation.setDeviceMetricsOverride', { width: 360, height: 844, deviceScaleFactor: 1, mobile: false })
  await input('select[aria-label=\"预算偏好\"]', 'economy')
  await screenshot('home-out-economy-360')
  await check('Budget switch retains decoded featured photography', "document.querySelector('.featured-visual img').naturalWidth > 0 && document.querySelector('.featured-visual img').getAttribute('src') === '/images/tomato-fusilli.webp'")
  await cdp('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: false })
  await screenshot('home-out-landscape-844')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  await input('select[aria-label=\"预算偏好\"]', 'balanced')
  await click('.featured-bottom a')
  await waitFor("document.querySelector('#ordering-title')")
  await check('Dining detail does not show a cooking tutorial', "!document.querySelector('#recipe-steps') && !document.querySelector('.ingredient-list') && !document.body.textContent.includes('预计总用时')")
  await screenshot('recipe-out-390')
  await click('.detail-toolbar .save-button')
  await navigate('#saved')
  await waitFor("document.querySelector('.saved-grid')")
  await check('Dining favorite appears in existing saved page', "document.querySelector('.saved-grid').textContent.includes('柠檬香草鸡排')")
  await screenshot('saved-390')
  await click('.saved-grid h3 a')
  await waitFor("document.querySelector('#recipe-steps')")
  await check('Saved detail returns to saved list', "document.querySelector('[aria-label=\"返回菜谱列表\"]').getAttribute('href') === '#saved'")
  await click('[aria-label="返回菜谱列表"]')
  await waitFor("document.querySelector('.saved-grid')")
  await click('.saved-grid .save-button')
  await check('Unsaving restores existing empty state', "document.querySelector('.empty-state').textContent.includes('把想吃的，先收好')")
  await navigate('#home')
  await waitFor("document.querySelector('.shuffle-button')")
  const previous = await evaluate("document.querySelector('.featured-name h3').textContent")
  await click('.shuffle-button')
  await check('Change batch rotates actual featured dish', `document.querySelector('.featured-name h3').textContent !== ${JSON.stringify(previous)}`)
  await evaluate('document.activeElement?.blur()')
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await check('Keyboard focus is visible', "document.activeElement.matches(':focus-visible')")
  await check('Reduced motion is honored', "getComputedStyle(document.querySelector('.page-enter')).animationName === 'none'")
  assert.deepEqual(errors, [], `Browser errors: ${errors.join('\n')}`)
  await writeFile(join(output, 'browser-report.json'), JSON.stringify({ base, checks, screenshots, errors }, null, 2))
  console.log(JSON.stringify({ passed: checks.length, screenshots: screenshots.length, errors, report: join(output, 'browser-report.json') }, null, 2))
  await cdp('Browser.close', {}, undefined)
} finally {
  socket?.close()
  if (browser.exitCode === null) browser.kill()
  await new Promise(resolveExit => browser.exitCode !== null ? resolveExit() : browser.once('exit', resolveExit))
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((error) => console.warn(`Temporary browser profile retained: ${profile}: ${error.message}`))
}
