/**
 * 宿主半离线/半在线用例。
 *
 * 覆盖：
 *   1. apply 的接线（返回值必须是 undefined；服务只用 ctx.inject 取；effect 注册 prefix 路由 + 看门狗）；
 *   2. 两道守卫：只服务回环连接；改状态的请求必须同源（GET 只读不要求）；
 *   3. 端口不写死：keep-awake 探测 URL 用假 ctx 里那个刻意的非 3080 端口拼出来；
 *      拿不到端口时按「未知」处理且**不阻塞**熄屏；
 *   4. /status 端到端：真的起 PowerShell 跑 scripts/lightout.ps1 + scripts/vdd-device.ps1
 *      + scripts/lightout-topology.ps1（三条都是**只读**的 status/check）并把结果解析回来；
 *   5. /off 在 dryRun=true 下只出计划、不产生副作用；
 *   6. 三条真实链路全部用 test/fixtures 下的桩脚本驱动（不碰真设备、不黑屏、不锁屏）：
 *      · VDD 被禁用 ⇒ 返回 needsVdd + 提权文案，且**没有**起守卫；
 *      · VDD 就绪 ⇒ 起守卫、读回执、守卫死后看门狗还原拓扑；
 *      · api /on ⇒ 杀掉守卫 + 还原；
 *      · 并发（同一时刻两个 /off 只能起一个守卫）、/on↔/off 互斥、/on 只清自己杀掉的那份回执、
 *        spawn 失败必须报失败（不许假成功回执）、看门狗退避 + "用户回来立刻重试"；
 *   7. 脚本静态契约：三个新执行器都在、都是纯 ASCII、PS 5.1 能解析、关键不变式还在；
 *   8. 404（含已移除的 /policy/safe）与参数归一化。
 *
 * 刻意不做的事：不在测试里触发真实熄屏/锁屏/提权（那会黑屏或弹 UAC）。
 * 真实动作只在人工点击或手动运行 scripts/ 下脚本时发生。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { apply, ROUTE_PATH, VERSION, KEEP_AWAKE_STATE_PATH, __test } from '../lib/index.js'

/** 与真实 `dsh web` 无关的刻意端口，用来证明没有写死 3080。 */
const FAKE_PORT = 59999

const fixture = (name) => fileURLToPath(new URL('./fixtures/' + name, import.meta.url))
const pkgFile = (relative) => fileURLToPath(new URL('../' + relative, import.meta.url))

/** 桩脚本的记账文件与状态文件（桩通过环境变量找到它们，见各 fixture 头部）。 */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lightout-test-'))
const MARKER = path.join(TMP, 'marker.txt')
const TOPO_STATE = path.join(TMP, 'topology-state.txt')
const HOLD_STATE = path.join(TMP, 'hold.json')
const HOLD_STATE_DISABLED = path.join(TMP, 'hold-disabled.json')
const HOLD_STATE_DEFAULT = path.join(TMP, 'hold-default.json')
const HOLD_STATE_CONC = path.join(TMP, 'hold-conc.json')
const HOLD_STATE_MUTEX = path.join(TMP, 'hold-mutex.json')
const HOLD_STATE_FOREIGN = path.join(TMP, 'hold-foreign.json')
const HOLD_STATE_BROKEN = path.join(TMP, 'hold-broken.json')
const HOLD_STATE_RETRY = path.join(TMP, 'hold-retry.json')
const HOLD_STATE_PENDING = path.join(TMP, 'hold-pending.json')
/** 手工造出来的"守卫正在跑"回执（pid 用本进程，一定活着）。 */
const HOLD_STATE_LIVE = path.join(TMP, 'hold-live.json')
/** 守卫放弃了还原的回执（restoreFailed）。 */
const HOLD_STATE_FAILED = path.join(TMP, 'hold-failed.json')
const ELEVATE_LOG = path.join(TMP, 'vdd-elevate.json')
const BASELINE = path.join(TMP, 'vdd-baseline.json')
const ELEVATE_LOG_REAL = path.join(TMP, 'vdd-elevate-real.json')
const BASELINE_REAL = path.join(TMP, 'vdd-baseline-real.json')
/** 事件日志（record() 现在落盘）：每个 mount 都写到 TMP，别碰用户真实的 %TEMP%。 */
const EVENTS = path.join(TMP, 'lightout-events.jsonl')
const EVENTS_BROKEN = path.join(TMP, 'lightout-events-broken.jsonl')
/** 关机拓展写给提权守护的禁用请求 + 守护的状态文件（都钉在 TMP：绝不碰真实 %TEMP% 的那两份）。 */
const DISABLE_REQUEST = path.join(TMP, 'vdd-disable.request')
const GUARD_STATE = path.join(TMP, 'vdd-guard.json')
/** 挂载预热用例的"探针起飞记录"：每 spawn 一次标准输出脚本就追加一行（见 fixtures/vdd-spawns.ps1）。 */
const SPAWN_LOG = path.join(TMP, 'vdd-spawns.log')
process.env.LIGHTOUT_TEST_MARKER = MARKER
process.env.LIGHTOUT_TEST_TOPO_STATE = TOPO_STATE
process.env.LIGHTOUT_TEST_SPAWN_LOG = SPAWN_LOG

function markerLines() {
  try {
    return fs
      .readFileSync(MARKER, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}
function resetMarker() {
  fs.rmSync(MARKER, { force: true })
}
function resetTopologyState() {
  fs.rmSync(TOPO_STATE, { force: true })
}
/** 挂载预热用例的探针跑道：每 spawn 一次 fixtures/vdd-spawns.ps1 就多一行。 */
function spawnLines() {
  try {
    return fs
      .readFileSync(SPAWN_LOG, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  } catch {
    return []
  }
}
function resetSpawnLog() {
  fs.rmSync(SPAWN_LOG, { force: true })
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 与真实 `dsh web` 无关的 keep-awake 应答替身：真的去连会让用例结果随宿主状态漂移。 */
let probeUrls = []
globalThis.fetch = async (url) => {
  probeUrls.push(String(url))
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        platform: 'win32',
        enabled: true,
        holdingWakeLock: true,
        preventDisplaySleep: false,
        helperPid: 4321,
        runningAgents: 2,
      }
    },
  }
}

let captured = null
let disposers = []
/** 被登记的关机拓展（SafelyQuit 服务面）。 */
let shutdownHooks = []
/** 关机拓展的摘除器：必须被 effect 收走（卸载插件要能撤登记，SafelyQuit 侧不留残留）。 */
let shutdownHookDisposers = []

/**
 * 假 ctx：inject 立刻回调，并把 webServer / safelyQuit 交给调用者（与 cordis 的等待语义等价地契约化）。
 * `effect` 在根 ctx 与注入 ctx 上都要有——宿主半用根 ctx 挂看门狗与关机拓展、用注入 ctx 挂路由。
 * `safelyQuitMissing: true` ＝ 服务缺席：cordis 的等待型 inject 就是**不回调**（插件照常，只是不登记）。
 */
function fakeContext(webServerOverrides, options = {}) {
  const effect = (fn) => {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
  }
  return {
    logger: { info() {} },
    effect,
    inject(services, callback) {
      assert.ok(Array.isArray(services) && services.length === 1, '每次只等一个服务，收到：' + JSON.stringify(services))
      if (services[0] === 'webServer') {
        callback({
          effect,
          webServer: {
            port: FAKE_PORT,
            register(route) {
              captured = route
              return () => {}
            },
            ...webServerOverrides,
          },
        })
        return
      }
      if (services[0] === 'safelyQuit') {
        if (options.safelyQuitMissing === true) return
        const safelyQuit = options.safelyQuit ?? {
          onShutdown(action, hookOptions) {
            shutdownHooks.push({ action, options: hookOptions })
            const off = () => {}
            shutdownHookDisposers.push(off)
            return off
          },
        }
        callback({ effect, safelyQuit })
        return
      }
      assert.fail('宿主半不得等这个服务：' + JSON.stringify(services))
    },
  }
}

function fakeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = typeof chunk === 'string' ? chunk : String(chunk ?? '')
    },
  }
}

const SAME_ORIGIN = {
  remote: '127.0.0.1',
  headers: { host: '127.0.0.1:' + String(FAKE_PORT), origin: 'http://127.0.0.1:' + String(FAKE_PORT) },
}

async function call(handler, method, path, body, options = {}) {
  // `remote`/`headers` 用 hasOwnProperty 判断：显式传 undefined 表示「没有这个字段」，
  // 不能靠 `??`（它会把显式 undefined 换成默认值，就测不到 fail-closed 分支了）。
  const has = (key) => Object.prototype.hasOwnProperty.call(options, key)
  const req = {
    method,
    url: path,
    socket: { remoteAddress: has('remote') ? options.remote : SAME_ORIGIN.remote },
    headers: has('headers') ? options.headers : SAME_ORIGIN.headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined && body !== null) yield Buffer.from(JSON.stringify(body), 'utf8')
    },
  }
  const res = fakeResponse()
  await handler(req, res)
  return { status: res.statusCode, json: res.body.length > 0 ? JSON.parse(res.body) : null }
}

/** 注册一套路由：返回它的 handler（同一进程里可以并存多套，互不干扰）。 */
function mount(config, ctxOptions) {
  captured = null
  shutdownHooks = []
  shutdownHookDisposers = []
  // 默认把状态文件、事件日志、禁用请求与守护状态都钉在 TMP 里：用例绝不读写 %TEMP% 里真实的那一份。
  apply(fakeContext(undefined, ctxOptions), { eventLog: EVENTS, stateFile: HOLD_STATE_DEFAULT, disableRequest: DISABLE_REQUEST, guardState: GUARD_STATE, ...config })
  assert.ok(captured !== null, 'apply 应注册一条路由')
  return captured.handler
}

