/**
 * 浏览器半用例：真实 React SSR 渲染断言 + 坞入口注册断言。
 *
 * 覆盖：
 *   1. 模块形状（window.__ModuleLoader__.load 被调用、factory 只 require('react') 与可选的 'react-dom'）；
 *   2. apply 经 `ctx.inject(['gui-frame'])` 往 **GUIFrame 的按钮面板**注册一个 `kind:'action'` 的入口，
 *      并且**一次都不碰** DSH 官方座位（夹具里的 `slots` 一被读到就抛）；
 *   3. 行内控件的五种状态渲染；**输出里不许出现 `<button>`**（坞那一行本身就是
 *      `<button data-guif-dock-action>`，里面再放 button 会被 React 19 判非法嵌套）；
 *   4. 提权弹层的两个落点档：能送出栈（`createPortal` → `document.body`，控件是原生 `<button>`）
 *      与送不出去（退回行内，控件必须是 `div[role=button]`，结构上仍不嵌套）；
 *   5. 回到前台/页面可见 ⇒ 带 refresh 探一次（宿主 kickWatchdog 的通道）＋卸载摘监听；
 *   6. 提权链：点过「取消」之后旧链不得复活。
 *
 * react / react-dom 从 web profile 的 node_modules 解析（与浏览器里跑的是同一份）。
 */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// React 从哪来：浏览器里的 'react' 由 DSH 客户端运行时提供，磁盘上不一定有一份现成的包；
// 而 profile 只要被重建（pnpm 严格布局），以前被提升到 profile 顶层的那份就会被剪掉。
// 所以按锚点顺序找，第一个能同时解析 react 与 react-dom/server 的胜出：
//   1) DSH_LIGHTOUT_REACT_FROM 指向的 package.json / 目录（用自己的 DSH 安装里那份）
//   2) 本仓库的测试专用依赖 tools/testdeps（cd tools/testdeps && npm install 一次即可）
// **有意不写任何绝对路径**：写死某台机器的 profile 位置，会让别人 clone 下来直接跑不起来。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ANCHORS = [
  process.env.DSH_LIGHTOUT_REACT_FROM,
  path.resolve(HERE, '..', '..', 'tools', 'testdeps', 'package.json'),
].filter(Boolean)

function resolveReact() {
  const tried = []
  for (const anchor of ANCHORS) {
    const pkg = anchor.endsWith('.json') ? anchor : path.join(anchor, 'package.json')
    if (!fs.existsSync(pkg)) {
      tried.push(`${pkg}  (不存在)`)
      continue
    }
    try {
      const req = createRequire(pathToFileURL(pkg))
      const react = req('react')
      const server = req('react-dom/server')
      return { react, server, from: pkg }
    } catch (err) {
      tried.push(`${pkg}  (${err.code ?? err.message})`)
    }
  }
  assert.fail(
    [
      '找不到 react / react-dom/server，无法做真实 SSR 渲染断言。试过的锚点：',
      ...tried.map((t) => `  - ${t}`),
      '修法（一次即可）：cd tools/testdeps && npm install react@^19 react-dom@^19 --no-audit --no-fund',
      '或用 DSH_LIGHTOUT_REACT_FROM=<含 react 的 package.json 或目录> 指定一处。',
    ].join('\n'),
  )
}

const { react: React, server: reactDomServer, from: REACT_FROM } = resolveReact()
const { renderToStaticMarkup } = reactDomServer
console.log(`  react        ok  （react ${React.version}，来自 ${REACT_FROM}）`)

// ── 1) 捕获 factory ───────────────────────────────────────────────────────
let definition = null
globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      definition = def
    },
  },
}
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  async text() {
    return ''
  },
})

await import(new URL('../lib/client.js', import.meta.url).href)
assert.ok(definition !== null, 'client.js 应调用 window.__ModuleLoader__.load')
assert.equal(definition.id, 'dsh-lightout')

/**
 * 造一个模块实例。`reactDom` 传 `null` ⇒ 模拟「平台种子表里没有 react-dom」
 * （弹层退回行内那一档）。**factory 是 require 的纯函数**，所以同一个定义能造多个互不干扰的实例。
 */
