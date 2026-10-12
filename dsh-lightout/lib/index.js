/**
 * dsh-lightout -- 宿主半。
 *
 * 职责：给浏览器半提供四条 **只服务本机** 的 HTTP 路由，把「熄屏但不打断 DSH」交给虚拟显示器
 * （Virtual-Display-Driver）+ 显示拓扑切换 + 电源请求：
 *   GET  /api/dsh-lightout/status   体检（VDD 设备状态 / 熄屏保持状态 / keep-awake / 电源键）
 *   POST /api/dsh-lightout/off      熄屏：把内置屏移出活动显示集（面板物理断电），会话**保持不锁**
 *   POST /api/dsh-lightout/on       逃生口：杀掉守卫并立刻还原拓扑，面板马上亮回来
 *   POST /api/dsh-lightout/vdd      按需启用/禁用虚拟显示器设备（提权；**必须先由界面点确认**）
 *
 * 为什么不是「关屏广播」（2026-09-26 实测定论）：
 *   本机只有 Modern Standby（无 S3）。`SC_MONITORPOWER` 关屏被记成 `Kernel-Power 566 原因
 *   SleepButton`，系统进 S0 待机会话、DAM 阶段挂起所有桌面应用 ⇒ DSH 连同进程树整体停摆
 *   （两次实测：缺口 94.5 s / 52 分钟）。所以熄屏改走「内置屏移出活动显示集」：面板物理断电、
 *   系统仍认为有屏、进程照跑。旧的「关屏广播」执行器已整条删除（原文备份在
 *   _research/legacy-backup-20260926/）；scripts/lightout.ps1 现在只剩**只读**的电源键策略报告，
 *   `/status` 的 machine 段用它（它必须便宜：每次未命中缓存都要跑一次）。
 *
 * 三层防线（缺一不可）：
 *   ① 预检 gate：熄屏前必须确认 VDD **设备已启用**。设备级状态才是权威——设备停用时拓扑枚举里
 *      仍残留一个 VDD 目标（2026-09-26 实测：availablePaths 6→5、totalModes 92→90），
 *      所以**不能**用「有没有 VDD 目标」判断可用性。
 *   ② 守卫进程：真正的动作在 scripts/lightout-hold.ps1（持 PowerRequestDisplayRequired +
 *      PowerRequestSystemRequired → 切拓扑 → 监听输入 → **先还原拓扑再 LockWorkStation**）。
 *      会话在暗窗期间保持未锁定：SetDisplayConfig 在锁屏状态下返回 5（拒绝访问），
 *      先锁就等于永远还原不回来（2026-09-26 11:11 踩过，面板黑了 52 分钟）。
 *   ③ 看门狗：宿主每 vddWatchdogMs 查一次「状态文件说还黑着、但守卫进程没了」，命中就还原拓扑。
 *      守卫是**隐藏窗口**进程（用户 2026-09-26 逐次同意；窗口可被任务管理器杀掉，看门狗是兜底）。
 *
 * 接线纪律（本项目实测教训）：
 *   - 取服务只用 `ctx.inject([...], cb)`，**禁止**在 apply 期一次性 `ctx.get`：loader 并发启动，
 *     一次性读取会把尚未 ACTIVE 的服务（webserver 要 await listen() 才 ACTIVE）静默跳过。
 *   - `apply` 必须显式 `return undefined`：返回值会被当成 effect 解释，返回普通对象会让 dsh web 起不来。
 *
 * 安全面（已注册路由**绕过**页面静态服务那道 token 门，所以本文件自己设门）：
 *   - 两条守卫照抄同机已成活的 `dsh-keep-awake`：① 只接受回环连接；② 改变状态的请求必须同源。
 *   - 本插件**不提供**任何改动系统电源策略的接口，也**不会**静默提权：`/vdd` 只是发起一次带 UAC
 *     的提权请求，用户在对话框上点是才会生效，界面在此之前会把 `[enable]` 段的中文说明原文摆出来。
 *   - 提权动作只有一件事：`pnputil /enable-device ROOT\DISPLAY\0000`（撤销＝`/vdd {action:disable}`，
 *     或 DSH 退出时由常驻守卫自动禁用）。
 *
 * 名字的三层区分（别混）：
 *   - 行 id      `lightout`      —— cordis.patch.yml 里的 `- id: lightout`
 *   - 行 name    `dsh-lightout`  —— 也是浏览器半 `__ModuleLoader__.load({ id })` 用的那个 id
 *   - 本文件     `export const name = 'lightout'` —— cordis 运行时名，与上面两者无关
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'lightout'
export const VERSION = '1.1.0'
export const ROUTE_PATH = '/api/dsh-lightout'

/** keep-awake 插件的状态路由（只在 loopback 上探；端口取自 webServer，见 keepAwakeBase）。 */
export const KEEP_AWAKE_STATE_PATH = '/dsh-keep-awake/state'

const DEFAULTS = {
  /** 暗窗的绝对上限（秒）。守卫到点或键鼠一动就还原；缺省 8 小时。 */
  maxDarkSeconds: 28800,
  /** 守卫检测键鼠输入的轮询间隔（毫秒）。 */
  darkPollMs: 200,
  /** 熄屏守卫的状态文件；空串＝用 %TEMP%\lightout-hold.json（与脚本缺省一致）。 */
  stateFile: '',
  /**
   * 提权结果文件：`-Elevate` 把 UAC 的结果（接受/取消）写在这里，宿主读它。
   * 用户点「否」时能**立刻**报"授权已取消、熄屏不可用"，而不是让界面白等 90 秒。
   * 空串＝%TEMP%\lightout-vdd-elevate.json。
   */
  elevateLog: '',
  /**
   * 版本检查基线：启用设备成功时记下当时的显卡/VDD 驱动版本，之后 verify 拿它比对，
   * 于是"GPU 驱动更新过"这件事在熄屏之前就能看到。空串＝%TEMP%\lightout-vdd-baseline.json。
   */
  vddBaseline: '',
  /**
   * 关机拓展的「禁用请求」文件：DSH 关闭时宿主写一下，**提权常驻守护**（scripts/lightout-vdd-guard.ps1，
   * 由 tools/install-vdd-guard.ps1 注册的计划任务在登录时以最高权限启动）看到就立刻禁用 VDD。
   * 为什么要绕这一道：关机拓展以宿主权限（普通用户）跑，而禁用设备要管理员，写文件是它唯一能做的事。
   * 空串＝%TEMP%\lightout-vdd-disable.request（与守护脚本的缺省一致）。
   */
  disableRequest: '',
  /**
   * 提权守护的状态文件（只读）：/status 把它原样报给界面与排障者，不必翻日志。
   * 空串＝%TEMP%\lightout-vdd-guard.json。守护缺席时读不到，按 null 报（不是错误）。
   */
  guardState: '',
  /**
   * 事件日志（JSONL，落盘）。`record()` 每次动作追加一行，只保留最近若干条。
   * 空串＝%TEMP%\lightout-events.jsonl。**为什么要落盘**：15:06 事故复盘时宿主内存里的
   * history 随重启清零、`~/.dsh/logs` 里也没有主日志 ⇒ 事故无法回放。
   */
  eventLog: '',
  /** 看门狗间隔（毫秒）；0＝关闭。 */
  vddWatchdogMs: 5000,
  /** 等守卫落下状态文件的上限（毫秒）——决定 /off 多久返回回执。 */
  darkReceiptMs: 8000,
  /** 熄屏前是否强制要求 VDD 设备已启用（关掉＝允许在设备停用时硬闯，不建议）。 */
  vddGate: true,
  /**
   * 看门狗还原失败后的退避（毫秒）：前 RESTORE_RETRY_FAST_TRIES 次用这个间隔。
   * 太密＝每次都要起 PowerShell（2026-09-26 事故的形态之一），太疏＝面板久不回来。
   */
  restoreRetryMs: 20000,
  /**
   * 连续失败超过 RESTORE_RETRY_FAST_TRIES 次之后的退避（毫秒）。30 s 是有意的折中：
   * 这一档生效时面板很可能还黑着，用户解锁回来要是还得等两分钟才等到下一次重试，
   * 体验上就等于"没在重试"（t8 判定 120 s 太久；客户端 focus/visibility 的 kick 是另一条更快的路）。
   */
  restoreRetrySlowMs: 30000,
  // ── 通用 ──────────────────────────────────────────────────────────────────────────
  /** 体检结果缓存时长（毫秒），避免浏览器每次轮询都起 PowerShell。 */
  statusCacheMs: 15000,
  /**
   * 挂载后等多久检查"宿主是否交了 webServer 服务"（毫秒）。拿不到就 warn 一条，`0` ＝ 不检查。
   *
   * 为什么需要：`ctx.inject` 在服务缺席时只是让子 fiber 悬置 —— 插件照常挂载、不抛、不报错，
   * 而四条路由一条也没注册。外部最典型的成因是**宿主版本与插件不匹配**（旧版没有这个服务名），
   * 表现是"装上了、dump-config 里也有，但所有请求 404、界面点了没反应"。诊断只报告事实，
   * 不改行为：拿不到服务时插件本来就什么都不做，这里只是让它出声。
   */
  routeProbeMs: 10000,
  /** 单次 PowerShell 调用的超时（毫秒）。 */
  helperTimeoutMs: 20000,
  /** 是否探测 keep-awake 插件状态。 */
  probeKeepAwake: true,
  /**
   * 请求体上限（字节）。`/off` 的 busy 位覆盖 body 读取（否则并发 /off 全通过检查），
   * 所以读取必须有上限，不能让一个不结束的请求把 busy 顶住。
   */
  bodyMaxBytes: 8192,
  /** 同一个 /vdd 动作的去重窗口（毫秒）：窗口内重复请求不再另起一个提权进程。 */
  vddDedupMs: 60000,
  /**
   * 只演练不执行（给自检/验收用）：仍返回完整 JSON，但不切拓扑、不起守卫、不提权。
   * **只在 profile 行的 config 里生效**——请求体/查询串里传 dryRun 不会改变行为（见 README）。
   */
  dryRun: false,
  /** 脚本路径覆盖（测试用桩；空串＝用包内 scripts/ 下的默认脚本）。 */
  scripts: { machine: '', topology: '', hold: '', vdd: '' },
  /** PowerShell 可执行文件覆盖（测试用桩：用它演练「spawn 失败」这条错误路径）。 */
  psExe: '',
  /**
   * 守卫/提权进程的 stdout+stderr 落盘（滚动）。空串＝%TEMP%\lightout-guard.log。
   * 为什么必须落盘：`stdio:'ignore'` 会把"为什么没起来"一起丢掉（t8 指出界面分不清
   * guard-already-running / guard-lock-unavailable / guard-exited 三种原因）。
   */
  guardLog: '',
  /**
   * 期望的 VDD managed 设备实例路径。`/status` 会拿它跟 verify 报回来的实例比对，
   * 不一致/多实例/选不出 managed 都会写进 warnings（空串＝不检查一致性）。
   * 注：脚本侧目前把 `ROOT\DISPLAY\0000` 写死为默认 managed 实例；这里只是**显式化期望值**，
   * 不改变脚本行为。
   */
  vddInstance: 'ROOT\\DISPLAY\\0000',
}