/**
 * 本地 'YYYY-MM-DDTHH:MM:SS'——守卫用 `(Get-Date).ToString('s')` 写的就是这个格式。
 * 回执的 deadline 必须是**未来**：过了期的回执不再算「还黑着」（见 readHoldState）。
 */
function localStamp(offsetMs) {
  const when = new Date(Date.now() + (offsetMs ?? 0))
  return new Date(when.getTime() - when.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
}

/**
 * 等某个条件成立（PowerShell 冷启动在忙机器上能到 1–2 s，桩脚本的 marker 落盘也会慢），
 * 返回条件最终是否成立。别用固定 `sleep` 赌时间——那一套在本机实测会偶发假失败。
 */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return predicate()
    await sleep(100)
  }
}

/**
 * 在 `from` 之后、`to` 之前取一段原文（脚本静态断言用）：用来把断言**定位到具体分支**，
 * 避免"有界正则被后面别的分支误命中"（t8 的反证就是这么漏掉的）。找不到返回 ''。
 */
function sliceBetween(text, from, to) {
  const start = text.indexOf(from)
  if (start < 0) return ''
  const end = text.indexOf(to, start)
  return end > start ? text.slice(start, end) : text.slice(start)
}

let handler = null

// ── 1) 接线 ────────────────────────────────────────────────────────────────
{
  captured = null
  const ctx = fakeContext()
  const returned = apply(ctx, { dryRun: true, elevateLog: ELEVATE_LOG_REAL, vddBaseline: BASELINE_REAL, eventLog: EVENTS, stateFile: HOLD_STATE_DEFAULT, disableRequest: DISABLE_REQUEST, guardState: GUARD_STATE })
  assert.equal(returned, undefined, 'apply 必须返回 undefined，否则会被当成 effect 解释')
  assert.ok(captured !== null, '应注册一条路由')
  assert.equal(captured.kind, 'prefix')
  assert.equal(captured.path, ROUTE_PATH)
  assert.equal(typeof captured.handler, 'function')
  assert.ok(disposers.length >= 2, '应注册两个 effect：路由 + 看门狗')
  handler = captured.handler
  console.log('  接线  ok  kind=%s path=%s（含看门狗 effect）', captured.kind, captured.path)
}