function instance({ reactDom }) {
  const requested = []
  const mod = definition.factory((spec) => {
    requested.push(spec)
    if (spec === 'react') return React
    if (spec === 'react-dom') {
      if (reactDom === null) throw new Error("Cannot find module 'react-dom'")
      return reactDom
    }
    throw new Error('客户端半不应 require：' + spec)
  })
  return { mod, requested }
}

/** 假 `react-dom`：只记下 createPortal 的调用参数，返回 null（SSR 里等价于「不渲染」）。 */
function fakeReactDom(portals) {
  return {
    createPortal(element, container) {
      portals.push({ element, container })
      return null
    },
  }
}

// ── 浏览器侧最小 DOM 夹具（ensureStyle、弹层落点判定、focus/visibilitychange 都要它）────────
const styleTags = []
const BODY = { nodeType: 1, __body: true }
function installDocument({ visibilityState = 'visible' } = {}) {
  const added = []
  const removed = []
  globalThis.document = {
    visibilityState,
    body: BODY,
    addEventListener: (type) => added.push(type),
    removeEventListener: (type) => removed.push(type),
    querySelector: () => styleTags.find(() => false) ?? null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '', parentNode: null }
      styleTags.push(tag)
      return tag
    },
    head: { appendChild: () => {} },
  }
  // window 也要有监听面（apply 会挂 focus / visibilitychange）；`__ModuleLoader__` 留着不动
  globalThis.window = {
    ...(globalThis.window ?? {}),
    addEventListener: (type) => added.push(type),
    removeEventListener: (type) => removed.push(type),
  }
  return { added, removed }
}
installDocument()

// ── 2) 坞入口注册（GUIFrame 服务面）──────────────────────────────────────────
/** 假 ctx：`slots` 是**陷阱**（读到就抛）—— 证明官方座位那条路已经整条删干净。 */
function makeCtx() {
  const state = { injections: [], injected: null, effectLabels: [], disposers: [] }
  return {
    state,
    ctx: {
      inject(deps, callback) {
        state.injections.push(deps)
        state.injected = callback
      },
      effect(fn) {
        const disposer = fn()
        state.disposers.push(disposer)
      },
      get slots() {
        throw new Error('客户端半不该再碰 slots（官方 sidebar.footer.action 座位已删）')
      },
    },
  }
}

/** 假 gui-frame 服务面：只实现 `register`，把注册面原样记下来。 */
function makeGui(guiState) {
  return {
    register(entry, Component) {
      guiState.registrations.push({ entry, Component })
      return () => {
        guiState.disposals += 1
      }
    },
  }
}

const portals = []
const guiState = { registrations: [], disposals: 0 }
const A = instance({ reactDom: fakeReactDom(portals) })
const A_ctx = makeCtx()
A.mod.apply(A_ctx.ctx)

assert.deepEqual(A.mod.inject, [], '不声明任何服务（写进去会让缺服务时整个模块 fiber 悬置）')
assert.deepEqual(A.requested.slice().sort(), ['react', 'react-dom'], "只允许 require('react') 与 'react-dom'")
assert.deepEqual(A_ctx.state.injections, [['gui-frame']], '经 ctx.inject([\'gui-frame\']) 等坞服务就位')
assert.equal(guiState.registrations.length, 0, '服务未就位之前一次都不许注册')

// 服务就位：GUIFrame 的回调把注入了服务的 ctx 交回来
const injectedState = { effectLabels: [], disposers: [] }
const injectedCtx = {
  get: (name) => (name === 'gui-frame' ? makeGui(guiState) : undefined),
  effect(fn, label) {
    injectedState.effectLabels.push(label)
    const disposer = fn()
    injectedState.disposers.push(disposer)
  },
}
A_ctx.state.injected(injectedCtx)

assert.equal(guiState.registrations.length, 1, '服务就位后应注册恰好一个坞入口')
const { entry, Component } = guiState.registrations[0]
assert.equal(entry.id, 'dsh-lightout/off', 'entry.id 必须带命名空间前缀')
assert.equal(entry.kind, 'action', "kind:'action' ⇒ 只进按钮面板，不占官方座位")
assert.equal(entry.source, 'dsh-lightout')
assert.equal(entry.order, 10)
assert.equal(typeof entry.label, 'function', 'label 传 thunk（坞每次读取重新求值）')
assert.equal(entry.label(), '熄屏')
assert.equal(typeof entry.icon, 'function', 'icon 传组件，不是名字字符串')
assert.equal(typeof Component, 'function')