/** 包内脚本的默认相对路径。 */
const SCRIPT_FILES = {
  machine: 'scripts/lightout.ps1',
  topology: 'scripts/lightout-topology.ps1',
  hold: 'scripts/lightout-hold.ps1',
  vdd: 'scripts/vdd-device.ps1',
}

/** 数值键归一化表：[键, 最小值, 最大值, 是否取整]（缺省值一律取 DEFAULTS[key]）。 */
const NUM_KEYS = [
  ['maxDarkSeconds', 5, 86400, true],
  ['darkPollMs', 50, 5000, true],
  ['darkReceiptMs', 500, 60000, true],
  ['restoreRetryMs', 200, 600000, true],
  ['restoreRetrySlowMs', 200, 3600000, true],
  ['statusCacheMs', 0, Number.MAX_SAFE_INTEGER, false],
  ['helperTimeoutMs', 1000, Number.MAX_SAFE_INTEGER, false],
  ['bodyMaxBytes', 0, 1024 * 1024, true],
  ['vddDedupMs', 0, 3600000, true],
]

const PS_EXE = 'powershell.exe'
const MAX_BUFFER = 4 * 1024 * 1024
const PROBE_TIMEOUT_MS = 2000
/** 看门狗还原失败：前 RESTORE_RETRY_FAST_TRIES 次用 restoreRetryMs，之后降级到 restoreRetrySlowMs。 */
const RESTORE_RETRY_FAST_TRIES = 5
/** 事件日志的上限：超过 EVENTS_MAX 条就截断成最近 EVENTS_KEEP 条。 */
const EVENTS_MAX = 40
const EVENTS_KEEP = 20
/** 守卫日志滚动：超过 GUARD_LOG_MAX_LINES 行就只留最后 GUARD_LOG_KEEP_LINES 行。 */
const GUARD_LOG_MAX_LINES = 400
const GUARD_LOG_KEEP_LINES = 200
/**
 * 回执过期宽限（毫秒）：守卫到点会自己退出，所以「已过 deadline + 宽限」的回执不再算「还黑着」。
 * 没有这一条，一个 pid 恰好被系统复用给别的进程的陈旧回执会让面板永远不还原、/off 永远 409。
 */
const RECEIPT_EXPIRY_SLACK_MS = 120000
/** 提权结果文件只认最近 10 分钟的记录，更早的是上一次请求留下的。 */
const ELEVATE_LOG_TTL_MS = 10 * 60 * 1000
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

function pkgFile(relative) {
  return fileURLToPath(new URL('../' + relative, import.meta.url))
}

function scriptPath(options, which) {
  const override = options.scripts[which]
  return typeof override === 'string' && override.length > 0 ? override : pkgFile(SCRIPT_FILES[which])
}

/** 覆盖值优先、否则落到 %TEMP%\<name>：四个状态文件同一套规则。 */
function tmpFile(options, key, name) {
  const override = options[key]
  return typeof override === 'string' && override.length > 0 ? override : path.join(os.tmpdir(), name)
}

function holdStateFile(options) {
  return tmpFile(options, 'stateFile', 'lightout-hold.json')
}

function elevateLogFile(options) {
  return tmpFile(options, 'elevateLog', 'lightout-vdd-elevate.json')
}

function baselineFile(options) {
  return tmpFile(options, 'vddBaseline', 'lightout-vdd-baseline.json')
}

function eventFile(options) {
  return tmpFile(options, 'eventLog', 'lightout-events.jsonl')
}

function guardLogFile(options) {
  return tmpFile(options, 'guardLog', 'lightout-guard.log')
}

/** 关机拓展写给提权守护的禁用请求（守护脚本按同一路径轮询）。 */
function requestFile(options) {
  return tmpFile(options, 'disableRequest', 'lightout-vdd-disable.request')
}

/** 提权守护自己写的状态文件（只读；守护缺席时读不到，按 null 报）。 */
function guardStateFile(options) {
  return tmpFile(options, 'guardState', 'lightout-vdd-guard.json')
}

function clampNum(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

function normalizeOptions(config) {
  const input = config !== null && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (key === 'scripts' || key === 'psExe') continue
    if (input[key] !== undefined) merged[key] = input[key]
  }
  const rawScripts = input.scripts !== null && typeof input.scripts === 'object' ? input.scripts : {}
  merged.scripts = { ...DEFAULTS.scripts }
  for (const key of Object.keys(DEFAULTS.scripts)) {
    if (typeof rawScripts[key] === 'string' && rawScripts[key].length > 0) merged.scripts[key] = rawScripts[key]
  }
  merged.psExe = typeof input.psExe === 'string' && input.psExe.length > 0 ? input.psExe : ''
  merged.vddInstance = typeof input.vddInstance === 'string' ? input.vddInstance : DEFAULTS.vddInstance

  for (const [key, min, max, round] of NUM_KEYS) {
    const value = clampNum(merged[key], min, max, DEFAULTS[key])
    merged[key] = round ? Math.round(value) : value
  }
  merged.vddWatchdogMs =
    merged.vddWatchdogMs === 0 ? 0 : Math.round(clampNum(merged.vddWatchdogMs, 500, 300000, DEFAULTS.vddWatchdogMs))

  merged.vddGate = merged.vddGate !== false
  merged.probeKeepAwake = merged.probeKeepAwake !== false
  merged.dryRun = merged.dryRun === true
  for (const key of ['stateFile', 'elevateLog', 'vddBaseline', 'eventLog', 'guardLog', 'disableRequest', 'guardState']) {
    merged[key] = typeof merged[key] === 'string' ? merged[key] : ''
  }
  return merged
}

// ── 守卫（逐字照抄 dsh-keep-awake：同机同契约，行为已在 GUI 里验证过）────────────

/** 只把真正的回环地址当自己人；取不到地址（不是真实请求上下文）一律拒绝。 */
function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * 改变状态的请求必须是同源浏览器请求：要么 `origin` 与 `host` 同源且 host 是回环，
 * 要么没有 `origin` 但 `sec-fetch-site: same-origin`（浏览器对同源 POST 会带其中一个）。
 * 跨站表单、跨站 fetch 与命令行裸 POST 都拿不到这两样，因此被挡在门外。
 * 副作用：curl 自检必须显式带 `origin` 头（README 里给了完整命令）。
 */
function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host && loopbackHost
    } catch {
      return false
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin'
}

// ── 小工具 ────────────────────────────────────────────────────────────────────

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 非空行（已 trim）：三个脚本输出解析点共用同一套切行规则。 */
function textLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 首选最后一条 `RESULT:` 行，没有就退回最后一行（vdd / topology 的契约）。 */
function pickResultLine(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('RESULT:')) return lines[i]
  }
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

/** 读一个 JSON 文件：读不到 / 解析失败都给出明确标记，永不抛。 */
function readJsonFile(file) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return { read: false, value: null }
  }
  try {
    return { read: true, value: JSON.parse(stripBom(raw)) }
  } catch {
    return { read: true, value: null }
  }
}

/** 删文件；删不掉不算错（守卫/脚本自己收尾时也会删）。 */
function rmQuiet(file) {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* ignore */
  }
}

/** 日志滚动：超过 maxLines 行就只留最后 keepLines 行（没有文件/读不动都静默）。 */
function rotateLog(file, maxLines, keepLines) {
  try {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
    if (lines.length > maxLines) fs.writeFileSync(file, lines.slice(-keepLines).join('\n') + '\n', 'utf8')
  } catch {
    /* 没有日志文件就不用管 */
  }
}

/** 守卫写的本地时间串（`(Get-Date).ToString('s')`）→ 毫秒；解析不了返回 null。 */
function parseLocalSeconds(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 解析脚本写的 `key=value ...` 行（`RESULT: ` 前缀可省）。值是嵌套的 `a=1 b=2` 时，
 * 内层键也会被解析出来——脚本故意把嵌套项放最后，见 vdd-device.ps1 的 RESULT 行。
 */
function parseKeyValues(line) {
  const out = {}
  if (typeof line !== 'string' || line.length === 0) return out
  const text = line.replace(/^\s*RESULT:\s*/, '').trim()
  const marks = []
  const re = /([A-Za-z_][A-Za-z0-9_]*)=/g
  let match = re.exec(text)
  while (match !== null) {
    marks.push({ key: match[1], start: match.index, valueStart: re.lastIndex })
    match = re.exec(text)
  }
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length
    out[marks[i].key] = text.slice(marks[i].valueStart, end).trim()
  }
  return out
}

/** 进程是否还活着。EPERM ＝ 存在但不属于我们，同样算活着。 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 等待若干毫秒。**不要 unref**：这是被 await 的定时器，unref 掉会让事件循环在没有其它
 * 句柄时直接退出、await 永远不 settle（2026-09-26 离线用例就是这么卡住的）。
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

// ── 脚本调用 ──────────────────────────────────────────────────────────────────

/** 跑一次脚本，拿原始输出（超时/失败都变成 reject，调用方决定怎么记）。 */
function execScript(file, args, timeoutMs, exe = PS_EXE) {
  return new Promise((resolve, reject) => {
    execFile(exe, [...PS_ARGS, file, ...args], { maxBuffer: MAX_BUFFER, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      const out = stripBom(String(stdout ?? '')).trim()
      const err = stripBom(String(stderr ?? '')).trim()
      const code = typeof error?.code === 'number' ? error.code : 0
      if (out.length === 0) {
        const detail = err.length > 0 ? err.slice(0, 400) : String(error?.message ?? 'no output')
        reject(new Error('脚本未返回内容（' + path.basename(file) + '）：' + detail))
        return
      }
      resolve({ text: out, stderr: err, code })
    })
  })
}