// ── 2) 守卫 ────────────────────────────────────────────────────────────────
{
  const outside = await call(handler, 'GET', ROUTE_PATH + '/status', undefined, { remote: '192.168.1.50' })
  assert.equal(outside.status, 403, '非回环连接必须拒绝')
  assert.match(outside.json.error, /loopback/)

  const noSocket = await call(handler, 'GET', ROUTE_PATH + '/status', undefined, { remote: undefined })
  assert.equal(noSocket.status, 403, '取不到远端地址时按拒绝处理（fail closed）')

  const crossSite = await call(handler, 'POST', ROUTE_PATH + '/off', {}, {
    headers: { host: '127.0.0.1:' + String(FAKE_PORT), origin: 'http://evil.example' },
  })
  assert.equal(crossSite.status, 403, '跨站 POST 必须拒绝')
  assert.match(crossSite.json.error, /same-origin/)

  const bare = await call(handler, 'POST', ROUTE_PATH + '/off', {}, { headers: { host: '127.0.0.1:' + String(FAKE_PORT) } })
  assert.equal(bare.status, 403, '既没有 origin 也没有 sec-fetch-site 的裸 POST 必须拒绝')

  const crossSiteVdd = await call(handler, 'POST', ROUTE_PATH + '/vdd', { action: 'enable' }, {
    headers: { host: '127.0.0.1:' + String(FAKE_PORT), origin: 'http://evil.example' },
  })
  assert.equal(crossSiteVdd.status, 403, '提权入口同样必须挡跨站')

  const crossSiteFetch = await call(handler, 'POST', ROUTE_PATH + '/on', undefined, {
    headers: { host: '127.0.0.1:' + String(FAKE_PORT), 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSiteFetch.status, 403, 'sec-fetch-site: cross-site 必须拒绝')

  const secFetchOk = await call(handler, 'POST', ROUTE_PATH + '/on', undefined, {
    headers: { host: 'localhost:' + String(FAKE_PORT), 'sec-fetch-site': 'same-origin' },
  })
  assert.equal(secFetchOk.status, 200, 'sec-fetch-site: same-origin 且 host 是回环 ⇒ 放行')
  assert.equal(secFetchOk.json.dryRun, true, 'dryRun 下 /on 不得真的去动拓扑')

  // 读路由也要挡跨站：每次 /status 都要起 2 个 PowerShell，不能让任意页面当放大器。
  const crossSiteRead = await call(handler, 'GET', ROUTE_PATH + '/status', undefined, {
    headers: { host: '127.0.0.1:' + String(FAKE_PORT), 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossSiteRead.status, 403, 'sec-fetch-site: cross-site 的 GET 必须拒绝')
  assert.match(crossSiteRead.json.error, /cross-site/)
  console.log('  守卫  ok  回环 + 同源 双向都验过（/off、/on、/vdd 三个入口 + 跨站 GET）')
}

// ── 3) 端口不写死 ──────────────────────────────────────────────────────────
{
  assert.equal(__test.keepAwakeBase({ port: 3080 }), 'http://127.0.0.1:3080')
  assert.equal(__test.keepAwakeBase({ port: FAKE_PORT }), 'http://127.0.0.1:' + String(FAKE_PORT))
  assert.equal(__test.keepAwakeBase({}), null, '拿不到 port 时不得退化成写死的 3080')
  assert.equal(__test.keepAwakeBase({ port: 0 }), null)
  assert.equal(__test.keepAwakeBase(undefined), null)

  probeUrls = []
  const { status, json } = await call(handler, 'GET', ROUTE_PATH + '/status?refresh=1')
  assert.equal(status, 200)
  assert.ok(probeUrls.length > 0, '应探测过 keep-awake')
  assert.equal(
    probeUrls[0],
    'http://127.0.0.1:' + String(FAKE_PORT) + KEEP_AWAKE_STATE_PATH,
    '探测 URL 必须用 webServer.port 拼出来',
  )
  assert.equal(json.keepAwake.available, true)
  assert.equal(json.keepAwake.holdingWakeLock, true)
  assert.equal(json.keepAwake.probeUrl, probeUrls[0])
  console.log('  端口  ok  probe=%s', probeUrls[0])
}

// ── 4) /status 端到端（真的跑三个只读 PowerShell）────────────────────────────
{
  const { status, json } = await call(handler, 'GET', ROUTE_PATH + '/status?refresh=1')
  assert.equal(status, 200)
  assert.equal(json.version, VERSION)
  assert.match(json.scripts.machine, /lightout\.ps1$/, '电源键策略报告仍由 scripts/lightout.ps1 提供')
  assert.equal(json.machine?.ok, true, 'lightout.ps1 status 应返回 ok')
  assert.equal(typeof json.machine?.policy?.PBUTTONACTION?.effective, 'number')
  assert.equal(typeof json.vdd?.disabled, 'boolean', 'VDD 设备状态必须以布尔值报出来（设备级状态才是权威）')
  assert.equal(typeof json.vdd?.present, 'boolean')
  assert.equal(typeof json.vdd?.check?.driverVersion, 'string', '版本检查必须报出 VDD 驱动版本')
  assert.equal(typeof json.vdd?.check?.driverStore, 'boolean', '必须检查驱动包还在不在 DriverStore 里')
  assert.equal(typeof json.vdd?.check?.gpuChanged, 'boolean', '必须报出"显卡驱动是否变过"')
  assert.ok(
    ['ready', 'disabled', 'driver-missing', 'missing'].includes(json.vdd?.check?.verdict),
    '版本检查必须给出一个已知 verdict，实际：' + String(json.vdd?.check?.verdict),
  )
  assert.equal(json.elevation, null, '这次会话还没提权过 ⇒ 不该有提权记录')
  assert.equal(typeof json.topology?.internalActive, 'boolean', '拓扑检查必须是解析后的布尔值，不是原始行')
  assert.equal(typeof json.hold?.present, 'boolean')
  assert.equal(json.watchdog.enabled, true)
  assert.equal(json.watchdog.attempts, 0)
  assert.equal(json.options.maxDarkSeconds, 28800)
  assert.equal(json.options.eventLog, EVENTS, '/status 必须报出事件日志路径')
  assert.equal(typeof json.vddReady, 'boolean', 'VDD 是否就绪由宿主算好给客户端（单一来源）')
  assert.ok(Array.isArray(json.warnings), 'warnings 必须始终是数组（客户端照抄它）')
  assert.ok(!('events' in json), '/status 不再暴露 events[]（GET 不受同源门保护，只留最近一条 last）')
  assert.ok('last' in json, 'last（最近一条事件）仍然保留')
  assert.ok('keepAwake' in json, '应带上 keep-awake 体检')
  console.log(
    '  /status  ok  vdd.disabled=%s internalActive=%s hold=%s 电源键=%s',
    json.vdd.disabled,
    json.topology.internalActive,
    json.hold.present,
    json.machine.policy.PBUTTONACTION.effective,
  )
}

// ── 5) /off 在 dryRun 下只出计划 ────────────────────────────────────────────
{
  resetMarker()
  const off = await call(handler, 'POST', ROUTE_PATH + '/off', { lock: true })
  assert.equal(off.status, 200)
  assert.equal(off.json.action, 'off')
  assert.equal(off.json.dryRun, true, 'dryRun 下不得真熄屏')
  assert.equal(off.json.mode, 'vdd-dark')
  assert.equal(off.json.plan.wouldKeepSessionUnlocked, true, '本机不可能在锁定状态下还原拓扑：必须写明暗窗期间不锁')
  assert.deepEqual(off.json.plan.wouldHold, ['DisplayRequired', 'SystemRequired'])
  assert.ok(off.json.needsVdd === null || typeof off.json.needsVdd === 'string', 'dryRun 应报告 VDD 是否就绪而不是拒绝')
  assert.equal(markerLines().length, 0, 'dryRun 不得起任何桩脚本');
  assert.equal(fs.existsSync(HOLD_STATE), false, 'dryRun 不得落下守卫状态文件')
  console.log('  /off dryRun  ok  needsVdd=%s（无副作用）', String(off.json.needsVdd))
}

// ── 6) VDD 被禁用 ⇒ 要授权，且不起守卫 ─────────────────────────────────────
{
  const disabled = mount({
    scripts: { vdd: fixture('vdd-disabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_DISABLED,
    elevateLog: ELEVATE_LOG,
    vddBaseline: BASELINE,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  resetMarker()
  fs.rmSync(ELEVATE_LOG, { force: true })

  const off = await call(disabled, 'POST', ROUTE_PATH + '/off', {})
  assert.equal(off.status, 200)
  assert.equal(off.json.ok, false)
  assert.equal(off.json.needsVdd, 'disabled')
  assert.equal(off.json.elevation.needsAdmin, true)
  // 文案只有一个真源（scripts/vdd-device.messages.zh.txt）。桩脚本目录里没有那个文件 ⇒
  // 宿主返回空串、客户端用 `prompt.error` 兜底；**不再有内置的第二份文案**（必然漂移）。
  // 真实路径的文案在下面「纯函数」一节逐字断言。
  assert.equal(off.json.elevation.wording, '', '读不到 messages 文件 ⇒ 空串（由客户端 error 兜底）')
  assert.equal(typeof off.json.elevation.check?.driverVersion, 'string', '提权说明里要带上只读的环境/版本检查')
  assert.equal(off.json.elevation.check?.verdict, 'disabled')
  assert.equal(off.json.elevation.endpoint, '/vdd')
  assert.deepEqual(off.json.elevation.body, { action: 'enable' })
  assert.equal(markerLines().includes('hold:dark'), false, 'VDD 没就绪时**不得**起守卫')
  assert.equal(fs.existsSync(HOLD_STATE_DISABLED), false)

  // 去重只在**提权进程还在跑**时成立（t8 必修 3）：桩用 LIGHTOUT_TEST_VDD_HOLD_MS 保持存活，
  // 所以这个开关必须在第一次请求之前就设好。
  process.env.LIGHTOUT_TEST_VDD_HOLD_MS = '4000'
  try {
    const vddCall = await call(disabled, 'POST', ROUTE_PATH + '/vdd', { action: 'enable' })
    assert.equal(vddCall.status, 200)
    assert.equal(vddCall.json.ok, true)
    assert.equal(vddCall.json.requested, 'enable')
    assert.equal(vddCall.json.elevate, true, '启用必须走提权路径')
    assert.equal(vddCall.json.needsAdmin, true)
    assert.equal(typeof vddCall.json.helperPid, 'number')
    const vddAgain = await call(disabled, 'POST', ROUTE_PATH + '/vdd', { action: 'enable' })
    assert.equal(vddAgain.status, 200)
    assert.equal(vddAgain.json.deduplicated, true, '上一次的提权进程还在跑 ⇒ 复用，不另起一个')
    assert.equal(vddAgain.json.helperPid, vddCall.json.helperPid)
    assert.ok(
      await waitUntil(() => markerLines().some((line) => line.startsWith('vdd:enable:elevate:parent=')), 8000),
      '应把 -Elevate 与宿主 pid 一起交给执行器（DSH 退出时由它自动禁用设备），实际：' + JSON.stringify(markerLines()),
    )
    // 反方向：等那个 launcher 退出，再去重就不该成立（否则用户点了否、60 s 内再点授权根本弹不出 UAC）。
    assert.ok(await waitUntil(() => !__test.isPidAlive(vddCall.json.helperPid), 8000), '桩 launcher 应已退出')
    const spawnsBefore = markerLines().filter((line) => line.startsWith('vdd:enable:elevate')).length
    const vddThird = await call(disabled, 'POST', ROUTE_PATH + '/vdd', { action: 'enable' })
    assert.equal(vddThird.status, 200)
    assert.equal(vddThird.json.deduplicated, undefined, '上一次的进程已经退出 ⇒ 必须允许重新发起授权')
    assert.notEqual(vddThird.json.helperPid, vddCall.json.helperPid, '这是一次新的提权请求')
    assert.ok(
      await waitUntil(() => markerLines().filter((line) => line.startsWith('vdd:enable:elevate')).length > spawnsBefore, 8000),
      '新的请求必须真的起第二个提权进程，实际：' + JSON.stringify(markerLines()),
    )
  } finally {
    delete process.env.LIGHTOUT_TEST_VDD_HOLD_MS
  }

  // 「用户点了否」必须能被立刻读出来：否则界面只能白等到超时。
  const afterDecline = await call(disabled, 'GET', ROUTE_PATH + '/status?refresh=1')
  assert.equal(afterDecline.json.elevation.declined, true, '取消授权的记录必须出现在 /status 里')
  assert.equal(afterDecline.json.elevation.requested, 'enable')
  assert.equal(afterDecline.json.elevation.launched, false)
  assert.ok(String(afterDecline.json.elevation.error).length > 0, '取消授权要留下原因（原文来自 Start-Process 的异常）')
  assert.equal(afterDecline.json.vdd.disabled, true, '取消授权后设备保持禁用，熄屏功能不可用')
  console.log('  VDD 禁用  ok  needsVdd + 提权文案 + 已取消授权可立刻读出；守卫未启动')
}

// ── 7) VDD 就绪 ⇒ 起守卫、收回执、守卫死后看门狗还原 ────────────────────────
{
  const enabled = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE,
    vddWatchdogMs: 500,
    probeKeepAwake: false,
  })
  resetMarker()
  resetTopologyState()

  const off = await call(enabled, 'POST', ROUTE_PATH + '/off', {})
  assert.equal(off.status, 200)
  assert.equal(off.json.ok, true)
  assert.equal(off.json.mode, 'vdd-dark')
  assert.equal(off.json.guardPid, 999999, '回执里的 pid 必须来自守卫写的状态文件')
  assert.match(String(off.json.checkAfterSwitch), /internalActive=False/, '回执必须带上「内置屏已移出活动集」这一条')
  assert.match(String(off.json.note), /键鼠一动/, '回执必须写明唤醒路径')
  assert.ok(
    markerLines().some((line) => line.startsWith('hold:dark')),
    '应真的起了守卫桩，实际：' + JSON.stringify(markerLines()),
  )
  assert.ok(
    markerLines().includes('hold:dark:parent=' + String(process.pid)),
    '守卫必须拿到宿主 pid（宿主没了它要自己还原），实际：' + JSON.stringify(markerLines()),
  )
  assert.equal(fs.existsSync(HOLD_STATE), true, '守卫应落下状态文件')

  // 守卫桩写的 pid 永远不存在 ⇒ 看门狗必须接手还原拓扑
  assert.ok(
    await waitUntil(() => markerLines().includes('topology:restore'), 8000),
    '守卫已死且拓扑还黑着 ⇒ 看门狗必须还原，实际：' + JSON.stringify(markerLines()),
  )
  assert.ok(markerLines().includes('topology:check'), '看门狗应先查一次拓扑，实际：' + JSON.stringify(markerLines()))
  assert.ok(await waitUntil(() => !fs.existsSync(HOLD_STATE), 8000), '看门狗处理完应清掉状态文件')

  const on = await call(enabled, 'POST', ROUTE_PATH + '/on', {})
  assert.equal(on.status, 200)
  assert.equal(on.json.ok, true)
  assert.equal(on.json.action, 'restore')
  assert.equal(on.json.topology, 'restored-by-stub')
  assert.ok(markerLines().includes('hold:restore'), '逃生口必须真的调执行器还原')
  console.log('  熄屏+看门狗  ok  守卫→回执→看门狗还原→/on 逃生口')
}

// ── 8) 并发：同一时刻的两个 /off 只能起一个守卫（钉住「busy 最前置」）──────────────
// 0.3.0 的写法在 probeVdd（数秒级 PowerShell）**之后**才置 busy ⇒ 两个请求都通过检查、
// 各起一个守卫，这正是一次事故的核心。这条用例就是它的回归钉：把 busy 挪到任何一个
// await 之后，它必须变红。
{
  const conc = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_CONC,
    eventLog: EVENTS,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  const startedGuards = () => markerLines().filter((line) => line.startsWith('hold:dark'))
  resetMarker()
  fs.rmSync(HOLD_STATE_CONC, { force: true })

  const pending = call(conc, 'POST', ROUTE_PATH + '/off', {})
  await sleep(60) // 第一个请求此刻正卡在 probeVdd 里（桩也要几百毫秒）
  const second = await call(conc, 'POST', ROUTE_PATH + '/off', {})
  const first = await pending
  assert.equal(second.status, 409, '第二个 /off 必须在 busy 上被挡下，实际：' + String(second.status) + ' ' + JSON.stringify(second.json))
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.ok(await waitUntil(() => startedGuards().length >= 1, 8000), '第一个 /off 必须起守卫，实际：' + JSON.stringify(markerLines()))
  assert.equal(startedGuards().length, 1, '同一时刻只能起一个守卫，实际：' + JSON.stringify(markerLines()))

  // 同一个 tick 里的两个请求（busy 必须是**同步**置位的，不是"等第一个 await 回来再置"）
  resetMarker()
  const both = await Promise.all([call(conc, 'POST', ROUTE_PATH + '/off', {}), call(conc, 'POST', ROUTE_PATH + '/off', {})])
  assert.equal(both.filter((entry) => entry.status === 200).length, 1, '同一 tick 并发两个 /off：只能有一个 200')
  assert.equal(startedGuards().length, 1, '同一 tick 并发也只能起一个守卫，实际：' + JSON.stringify(markerLines()))
  await sleep(400)
  assert.equal(startedGuards().length, 1, '稍后也不得冒出第二个守卫')
  fs.rmSync(HOLD_STATE_CONC, { force: true })
  console.log('  并发  ok  同一时刻两个 /off ⇒ 409 挡下第二个，只起一个守卫（busy 最前置）')
}

// ── 9) /on ↔ /off 互斥：等待体检期间点了「结束熄屏」⇒ /off 必须作废，不许再点黑 ───────
{
  const mutex = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_MUTEX,
    eventLog: EVENTS,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  resetMarker()
  fs.rmSync(HOLD_STATE_MUTEX, { force: true })
  const pending = call(mutex, 'POST', ROUTE_PATH + '/off', {})
  await sleep(60)
  const on = await call(mutex, 'POST', ROUTE_PATH + '/on', {})
  assert.equal(on.status, 200)
  const off = await pending
  assert.equal(off.status, 200)
  assert.equal(off.json.ok, false, '被 /on 作废的 /off 不许报成功')
  assert.equal(off.json.superseded, true, '必须明确说明"这次熄屏被随后的结束熄屏取消"')
  assert.equal(markerLines().filter((line) => line.startsWith('hold:dark')).length, 0, '/on 之后的 /off 不得再起守卫（否则屏幕又黑）')
  assert.equal(fs.existsSync(HOLD_STATE_MUTEX), false, '也不得留下守卫回执')
  console.log('  /on↔/off 互斥  ok  在飞的 /off 被 /on 作废，不再点黑')
}

// ── 10) /on 只删自己杀掉的那个 pid 的回执：别人的活守卫回执必须留下 ─────────────────
{
  const foreign = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_FOREIGN,
    eventLog: EVENTS,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  resetMarker()
  fs.rmSync(HOLD_STATE_FOREIGN, { force: true })
  // 打桩的 restore 会顺手写下一份"刚起来的另一个守卫"回执（pid = 本进程，绝对活着）：
  // 真实的 /on 就是在 restore 那几秒里和一个新守卫擦肩而过。
  process.env.LIGHTOUT_TEST_RESTORE_RECEIPT_PID = String(process.pid)
  try {
    const on = await call(foreign, 'POST', ROUTE_PATH + '/on', {})
    assert.equal(on.status, 200)
    assert.equal(on.json.killedGuard, false)
    assert.equal(on.json.cleared, false, '不是自己杀的那个 pid ⇒ 不许清回执')
    assert.equal(fs.existsSync(HOLD_STATE_FOREIGN), true, '别人的活守卫回执必须留下（看门狗只认它）')
    const receipt = JSON.parse(fs.readFileSync(HOLD_STATE_FOREIGN, 'utf8').replace(/^\uFEFF/, ''))
    assert.equal(receipt.pid, process.pid)
  } finally {
    delete process.env.LIGHTOUT_TEST_RESTORE_RECEIPT_PID
  }
  fs.rmSync(HOLD_STATE_FOREIGN, { force: true })
  console.log('  /on 回执归属  ok  只删自己杀掉的 pid；别人的活守卫回执留着')
}

// ── 11) spawn 失败 ⇒ /off 必须报失败，绝不许出现 200 ok:true 的假成功回执 ─────────────
{
  const broken = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    psExe: path.join(TMP, 'no-such-powershell.exe'),
    stateFile: HOLD_STATE_BROKEN,
    eventLog: EVENTS_BROKEN,
    vddGate: false, // 预检本身也要起 PowerShell：这里只考"守卫起不来"那条路
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  resetMarker()
  fs.rmSync(HOLD_STATE_BROKEN, { force: true })
  fs.rmSync(EVENTS_BROKEN, { force: true })
  const off = await call(broken, 'POST', ROUTE_PATH + '/off', {})
  assert.equal(off.status, 500, '守卫没起来就不许报成功，实际：' + String(off.status) + ' ' + JSON.stringify(off.json))
  assert.equal(off.json.ok, false)
  assert.equal(off.json.reason, 'guard-spawn-failed')
  assert.equal(fs.existsSync(HOLD_STATE_BROKEN), false, '错误分支不得留下"成功回执"')
  assert.equal(markerLines().length, 0, 'spawn 都没成功，不该有任何桩脚本被调用')
  const events = fs.readFileSync(EVENTS_BROKEN, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line))
  assert.equal(events.at(-1).ok, false, '事件日志里必须记成失败（不是 ok:true）')
  assert.equal(events.at(-1).reason, 'guard-spawn-failed')
  console.log('  spawn 失败  ok  500 + ok:false + 事件记失败（没有假成功回执）')
}

// ── 12) 看门狗：tick 不重叠（重入闸）/ 退避窗口内不空转 / 用户回来立刻重试 / 告警上界面 ──
{
  const wd = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_RETRY,
    eventLog: EVENTS,
    vddWatchdogMs: 300,
    restoreRetryMs: 60000, // 退避拉长，方便断言"窗口内不再打"
    vddGate: false,
    probeKeepAwake: false,
  })

  /** 还原动作必须是"原子的"：中途不得插进别的 marker —— 插进来就说明有第二个 tick 挤进来了。 */
  function restoresAreAtomic(lines) {
    let mid = false
    for (const line of lines) {
      if (line === 'topology:restore') {
        if (mid) return false
        mid = true
      } else if (line === 'topology:restore:done' || line === 'topology:restore:failed') {
        mid = false
      } else if (mid) {
        return false
      }
    }
    return true
  }

  // 第一步：还原很慢（400 ms）而看门狗每 300 ms 一次 —— 没有重入闸的话第二个 tick 会插进
  // 第一个 tick 的"执行还原"和"复查"之间（＝多路并发，各起 PowerShell）。
  resetMarker()
  resetTopologyState()
  fs.writeFileSync(
    HOLD_STATE_RETRY,
    JSON.stringify({ action: 'dark', ok: true, pid: 999999, startedAt: localStamp(-1000), deadline: localStamp(3600 * 1000), maxSeconds: 28800 }),
    'utf8',
  )
  process.env.LIGHTOUT_TEST_TOPO_DELAY_MS = '400'
  try {
    assert.ok(await waitUntil(() => markerLines().includes('topology:restore:done'), 8000), '慢还原也必须跑完（重入闸不能把唯一的 tick 卡死）')
    await sleep(600) // 再给"可能挤进来的第二个 tick"一点时间：它会出现交错的 marker
    assert.ok(restoresAreAtomic(markerLines()), '看门狗 tick 不得重叠（还原中途不许插进别的调用），实际：' + JSON.stringify(markerLines()))
    assert.ok(await waitUntil(() => !fs.existsSync(HOLD_STATE_RETRY), 4000), '还原成功 ⇒ 回执应被清掉')
  } finally {
    delete process.env.LIGHTOUT_TEST_TOPO_DELAY_MS
  }

  // 第二步：还原永远失败 ⇒ 退避窗口内必须停手
  resetMarker()
  resetTopologyState() // 上一阶段已经还原过：这里要让 check 重新报"还黑着"
  fs.writeFileSync(
    HOLD_STATE_RETRY,
    JSON.stringify({ action: 'dark', ok: false, restoreFailed: true, restored: false, restoreAttempts: 1, pid: 999999, reason: 'panel could not be restored' }),
    'utf8',
  )
  process.env.LIGHTOUT_TEST_TOPO_FAIL = '1' // restore 永远不生效 ⇒ 看门狗走失败分支
  try {
    assert.ok(await waitUntil(() => markerLines().includes('topology:restore:failed'), 8000), '还原失败分支必须被走到，实际：' + JSON.stringify(markerLines()))
    await sleep(900) // 退避窗口是 60 s：这段时间里不许再打
    assert.equal(
      markerLines().filter((line) => line === 'topology:restore').length,
      1,
      '失败之后必须在退避窗口内停手（旧写法是 300 ms 一次 = 每秒两个 PowerShell），实际：' + JSON.stringify(markerLines()),
    )
    assert.ok(restoresAreAtomic(markerLines()), '失败路径同样不许重叠：' + JSON.stringify(markerLines()))
    assert.equal(fs.existsSync(HOLD_STATE_RETRY), true, '还原没成功 ⇒ 回执留着交给下一次（也是 /status 告警的来源）')
    resetMarker()
    const status = await call(wd, 'GET', ROUTE_PATH + '/status?refresh=1')
    assert.equal(status.status, 200)
    assert.ok(
      status.json.warnings.some((warning) => /面板尚未还原/.test(String(warning))),
      '/status 必须把"面板还没还原"报给界面（warnings 是真源，warning 取第一顺位），实际：' + JSON.stringify(status.json.warnings),
    )
    assert.match(String(status.json.warning), /面板尚未还原/, '最紧急的一条要排在第一顺位')
    assert.ok(
      await waitUntil(() => markerLines().includes('topology:restore'), 8000),
      '显式 refresh（用户回来了）必须立刻重试，不等退避窗口，实际：' + JSON.stringify(markerLines()),
    )

    // 第三步：kick 正好撞在**在飞的 tick** 上 ⇒ 必须排队、出闸后补跑一次（t8 必修 2）。
    // 判据：这次 mount 的 restoreRetryMs=60 s，所以窗口内**定时器不会**再起还原；能出现第二次
    // restore:failed 就只能是"被挡下的 kick 补跑了"。
    resetMarker()
    process.env.LIGHTOUT_TEST_TOPO_DELAY_MS = '2500' // 把在飞 tick 拖住，好让下一次 refresh 撞进来
    try {
      const first = await call(wd, 'GET', ROUTE_PATH + '/status?refresh=1') // 它末尾的 kick 起 tick
      assert.equal(first.status, 200)
      assert.ok(await waitUntil(() => markerLines().includes('topology:restore'), 8000), 'kick 之后应起一次还原')
      const second = await call(wd, 'GET', ROUTE_PATH + '/status?refresh=1') // 这一次的 kick 会撞在在飞 tick 上
      assert.equal(second.status, 200)
      assert.ok(
        await waitUntil(() => markerLines().filter((line) => line === 'topology:restore:failed').length >= 2, 20000),
        '被重入闸挡下的 kick 必须在出闸后补跑（否则"用户回来立刻重试"有相当概率是空转），实际：' + JSON.stringify(markerLines()),
      )
    } finally {
      delete process.env.LIGHTOUT_TEST_TOPO_DELAY_MS
    }
  } finally {
    delete process.env.LIGHTOUT_TEST_TOPO_FAIL
  }
  fs.rmSync(HOLD_STATE_RETRY, { force: true })
  console.log('  看门狗  ok  tick 不重叠；退避窗口内不空转；refresh 立刻重试；被挡下的 kick 会补跑')
}

// ── 13) 上一次的还原还没完成时，/off 必须接管工作单，不许清回执也不许起新守卫 ──────────
// 旧行为：先删掉唯一的工作单、再起一个全新的 8 小时守卫 ⇒ 用户在黑屏里盲点一下又是一轮长暗窗（t8 必修 4）。
{
  const pending = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_PENDING,
    eventLog: EVENTS,
    vddWatchdogMs: 0, // 关掉看门狗：这里只验 /off 自身的行为（kick 走的是同一条 watchdogTick 通道）
    probeKeepAwake: false,
  })
  resetMarker()
  const receipt = { action: 'dark', ok: false, restoreFailed: true, restored: false, restoreAttempts: 1, pid: 999999, reason: 'panel could not be restored' }
  fs.writeFileSync(HOLD_STATE_PENDING, JSON.stringify(receipt), 'utf8')
  const off = await call(pending, 'POST', ROUTE_PATH + '/off', {})
  assert.equal(off.status, 200)
  assert.equal(off.json.ok, false)
  assert.equal(off.json.reason, 'panel-not-restored', '必须明说"上一次还没还原完"而不是又黑一次')
  assert.equal(markerLines().filter((line) => line.startsWith('hold:dark')).length, 0, '不得起新守卫')
  assert.equal(fs.existsSync(HOLD_STATE_PENDING), true, '工作单必须留着（看门狗靠它收尾）')
  assert.equal(JSON.parse(fs.readFileSync(HOLD_STATE_PENDING, 'utf8').replace(/^\uFEFF/, '')).restoreFailed, true)
  // 回执形状要和其它 /off 分支一致（t8 必修 6③）
  for (const key of ['ok', 'action', 'mode', 'reason', 'error', 'needsVdd', 'hold', 'guardPid', 'vdd', 'plan', 'keepAwake', 'warning']) {
    assert.ok(key in off.json, '/off 回执必须始终含 ' + key + '，实际：' + Object.keys(off.json).join(','))
  }
  fs.rmSync(HOLD_STATE_PENDING, { force: true })
  console.log('  /off×未还原完  ok  接管工作单：不清回执、不起新守卫、reason=panel-not-restored')
}

// ── 14) managed 实例：期望值可配置，偏差/多实例/选不出都要报出来 ────────────────────
{
  const mismatch = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_DEFAULT,
    eventLog: EVENTS,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
    vddInstance: 'ROOT\\DISPLAY\\0009', // 故意跟桩报的 0000 不一致
  })
  const status = await call(mismatch, 'GET', ROUTE_PATH + '/status?refresh=1')
  assert.equal(status.status, 200)
  assert.equal(typeof status.json.vdd?.check?.deviceChoice, 'string', 'verify 的 deviceChoice 必须透到 check')
  assert.equal(status.json.vdd.check.deviceCount, 2, 'deviceCount 必须透出来')
  const warnings = status.json.warnings.join(' | ')
  assert.match(warnings, /实例与期望不一致/, '期望值不一致必须报出来，实际：' + warnings)
  assert.match(warnings, /2 张 VDD 设备实例/, '多实例（只报告不拒绝）必须报出来，实际：' + warnings)
  console.log('  managed 实例  ok  期望值可配置；偏差与多实例都进 warnings')
}