// 自持 disposer：坞的服务面不是 cordis 的 traceable Service，卸载要靠我们自己归还
assert.equal(injectedState.effectLabels.length, 1)
assert.equal(typeof injectedState.disposers[0], 'function', '注册必须挂在自己的 effect 上（别留僵尸入口）')
injectedState.disposers[0]()
assert.equal(guiState.disposals, 1, '卸载时要把坞入口归还给 GUIFrame')

/** SSR 渲染坞那一行（行内控件的那几个状态都走它）。 */
function renderA(props) {
  return renderToStaticMarkup(React.createElement(Component, props ?? {}))
}

function setStatus(mod, keepAwake, extra = {}) {
  mod.__shared.set({
    status: {
      keepAwake,
      machine: { policy: { PBUTTONACTION: { effective: 3 } } },
      last: null,
      ...extra,
    },
    busy: false,
    armed: false,
    error: null,
  })
}

// ── 3) 行内控件的五种状态 ────────────────────────────────────────────────────
// 未知态 1：状态还没拉回来 —— 不得当成告警，也不得阻塞点击
A.mod.__shared.set({ status: null, busy: false, armed: false, error: null, prompt: null })
let html = renderA()
assert.match(html, /熄屏（正在读取状态…）/)
assert.match(html, /class="lo-btn"/)
assert.match(html, /data-dsh-lightout-entry="dsh-lightout\/off"/)
assert.match(html, /data-dsh-lightout-state="idle"/)
assert.match(html, /<svg/)
assert.doesNotMatch(html, /<button/, '行内控件不许是 <button>（坞那一行本身就是 button）')
assert.doesNotMatch(html, /有风险/)

// 未知态 2：探不到 keep-awake（没装 / 端口未知 / 探测失败）—— 一律按「未知」处理，不告警
setStatus(A.mod, { available: false, reason: 'unknown-port（读不到 webServer.port，按未知处理）' })
html = renderA()
assert.match(html, /防休眠：未探测到 keep-awake/)
assert.doesNotMatch(html, /有风险/)
assert.doesNotMatch(html, /lo-btn-warn/)

// 未知态 3：status 里连 keepAwake 字段都没有
setStatus(A.mod, undefined)
html = renderA()
assert.doesNotMatch(html, /有风险/)
console.log('  未知态  ok  三种「探不到」都不升级成告警、都不阻塞')

// 常态：keep-awake 正持有唤醒锁
setStatus(A.mod, { available: true, holdingWakeLock: true, preventDisplaySleep: false })
html = renderA()
assert.match(html, /class="lo-btn"/)
assert.match(html, /熄屏/)
assert.doesNotMatch(html, /有风险/)
assert.match(html, /防休眠：正常/)
assert.match(html, /电源键=关机/) // tooltip 里带着宿主算好的体检读数

// 告警：**宿主**在 warnings 里报「keep-awake 没持有唤醒锁」——客户端只照抄，不自己重算
setStatus(A.mod, { available: true, holdingWakeLock: false }, { warnings: ['keep-awake 未持有系统唤醒锁：暗窗期间机器可能进入睡眠，DSH 会停摆'] })
html = renderA()
assert.match(html, /熄屏（有风险）/)
assert.match(html, /lo-btn-warn/)
assert.match(html, /防休眠：未持有唤醒锁/)
assert.match(html, /⚠ keep-awake 未持有系统唤醒锁/)
assert.match(html, /data-dsh-lightout-state="warn"/)

// 判据单一来源：宿主没报 warning ⇒ 客户端**不许**自己从 keepAwake 重算一份告警
setStatus(A.mod, { available: true, holdingWakeLock: false })
html = renderA()
assert.doesNotMatch(html, /有风险/)
assert.doesNotMatch(html, /lo-btn-warn/)

// 二次确认
setStatus(A.mod, { available: true, holdingWakeLock: false }, { warnings: ['keep-awake 未持有系统唤醒锁'] })
A.mod.__shared.set({ armed: true })
html = renderA()
assert.match(html, /仍要熄屏？/)
assert.match(html, /data-dsh-lightout-state="armed"/)

// 失败态：屏幕没黑掉，用户看得见
setStatus(A.mod, { available: true, holdingWakeLock: true })
A.mod.__shared.set({ armed: false, error: '执行器未返回内容：boom' })
html = renderA()
assert.match(html, /熄屏失败/)
assert.match(html, /lo-btn-error/)
assert.match(html, /执行器未返回内容/)
assert.match(html, /data-dsh-lightout-state="error"/)