/** 跑一次脚本，把最后一行当 JSON 解析（machine status / lightout-hold.ps1 的契约）。 */
async function runScriptJson(file, args, timeoutMs, exe = PS_EXE) {
  const { text, code } = await execScript(file, args, timeoutMs, exe)
  const lines = textLines(text)
  const last = lines.length > 0 ? lines[lines.length - 1] : ''
  try {
    return JSON.parse(last)
  } catch (cause) {
    throw new Error('脚本输出不是合法 JSON（' + path.basename(file) + '，exit=' + String(code) + '）：' + String(cause?.message ?? cause) + '；原文：' + last.slice(0, 200))
  }
}

/**
 * 跑一次脚本，返回原文 + 解析出的 key=value（vdd-device.ps1 / lightout-topology.ps1 的契约）。
 *
 * 必须解析出至少一个键，否则算失败：`powershell -File <不存在的文件>` 会把
 * "Windows PowerShell / Copyright ..." 横幅打到 **stdout** 并退出非零——只看"有没有输出"
 * 会把它当成一次成功的探测（2026-09-26 用例就是这么被骗的）。
 */
async function runScriptText(file, args, timeoutMs, exe = PS_EXE) {
  const { text, code } = await execScript(file, args, timeoutMs, exe)
  const lines = textLines(text)
  const values = parseKeyValues(pickResultLine(lines))
  if (Object.keys(values).length === 0) {
    throw new Error('脚本没有输出可解析的 key=value（' + path.basename(file) + '，exit=' + String(code) + '）：' + text.slice(0, 200))
  }
  return { text, values, code }
}

/**
 * 起一个**隐藏窗口**的脚本进程（守卫/提权请求都走这条路），父进程不等待它。
 *
 * 为什么不能用 `detached: true`：本机实测（2026-09-26）——`detached` 配上 PowerShell 时子进程
 * 根本不执行（`stdio:'ignore'` + detached：进程 4 秒后 ESRCH，脚本一行都没跑；不 detached 的同一条
 * 命令一次成功）。所以这里只隐藏窗口、不脱离控制台；`unref()` 让 node 不因它而拖住退出。
 *
 * 生命周期：guard 不随宿主请求结束而结束；宿主若正常退出/被杀，guard 靠自己的 `-ParentPid`
 * 发现并还原（见 scripts/lightout-hold.ps1），`-MaxSeconds` 是最后的兜底。
 * 隐藏窗口是机制的一部分，用户 2026-09-26 明确同意（规则：起隐藏窗口后台进程需逐次同意）。
 *
 * **必须挂 `'error'` 监听**：spawn 失败（PATH 里没有 powershell、句柄耗尽、被安全软件拦）
 * 时 ChildProcess 会抛出一个**未捕获的 'error' 事件**——不挂监听等于把宿主进程打死；
 * 只挂监听还不够，调用方必须把 `failure()` 当成真失败（否则就成了"200 ok:true pending"的假成功）。
 *
 * @returns {{ pid: number|null, failure: () => unknown, exitCode: () => number|null }} pid 为 null 或 failure() 非 null 都算没起来。
 */
function spawnHidden(file, args, exe = PS_EXE, logFile = '') {
  let failure = null
  let exitCode = null
  // stdout/stderr 重定向到滚动日志：`stdio:'ignore'` 会把"为什么没起来"（已锁/已有守卫/崩溃）
  // 一起丢掉（t8 的覆盖缺口）。没有 logFile 时保持原来的 ignore。
  const stdio = ['ignore', 'ignore', 'ignore']
  let logFd = null
  if (typeof logFile === 'string' && logFile.length > 0) {
    try {
      logFd = fs.openSync(logFile, 'a')
      stdio[1] = logFd
      stdio[2] = logFd
    } catch {
      logFd = null
    }
  }
  let child
  try {
    child = spawn(exe, [...PS_ARGS, file, ...args], { stdio, windowsHide: true })
  } catch (error) {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch {
        /* ignore */
      }
    }
    failure = error
    return { pid: null, failure: () => failure, exitCode: () => exitCode }
  }
  // 父进程这一份句柄用完就关（子进程持有自己的副本）。
  if (logFd !== null) {
    try {
      fs.closeSync(logFd)
    } catch {
      /* ignore */
    }
  }
  child.on('error', (error) => {
    failure = error
  })
  child.on('exit', (code) => {
    exitCode = typeof code === 'number' ? code : null
  })
  child.unref()
  return { pid: child.pid ?? null, failure: () => failure, exitCode: () => exitCode }
}

/** 这次 /off 或 /vdd 实际要用的 PowerShell（测试用桩可覆盖）。 */
function psExeOf(options) {
  return options.psExe.length > 0 ? options.psExe : PS_EXE
}

// ── 熄屏守卫的状态文件 ────────────────────────────────────────────────────────

function clearHoldState(options) {
  rmQuiet(holdStateFile(options))
}

/** 读守卫落的状态文件；不存在的分支都变成 present:false，绝不抛。 */
function readHoldState(options) {
  const file = holdStateFile(options)
  const { read, value: parsed } = readJsonFile(file)
  if (!read) return { file, present: false, active: false, pid: null, pidAlive: false, ok: null, corrupt: false }
  if (parsed === null || typeof parsed !== 'object') {
    return { file, present: true, active: false, pid: null, pidAlive: false, ok: null, corrupt: true }
  }
  const pid = typeof parsed.pid === 'number' ? parsed.pid : null
  const pidAlive = pid !== null ? isPidAlive(pid) : false
  const ok = parsed.ok === false ? false : true
  const startedAt = typeof parsed.startedAt === 'string' ? parsed.startedAt : null
  const deadline = typeof parsed.deadline === 'string' ? parsed.deadline : null
  const maxSeconds = typeof parsed.maxSeconds === 'number' ? parsed.maxSeconds : null
  // 回执自带的到期时刻：守卫到点会自己退出，所以过了期的回执不再能代表"还黑着"。
  // 没有这一条，一个 pid 恰好被复用给别的进程的陈旧回执会让面板永远不还原、/off 永远 409，
  // 而且 /on 会去杀那个无关进程（2026-09-26 审计 F8）。
  const startedMs = parseLocalSeconds(startedAt)
  const deadlineMs = parseLocalSeconds(deadline)
  const expiresAt =
    deadlineMs !== null ? deadlineMs : startedMs !== null && maxSeconds !== null ? startedMs + maxSeconds * 1000 : null
  return {
    file,
    present: true,
    ok,
    corrupt: false,
    // active ＝「还黑着且守卫在跑」。失败回执（ok:false）、守卫已死、回执过期都不算 active。
    active: parsed.action === 'dark' && ok && pidAlive && !(expiresAt !== null && Date.now() > expiresAt + RECEIPT_EXPIRY_SLACK_MS),
    pid,
    pidAlive,
    expiresAt,
    startedAt,
    deadline,
    maxSeconds,
    exitReason: typeof parsed.exitReason === 'string' ? parsed.exitReason : null,
    restored: typeof parsed.restored === 'boolean' ? parsed.restored : null,
    locked: typeof parsed.locked === 'boolean' ? parsed.locked : null,
    // 守卫**放弃**了还原（面板可能还黑着）：这不是"脚本自己已经收拾过"的失败回执，
    // 看门狗必须接手，见 watchdogTick。
    restoreFailed: parsed.restoreFailed === true,
    restoreAttempts: typeof parsed.restoreAttempts === 'number' ? parsed.restoreAttempts : null,
    restoreBlockedByLock: parsed.restoreBlockedByLock === true,
    checkAfterSwitch: typeof parsed.checkAfterSwitch === 'string' ? parsed.checkAfterSwitch : null,
    reason: typeof parsed.reason === 'string' ? parsed.reason : null,
    raw: parsed,
  }
}

/**
 * 等守卫把状态文件落下来：落了就返回它。守卫没能起来（spawn 失败 / 先死 / 超时）时返回带标记的空壳。
 * `failureRef` 是 spawnHidden 的 failure()——spawn 失败必须与 guardGone 分开报：前者是"没起来"，
 * 后者是"起来了又立刻退出"。
 */
async function waitForHoldState(options, guardPid, timeoutMs, failureRef) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hold = readHoldState(options)
    if (hold.present) return hold
    const spawnError = typeof failureRef === 'function' ? failureRef() : null
    if (spawnError !== null && spawnError !== undefined) {
      return { ...hold, spawnError: String(spawnError?.message ?? spawnError) }
    }
    if (guardPid !== null && !isPidAlive(guardPid)) return { ...hold, guardGone: true }
    await sleep(200)
  }
  return { ...readHoldState(options), timeout: true }
}

// ── VDD 设备状态与提权文案 ────────────────────────────────────────────────────

/** 读提权结果文件：只认最近 10 分钟的记录，更早的是上一次请求留下的。 */
function readElevateLog(options) {
  const { value: parsed } = readJsonFile(elevateLogFile(options))
  if (parsed === null || typeof parsed !== 'object') return null
  const at = typeof parsed.at === 'string' ? parsed.at : null
  if (at !== null) {
    const when = Date.parse(at)
    if (Number.isFinite(when) && Date.now() - when > ELEVATE_LOG_TTL_MS) return null
  }
  const error = typeof parsed.error === 'string' && parsed.error.length > 0 ? parsed.error : null
  return {
    requested: parsed.action === 'disable' ? 'disable' : 'enable',
    launched: parsed.launched === true,
    // 用户点了 UAC 上的「否」：Start-Process 会抛"操作已被用户取消"，脚本据此写下 declined。
    declined: parsed.declined === true,
    at,
    error,
  }
}

function clearElevateLog(options) {
  rmQuiet(elevateLogFile(options))
}