// ── 9) VDD 执行器探不到 ⇒ 状态里记「探不到」，且不阻塞 status ─────────────────
{
  const blind = mount({
    scripts: { vdd: path.join(TMP, 'nope-does-not-exist.ps1') },
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  const status = await call(blind, 'GET', ROUTE_PATH + '/status?refresh=1')
  assert.equal(status.status, 200)
  assert.equal(status.json.vdd.available, false)
  assert.equal(status.json.vdd.disabled, null, '探不到时不得猜成「已启用」或「已禁用」')
  assert.match(String(status.json.warning), /探不到/)
  console.log('  VDD 探不到  ok  记「探不到」且不崩')
}

// ── 10) 404（含已移除的 /policy/safe）与参数归一化 ─────────────────────────
{
  const missing = await call(handler, 'GET', ROUTE_PATH + '/nope')
  assert.equal(missing.status, 404)

  const wrongMethod = await call(handler, 'DELETE', ROUTE_PATH + '/off')
  assert.equal(wrongMethod.status, 404, '未声明的方法不应命中')

  const policy = await call(handler, 'POST', ROUTE_PATH + '/policy/safe', {})
  assert.equal(policy.status, 404, 'POST /policy/safe 已从交付面移除，不得再存在')
  const policyRestore = await call(handler, 'POST', ROUTE_PATH + '/policy/safe', { restore: true })
  assert.equal(policyRestore.status, 404, '还原分支同样不得存在')

  const defaults = __test.normalizeOptions(undefined)
  assert.equal(defaults.maxDarkSeconds, 28800, '暗窗绝对上限 8 小时')
  assert.equal(defaults.darkPollMs, 200)
  assert.equal(defaults.vddWatchdogMs, 5000)
  assert.equal(defaults.darkReceiptMs, 8000)
  assert.equal(defaults.vddGate, true, '熄屏前必须查设备状态（设备级状态才是权威）')
  assert.equal(defaults.stateFile, '', '空串＝用 %TEMP%\\lightout-hold.json')
  assert.equal(defaults.elevateLog, '', '空串＝用 %TEMP%\\lightout-vdd-elevate.json')
  assert.equal(defaults.vddBaseline, '', '空串＝用 %TEMP%\\lightout-vdd-baseline.json')
  assert.equal(defaults.eventLog, '', '空串＝用 %TEMP%\\lightout-events.jsonl')
  assert.equal(defaults.restoreRetryMs, 20000, '看门狗失败重试：前几次 20 s')
  assert.equal(defaults.restoreRetrySlowMs, 30000, '连续失败后的降级间隔（t8：120 s 太久）')
  assert.equal(defaults.vddDedupMs, 60000, '/vdd 同动作去重窗口')
  assert.equal(defaults.bodyMaxBytes, 8192, '/off 的 body 上限（busy 覆盖读取，不能没有上限）')
  assert.equal(defaults.psExe, '', '空串＝用 powershell.exe')
  assert.equal(defaults.dryRun, false)
  assert.equal(defaults.probeKeepAwake, true)
  // 已删除的死键不得回来（它们曾经只是被接受、完全不生效）
  for (const dead of [
    'lockDelayMs',
    'repeat',
    'repeatGapMs',
    'tailDelayMs',
    'preOffSettleMs',
    'lockOnWake',
    'autoLockMs',
    'dimTo',
  ]) {
    assert.equal(defaults[dead], undefined, dead + ' 已删除，不得再出现在默认值里')
  }

  const clamped = __test.normalizeOptions({
    maxDarkSeconds: 999999,
    darkPollMs: 1,
    vddWatchdogMs: 1,
    darkReceiptMs: 1,
    restoreRetryMs: 1,
    restoreRetrySlowMs: 99999999,
    bodyMaxBytes: 99999999,
    dryRun: true,
  })
  assert.equal(clamped.maxDarkSeconds, 86400, 'maxDarkSeconds 上限 24h')
  assert.equal(clamped.darkPollMs, 50, 'darkPollMs 下限 50ms')
  assert.equal(clamped.vddWatchdogMs, 500, '看门狗下限 500ms')
  assert.equal(clamped.darkReceiptMs, 500)
  assert.equal(clamped.restoreRetryMs, 200, '退避下限 200ms')
  assert.equal(clamped.restoreRetrySlowMs, 3600000, '降级退避上限 1h')
  assert.equal(clamped.bodyMaxBytes, 1024 * 1024, 'body 上限 1 MiB')
  assert.equal(clamped.dryRun, true)
  assert.equal(__test.normalizeOptions({ vddWatchdogMs: 0 }).vddWatchdogMs, 0, '看门狗允许显式关闭')
  assert.equal(__test.normalizeOptions({ scripts: { vdd: fixture('vdd-enabled.ps1') } }).scripts.vdd, fixture('vdd-enabled.ps1'))
  assert.equal(__test.normalizeOptions({ scripts: { vdd: '' } }).scripts.vdd, '', '空串＝用包内默认脚本')
  console.log('  404/归一化  ok  （/policy/safe 已移除）')
}

// ── 11) 纯函数直测 ─────────────────────────────────────────────────────────
{
  assert.equal(__test.isLoopbackAddress('127.0.0.1'), true)
  assert.equal(__test.isLoopbackAddress('::1'), true)
  assert.equal(__test.isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(__test.isLoopbackAddress('192.168.1.50'), false)
  assert.equal(__test.isLoopbackAddress(undefined), false)

  assert.equal(
    __test.isSameOriginMutation({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' } }),
    true,
  )
  assert.equal(
    __test.isSameOriginMutation({ headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3081' } }),
    false,
    '端口不同不算同源',
  )
  assert.equal(
    __test.isSameOriginMutation({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }),
    true,
  )
  assert.equal(__test.isSameOriginMutation({ headers: { host: '127.0.0.1:3080' } }), false)
  assert.equal(__test.isSameOriginMutation({ headers: {} }), false)

  // RESULT 行的键值解析：嵌套项必须排在最后（vdd-device.ps1 的契约），否则内层键会被吃掉
  const kv = __test.parseKeyValues(
    'RESULT: action=state device=ROOT\\DISPLAY\\0000 disabled=False monitor=True admin=False topology=activePaths=1 internalActive=True vddActive=False',
  )
  assert.equal(kv.action, 'state')
  assert.equal(kv.device, 'ROOT\\DISPLAY\\0000')
  assert.equal(kv.disabled, 'False')
  assert.equal(kv.activePaths, '1', '嵌套的拓扑键也要解析出来')
  assert.equal(kv.internalActive, 'True')

  assert.equal(__test.isPidAlive(process.pid), true)
  assert.equal(__test.isPidAlive(999999), false)
  assert.equal(__test.isPidAlive(0), false)
  assert.equal(__test.isPidAlive(null), false)

  // spawnHidden 必须自己吃掉 'error' 事件（没监听的话未捕获的 'error' 会打死宿主进程），
  // 而且必须能把失败报出来——只挂监听还不够，调用方要能把它当成真失败。
  const brokenSpawn = __test.spawnHidden(path.join(TMP, 'never-runs.ps1'), [], path.join(TMP, 'no-such-powershell.exe'))
  assert.equal(brokenSpawn.pid, null, 'spawn 失败 ⇒ pid 为 null')
  await sleep(300)
  assert.ok(brokenSpawn.failure() instanceof Error, 'spawn 失败必须能由 failure() 读出（进程还活着）')

  assert.match(__test.holdStateFile({ stateFile: '' }), /lightout-hold\.json$/)
  assert.equal(__test.holdStateFile({ stateFile: 'C:\\x\\y.json' }), 'C:\\x\\y.json')
  assert.ok(__test.elevateLogFile({ elevateLog: '' }).endsWith('lightout-vdd-elevate.json'))
  assert.ok(__test.baselineFile({ vddBaseline: '' }).endsWith('lightout-vdd-baseline.json'))
  assert.equal(__test.readElevateLog({ elevateLog: path.join(TMP, 'no-such-elevate.json') }), null)

  // 提权记录只在最近 10 分钟内有效：上一次请求留下的记录不能拿来解释这一次
  const staleLog = path.join(TMP, 'stale-elevate.json')
  fs.writeFileSync(staleLog, JSON.stringify({ action: 'enable', launched: false, declined: true, at: '2020-01-01T00:00:00', error: 'old' }), 'utf8')
  assert.equal(__test.readElevateLog({ elevateLog: staleLog }), null, '过期记录必须被忽略')
  const freshLog = path.join(TMP, 'fresh-elevate.json')
  // 本地墙钟时间，和被测代码的读法一致：PowerShell 的 `(Get-Date).ToString('s')` 写的是本地时间，
  // 而 `Date.parse('2026-09-26T12:05:31')`（无时区）也按本地解释。用 toISOString() 会写成 UTC，
  // 被当成 8 小时前的记录过滤掉——这里踩过一次。
  const localNow = new Date()
  const localStamp = new Date(localNow.getTime() - localNow.getTimezoneOffset() * 60000).toISOString().slice(0, 19)
  fs.writeFileSync(freshLog, JSON.stringify({ action: 'enable', launched: false, declined: true, at: localStamp, error: 'canceled by the user' }), 'utf8')
  const fresh = __test.readElevateLog({ elevateLog: freshLog })
  assert.equal(fresh.declined, true)
  assert.equal(fresh.launched, false)
  assert.equal(fresh.requested, 'enable')
  assert.equal(__test.readHoldState({ stateFile: path.join(TMP, 'missing.json') }).present, false)
  assert.equal(__test.readHoldState({ stateFile: HOLD_STATE }).present, false, '状态文件已被看门狗清掉')

  // 提权文案必须来自 vdd-device.messages.zh.txt（单一真源），不是代码里另写一份
  const wording = __test.readWording(__test.normalizeOptions(undefined))
  assert.match(wording, /ROOT\\DISPLAY\\0000/, '文案应来自 messages 文件')
  assert.match(wording, /不会做的事/)
  assert.equal(
    __test.readWording(__test.normalizeOptions({ scripts: { vdd: fixture('vdd-enabled.ps1') } })),
    '',
    '读不到 messages 文件 ⇒ 返回空串（客户端用 prompt.error 兜底，不再有第二份文案）',
  )
  console.log('  纯函数  ok  守卫 / RESULT 解析 / 探活 / 状态文件 / 提权文案（单一真源）')
}

// ── 12) 执行器脚本静态契约 ─────────────────────────────────────────────────
{
  const scripts = ['scripts/lightout-topology.ps1', 'scripts/lightout-hold.ps1', 'scripts/vdd-device.ps1', 'scripts/lightout-vdd-guard.ps1']
  for (const relative of scripts) {
    const file = pkgFile(relative)
    assert.ok(fs.existsSync(file), relative + ' 必须在包里')
    const text = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(text, /[^\x00-\x7F]/, relative + ' 必须纯 ASCII（PS 5.1 按 ANSI 解析无 BOM 的 .ps1）')
  }

  const hold = fs.readFileSync(pkgFile('scripts/lightout-hold.ps1'), 'utf8')
  assert.match(hold, /lockedWhileDark = \$false/, '暗窗期间不得锁屏：锁着的时候 SetDisplayConfig 会被拒绝（5）')
  assert.match(hold, /Do NOT lock here/, '这条不变式必须留在代码里，别再被"顺手"改回去')
  assert.match(hold, /internalActive=True/, '还原必须校验内置屏回来了')
  assert.match(hold, /StateFile/, '必须把回执落盘，供宿主读')
  assert.match(hold, /FileShare\]::None/, '守卫必须有单实例锁：第二个守卫绝不能再叠上来（2026-09-26 事故）')
  assert.doesNotMatch(
    hold,
    /AddSeconds\(\[Math\]::Max\(60, \$MaxSeconds\)\)/,
    '还原重试窗口不得再取自暗窗上限（那是 8 小时：会让 CPU 与面板反复重配置一直跑下去）',
  )
  assert.match(hold, /\$RestoreSeconds/, '还原重试必须有独立的小窗口参数')
  assert.match(hold, /restoreFailed/, '放弃还原时必须把 restoreFailed 落盘，看门狗才知道要接手')
  // 跨层覆盖缺口（t8 的反证：删掉终局那次落盘，整套宿主用例仍会全绿）——这里补**定位到分支**的
  // 断言：`$result.ok = $restored` 之后、该动作的 Emit-Result 之前必须有 Save-HoldReceipt。
  // （有界正则/按括号取块都会被后面别的分支误命中——前两版就是这么漏掉反证的。）
  const darkTail = sliceBetween(hold, '$result.ok = $restored', 'Emit-Result $result')
  assert.match(
    darkTail,
    /Save-HoldReceipt/,
    '「放弃还原」的分支里必须调用 Save-HoldReceipt（否则盘上回执没有 ok/restoreFailed，t2-F1 会原样复活）',
  )
  const crashBlock = sliceBetween(hold, 'guard-crashed', 'Emit-Result $result')
  assert.match(crashBlock, /Save-HoldReceipt/, '守卫崩溃的分支也必须落盘（宿主看门狗只认回执）')

  const vdd = fs.readFileSync(pkgFile('scripts/vdd-device.ps1'), 'utf8')
  assert.match(vdd, /pnputil\.exe \/disable-device|Set-DeviceState/, '禁用必须走 pnputil /disable-device')
  assert.match(vdd, /enable-device/, '启用必须走 pnputil /enable-device')
  assert.match(vdd, /-WindowStyle Hidden/, '提权后的守卫窗口必须隐藏（可见窗口被关掉 = 守卫消失）')
  assert.match(vdd, /ShowWindow/, '但要留一个显式开关给人工排查')
  assert.match(vdd, /ConfigFlags/, '设备级状态才是权威：必须读 ConfigFlags')
  assert.match(vdd, /Status -ne 'Unknown'/, 'present 判定必须排掉非在位的设备实例')
  assert.match(vdd, /'verify'/, 'verify（只读版本/环境检查）必须是正式动作')
  assert.match(vdd, /\$Action -ne 'verify'/, 'verify 不能走提权：取消授权之后它仍然要能用')
  assert.match(vdd, /ElevateLog/, '提权结果必须落盘，供宿主读出"用户点了否"')
  assert.match(vdd, /declined/, '脚本必须写下 declined')
  assert.match(vdd, /gpuChanged/, '版本检查必须比对显卡驱动版本，才能在 GPU 更新后提前告警')
  assert.match(vdd, /VddMonitorAll|present-only/, 'present 判定要有明确的在位过滤')
  // 2026-10-11 用户裁定：删掉「守卫 24 小时到点自行禁用 VDD」。这条契约同时钉住"删干净"与
  // "删了之后 pid 复用仍有防线"——只删不加就会让裸 pid 误判变成永不到期的死等。
  assert.doesNotMatch(vdd, /\$MaxWatchMinutes/, '24 小时死线的参数与它的引用必须都已删除：DSH 连续跑几天也不许守卫自己禁用 VDD')
  assert.doesNotMatch(vdd, /cap-reached/, '「到点即禁用」的分支必须整条消失，不留死代码')
  assert.match(vdd, /StartTime/, 'pid 复用防线改为比对进程启动时间（裸 pid 会被回收，见裁定 Q4）')
  assert.match(vdd, /pid-reused/, 'pid 被复用要报成独立 reason，不要混进 parent-gone')
  assert.doesNotMatch(vdd, /AddMinutes/, '守卫不得再有任何自设的到期时间')

  // 提权守护（计划任务启动的常驻者）：它只做"没有 DSH 就跑一次禁用"，绝不启用任何东西
  const guard = fs.readFileSync(pkgFile('scripts/lightout-vdd-guard.ps1'), 'utf8')
  assert.match(guard, /Win32_Process/, '判活要真的去看进程表')
  assert.match(guard, /CommandLine/, 'DSH 宿主必须按**命令行指纹**判活：裸 pid 会被回收（与 Q4 同一条理由）')
  assert.match(guard, /DshExclude/, '必须排掉 DSH 自己的 subprocess runner —— 它的命令行会带上被执行的整段载荷（本脚本的演练就踩过）')
  assert.match(guard, /dsh-subprocess-local/, '排除特征就是 runner 的包路径')
  assert.doesNotMatch(guard, /-Action enable/, '守护绝不启用设备：启用必须留在用户交互的 UAC 后面')
  assert.match(guard, /lightout-vdd-disable\.request/, '请求文件路径的缺省值必须与宿主半写的那一份一致')
  assert.match(guard, /lightout-vdd-guard\.json/, '状态文件路径的缺省值必须与宿主 /status 读的那一份一致')
  assert.match(guard, /Test-Admin/, '守护必须自报有没有管理员权限（没有的话 disable 只会回 needadmin）')
  assert.match(guard, /-File \$VddScript -Action disable/, '禁用必须复用 vdd-device.ps1：pnputil 只有一处实现')

  // 安装脚本（工作区 tools/ 下，不随包分发）：任务名与最高权限是它对外的契约
  const installerPath = fileURLToPath(new URL('../../tools/install-vdd-guard.ps1', import.meta.url))
  assert.ok(fs.existsSync(installerPath), 'tools/install-vdd-guard.ps1 必须在（它注册守护的计划任务）')
  const installer = fs.readFileSync(installerPath, 'utf8')
  assert.doesNotMatch(installer, /[^\x00-\x7F]/, 'install-vdd-guard.ps1 必须纯 ASCII')
  assert.match(installer, /DSH-LightOut-VDD-Guard/, '计划任务名是对外契约（回退命令靠它）')
  assert.match(installer, /RunLevel Highest/, '守护必须最高权限：pnputil 要管理员，而计划任务不弹 UAC')
  assert.match(installer, /-AtLogOn/, '登录时启动：登录之后守护才可能有活干')
  assert.match(installer, /Unregister-ScheduledTask/, '必须带一条真回退路径')
  assert.match(installer, /\[switch\]\$Restart/, '必须有一条"改了守护脚本之后如何生效"的显式通道')
  assert.match(installer, /IgnoreNew/, '安装/重启必须先停旧进程：IgnoreNew 会让已在跑的旧进程继续跑旧脚本')
  assert.match(installer, /guard freshness/, '-Status 要能回答"现在跑的是不是旧脚本"')
  assert.match(installer, /lightout-vdd-guard\\\.ps1/, '进程匹配必须带 .ps1 后缀，否则做检测的那条命令自己会被误认为守护进程')
  assert.match(installer, /state-file pid/, '进程判据必须有一条不依赖 CommandLine 的路：提权进程的 CommandLine 普通权限读不到（WMI 返回 null），只靠命令行会把活着的守护报成"未运行"')
  assert.match(installer, /Get-Process -Id/, '用守护状态文件里的 pid 判活（这条不受 CommandLine 可读性影响）')

  const messages = fs.readFileSync(pkgFile('scripts/vdd-device.messages.zh.txt'), 'utf8')
  assert.match(messages, /\[enable\]/, '提权文案必须有 [enable] 段')
  assert.match(messages, /\[verify\]/, '只读版本检查也要有自己的说明段')
  assert.match(messages, /不会做的事/, '文案必须写清「不会做什么」')

  // PS 5.1 真的能解析这三个脚本（不是"看起来像 PowerShell"）
  const parse = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      scripts
        .map((relative) => {
          const file = pkgFile(relative).replace(/'/g, "''")
          return "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('" + file + "',[ref]$null,[ref]$e);$e.Count"
        })
        .join(';'),
    ],
    { encoding: 'utf8' },
  )
  assert.deepEqual(
    parse.trim().split(/\r?\n/).map((line) => line.trim()),
    ['0', '0', '0', '0'],
    '四个执行器都必须能被 Windows PowerShell 5.1 解析',
  )

  console.log('  脚本契约  ok  四个执行器 ASCII + PS 5.1 可解析 + 关键不变式在位')
}

// ── 13) 已有守卫在跑 ⇒ 绝不再叠第二个（2026-09-26 事故的核心不变式）──────────
// 事故链：提权轮询堆积 ⇒ 多个 /off 并发到达 ⇒ 旧代码在 probeVdd 之后才置 busy，全部通过
// ⇒ 同时起好几个守卫，各自切拓扑、各自编译 C#、唤醒时抢着还原 ⇒ 屏幕反复黑 + 风扇狂转。
{
  const single = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_LIVE,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  resetMarker()
  // deadline 必须是**未来**：过了期的回执不再算「还黑着」（pid 复用的防护，见 readHoldState）。
  fs.writeFileSync(
    HOLD_STATE_LIVE,
    JSON.stringify({ action: 'dark', ok: true, pid: process.pid, startedAt: localStamp(-1000), deadline: localStamp(8 * 3600 * 1000), maxSeconds: 28800 }),
    'utf8',
  )
  const again = await call(single, 'POST', ROUTE_PATH + '/off', {})
  assert.equal(again.status, 409, '已有守卫在跑时必须拒绝，而不是再起一个')
  assert.equal(again.json.ok, false)
  assert.equal(again.json.guardPid, process.pid, '回执要把正在跑的那个守卫的 pid 报出来')
  const startedGuards = () => markerLines().filter((line) => line.startsWith('hold:dark'))
  assert.equal(startedGuards().length, 0, '不得起第二个守卫，实际：' + JSON.stringify(markerLines()))

  // busy 位不能在拒绝路径上泄漏：守卫结束后必须能正常再熄屏
  fs.rmSync(HOLD_STATE_LIVE, { force: true })
  const fresh = await call(single, 'POST', ROUTE_PATH + '/off', {})
  assert.equal(fresh.status, 200, '守卫没了以后必须能再熄屏（busy 位不能在 409 路径上泄漏）')
  assert.equal(fresh.json.ok, true)
  assert.equal(startedGuards().length, 1, '这时才该起守卫，实际：' + JSON.stringify(markerLines()))
  fs.rmSync(HOLD_STATE_LIVE, { force: true })
  console.log('  单守卫  ok  已有守卫 ⇒ 409 拒绝；busy 位在拒绝路径上照样释放')
}

// ── 14) 守卫放弃还原（restoreFailed）⇒ 看门狗接手，且不空转 ──────────────────
{
  const wd = mount({
    scripts: { vdd: fixture('vdd-enabled.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_FAILED,
    vddWatchdogMs: 500,
    probeKeepAwake: false,
  })
  resetMarker()
  resetTopologyState()
  fs.writeFileSync(
    HOLD_STATE_FAILED,
    JSON.stringify({ action: 'dark', ok: false, restoreFailed: true, restored: false, restoreAttempts: 1, pid: 999999, note: 'panel could not be restored' }),
    'utf8',
  )
  assert.ok(await waitUntil(() => markerLines().includes('topology:restore'), 8000), 'restoreFailed 必须让看门狗接手还原，实际：' + JSON.stringify(markerLines()))
  assert.ok(await waitUntil(() => !fs.existsSync(HOLD_STATE_FAILED), 8000), '还原成功后应清掉回执')
  console.log('  看门狗接手  ok  restoreFailed ⇒ 还原 + 清回执')
}

// ── 15) 关机拓展（SafelyQuit）⇒ 只发令给提权守护；服务缺席/旧版都不影响其余部分 ──
// 为什么要这条：关机拓展以**宿主权限**跑，而禁用设备要管理员 —— 所以它能做的只有写一个请求文件，
// 真正执行的是 scripts/lightout-vdd-guard.ps1（计划任务以最高权限启动的常驻守护）。
{
  // 15a) 服务在场：登记一条 hook，参数与"只发令"的语义都要钉住
  fs.rmSync(DISABLE_REQUEST, { force: true })
  const h15 = mount({ probeKeepAwake: false, vddWatchdogMs: 0, dryRun: true })
  assert.equal(shutdownHooks.length, 1, 'safelyQuit 在场时应恰好登记一条关机拓展')
  const hook = shutdownHooks[0]
  assert.equal(hook.options.id, 'dsh-lightout/vdd-disable')
  assert.equal(hook.options.order, 20, 'order 决定它在别的关机动作之后的次序')
  assert.equal(hook.options.timeoutMs, 3000, '单条超时给足（被动关闭那一趟总共只有 2.5 s 预算）')
  assert.equal(typeof hook.action, 'function', '动作必须是函数式：命令式在这里拿不到管理员权限')
  assert.equal(shutdownHookDisposers.length, 1, '摘除器必须交给 ctx.effect 自持（卸载即撤登记）')

  // 动作跑起来：**同步写一个请求文件就返回**（绝不在这里等守护跑 pnputil）
  await hook.action()
  assert.ok(fs.existsSync(DISABLE_REQUEST), 'hook 必须写出禁用请求文件，实际：' + DISABLE_REQUEST)
  const request = JSON.parse(fs.readFileSync(DISABLE_REQUEST, 'utf8'))
  assert.equal(request.reason, 'safely-quit')
  assert.equal(request.pid, process.pid)

  // /status 必须如实转述守护状态：没跑过 ⇒ null（不是错误），跑过 ⇒ 原样报出
  const status15 = await call(h15, 'GET', ROUTE_PATH + '/status')
  assert.equal(status15.status, 200)
  assert.ok('guard' in status15.json, '/status 必须带上 guard 段')
  assert.equal(status15.json.guard, null, '守护没跑过时 guard 必须是 null')
  fs.writeFileSync(GUARD_STATE, JSON.stringify({ pid: 4321, dshHosts: 0, lastReason: 'dsh-gone', deviceDisabled: true }), 'utf8')
  const status15b = await call(h15, 'GET', ROUTE_PATH + '/status')
  assert.equal(status15b.json.guard.pid, 4321)
  assert.equal(status15b.json.guard.lastReason, 'dsh-gone')
  assert.equal(status15b.json.guard.deviceDisabled, true)
  assert.equal(status15b.json.guard.requestFile, DISABLE_REQUEST, '守护状态里要带上请求文件路径，排障时一步到位')

  // 15b) 服务缺席（没装 SafelyQuit）：不登记、不抛，路由与其余功能照常
  const h15c = mount({ probeKeepAwake: false, vddWatchdogMs: 0, dryRun: true }, { safelyQuitMissing: true })
  assert.equal(shutdownHooks.length, 0, '服务缺席时不得登记任何关机拓展')
  assert.equal((await call(h15c, 'GET', ROUTE_PATH + '/status')).status, 200, '服务缺席不影响插件其余部分')

  // 15c) 服务在、但版本太旧（没有 onShutdown）：同样只是不登记
  mount({ probeKeepAwake: false, vddWatchdogMs: 0, dryRun: true }, { safelyQuit: {} })
  assert.equal(shutdownHooks.length, 0, '没有 onShutdown 的旧版服务不得被登记')

  fs.rmSync(DISABLE_REQUEST, { force: true })
  fs.rmSync(GUARD_STATE, { force: true })
  console.log('  关机拓展  ok  只发令（写请求文件）+ 缺席/旧版都不影响其余部分 + /status 转述守护状态')
}

// ── 16) 挂载期预热体检（"体检到底什么时候跑"钉死在这里）──────────────────────
{
  resetSpawnLog()
  // 探针跑道 + 让它在飞久一点：这样"首请求去 JOIN 它"是可判定的，而不是撞运气。
  process.env.LIGHTOUT_TEST_SPAWN_SLEEP_MS = '1200'
  const h16 = mount({
    scripts: { vdd: fixture('vdd-spawns.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_DEFAULT,
    disableRequest: DISABLE_REQUEST,
    guardState: GUARD_STATE,
    elevateLog: ELEVATE_LOG,
    vddBaseline: BASELINE,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })

  // ① 挂载那一刻就起飞了（不 await：apply 已经返回，探针还在跑）
  assert.ok(
    await waitUntil(() => spawnLines().length >= 1, 8000),
    '挂载期必须立刻起一次预热体检（探针跑道应见到第一行）',
  )
  assert.equal(spawnLines()[0], 'vdd:verify', '预热体检跑的就是 vdd-device.ps1 -Action verify（只读版本检查）')

  // ② 挂载期恰好一次：探测还没回来，不能有第二条腿
  assert.equal(spawnLines().length, 1, '挂载期只许起一次体检，实际起飞了 ' + String(spawnLines().length) + ' 次')

  // ③ 紧接着的 /status **复用**挂载期那一份（单飞），不另起 PowerShell
  const first = await call(h16, 'GET', ROUTE_PATH + '/status')
  assert.equal(first.status, 200)
  assert.ok('envCheck' in first.json, '/status 必须带上 envCheck 段（体检来源/时间/是否在飞）')
  assert.equal(
    first.json.envCheck.trigger,
    'mount',
    '第一次读到的体检必须标成挂载期跑的，实际：' + String(first.json.envCheck.trigger),
  )
  assert.equal(first.json.envCheck.warmedAtMount, true, 'warmedAtMount 必须如实报 true')
  assert.equal(typeof first.json.envCheck.finishedAt, 'string', '预热跑完后必须报出完成时间')
  assert.equal(first.json.envCheck.inFlight, false, '结果已落地 ⇒ inFlight 必须是 false')
  assert.match(first.json.vdd?.check?.driverVersion ?? '', /^9\.9\.9\.9$/, '这份体检的数据必须真的来自探针（桩报 9.9.9.9）')
  assert.equal(
    spawnLines().length,
    1,
    '/status 必须复用挂载期那份在飞结果（单飞），不许再起一次；实际：' + spawnLines().join(' | '),
  )

  // ④ 缓存还在窗口内 ⇒ 仍然是同一份，来源不变（缓存不会把自己伪装成"刚重跑"）
  const cached = await call(h16, 'GET', ROUTE_PATH + '/status')
  assert.equal(cached.json.envCheck.trigger, 'mount', '缓存命中不得改写来源')
  assert.equal(spawnLines().length, 1, '缓存命中不得起探针')

  // ⑤ ?refresh=1 ⇒ 真的重跑一次，来源与完成时间都换成新的
  const refreshed = await call(h16, 'GET', ROUTE_PATH + '/status?refresh=1')
  assert.equal(refreshed.json.envCheck.trigger, 'refresh', '带 refresh 的那次必须标成 refresh')
  assert.equal(spawnLines().length, 2, 'refresh 必须真起一次探针')
  assert.notEqual(refreshed.json.envCheck.finishedAt, first.json.envCheck.finishedAt, '重跑必须刷新完成时间')
  assert.ok(
    Date.parse(refreshed.json.envCheck.finishedAt) >= Date.parse(first.json.envCheck.finishedAt),
    '完成时间只能前进',
  )

  // ⑥ dryRun ⇒ 有意不起（挂载不得有副作用；测试整套挂载也靠这条保持安静）
  resetSpawnLog()
  const h16dry = mount({
    dryRun: true,
    scripts: { vdd: fixture('vdd-spawns.ps1'), hold: fixture('hold-stub.ps1'), topology: fixture('topology-stub.ps1') },
    stateFile: HOLD_STATE_DEFAULT,
    vddWatchdogMs: 0,
    probeKeepAwake: false,
  })
  await sleep(600)
  assert.equal(spawnLines().length, 0, 'dryRun 下挂载期不得起任何探针')
  const dry = await call(h16dry, 'GET', ROUTE_PATH + '/status', undefined, {})
  assert.equal(dry.json.envCheck.warmedAtMount, false, 'dryRun 下必须如实报 warmedAtMount=false')

  delete process.env.LIGHTOUT_TEST_SPAWN_SLEEP_MS
  resetSpawnLog()
  console.log(
    '  挂载预热  ok  起飞 1 次 → /status 复用（单飞）→ refresh 真重跑 → dryRun 不起（envCheck.trigger=mount 可判读）',
  )
}

// ── 17) 静态契约：预热体检的接线不许被改回"只在请求里跑" ─────────────────────
{
  const host = fs.readFileSync(pkgFile('lib/index.js'), 'utf8')
  assert.match(host, /startStatusProbe\('mount'\)/, 'apply 期必须有挂载预热这一次探测（trigger=mount）')
  assert.match(host, /'dsh-lightout: mount-warmup'/, '预热必须挂成 effect（卸载/热重载随插件一起作废）')
  assert.match(host, /envCheck: envCheckReport\(\)/, '/status 必须报出体检来源')
  const warm = sliceBetween(host, "ctx.effect(() => {\n    if (options.dryRun) return undefined", 'mount-warmup')
  assert.match(warm, /dryRun/, 'dryRun 必须短路掉挂载预热（否则"挂载无副作用"这条契约就破了）')
  // 客户端只翻译宿主的 trigger，不自己编时间
  const client = fs.readFileSync(pkgFile('lib/client.js'), 'utf8')
  assert.match(client, /function envCheckLabel\(/, '客户端必须把体检来源翻成人话（tooltip）')
  assert.match(client, /check\.trigger === 'mount'/, '挂载期那一档要有自己的文案')
  console.log('  静态契约  ok  挂载预热 + effect 生命周期 + dryRun 短路 + 客户端文案')
}

// ── 19) 行为：拿不到 webServer 必须出声，服务到位/dryRun 都不许出声 ──────────
{
  const warns = []
  const probeDisposers = []
  const probeCtx = (inject) => ({
    logger: { info() {}, warn(...a) { warns.push(a.map(String).join(' ')) } },
    effect(fn) { const off = fn(); if (typeof off === 'function') probeDisposers.push(off); return off },
    inject,
    get() { return undefined },
  })
  const hits = () => warns.filter((w) => w.includes('webServer')).length

  // A) 宿主始终不交 webServer（cordis 的等待型 inject 就是不回调）⇒ 到点必须 warn 一次
  warns.length = 0
  apply(probeCtx(() => {}), { routeProbeMs: 30, dryRun: false })
  await sleep(80)
  assert.equal(hits(), 1, '拿不到 webServer 必须 warn 一条（这就是这条诊断存在的理由），实际：' + JSON.stringify(warns))

  // B) 宿主交了 webServer（fakeContext 的 inject 立刻回调）⇒ 不许 warn（假警会让人不再信这条日志）
  warns.length = 0
  const goodCtx = fakeContext({ register() { return () => {} } })
  goodCtx.logger = { info() {}, warn(...a) { warns.push(a.map(String).join(' ')) } }
  apply(goodCtx, { routeProbeMs: 30, dryRun: false })
  await sleep(80)
  assert.equal(hits(), 0, '服务到位不得误报，实际：' + JSON.stringify(warns))

  // C) dryRun ⇒ 连这条诊断也不起（挂载无副作用是既有契约）
  warns.length = 0
  apply(probeCtx(() => {}), { routeProbeMs: 30, dryRun: true })
  await sleep(80)
  assert.equal(hits(), 0, 'dryRun 下不得起诊断，实际：' + JSON.stringify(warns))

  for (const off of probeDisposers) { try { off() } catch { /* 收尾失败不影响结论 */ } }
  console.log('  服务诊断行为  ok  缺服务出声 1 次 / 服务到位 0 次 / dryRun 0 次')
}

for (const dispose of disposers) dispose()
fs.rmSync(TMP, { recursive: true, force: true })

console.log('host.test.mjs 全部通过')
process.exit(0)