// 熄屏保持中：这一下点的是「结束熄屏」（逃生口）
A.mod.__shared.set({ error: null, status: { hold: { active: true, deadline: '2026-10-05T12:00:00Z' }, keepAwake: { available: true, holdingWakeLock: true }, vdd: { available: true, present: true, disabled: false }, warnings: [], machine: {} } })
html = renderA()
assert.match(html, /结束熄屏/)
assert.match(html, /data-dsh-lightout-state="holding"/)

// 忙碌态
A.mod.__shared.set({ status: null, busy: true, armed: false, error: null })
html = renderA()
assert.match(html, /熄屏中…/)
assert.match(html, /lo-btn-busy/)
assert.doesNotMatch(html, /<button/)
console.log('  行内控件  ok  五种状态；任何一态都没有 <button>')

// ── 4) 弹层的两个落点档 ──────────────────────────────────────────────────────
const PROMPT = {
  ok: false,
  needsVdd: 'disabled',
  error: '虚拟显示器当前是禁用状态',
  elevation: { wording: 'W', body: { action: 'enable' }, check: null },
}

// 档 A（有 react-dom + 有 document.body）：弹层**送出坞那一行**，控件是原生 `<button>`
A.mod.__shared.set({ busy: false, prompt: PROMPT })
html = renderA()
assert.equal(portals.length, 1, '弹层必须经 createPortal 送出栈（不能在坞那一行里面）')
assert.equal(portals[0].container, BODY, '送出栈的宿主是 document.body')
assert.doesNotMatch(html, /lo-modal/, '送出栈之后，行内不该再有弹层节点')
const portalHtml = renderToStaticMarkup(portals[0].element)
assert.match(portalHtml, /class="lo-modal"/)
assert.equal((portalHtml.match(/<button/g) || []).length, 2, '送出栈那一档的两颗键是原生 button')
assert.match(portalHtml, /取消/)
assert.match(portalHtml, /授权并启用/)
assert.match(portalHtml, /管理员授权只用于启用这一个设备/)

// 档 B（拿不到 react-dom）：弹层留在行内，但控件必须是 div[role=button] —— 结构上仍不嵌套
const B = instance({ reactDom: null })
const B_ctx = makeCtx()
B.mod.apply(B_ctx.ctx)
const B_gui = { registrations: [], disposals: 0 }
B_ctx.state.injected({
  get: (name) => (name === 'gui-frame' ? makeGui(B_gui) : undefined),
  effect: (fn) => {
    fn()
  },
})
assert.deepEqual(B.requested.slice().sort(), ['react', 'react-dom'], '拿不到 react-dom 时要能吞掉那个异常')
assert.equal(B_gui.registrations.length, 1)
B.mod.__shared.set({ status: null, busy: false, armed: false, error: null, prompt: PROMPT })
const inlineHtml = renderToStaticMarkup(React.createElement(B_gui.registrations[0].Component, {}))
assert.match(inlineHtml, /class="lo-modal"/, '拿不到 react-dom 时弹层退回行内（功能不许丢）')
assert.match(inlineHtml, /role="button"/)
assert.match(inlineHtml, /tabindex="0"/)
assert.doesNotMatch(inlineHtml, /<button/, '退回行内那一档也不许出现 <button>')

// 弹层在行**之后**（同级），不是嵌在行内控件里面：行的那个 div 先闭合，弹层才开始
const rowAt = inlineHtml.indexOf('class="lo-btn"')
const modalAt = inlineHtml.indexOf('lo-modal')
assert.ok(rowAt > 0, '行必须渲染出来')
assert.ok(modalAt > rowAt, '弹层要排在行之后')
assert.ok(inlineHtml.slice(rowAt, modalAt).includes('</div>'), '行先闭合、弹层再出现（同级）')
B.mod.__shared.set({ prompt: null })
A.mod.__shared.set({ prompt: null })
console.log('  提权弹层  ok  送出栈档用原生 button；退回行内档用 div[role=button]，都不嵌套')