/** 只读：VDD 设备是否在、是否被禁用 + 版本检查（设备级状态才是权威，见文件头 ①）。 */
async function probeVdd(options) {
  try {
    const { values } = await runScriptText(scriptPath(options, 'vdd'), ['-Action', 'verify', '-Baseline', baselineFile(options)], options.helperTimeoutMs, psExeOf(options))
    const device = values.device ?? ''
    const check = {
      verdict: typeof values.verdict === 'string' ? values.verdict : null,
      driverVersion: typeof values.driverVersion === 'string' ? values.driverVersion : '',
      infName: typeof values.infName === 'string' ? values.infName : '',
      driverStore: values.driverStore === 'True',
      monitors: Number.isFinite(Number(values.monitor)) ? Number(values.monitor) : 0,
      gpuCount: Number.isFinite(Number(values.gpuCount)) ? Number(values.gpuCount) : 0,
      gpuChanged: values.gpuChanged === 'True',
      vddChanged: values.vddChanged === 'True',
      // managed 实例的选择结果（vdd-device.ps1 的 RESULT 里一直有，t8 指出宿主没往上报）：
      // choice=managed 正常；ambiguous ＝ 多张候选选不出；missing/none ＝ 找不到设备。
      deviceChoice: typeof values.deviceChoice === 'string' ? values.deviceChoice : null,
      deviceCount: Number.isFinite(Number(values.deviceCount)) ? Number(values.deviceCount) : null,
      siblings: typeof values.siblings === 'string' && values.siblings.length > 0 ? values.siblings : null,
    }
    return {
      available: true,
      error: null,
      present: device.length > 0 && device !== 'none',
      device: device === 'none' ? null : device,
      disabled: values.disabled === 'True' ? true : values.disabled === 'False' ? false : null,
      // 设备停用时拓扑枚举里仍残留一个 VDD 目标，所以 monitor 只作参考，判定一律用 disabled。
      monitor: check.monitors > 0,
      check,
    }
  } catch (error) {
    return { available: false, error: String(error?.message ?? error), present: null, device: null, disabled: null, monitor: null, check: null }
  }
}

/** VDD 是否已经就绪（可用作熄屏目标）。 */
function vddReady(vdd) {
  return vdd.available === true && vdd.present === true && vdd.disabled === false
}

function messagesPath(options) {
  return path.join(path.dirname(scriptPath(options, 'vdd')), 'vdd-device.messages.zh.txt')
}

/**
 * 提权前给用户看的中文说明：**直接取 vdd-device.messages.zh.txt 的 `[enable]` 段**，
 * 保证界面上读到的与脚本提权时打印的是同一份原文（单一真源）。
 *
 * 读不到就返回**空串**：客户端会用 `prompt.error` 兜底。**不再内置第二份文案**——
 * 2026-09-26 审计发现内置那份与 messages 文件已经漂移，而 README 却宣称单一真源。
 */
function readWording(options) {
  try {
    const text = stripBom(fs.readFileSync(messagesPath(options), 'utf8'))
    const body = []
    let on = false
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[(.+?)\]\s*$/.exec(line)
      if (section !== null) {
        on = section[1] === 'enable'
        continue
      }
      if (on) body.push(line)
    }
    return body.join('\n').trim()
  } catch {
    return ''
  }
}

// ── keep-awake 探测（依赖探测；探不到一律按「未知」处理，绝不阻塞熄屏）──────────

/**
 * 取 keep-awake 的基地址。端口来自 `webServer.port` 这个官方 getter（`dsh web` 的端口是配置项，
 * 不一定是 3080），**绝不硬编码**。取不到就返回 null，调用方按「未知」处理。
 */
function keepAwakeBase(webServer) {
  try {
    const port = webServer?.port
    if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) return null
    return 'http://127.0.0.1:' + port
  } catch {
    return null
  }
}

/** 探一次 keep-awake 插件状态：暗窗期间「DSH 还在工作」靠的就是它持有的系统唤醒锁。 */
async function probeKeepAwake(base) {
  if (base === null) return { available: false, reason: 'unknown-port（读不到 webServer.port，按未知处理）' }
  const probeUrl = base + KEEP_AWAKE_STATE_PATH
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(probeUrl, { signal: controller.signal })
    if (!response.ok) return { available: false, reason: 'HTTP ' + String(response.status), probeUrl }
    const body = await response.json()
    return {
      available: true,
      probeUrl,
      enabled: body?.enabled === true,
      holdingWakeLock: body?.holdingWakeLock === true,
      preventDisplaySleep: body?.preventDisplaySleep === true,
      helperPid: typeof body?.helperPid === 'number' ? body.helperPid : null,
      runningAgents: typeof body?.runningAgents === 'number' ? body.runningAgents : null,
    }
  } catch (cause) {
    return { available: false, reason: String(cause?.message ?? cause), probeUrl }
  } finally {
    clearTimeout(timer)
  }
}

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 读请求体（JSON）。**必须有上限**：`/off` 的 busy 位覆盖读取过程，一个不结束的请求会把
 * busy 顶住、让后面所有 /off 都拿 409。超限直接 413。
 */
async function readJsonBody(req, maxBytes) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      const error = new Error('请求体过大（上限 ' + String(maxBytes) + ' 字节）')
      error.statusCode = 413
      throw error
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 挂载点。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 行配置（见 cordis.patch.yml 的注释）。
 */
export function apply(ctx, config = {}) {
  const options = normalizeOptions(config)
  const psExe = psExeOf(options)
  const state = {
    /**
     * 体检结果的缓存**连来源一起存**：`trigger`/`startedAt`/`finishedAt` 记的是"这份数据是
     * 哪一次探测产出的"。挂载期预热（见下面的 mount 预热）与请求期探测共用这一个槽位，
     * 所以界面能如实说出"这份环境与版本检查是插件启动时跑的、还是刚为你重跑的"。
     */
    statusCache: { at: 0, value: null, trigger: null, startedAt: 0, finishedAt: 0 },
    /** 正在飞的那次体检（单飞：并发 /status 共享同一次探测，别把 PowerShell 堆起来）。 */
    statusProbe: null,
    /** 在飞那一轮的来源与起点（结果落地时冻进 statusCache，见 envCheckReport）。 */
    statusProbeTrigger: null,
    statusProbeStartedAt: 0,
    /** 挂载期预热体检起过没有（dryRun 下不起，/status.envCheck.warmedAtMount 如实报它）。 */
    mountWarmup: { started: false },
    /**
     * 宿主服务到没到（只用于诊断，不参与行为）。`ctx.inject` 服务缺席时静默，这正是
     * "装上却什么都不发生"最难查的地方，所以挂载后按 `routeProbeMs` 检查一次并出声。
     */
    platformProbe: { webServer: false, warned: false },
    busy: false,
    guard: null,
    /** 熄屏/还原的意图序号：/on 会作废在飞的 /off（见 /off 的意图复核）。 */
    intent: { seq: 0, kind: null },
    /** 看门狗重入闸：tick 不重叠（慢还原时 5 秒一次的定时器会叠出十几路并发）。 */
    ticking: false,
    /** 重入期间到达的 kick（用户点了逃生口或界面回到前台）：出闸后补跑一次，别把一次性事件丢掉。 */
    kickPending: false,
    watchdog: { at: 0, action: null },
    /** restoreFailed 期间的重试退避（见 watchdogTick）。 */
    restoreRetry: { nextAt: 0, attempts: 0 },
    /** 最近一次 /vdd 请求（同动作去重用）。 */
    lastVdd: null,
  }

  /** 记一条事件：**落盘**（修 2026-09-26 的「事故无法回放」）+ 控制台。 */
  function record(entry) {
    const line = JSON.stringify(entry)
    try {
      const file = eventFile(options)
      fs.appendFileSync(file, line + '\n', 'utf8')
      const lines = textLines(fs.readFileSync(file, 'utf8'))
      if (lines.length > EVENTS_MAX) fs.writeFileSync(file, lines.slice(-EVENTS_KEEP).join('\n') + '\n', 'utf8')
    } catch {
      /* 日志写不进去绝不能影响动作本身 */
    }
    if (ctx.logger) ctx.logger.info('lightout: %s %s', entry.action, entry.ok ? 'ok' : 'failed')
  }

  /** /status 用：读回最近的事件（**跨宿主重启仍然在盘上**）。 */
  function recentEvents() {
    try {
      return textLines(fs.readFileSync(eventFile(options), 'utf8'))
        .slice(-EVENTS_KEEP)
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter((entry) => entry !== null)
    } catch {
      return []
    }
  }

  /** 本进程记下的那个守卫是否还活着。 */
  function isLiveGuard(guard) {
    return guard !== null && Number.isInteger(guard.pid) && isPidAlive(guard.pid)
  }

  /**
   * 关机拓展的「发令」：写一个请求文件就完事，**不等回执**。
   *
   * 为什么只能发令：关机拓展以宿主权限（普通用户）跑，而禁用设备要管理员；真正执行的是提权常驻守护
   * （scripts/lightout-vdd-guard.ps1，计划任务在登录时以最高权限启动）。被动关闭那一趟只有 2.5 秒预算，
   * 所以这里必须是一次同步小文件写，绝不能去等守护跑完 pnputil。
   * @returns {boolean} 请求是否真的落盘（失败只记录，绝不抛——关机流程不能被它打断）。
   */
  function writeDisableRequest(reason) {
    const file = requestFile(options)
    try {
      fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, reason }) + '\n', 'utf8')
      return true
    } catch (error) {
      if (ctx.logger) ctx.logger.info('lightout: could not write the disable request (%s): %s', file, String(error?.message ?? error))
      return false
    }
  }

  /**
   * 读提权守护的状态文件（只读）：/status 把它原样报出去。守护没跑过/没装 ⇒ null。
   * 不在这里判断"守护该不该在跑"——那是安装脚本与文档的事，宿主只做诚实转述。
   */
  function readGuardState() {
    const { value } = readJsonFile(guardStateFile(options))
    if (value === null || typeof value !== 'object') return null
    return { ...value, file: guardStateFile(options), requestFile: requestFile(options) }
  }

  /**
   * /on 允许删掉哪些回执：**只删自己杀掉的那个 pid 的**，或者一个没有主（pid 为空 / pid 已死）
   * 的陈旧回执。别人的活守卫回执必须留下——删了它看门狗就失明（它只认回执），界面也会丢掉
   * 「结束熄屏」、再点只拿到 409（2026-09-26 审计 F2）。
   * `restoreFailed` 的回执一律留下：那是看门狗的工作单。
   */
  function shouldClearReceipt(hold, killedPid) {
    if (hold.present !== true) return false
    if (hold.restoreFailed === true) return false
    if (hold.pid === null) return true
    if (killedPid !== null && hold.pid === killedPid) return true
    return hold.pidAlive !== true
  }

  /** 推进一次意图（/off 起始、/on 起始各推一次）：后到的意图作废在飞的前一个。 */
  function bumpIntent(kind) {
    state.intent = { seq: state.intent.seq + 1, kind }
    return state.intent.seq
  }

  /**
   * `/off` 的**统一回执形状**：无论成功、busy 冲突、被取代还是失败，键集合都一样
   * （用不到的给 null），客户端只认一种形状（t8 必修 6③：此前 busy-409 只有 `{error}`）。
   */
  function offPayload(extra) {
    return {
      ok: false,
      action: 'off',
      mode: 'vdd-dark',
      reason: null,
      error: null,
      needsVdd: null,
      hold: null,
      guardPid: null,
      vdd: null,
      plan: null,
      keepAwake: null,
      warning: null,
      ...extra,
    }
  }

  /**
   * 看门狗：守卫死了但拓扑还黑着 ⇒ 还原。
   *
   * 只有「状态文件在 + 记的是成功的 dark + 守卫进程没了」才动手，其余情况一次读文件就返回，
   * 所以正常运行时它只是个 5 秒一次的 readFileSync（外加一次 process.kill 探活）。
   *
   * `restoreFailed`（守卫没能还原回来，典型是暗窗期间会话被锁上）时看门狗必须接手，但：
   *   · **重入闸**：慢还原（一次 tick 最多 3 个 PowerShell、各 20 s 上限）时定时器会叠出十几路
   *     并发，所以入口先占坑、finally 释放；
   *   · **退避 + 降级**：前 RESTORE_RETRY_FAST_TRIES 次按 restoreRetryMs（20 s），之后降级到
   *     restoreRetrySlowMs（2 min）——不再"每 20 秒试一次、失败就永远试下去"；
   *   · `kick=true` ＝ 用户回来了（/on 或客户端显式 refresh）：不走退避窗口，立刻试一次。
   */
  async function watchdogTick(kick) {
    // 重入闸：tick 不重叠（慢还原一次 3–6 s，窗口 20 s，不设闸会叠出十几路并发）。
    // **重入时把 kick 排队**：kick 是一次性的（用户点「结束熄屏」/ 界面回到前台），被丢掉就再也不会重来
    // ——t8 指出"用户显式刷新有约 1/4 概率正好撞在在飞 tick 上而失效"。定时器 tick 不排队（下一次自己会来）。
    if (state.ticking) {
      if (kick === true) state.kickPending = true
      return
    }
    const hold = readHoldState(options)
    if (!hold.present) return
    const failing = hold.ok === false && hold.restoreFailed === true
    if (hold.ok === false && !failing) return // 失败回执：脚本自己已经还原过，留着让 /status 说明原因
    if (hold.active) return // 守卫还在跑：一切正常
    if (failing && kick !== true && Date.now() < state.restoreRetry.nextAt) return // 退避窗口内：别空转
    state.ticking = true
    try {
      let restored = false
      let detail = null
      try {
        const check = await runScriptText(scriptPath(options, 'topology'), ['-Action', 'check'], options.helperTimeoutMs, psExe)
        if (/internalActive=True/.test(check.text)) {
          state.watchdog = { at: Date.now(), action: 'ok（拓扑本来就是好的）' }
          state.restoreRetry = { nextAt: 0, attempts: 0 }
        } else {
          // restore 是**动作**不是查询：它跑起来就算数，输出解析失败不该被当成"没还原"
          // （旧写法用 runScriptText 解析它的输出，一个不含 key=value 的回执就会被判失败，
          // 然后白等一个退避窗口）。所以：执行 → 再 check 一次确认结果。
          const out = await execScript(scriptPath(options, 'topology'), ['-Action', 'restore'], options.helperTimeoutMs, psExe).catch((error) => ({
            text: String(error?.message ?? error),
            code: -1,
          }))
          detail = out.text.slice(0, 400)
          const after = await runScriptText(scriptPath(options, 'topology'), ['-Action', 'check'], options.helperTimeoutMs, psExe)
          if (!/internalActive=True/.test(after.text)) {
            throw new Error('还原后内置屏仍未回到活动显示集：' + after.text.slice(0, 200))
          }
          restored = true
          state.watchdog = { at: Date.now(), action: 'restored（守卫已死，拓扑被还原）' }
          state.restoreRetry = { nextAt: 0, attempts: 0 }
          if (ctx.logger) ctx.logger.info('lightout: watchdog restored the topology (guard pid %s is gone)', String(hold.pid))
        }
        clearHoldState(options)
      } catch (error) {
        // 还原仍然失败（会话还锁着？）：把回执留下，退避后再试一次（次数多了自动降级）。
        const attempts = state.restoreRetry.attempts + 1
        const delay = attempts < RESTORE_RETRY_FAST_TRIES ? options.restoreRetryMs : options.restoreRetrySlowMs
        state.restoreRetry = { nextAt: Date.now() + delay, attempts }
        state.watchdog = { at: Date.now(), action: 'failed: ' + String(error?.message ?? error) }
      }
      record({ action: 'watchdog', at: new Date().toISOString(), ok: !String(state.watchdog.action).startsWith('failed'), restored, detail })
    } finally {
      state.ticking = false
      // 出闸后补跑被挡下的那次 kick（清标志再跑，避免自己再把自己排一次）。
      if (state.kickPending === true) {
        state.kickPending = false
        void watchdogTick(true)
      }
    }
  }

  /** 用户回到桌面了（/on 或客户端显式 refresh）：把退避窗口清零并立刻试一次。 */
  function kickWatchdog(reason) {
    const hold = readHoldState(options)
    if (!(hold.present === true && hold.ok === false && hold.restoreFailed === true)) return
    state.restoreRetry = { nextAt: 0, attempts: state.restoreRetry.attempts }
    if (ctx.logger) ctx.logger.info('lightout: watchdog kick (%s)', reason)
    void watchdogTick(true)
  }

  /** 「面板还没还原回来」的告警文案：写进 /status 的 warning，界面才看得见。 */
  function restoreWarning(hold) {
    if (hold === null || hold.present !== true || hold.ok !== false || hold.restoreFailed !== true) return null
    const tries = state.restoreRetry.attempts
    const slow = tries >= RESTORE_RETRY_FAST_TRIES ? '，重试间隔已降到 ' + String(Math.round(options.restoreRetrySlowMs / 1000)) + ' s' : ''
    return '面板尚未还原（已重试 ' + String(tries) + ' 次' + slow + '）：' + String(hold.reason ?? hold.note ?? '还原失败')
  }

  /**
   * 插件卸载/热重载时把守卫收干净：**先还原、再杀守卫**（顺序不能反）。
   * 先杀的话，还原没跑完宿主就可能退出 ⇒ 面板停在全黑、盘上只剩一个 pid 已死的回执。
   * 反过来的话，即使这里被打断，守卫自己的 `-ParentPid` 观察也会兜住还原。
   */
  async function disposeGuard() {
    const hold = readHoldState(options)
    const pid = hold.active === true ? hold.pid : isLiveGuard(state.guard) ? state.guard.pid : null
    if (pid === null) return
    try {
      await runScriptJson(scriptPath(options, 'hold'), ['-Action', 'restore', '-StateFile', holdStateFile(options)], options.helperTimeoutMs, psExe)
    } catch (error) {
      if (ctx.logger) ctx.logger.info('lightout: dispose restore failed: %s', String(error?.message ?? error))
    }
    try {
      process.kill(pid)
    } catch (error) {
      if (ctx.logger) ctx.logger.info('lightout: dispose could not kill the guard pid %s: %s', String(pid), String(error?.message ?? error))
    }
    const after = readHoldState(options)
    if (shouldClearReceipt(after, pid)) clearHoldState(options)
  }

  function startWatchdog() {
    if (!(options.vddWatchdogMs > 0)) return () => {}
    const timer = setInterval(() => {
      void watchdogTick().catch((error) => {
        if (ctx.logger) ctx.logger.warn('lightout: watchdog tick failed: %s', String(error?.message ?? error))
      })
    }, options.vddWatchdogMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }

  /**
   * 一次真体检：2 个 PowerShell（machine status + topology check）＋ 1 次 VDD 探测。
   *
   * `trigger` 只作**来源标记**（'mount' / 'refresh' / 'cache-expired' / 'first-request'），随结果
   * 一起冻进缓存：界面据此说明"这份环境与版本检查是哪一次跑出来的"。调用方（startStatusProbe）
   * 负责先把它写进 state.statusProbeTrigger。
   */
  function probeMachine(trigger) {
    const startedAt = Date.now()
    state.statusProbeStartedAt = startedAt
    return Promise.all([
      runScriptJson(scriptPath(options, 'machine'), ['-Action', 'status'], options.helperTimeoutMs, psExe).catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
      probeVdd(options),
      runScriptText(scriptPath(options, 'topology'), ['-Action', 'check'], options.helperTimeoutMs, psExe)
        .then((out) => {
          const line = textLines(out.text).find((entry) => entry.includes('activePaths=')) ?? ''
          const values = parseKeyValues(line)
          return {
            ok: /activePaths=\d+/.test(out.text),
            activePaths: Number.isFinite(Number(values.activePaths)) ? Number(values.activePaths) : null,
            internalActive: values.internalActive === 'True',
            vddActive: values.vddActive === 'True',
            vddTargets: Number.isFinite(Number(values.vddTargets)) ? Number(values.vddTargets) : null,
          }
        })
        .catch((error) => ({ ok: false, error: String(error?.message ?? error) })),
    ]).then(([machine, vdd, topology]) => {
      const value = { machine, vdd, topology }
      const finishedAt = Date.now()
      state.statusCache = { at: finishedAt, value, trigger: state.statusProbeTrigger, startedAt, finishedAt }
      return state.statusCache
    })
  }

  /**
   * 真探一次并占住单飞位：返回**这一轮的缓存条目**（来源与时间戳跟着数据一起走，
   * 不会被下一次探测覆盖 —— 见 envCheckReport）。
   */
  function startStatusProbe(trigger) {
    state.statusProbeTrigger = String(trigger)
    const probe = probeMachine(trigger)
    state.statusProbe = probe.finally(() => {
      state.statusProbe = null
    })
    return state.statusProbe
  }

  /** 体检结果：15 s 缓存；并发请求**单飞**（提权轮询 + 定时轮询撞在一起时只起一轮 PowerShell）。 */
  async function machineStatus(refresh) {
    const age = Date.now() - state.statusCache.at
    if (refresh !== true && state.statusCache.value !== null && age <= options.statusCacheMs) return state.statusCache.value
    if (state.statusProbe === null) {
      startStatusProbe(refresh === true ? 'refresh' : state.statusCache.value !== null ? 'cache-expired' : 'first-request')
    }
    const entry = await state.statusProbe
    return entry.value
  }

  /**
   * `/status.envCheck`：**只报事实，不算判据**（判据仍由脚本给出）。
   * 客户端据此在界面上写明"环境与版本检查是插件启动时跑的、还是刚重跑的、还是正在跑"。
   */
  function envCheckReport() {
    const entry = state.statusCache
    return {
      // 'mount' ＝ 插件挂载时的预热体检；'refresh' / 'cache-expired' / 'first-request' ＝ 请求触发。
      trigger: entry.trigger,
      startedAt: entry.startedAt > 0 ? new Date(entry.startedAt).toISOString() : null,
      finishedAt: entry.finishedAt > 0 ? new Date(entry.finishedAt).toISOString() : null,
      ageMs: entry.finishedAt > 0 ? Math.max(0, Date.now() - entry.finishedAt) : null,
      inFlight: state.statusProbe !== null,
      // 挂载预热是否真的起了：dryRun（以及测试里钉住脚本的挂载）下**不起**，如实报 false 而不是骗人。
      warmedAtMount: state.mountWarmup.started,
      stale: entry.finishedAt === 0 || Date.now() - entry.finishedAt > options.statusCacheMs,
    }
  }

  /**
   * **挂载期预热体检**：apply 时不 await（宿主启动不被 3 个 PowerShell 拖住），结果落进同一个
   * statusCache ⇒ 面板第一次打开就有一份"随启动跑出来"的环境与版本检查，而不是等某个请求现跑。
   *
   * 三条纪律：
   *   · 不阻塞、不抛：探测自身的失败已在 probeMachine 内被吞成"探不到"，这里再挂一次空 catch 兜底；
   *   · `dryRun` 下不起（dryRun ＝ 连只读探测也不许有副作用的那一档，测试也靠它保证挂载无副作用）；
   *   · 用 effect 挂：cordis 卸载/热重载时这一轮预热随插件一起作废，不留下"没人认领"的探针。
   */
  ctx.effect(() => {
    if (options.dryRun) return undefined
    state.mountWarmup.started = true
    void startStatusProbe('mount').catch(() => {})
    return undefined
  }, 'dsh-lightout: mount-warmup')

  /**
   * **到点检查宿主服务是否真的到了**（只报告，不改行为）。
   *
   * `ctx.inject(['webServer'], …)` 在服务缺席时**静默**：插件照常挂载、不抛，而下面的路由一条也没注册。
   * 外部最典型的成因是宿主版本与插件不匹配（旧版没有这个服务名），表现是"装上了、
   * `--dump-config` 里也有那一行，但所有请求 404、界面点了没反应"——不说出来就没法查。
   *
   * 三条纪律与预热一致：不 await、dryRun 下不起（测试的挂载无副作用契约）、用 effect 挂
   * （卸载时把定时器收掉，不留没人认领的回调）。去重由 `state.platformProbe.warned` 完成：
   * 定时器每个实例只起一次，服务晚到时 inject 回调会把 `webServer` 标上、自然不再 warn。
   */
  ctx.effect(() => {
    if (options.dryRun || !(options.routeProbeMs > 0)) return undefined
    const timer = setTimeout(() => {
      if (state.platformProbe.webServer || state.platformProbe.warned) return
      state.platformProbe.warned = true
      if (ctx.logger) {
        ctx.logger.warn(
          'lightout: 宿主未提供 webServer 服务（等了 %d ms），%s 下的路由未注册 —— ' +
            '插件仍会挂载，但所有请求会 404；宿主版本可能与本插件不匹配（实测环境 dsh 0.1.5-rc.3）',
          options.routeProbeMs,
          ROUTE_PATH,
        )
      }
    }, options.routeProbeMs)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearTimeout(timer)
  }, 'dsh-lightout: route-service-probe')

  /**
   * @param webServer - 由 `ctx.inject(['webServer'], …)` 交出来的服务实例；端口在**每次请求时**读，
   *   拿到的是 listen 之后的真实端口（配置成 0 时也一样）。
   */
  async function handleRoute(req, res, webServer) {
    // 门 1：只服务回环连接。
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      return sendJson(res, 403, { error: 'loopback connections only' })
    }
    // 门 2：改状态的请求必须同源（GET 只读）。GET 也要挡住跨站：`<img>` / `fetch(no-cors)`
    // 够得着读路由，而每次 /status 都要起 2 个 PowerShell —— 不能让它变成任意页面的放大器。
    if (req.method === 'GET') {
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        return sendJson(res, 403, { error: 'cross-site reads are not allowed' })
      }
    } else if (!isSameOriginMutation(req)) {
      return sendJson(res, 403, { error: 'state-changing requests must be same-origin' })
    }

    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { error: 'bad url' })
    }
    const sub = url.pathname.startsWith(ROUTE_PATH) ? url.pathname.slice(ROUTE_PATH.length) : url.pathname

    try {
      if (req.method === 'GET' && (sub === '/status' || sub === '' || sub === '/')) {
        const refresh = url.searchParams.get('refresh') === '1'
        const [machineState, keepAwake] = await Promise.all([
          machineStatus(refresh).catch((error) => ({ machine: { ok: false, error: String(error?.message ?? error) }, vdd: null, topology: null })),
          options.probeKeepAwake
            ? probeKeepAwake(keepAwakeBase(webServer))
            : Promise.resolve({ available: false, reason: 'disabled' }),
        ])
        const hold = readHoldState(options)
        const elevation = readElevateLog(options)
        const vdd = machineState?.vdd ?? null
        // 唤醒锁、VDD、以及「面板还没还原回来」这三类判据**只在宿主算一次**，客户端照抄
        // `warnings`（两边各写一份必然漂移，2026-09-26 审计 D9/D10）。
        const warnings = []
        if (vdd?.available === false) warnings.push('探不到虚拟显示器执行器：' + String(vdd.error ?? '未知原因'))
        else if (vdd?.present === false) warnings.push('虚拟显示器驱动未安装（scripts/vdd-device.ps1 报 device=none）')
        else if (vdd?.check?.driverStore === false) warnings.push('虚拟显示器驱动包不在 DriverStore 里（INF 缺失）：需要重装 VDD 驱动')
        else if (vdd?.check?.gpuChanged === true) warnings.push('显卡/显示驱动自上次启用虚拟显示器以来更新过：上手前先确认面板能正常回来')
        if (keepAwake?.available === true && keepAwake.holdingWakeLock !== true) {
          warnings.push('keep-awake 未持有系统唤醒锁：暗窗期间机器可能进入睡眠，DSH 会停摆')
        }
        // managed 设备实例：脚本侧把 `ROOT\DISPLAY\0000` 写死为默认，这里把它显式化并报出偏差
        // （t8 指出宿主从没往上报 deviceChoice/deviceCount，多实例是静默的）。
        if (vdd?.available === true && vdd.present === true) {
          const want = options.vddInstance
          if (want.length > 0 && typeof vdd.device === 'string' && vdd.device.toUpperCase() !== want.toUpperCase()) {
            warnings.push('虚拟显示器实例与期望不一致：期望 ' + want + '，实际 ' + String(vdd.device))
          }
          if (vdd.check?.deviceChoice === 'ambiguous') {
            warnings.push('虚拟显示器有多张候选设备实例、选不出 managed 实例：启用会被拒绝（先人工确认哪张该用）')
          } else if (typeof vdd.check?.deviceCount === 'number' && vdd.check.deviceCount > 1) {
            warnings.push('本机有 ' + String(vdd.check.deviceCount) + ' 张 VDD 设备实例：只会动 managed 那张，其余保持原样')
          }
        }
        const restoreWarn = restoreWarning(hold)
        // 「面板还没还原」是最紧急的一条（用户可能正对着黑屏）⇒ 放在最前面，也是 `warning` 的取值。
        if (restoreWarn !== null) warnings.unshift(restoreWarn)
        const events = recentEvents()
        // 显式 refresh ＝ 用户正看着界面（客户端在 /on 之后与提权轮询里都会带它）：
        // 面板还没还原的话就立刻重试一次，不必被动等退避窗口（用户回来这件事只有界面能告诉我们）。
        if (refresh) kickWatchdog('status-refresh')
        return sendJson(res, 200, {
          version: VERSION,
          route: ROUTE_PATH,
          // 这份体检数据是谁跑出来的（挂载预热 / 刷新 / 缓存过期 / 首次请求）＋ 有没有在飞 —— 只报事实。
          envCheck: envCheckReport(),
          options: {
            maxDarkSeconds: options.maxDarkSeconds,
            darkPollMs: options.darkPollMs,
            stateFile: holdStateFile(options),
            elevateLog: elevateLogFile(options),
            vddBaseline: baselineFile(options),
            eventLog: eventFile(options),
            vddWatchdogMs: options.vddWatchdogMs,
            darkReceiptMs: options.darkReceiptMs,
            vddGate: options.vddGate,
            restoreRetryMs: options.restoreRetryMs,
            restoreRetrySlowMs: options.restoreRetrySlowMs,
            statusCacheMs: options.statusCacheMs,
            dryRun: options.dryRun,
          },
          scripts: {
            machine: scriptPath(options, 'machine'),
            topology: scriptPath(options, 'topology'),
            hold: scriptPath(options, 'hold'),
            vdd: scriptPath(options, 'vdd'),
          },
          machine: machineState?.machine ?? null,
          vdd,
          // 客户端不再自己算 VDD 是否就绪：读这个由宿主算好的布尔值。
          vddReady: vddReady(vdd),
          topology: machineState?.topology ?? null,
          hold,
          // 最近一次提权请求的结果：declined=true 就是"用户点了否，熄屏功能不可用"。
          elevation,
          watchdog: {
            enabled: options.vddWatchdogMs > 0,
            intervalMs: options.vddWatchdogMs,
            lastAt: state.watchdog.at,
            lastAction: state.watchdog.action,
            attempts: state.restoreRetry.attempts,
            nextRetryMs: Math.max(0, state.restoreRetry.nextAt - Date.now()),
          },
          // 界面上要显示的全部告警：`warnings` 是真源，`warning` 保留第一顺位给旧读取方。
          warnings,
          warning: warnings.length > 0 ? warnings[0] : null,
          keepAwake,
          // 提权守护（计划任务 DSH-LightOut-VDD-Guard）的状态：**只读转述**，没装/没跑就是 null。
          guard: readGuardState(),
          // 只回**最近一条**事件：完整事件日志在 options.eventLog 指的文件里（落盘保留，
          // 跨宿主重启可复盘），但 GET /status 不受同源门保护，不该把它变成一个读出口。
          last: events.length > 0 ? events[events.length - 1] : null,
        })
      }

      if (req.method === 'POST' && sub === '/off') {
        // busy 必须在**这一刻**置位：下面每一次 await 都是数秒级的 PowerShell 调用，旧代码
        // 等它们跑完才置位，于是并发到达的 /off（提权轮询堆积时真的会发出来）全部通过了
        // 检查、各起一个守卫 —— 多个守卫同时切拓扑、又在唤醒时抢着还原，屏幕反复黑、
        // PowerShell 反复编译把 CPU 打满（2026-09-26 事故）。整个分支都在这个 busy 位里。
        if (state.busy) {
          // busy 冲突也走同一个回执形状（t8 必修 6③）。
          return sendJson(res, 409, offPayload({ reason: 'busy', error: '已有一次熄屏正在进行' }))
        }
        state.busy = true
        // 意图序号：/on 会推高它。下面等了好几秒（probeVdd），spawn 之前要复核这个号还在不在，
        // 否则"用户刚点「结束熄屏」，屏幕又黑回去"（2026-09-26 审计 F2）。
        const myIntent = bumpIntent('off')
        let vdd = null
        let plan = null
        let keepAwake = null
        let warning = null
        /** 收尾：记一条事件 + 回包（所有返回分支共用，不再各写一遍 record）。 */
        const finish = (status, payload, entry) => {
          record({ action: 'off', at: new Date().toISOString(), vdd, ...entry })
          return sendJson(res, status, payload)
        }
        /**
         * /off 的**统一回执形状**：ok/action/mode/reason/error/needsVdd/hold/guardPid/vdd/plan/
         * keepAwake/warning 永远在场（用不到的给 null）。此前 busy-409 用 `{error}`、其它用完整载荷，
         * 客户端要按两种形状判读（t8 必修 6③）。
         */
        const reply = (status, extra, entry) => finish(status, offPayload({ vdd, plan, keepAwake, warning, ...extra }), entry)
        try {
          const liveHold = readHoldState(options)
          // 上一次的还原还没完成（面板可能还黑着）：**接管那张工作单**，不清回执、也不起新守卫。
          // 旧行为会先删掉唯一的工作单、再起一个全新的 8 小时守卫 ⇒ 用户在黑屏里盲点一下又是一轮长暗窗
          // （t8 必修 4）。这里让看门狗立刻接手，并把原因如实回给界面。
          if (liveHold.present === true && liveHold.restoreFailed === true) {
            kickWatchdog('off-with-pending-restore')
            return reply(
              200,
              {
                reason: 'panel-not-restored',
                error:
                  '上一次熄屏的还原还没完成（面板可能还黑着）：已让看门狗立刻接手还原；请等面板回来，或点「结束熄屏」。现在不会起新的熄屏守卫。',
                hold: liveHold,
              },
              { ok: false, reason: 'panel-not-restored' },
            )
          }
          // 已经有一个守卫在跑（或刚起、还在启动窗口里）⇒ 绝不再叠第二个。
          if (liveHold.active === true || isLiveGuard(state.guard)) {
            const guardPid = liveHold.pid ?? (state.guard === null ? null : state.guard.pid)
            return reply(
              409,
              {
                reason: 'already-running',
                error: '已有一次熄屏保持正在进行：不会再叠第二个守卫（再点一次按钮即结束它，或 POST /on）',
                hold: liveHold,
                guardPid,
              },
              { ok: false, reason: 'already-running', guardPid },
            )
          }
          // body 只是被吃掉（`lock` 那条旧路线已随 legacy 一起删除），但读取有上限：
          // busy 覆盖这一段，不能让一个不结束的请求把 busy 顶住。
          await readJsonBody(req, options.bodyMaxBytes)

        // 熄屏前先体检：没人持有系统唤醒锁，暗窗期间机器可能会自己睡过去。
        // 探不到（没有 keep-awake / 端口未知 / 探测失败）只记「未知」，**不阻塞**熄屏。
        keepAwake = options.probeKeepAwake
          ? await probeKeepAwake(keepAwakeBase(webServer))
          : { available: false, reason: 'disabled' }
        warning =
          keepAwake?.available === true && keepAwake.holdingWakeLock !== true
            ? 'keep-awake 未持有系统唤醒锁：暗窗期间机器可能进入睡眠，DSH 会停摆'
            : null

        plan = {
          wouldHold: ['DisplayRequired', 'SystemRequired'],
          wouldSwitch: '内置屏移出活动显示集（面板物理断电），虚拟屏接管',
          wouldLock: '还原拓扑之后才 LockWorkStation（锁着的时候 SetDisplayConfig 会被拒绝）',
          wouldKeepSessionUnlocked: true,
          maxSeconds: options.maxDarkSeconds,
        }
        // 赋给外面那个 `vdd`（而不是再声明一个）：`finish` 闭包要把它写进事件日志。
        vdd = await probeVdd(options)

        if (options.dryRun) {
          return reply(
            200,
            { ok: true, dryRun: true, needsVdd: vdd.present === false ? 'missing' : vdd.disabled === true ? 'disabled' : null },
            { ok: true, dryRun: true },
          )
        }

        if (options.vddGate && !vddReady(vdd)) {
          const reason = vdd.available !== true ? 'probe-failed' : vdd.present === false ? 'missing' : 'disabled'
          const message =
            reason === 'missing'
              ? '虚拟显示器驱动未安装：熄屏需要它（见 dsh-lightout/README.md 的安装一节）'
              : reason === 'probe-failed'
                ? '探不到虚拟显示器状态：' + String(vdd.error ?? '未知原因')
                : '虚拟显示器当前是禁用状态（默认如此）：需要一次管理员授权才能启用'
          return reply(
            200,
            {
              reason,
              error: message,
              needsVdd: reason,
              elevation: {
                endpoint: '/vdd',
                method: 'POST',
                body: { action: 'enable' },
                needsAdmin: true,
                wording: readWording(options),
                // 只读的环境/版本检查：设备在不在、驱动版本、显卡驱动是否变过 —— 不需要管理员。
                check: vdd.check,
              },
            },
            { ok: false, reason },
          )
        }

        // 意图复核：等待体检的这几秒里用户可能已经点了「结束熄屏」（/on 推高了意图序号）
        // ⇒ 绝不能再点黑，否则"刚点结束，屏幕又黑"。
        if (state.intent.seq !== myIntent) {
          return reply(
            200,
            {
              superseded: true,
              reason: 'superseded-by-on',
              error: '熄屏已被随后的「结束熄屏」取消（等待体检期间收到了 /on），没有起守卫',
            },
            { ok: false, reason: 'superseded-by-on' },
          )
        }
        // 回执复核：这几秒里冒出来的东西决定还能不能点黑。
        const again = readHoldState(options)
        if (again.present === true && again.restoreFailed === true) {
          // 冒出一张"还没还原完"的工作单 ⇒ 同样别点黑（别删它、也别叠守卫）。
          kickWatchdog('off-race-pending-restore')
          return reply(
            200,
            {
              reason: 'panel-not-restored',
              error: '上一次熄屏的还原还没完成（面板可能还黑着）：已让看门狗立刻接手；现在不会起新的熄屏守卫。',
              hold: again,
            },
            { ok: false, reason: 'panel-not-restored' },
          )
        }
        if (again.active === true) {
          return reply(
            409,
            {
              reason: 'already-running',
              error: '已有一次熄屏保持正在进行：不会再叠第二个守卫（再点一次按钮即结束它，或 POST /on）',
              hold: again,
              guardPid: again.pid,
            },
            { ok: false, reason: 'already-running', guardPid: again.pid },
          )
        }

        // 到这里回执要么不存在、要么是"脚本自己收过尾"的陈旧件（restoreFailed 的工作单已在上面拦掉），
        // 清掉它再起守卫才是安全的。
        clearHoldState(options)
        rotateLog(guardLogFile(options), GUARD_LOG_MAX_LINES, GUARD_LOG_KEEP_LINES)
        const guard = spawnHidden(
          scriptPath(options, 'hold'),
          [
            '-Action', 'dark',
            '-MaxSeconds', String(options.maxDarkSeconds),
            '-PollMs', String(options.darkPollMs),
            '-StateFile', holdStateFile(options),
            // 宿主没了就自己还原：面板绝不能停在一个"要它黑的人已经不在"的状态里。
            '-ParentPid', String(process.pid),
          ],
          psExe,
          guardLogFile(options),
        )
        if (guard.pid === null) {
          // spawn 失败 ＝ 守卫根本没起来：**绝不能**落进"pending 就算成功"那条分支
          // （那正是 2026-09-26 审计的"假成功回执"：200 + ok:true，屏幕却没黑）。
          // 'error' 事件是**下一个 tick** 才到的：等一拍再读，否则详情永远只会写"未知原因"（t8 必修 6②）。
          await new Promise((resolve) => setImmediate(resolve))
          const failure = guard.failure()
          const detail = String(failure?.code ?? failure?.message ?? failure ?? '未知原因')
          return reply(
            500,
            {
              reason: 'guard-spawn-failed',
              error: '熄屏守卫没能启动（进程创建失败）：' + detail,
              guardPid: null,
            },
            { ok: false, reason: 'guard-spawn-failed', detail },
          )
        }
        state.guard = { pid: guard.pid, at: Date.now() }
        const hold = await waitForHoldState(options, guard.pid, options.darkReceiptMs, guard.failure)
        const base = { guardPid: hold.pid ?? guard.pid }

        if (typeof hold.spawnError === 'string') {
          state.guard = null
          return reply(
            500,
            { ...base, reason: 'guard-spawn-failed', error: '熄屏守卫没能启动（进程创建失败）：' + hold.spawnError },
            { ok: false, reason: 'guard-spawn-failed', detail: hold.spawnError },
          )
        }
        if (hold.present === true && hold.ok === false) {
          return reply(
            200,
            { ...base, reason: 'guard-failed', error: '熄屏守卫失败：' + String(hold.reason ?? '原因未知'), hold },
            { ok: false, reason: String(hold.reason ?? 'guard-failed'), detail: hold.raw },
          )
        }
        if (hold.present === true) {
          return reply(
            200,
            {
              ...base,
              ok: true,
              hold,
              startedAt: hold.startedAt,
              deadline: hold.deadline,
              maxSeconds: hold.maxSeconds,
              checkAfterSwitch: hold.checkAfterSwitch,
              note: '暗窗期间会话保持未锁定：键鼠一动先还原拓扑（最多 60 s 重试）再锁屏；也可随时 POST /on 强制还原',
            },
            { ok: true, detail: hold.raw },
          )
        }
        if (hold.guardGone === true) {
          // 退出码分流（lightout-hold.ps1 的契约）：3 ＝ 单实例锁被占（已有守卫 / 锁不可用）、
          // 4 ＝ 切黑后崩溃（应已留下失败回执）、2 ＝ 动作非法；stdout/stderr 都在 guardLog 里。
          // 这三件事以前在界面上完全分不出来，只会显示一句"守卫启动后立刻退出"（t8 必修 6①、台账 §一.9）。
          const code = guard.exitCode()
          const why =
            code === 3
              ? '单实例锁被占：已经有一个守卫在跑（或锁不可用）'
              : code === 4
                ? '守卫在切黑之后崩溃（应已留下失败回执，看门狗会接手）'
                : code === 2
                  ? '脚本动作非法'
                  : '没有留下状态文件'
          return reply(
            200,
            {
              ...base,
              reason: 'guard-exited',
              error: '熄屏守卫启动后立刻退出（' + why + '，exit=' + (code === null ? '未知' : String(code)) + '）；详细输出见 ' + guardLogFile(options),
              hold,
            },
            { ok: false, reason: 'guard-exited', exitCode: code },
          )
        }
        return reply(
          200,
          { ...base, ok: true, pending: true, hold, note: '守卫已启动，但还没落下状态文件（超出 darkReceiptMs）；用 /status 复查' },
          { ok: true, pending: true },
        )
      } finally {
        state.busy = false
      }
      }

      if (req.method === 'POST' && sub === '/on') {
        if (options.dryRun) {
          return sendJson(res, 200, { ok: true, action: 'restore', dryRun: true, topology: 'dry-run', check: 'dry-run', warning: null })
        }
        // 逃生口：**先推高意图**（任何在飞的 /off 到此作废，见 /off 的意图复核），
        // 再杀掉守卫（它的电源请求随之释放，也就不会再锁屏），最后还原拓扑。
        bumpIntent('on')
        const before = readHoldState(options)
        const killedPid = before.active === true ? before.pid : isLiveGuard(state.guard) ? state.guard.pid : null
        let killedGuard = false
        if (killedPid !== null) {
          try {
            process.kill(killedPid)
            killedGuard = true
            await sleep(300)
          } catch (error) {
            if (ctx.logger) ctx.logger.info('lightout: could not kill the guard pid %s: %s', String(killedPid), String(error?.message ?? error))
          }
        }
        const result = await runScriptJson(scriptPath(options, 'hold'), ['-Action', 'restore', '-StateFile', holdStateFile(options)], options.helperTimeoutMs, psExe)
        const after = readHoldState(options)
        if (killedGuard && state.guard !== null && state.guard.pid === killedPid) state.guard = null
        const cleared = shouldClearReceipt(after, killedPid)
        if (cleared) clearHoldState(options)
        // 还原没成功（或盘上还留着「还原失败」回执）⇒ 交给看门狗收尾，并让它立刻试一次。
        const ok = result?.ok !== false
        if (!ok || after.restoreFailed === true) kickWatchdog('on')
        record({ action: 'on', at: new Date().toISOString(), ok, killedGuard, killedPid, cleared, detail: result })
        return sendJson(res, 200, {
          ok,
          action: 'restore',
          killedGuard,
          killedPid,
          cleared,
          topology: result?.topology ?? null,
          check: result?.check ?? null,
          detail: result,
          warning: null,
        })
      }

      if (req.method === 'POST' && sub === '/vdd') {
        const body = await readJsonBody(req, options.bodyMaxBytes)
        const wanted = body?.action === 'disable' ? 'disable' : 'enable'
        const wording = readWording(options)
        const check = (await probeVdd(options)).check
        if (options.dryRun) {
          return sendJson(res, 200, { ok: true, action: 'vdd', requested: wanted, dryRun: true, needsAdmin: true, wording, check })
        }
        // 去重：**上一次的提权进程还在跑**才算"同一次请求"（t8 必修 3）。只按时间窗去重会让
        // "用户点了否、60 s 内又点授权"根本弹不出 UAC，界面还误报"已取消授权"。
        const previous = state.lastVdd
        const previousAlive = previous !== null && isPidAlive(previous.pid)
        if (previous !== null && previous.wanted === wanted && previousAlive) {
          record({ action: 'vdd-' + wanted, at: new Date().toISOString(), ok: true, deduplicated: true, helperPid: previous.pid })
          return sendJson(res, 200, {
            ok: true,
            action: 'vdd',
            requested: wanted,
            needsAdmin: true,
            elevate: true,
            deduplicated: true,
            helperPid: previous.pid,
            parentPid: wanted === 'enable' ? process.pid : null,
            wording,
            check,
            elevateLog: elevateLogFile(options),
            note: '上一次同样的授权请求还在进行中（提权进程仍在跑），没有另起一个提权进程。',
          })
        }
        // 只在没有更近的请求时才清结果文件：否则会把别的在飞请求的结论一起抹掉。
        if (previous === null || Date.now() - previous.at >= options.vddDedupMs) clearElevateLog(options)
        const args = ['-Action', wanted, '-Elevate', '-ElevateLog', elevateLogFile(options), '-Baseline', baselineFile(options)]
        if (wanted === 'enable') args.push('-ParentPid', String(process.pid))
        else args.push('-NoWatch')
        rotateLog(guardLogFile(options), GUARD_LOG_MAX_LINES, GUARD_LOG_KEEP_LINES)
        const helper = spawnHidden(scriptPath(options, 'vdd'), args, psExe, guardLogFile(options))
        state.lastVdd = { wanted, at: Date.now(), pid: helper.pid }
        if (helper.pid === null) {
          // 与 /off 同款：spawn 的 'error' 事件下一个 tick 才到，等一拍再读详情（别只写"未知原因"）。
          await new Promise((resolve) => setImmediate(resolve))
          const failure = helper.failure()
          const detail = String(failure?.code ?? failure?.message ?? failure ?? '未知原因')
          record({ action: 'vdd-' + wanted, at: new Date().toISOString(), ok: false, reason: 'elevate-launch-failed', detail })
          return sendJson(res, 500, {
            ok: false,
            action: 'vdd',
            requested: wanted,
            reason: 'elevate-launch-failed',
            error: '提权进程没能启动（进程创建失败）：' + detail,
          })
        }
        record({ action: 'vdd-' + wanted, at: new Date().toISOString(), ok: true, helperPid: helper.pid })
        return sendJson(res, 200, {
          ok: true,
          action: 'vdd',
          requested: wanted,
          needsAdmin: true,
          elevate: true,
          helperPid: helper.pid,
          parentPid: wanted === 'enable' ? process.pid : null,
          wording,
          check,
          elevateLog: elevateLogFile(options),
          note:
            wanted === 'enable'
              ? '提权窗口已发起：请在 UAC 对话框点「是」。启用成功后本会话结束（DSH 退出）时会自动再禁用它；点「否」则什么都不会发生，熄屏功能保持不可用。'
              : '提权窗口已发起：请在 UAC 对话框点「是」以禁用虚拟显示器。',
        })
      }

      return sendJson(res, 404, { error: 'not found', path: sub })
    } catch (error) {
      const status = typeof error?.statusCode === 'number' ? error.statusCode : 500
      return sendJson(res, status, { error: String(error?.message ?? error) })
    }
  }

  // 等待型注入：webServer 到位（= listen 完成后）才注册路由，端口届时才是真值。
  ctx.inject(['webServer'], (webCtx) => {
    state.platformProbe.webServer = true
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PATH,
          handler: (req, res) => handleRoute(req, res, webCtx.webServer),
        }),
      'dsh-lightout: route',
    )
  })

  /**
   * 关机拓展：DSH 关闭时**发令**给提权守护（写一个请求文件），让设备在收尾阶段就被禁用，
   * 不必等守护下一次轮询发现"DSH 没了"。
   *
   * 三条纪律：
   *   · 服务缺席（没装 SafelyQuit / 版本太旧）⇒ 只是不登记，插件其余部分照常（可选依赖，与 GUIFrame 同款）；
   *   · 动作是**同步小文件写、不等回执**：被动关闭那一趟只有 2.5 秒预算，等守护跑完 pnputil 必然超时；
   *   · 摘除器自持（`ctx.effect` 的返回值就是 `onShutdown` 给的摘除器）⇒ 卸载插件即撤登记，SafelyQuit 侧不留残留。
   *
   * 为什么不能直接在这里禁用设备：关机拓展以宿主权限（普通用户）跑，而 `pnputil /disable-device` 要管理员。
   * 真正执行的是 scripts/lightout-vdd-guard.ps1 —— 它由 tools/install-vdd-guard.ps1 注册的计划任务以最高权限启动。
   */
  ctx.inject(['safelyQuit'], (sqCtx) => {
    const sq = sqCtx['safelyQuit']
    if (sq === null || sq === undefined || typeof sq.onShutdown !== 'function') {
      if (ctx.logger) ctx.logger.info('lightout: safelyQuit 在，但没有 onShutdown（版本太旧？）—— 关机拓展未登记')
      return
    }
    sqCtx.effect(
      () =>
        sq.onShutdown(
          () => {
            const written = writeDisableRequest('safely-quit')
            record({ action: 'shutdown-request', at: new Date().toISOString(), ok: written, detail: { file: requestFile(options) } })
          },
          { id: 'dsh-lightout/vdd-disable', label: '禁用虚拟显示器（发令给提权守护）', order: 20, timeoutMs: 3000 },
        ),
      'dsh-lightout: shutdown-hook',
    )
  })

  // 看门狗随插件生命周期起停（unref 过，不会拖住宿主进程退出）；卸载时顺手把守卫收干净。
  ctx.effect(() => {
    const stopWatchdog = startWatchdog()
    return () => {
      stopWatchdog()
      void disposeGuard()
    }
  }, 'dsh-lightout: watchdog')

  if (ctx.logger) {
    ctx.logger.info('lightout: %s（vddGate=%s, maxDarkSeconds=%d, eventLog=%s）', ROUTE_PATH, options.vddGate, options.maxDarkSeconds, eventFile(options))
  }

  return undefined
}

/** 测试缝：离线用例直接调这些纯函数 / 守卫。 */
export const __test = { normalizeOptions, isLoopbackAddress, isSameOriginMutation, keepAwakeBase, parseKeyValues, isPidAlive, readHoldState, holdStateFile, readElevateLog, elevateLogFile, baselineFile, eventFile, readWording, spawnHidden, requestFile, guardStateFile }