// ── 5) 回到前台/页面可见 ⇒ 带 refresh 探一次（宿主 kickWatchdog 的通道）＋ 卸载摘监听 ──────
{
  const listeners = installDocument()
  const disposers2 = []
  const ctx2 = {
    inject(deps, callback) {
      assert.deepEqual(deps, ['gui-frame'])
      callback({
        get: () => undefined, // 坞不在场：本插件只是不注册按钮
        effect: (fn) => {
          disposers2.push(fn())
        },
      })
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers2.push(disposer)
    },
  }
  A.mod.apply(ctx2)
  assert.deepEqual(listeners.added, ['focus', 'visibilitychange'], '必须监听 focus 与 visibilitychange（回到前台就 refresh 一次）')
  for (const dispose of disposers2) if (typeof dispose === 'function') dispose()
  assert.deepEqual(listeners.removed, ['focus', 'visibilitychange'], '卸载时必须把两个监听都摘掉')
  console.log('  回到前台  ok  focus/visibilitychange → 带 refresh 的探测；卸载即摘')
}

// ── 5b) 坞服务始终不出现 ⇒ 不注册、不抛（GUIFrame 不在场是正常一态）──────────────
{
  const C = instance({ reactDom: null })
  const state = { injections: 0 }
  let threw = null
  try {
    C.mod.apply({
      inject(deps, callback) {
        state.injections += 1
        // 服务永不到场：这个回调**根本不会被调用** ⇒ 本插件什么都不注册（夹具里也不去调它）
        void callback
      },
      effect() {
        return undefined // 卸载器留着不管：这一档不验拆卸
      },
    })
  } catch (cause) {
    threw = cause
  }
  assert.equal(threw, null, '服务缺席不许抛（客户端 apply 抛错会打死整页）')
  assert.equal(state.injections, 1, '运行时注入照样声明出去')
  console.log('  服务缺席  ok  不注册、不抛、页面照常')
}

// ── 6) 提权链：点过「取消」之后，旧链不得复活（回归单测）──────────────────────
// 做法：用受控 fetch 记录 /off 与 /vdd 的调用次数，真实跑完 3 s 的轮询间隔。
{
  const originalFetch = globalThis.fetch
  let ready = false
  let offCalls = 0
  const okJson = (value) => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(value)
    },
  })
  globalThis.fetch = async (url) => {
    const target = String(url)
    if (target.includes('/vdd')) return okJson({ ok: true })
    if (target.endsWith('/off')) {
      offCalls += 1
      return okJson({ ok: true, action: 'off', mode: 'vdd-dark', hold: null })
    }
    if (target.includes('/status')) {
      return okJson({ vddReady: ready, hold: { active: false }, keepAwake: { available: true, holdingWakeLock: true }, warnings: [], last: null, machine: {} })
    }
    return okJson({})
  }
  const prompt = { ok: false, needsVdd: 'disabled', error: 'x', elevation: { wording: 'W', body: { action: 'enable' } } }
  A.mod.__shared.set({ status: null, busy: false, waiting: false, armed: false, error: null, prompt })
  void A.mod.__test.confirmElevate() // 流程 A：3 s 后才会 tick
  await new Promise((r) => setTimeout(r, 50))
  A.mod.__test.dismissPrompt() // 用户点「取消」⇒ epoch+1，流程 A 作废
  ready = true // 就算设备此刻就绪，被取消的链也不许自动熄屏
  await new Promise((r) => setTimeout(r, 3400))
  assert.equal(offCalls, 0, '取消过的提权链不得自动熄屏（/off 调用数应为 0，实际 ' + String(offCalls) + '）')
  // 反向对照：新开一条链、不取消 ⇒ 到 tick 必须自动继续熄屏一次（证明上面那条不是因为链路根本没跑）
  A.mod.__shared.set({ prompt, waiting: false })
  void A.mod.__test.confirmElevate()
  await new Promise((r) => setTimeout(r, 3400))
  assert.equal(offCalls, 1, '没被取消的链会照常自动熄屏一次（实际 ' + String(offCalls) + '）')
  A.mod.__shared.set({ prompt: null, waiting: false, busy: false, error: null })
  globalThis.fetch = originalFetch
  console.log('  提权链  ok  取消后旧链不复活；未取消的链照常自动熄屏')
}

// ── 7) 卸载 ───────────────────────────────────────────────────────────────
for (const dispose of A_ctx.state.disposers) if (typeof dispose === 'function') dispose()

console.log('client.test.mjs 全部通过')
process.exit(0)
