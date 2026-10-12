/**
 * dsh-lightout -- 浏览器半。
 *
 * 一个落位：**GUIFrame 的「按钮面板」**（`kind:'action'` 的动作型入口，用户在侧栏点 GUIFrame 那一行
 * 浮出的面板里就有这一条）。2026-10-05 按用户指令改造：原先占 DSH 官方座位 `sidebar.footer.action`
 * 的那颗按钮（以及 `exports.inject = ['slots']`）**已整条删除** —— 这是**单向依赖**，
 * 本文件不 import / 不读取 / 不修改 GUIFrame 的任何模块，只经运行时服务对话：
 *   `ctx.inject(['gui-frame'], cb)` 等 `gui-frame` 服务就位 → `service.register(entry, Component)`。
 *   · 不用**声明式** inject（`exports.inject` / package.json 的 `dsh.client.inject`）：缺服务会让整个
 *     模块 fiber 悬置 ⇒ 外壳 `assertEntriesActive` 直接抛错打死整页（GUIFrame 接入指南 §2 的红线）。
 *   · 服务始终不出现 ⇒ 本插件只是**不注册按钮**，页面照常（宿主路由与 `lib/index.js` 全不受影响）。
 *   · 卸下本插件 ⇒ 入口随 fiber 一起撤掉，GUIFrame 侧不留残留（自持 disposer，见 registerInto）。
 *
 * 交互链路（2026-09-26 起走虚拟显示器路线）：
 *   点一下 → 宿主把内置屏移出活动显示集（面板物理断电）→ 会话保持不锁 → 键鼠一动先还原拓扑再锁屏。
 *   屏幕黑了以后界面就看不见了，所以**所有反馈都发生在「没能黑屏」的那条路径上**：失败时行文字变红，
 *   屏幕还亮着，用户看得见。
 *
 * 三道界面保险：
 *   1. 入口定期探宿主 `/status`，把「虚拟屏是否已启用」「熄屏保持是否进行中」「防休眠是否正常」
 *      「电源键当前动作」写进行的 tooltip；
 *   2. 虚拟屏默认是**禁用**的：这时点熄屏，宿主返回 `needsVdd`，界面弹出一份中文说明（原文来自
 *      `scripts/vdd-device.messages.zh.txt` 的 `[enable]` 段），用户点「授权并启用」才会发出提权请求
 *      （UAC）。点完是之后界面自动继续熄屏——**不会静默提权**；
 *   3. 若宿主报「keep-awake 没持有唤醒锁」（`status.warnings`），第一次点击不执行，行文字改成
 *      「仍要熄屏？」要求再点一次。
 *
 * 界面判据**只有一份**：`warnings` / `vddReady` / `hold.active` 全部由宿主算好（两边各算一份必然漂移）。
 * 每次提权是一条独立流程（自增 epoch）。
 *
 * ═══ 与坞面板的两条硬约束（实测口径，改前端时别踩）═══
 *   ① **行内控件不得是 `<button>`**：坞给每个动作行套的壳本身就是一个
 *      `<button data-guif-dock-action="…">`，里面再放 `<button>` 会被 React 19 判非法嵌套
 *      （`In HTML, <button> cannot be a descendant of <button>`）。所以这里渲染的是一个
 *      **可点的 `<div>`**；键盘激活（焦点在行上按 Enter/Space，click 的 target 是**那一行**）
 *      由挂在行上的原生监听补上（见 useRowActivation）。
 *   ② **提权弹层不能留在行内**：它自带两颗键（取消 / 授权并启用），嵌进行里就是上面那条非法结构，
 *      而且点它俩会冒泡触发行的 onClick（同一个坑）。⇒ 弹层经 `createPortal`
 *      送到 `document.body` 上（坞那一行之外）。拿不到 `react-dom` 或没有 DOM 时退回行内渲染，
 *      那一档的弹层控件改用 `div[role=button]`（结构上仍不嵌套 `<button>`）。
 *
 * 只 require('react')（外加平台种子表里的 `react-dom`，仅用于把弹层送出栈；取不到就降级），
 * 样式走产品主题令牌，不依赖其它客户端模块的 id。
 */

window.__ModuleLoader__.load({
  id: 'dsh-lightout',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const exports = {}

    /**
     * 把提权弹层送出坞那一行的工具（平台种子表里的 `react-dom`）。
     * **失败必须吞**：factory 里抛错会冒泡到 loader.create ⇒ 整页停在失败卡片（文件头那条纪律）。
     * 取不到 ⇒ `createPortal = null` ⇒ 弹层退回行内渲染（见文件头硬约束②的降级档）。
     */
    const createPortal = (() => {
      try {
        const reactDom = require('react-dom')
        return typeof reactDom?.createPortal === 'function' ? reactDom.createPortal : null
      } catch {
        return null
      }
    })()

    /** 坞入口 id：**必须带包名前缀**（GUIFrame 的 ENTRY_ID_PATTERN），不占保留 key。 */
    const ENTRY_ID = 'dsh-lightout/off'
    /** 插件自报包名（坞的 stale 判定用）。 */
    const SOURCE = 'dsh-lightout'
    /**
     * 坞面板里的排序键：越小越靠前。取 10 —— 熄屏是日常动作，排在自检/关闭那两条前面。
     */
    const ENTRY_ORDER = 10

    const ENDPOINT = '/api/dsh-lightout'
    const CSS_ID = 'dsh-lightout/styles'
    /** 体检轮询间隔：宿主侧还有 15s 缓存，这里不必更密。 */
    const STATUS_POLL_MS = 60000
    /** 二次确认（「仍要熄屏？」）的有效期。 */
    const ARM_TIMEOUT_MS = 6000
    /** 失败提示在按钮上停留的时间。 */
    const ERROR_HOLD_MS = 8000
    /**
     * 提权后等「设备已启用」的轮询间隔与总时长（用户要在 UAC 上做决定，给足 90 秒）。
     * 间隔要比宿主一次 /status 的耗时更长：那一次要起几个 PowerShell（数秒）。轮询必须
     * **串行**（见 confirmElevate），否则会堆成一串并发请求。
     */
    const ELEVATE_POLL_MS = 3000
    const ELEVATE_WAIT_MS = 90000

    const CSS = [
      // ── 坞那一行里的控件：**只做内容，不做外壳** ────────────────────────────────
      // 行的盒子（`padding:7px 8px` / `gap:8px` / `min-height:36px` / `font-size:14px` /
      // `line-height:22px` / 悬停底色 / `border-radius:8px`）**由坞自己画**
      // （`[data-guif-dock-action]` ＝ DSH 侧栏 `.panelRow` 的逐值照抄）。这里一旦自带
      // padding/height/font-size，内容就相对邻居多缩进一截、整行也被顶高（真机实测：
      // 改前 icon 左内缩 18px、行高 46px、文字 13px，邻居是 8px / 36px / 14px ⇒ 一眼不在一条线上）。
      // 所以：`padding:0`、不给高度、字号与行同源（`font:inherit` 就是行的 14px）。
      '.lo-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;width:100%;min-width:0;',
      'padding:0;border:0;border-radius:0;background:transparent;color:inherit;',
      'font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}',
      // 悬停底色归**行**（`[data-guif-dock-action]:hover`）：DSH 侧栏的语义是「整行一个悬停面」，
      // 而且坞的样式表会把行内元素四态底色按 `!important` 抹平 —— 这里自画 hover 是死代码。
      // 忙碌（等待 UAC / 正在熄屏）：只收可点感，不换盒子尺寸。
      '.lo-btn-busy{opacity:.72;cursor:default}',
      // 危险/失败：只用颜色把状态顶到眼前（与坞里其它动作型入口的 confirm/force 同一手法）。
      '.lo-btn-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.lo-btn-error{color:var(--dsw-alias-state-error-primary)}',
      // 图标只吃 currentColor：颜色跟随行文字，暗色主题自动跟随，且不写颜色字面量。
      '.lo-icon{display:block;flex:none}',
      // 标签可省略号收缩（`min-width:0` 是 flex 里能真的收到省略号的前提）。
      '.lo-label{flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      // ── 提权说明弹层（`createPortal` 送到 `document.body`，**不在坞那一行里面**）──────────
      // `z-index:1000` ＝ GUIFrame 数字层级表里「非托管·**盖住**托管浮层」那一带的起点
      // （≤40 在下带、50–999 是托管段、≥1000 盖住）：坞面板自己是 `[data-guif-overlay-root]`
      // （z=20）里的一扇 `panel` 族窗口（200–299），60 那一档压在它下面就看不见了。
      '.lo-modal{position:fixed;left:16px;bottom:56px;z-index:1000;box-sizing:border-box;',
      'width:min(440px,calc(100vw - 32px));padding:14px 16px;border-radius:12px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
      'border:1px solid rgba(127,127,127,.35);box-shadow:0 12px 32px rgba(0,0,0,.32);',
      'font-size:12px;line-height:1.65;text-align:left}',
      '.lo-modal-title{margin:0 0 8px;font-size:13px;font-weight:600}',
      '.lo-modal-body{margin:0 0 12px;white-space:pre-wrap;word-break:break-word;font:inherit;',
      'max-height:40vh;overflow:auto}',
      '.lo-modal-actions{display:flex;gap:8px;justify-content:flex-end;align-items:center}',
      '.lo-modal-hint{margin-right:auto;color:var(--dsw-alias-label-secondary)}',
      '.lo-modal-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid transparent;',
      'background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;',
      'font-size:12px;display:inline-flex;align-items:center}',
      '.lo-modal-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.lo-modal-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2)}',
      '.lo-modal-btn-primary:hover{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-2)}',
    ].join('')

    function styleTag() {
      if (typeof document === 'undefined') return null
      return document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']')
    }

    /** 样式只插一次，带所有者标记，便于排查与热重载。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (styleTag() !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-lightout'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 卸载时把样式也带走：插件热重载/卸载后不该残留一份。 */
    function removeStyle() {
      const tag = styleTag()
      if (tag !== null && tag.parentNode !== null) tag.parentNode.removeChild(tag)
    }

    /** 最简订阅表：按钮与轮询在同一个 factory 闭包里。 */
    function createShared() {
      let state = { status: null, busy: false, armed: false, error: null, prompt: null, waiting: false }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }
    const shared = createShared()

    function useShared() {
      const [snap, setSnap] = React.useState(shared.get())
      React.useEffect(() => shared.subscribe(() => setSnap(shared.get())), [])
      return snap
    }

    /**
     * 调宿主路由；非 2xx 抛出带响应文本的错误。错误上带 `status` 与 `body`：
     * 409 是"已经有一次熄屏保持在进行"，界面必须把它与真失败分开。
     */
    async function api(path, init) {
      const options = init ?? {}
      // 先摊开 init 再合并 headers：否则 init.headers 会把 accept/content-type 整个顶掉。
      const response = await fetch(ENDPOINT + path, {
        ...options,
        headers: {
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers ?? {}),
        },
      })
      const text = await response.text()
      let value = null
      try {
        value = text.length > 0 ? JSON.parse(text) : null
      } catch {
        value = null
      }
      if (!response.ok) {
        const detail = value && typeof value.error === 'string' ? value.error : 'HTTP ' + String(response.status)
        const error = new Error(detail)
        error.status = response.status
        error.body = value
        throw error
      }
      return value
    }

    async function loadStatus(refresh) {
      const status = await api(refresh === true ? '/status?refresh=1' : '/status')
      shared.set({ status })
      return status
    }

    function vddLabel(status) {
      const vdd = status?.vdd
      if (vdd === null || vdd === undefined) return '虚拟屏：状态未知'
      if (vdd.available !== true) return '虚拟屏：探不到（' + String(vdd.error ?? '未知原因') + '）'
      if (vdd.present !== true) return '虚拟屏：驱动未安装'
      return vdd.disabled === true ? '虚拟屏：未启用（点熄屏会先请你授权）' : '虚拟屏：已启用'
    }

    const POWER_BUTTON_LABEL = { 0: '不采取任何动作', 1: '睡眠', 2: '休眠', 3: '关机' }
    /** 事件日志里的动作 → 人话（宿主记的是 action 字段）。 */
    const LAST_LABEL = {
      off: '上次熄屏',
      on: '上次结束熄屏',
      watchdog: '上次看门狗',
      'vdd-enable': '上次启用虚拟屏',
      'vdd-disable': '上次禁用虚拟屏',
    }

    /** 宿主记录里的 UTC ISO 串 → 本地 HH:MM:SS（直接 slice 会把 UTC 当本地，早 8 小时）。 */
    function localTime(at) {
      const when = new Date(at)
      return Number.isFinite(when.getTime()) ? when.toTimeString().slice(0, 8) : null
    }

    /**
     * 界面判据的**单一来源**：全部读宿主算好的字段。
     * `warnings`（唤醒锁 / VDD / 面板未还原）与 `vddReady` 都由 /status 给出，
     * 客户端不再自己重算一份。
     */
    function viewState(status) {
      const warnings = Array.isArray(status?.warnings) ? status.warnings : []
      return {
        warnings,
        warn: warnings.length > 0,
        holdActive: status?.hold?.active === true,
        vddReady: status?.vddReady === true,
      }
    }

    /**
     * 「环境与版本检查」是哪一次跑出来的：挂载预热 / 刚为你重跑 / 正在跑（宿主如实报 trigger，
     * 客户端只翻译成人话，不再自己猜时间）。宿主没给这一项（旧宿主）⇒ 什么都不显示。
     */
    function envCheckLabel(status) {
      const check = status?.envCheck
      if (check === null || check === undefined) return null
      if (check.inFlight === true) return '体检：正在跑…'
      if (typeof check.finishedAt !== 'string') return check.warmedAtMount === true ? '体检：随插件启动（结果还没出来）' : '体检：还没跑过'
      const at = localTime(check.finishedAt)
      if (check.trigger === 'mount') return '体检：随插件启动完成' + (at !== null ? '（' + at + '）' : '')
      const age = typeof check.ageMs === 'number' ? Math.round(check.ageMs / 1000) : null
      return '体检：刚重跑' + (at !== null ? '（' + at + '）' : '') + (age !== null && age > 0 ? '，' + String(age) + ' s 前' : '')
    }

    function describe(status) {
      if (status === null || status === undefined) return '熄屏（正在读取状态…）'
      const parts = [vddLabel(status)]
      const envCheck = envCheckLabel(status)
      if (envCheck !== null) parts.push(envCheck)
      const hold = status.hold
      if (hold?.active === true) {
        const until = typeof hold.deadline === 'string' ? '，最晚到 ' + hold.deadline.slice(11, 19) : ''
        parts.push('熄屏保持：进行中' + until)
      }
      const keepAwake = status.keepAwake
      if (keepAwake?.available === true) {
        parts.push(keepAwake.holdingWakeLock === true ? '防休眠：正常' : '防休眠：未持有唤醒锁')
      } else {
        parts.push('防休眠：未探测到 keep-awake')
      }
      const action = status.machine?.policy?.PBUTTONACTION?.effective
      if (typeof action === 'number') {
        parts.push('电源键=' + (POWER_BUTTON_LABEL[action] ?? String(action)))
      }
      const last = status.last
      if (last !== null && last !== undefined && last.ok === true && typeof last.at === 'string') {
        const when = localTime(last.at)
        if (when !== null) parts.push((LAST_LABEL[last.action] ?? '上次动作') + ' ' + when)
      }
      for (const warning of Array.isArray(status.warnings) ? status.warnings : []) {
        parts.push('⚠ ' + String(warning))
      }
      return '熄屏：把内置屏移出活动显示集（面板物理断电，系统仍认为有屏），DSH 继续工作；键鼠一动先还原再锁屏。' + parts.join(' · ')
    }

    let armTimer = null
    let errorTimer = null
    /**
     * 提权流程：**每次「授权并启用」都是一条独立流程**（自己的 settled / timer / deadline），
     * 并用自增 epoch 标记"谁是当前那条"。旧的模块级 `elevateSettled` + 单 handle 会被后一次流程
     * 重新置成"未定"，于是上一次在飞的探测会复活、甚至替已经点过「取消」的用户自动熄屏；
     * 两条链还会互相清掉对方的定时器。
     */
    let elevateSeq = 0
    let elevateFlow = null

    /** 作废当前提权流程（用户点取消 / 插件卸载）：epoch +1，在飞的探测回来时直接退出。 */
    function abortElevate() {
      elevateSeq += 1
      if (elevateFlow !== null) {
        elevateFlow.settled = true
        if (elevateFlow.timer !== null) clearTimeout(elevateFlow.timer)
        elevateFlow.timer = null
      }
      elevateFlow = null
    }

    function scheduleErrorClear() {
      if (errorTimer !== null) clearTimeout(errorTimer)
      errorTimer = setTimeout(() => shared.set({ error: null }), ERROR_HOLD_MS)
    }

    function fail(cause) {
      shared.set({ busy: false, waiting: false, error: String(cause?.message ?? cause) })
      scheduleErrorClear()
    }

    /** 真正发熄屏请求；返回宿主回执。虚拟屏没启用时把回执挂到 prompt 上让界面弹说明。 */
    async function runOff() {
      shared.set({ busy: true, armed: false, error: null, prompt: null, waiting: false })
      try {
        // 不带 body：本接口不接受任何参数。
        const result = await api('/off', { method: 'POST' })
        if (result?.needsVdd !== null && result?.needsVdd !== undefined && result?.ok === false) {
          shared.set({ busy: false, prompt: result })
          return result
        }
        if (result?.ok === false) {
          shared.set({ busy: false, error: String(result.error ?? '熄屏失败') })
          scheduleErrorClear()
          return result
        }
        shared.set({ busy: false })
        return result
      } catch (cause) {
        // 409 ＝ 宿主那边已经有一次熄屏保持在进行：这不是失败。把状态刷新回来，
        // 让按钮变成「结束熄屏」，而不是给用户一句错误的"熄屏失败"。
        if (cause?.status === 409) {
          shared.set({ busy: false, error: null })
          await loadStatus(true).catch(() => {})
          return null
        }
        fail(cause)
        return null
      }
    }

    async function trigger() {
      const snap = shared.get()
      if (snap.busy || snap.waiting) return
      const view = viewState(snap.status)
      // 正在熄屏保持中：这一下点的是「结束熄屏」。
      if (view.holdActive) {
        await endHold()
        return
      }
      // 第二道保险：唤醒锁明确缺失时先确认，避免暗窗期间机器睡过去。
      if (view.warn && snap.armed !== true) {
        shared.set({ armed: true, error: null })
        if (armTimer !== null) clearTimeout(armTimer)
        armTimer = setTimeout(() => shared.set({ armed: false }), ARM_TIMEOUT_MS)
        return
      }
      await runOff()
    }

    /**
     * 用户在说明弹层上点了「授权并启用」：发一次提权请求，然后轮询到设备就绪再自动继续熄屏。
     *
     * 轮询刻意用**递归 setTimeout** 而不是 setInterval：宿主每答一次 `/status` 都要起几个
     * PowerShell（数秒），setInterval 会把请求堆成一串并发飞行；设备就绪那一刻，**每一个**在飞
     * 的回调都会各自调一次 runOff()，于是同时起好几个熄屏守卫 —— 多个守卫抢同一条拓扑，
     * 屏幕反复黑、PowerShell 反复编译把 CPU 打满。
     * 每条流程自己持有 timer/settled/deadline，并用 `flow.id !== elevateSeq` 判定自己是否已被取代。
     */
    async function confirmElevate() {
      const snap = shared.get()
      const body = snap.prompt?.elevation?.body ?? { action: 'enable' }
      const flow = { id: (elevateSeq += 1), settled: false, timer: null, deadline: 0 }
      elevateFlow = flow
      shared.set({ waiting: true, prompt: null, error: null })
      const settle = (message) => {
        if (flow.settled) return
        flow.settled = true
        if (flow.timer !== null) clearTimeout(flow.timer)
        flow.timer = null
        shared.set({ waiting: false, error: message })
        scheduleErrorClear()
      }
      try {
        await api('/vdd', { method: 'POST', body: JSON.stringify(body) })
      } catch (cause) {
        settle(String(cause?.message ?? cause))
        return
      }
      // 请求飞出去的这段时间里用户可能已经点了「取消」（或被新流程取代）：别再往下走。
      if (flow.settled || flow.id !== elevateSeq) return
      flow.deadline = Date.now() + ELEVATE_WAIT_MS

      const tick = async () => {
        flow.timer = null
        if (flow.settled || flow.id !== elevateSeq) return
        try {
          const status = await loadStatus(true)
          if (flow.settled || flow.id !== elevateSeq) return
          if (viewState(status).vddReady) {
            flow.settled = true
            shared.set({ waiting: false })
            await runOff()
            return
          }
          // 用户在 UAC 上点了「否」：立刻收工，别让他白等 90 秒。
          // 熄屏这条路就此失效（虚拟显示器保持禁用），其余功能不受影响。
          if (status?.elevation?.declined === true) {
            settle('已取消授权：虚拟显示器保持禁用，熄屏功能不可用（其余功能不受影响）')
            return
          }
        } catch {
          /* 单次探测失败不算数，等下一次 */
        }
        if (flow.settled || flow.id !== elevateSeq) return
        if (Date.now() > flow.deadline) {
          settle('没等到授权结果（UAC 被取消，或设备启用失败）')
          return
        }
        flow.timer = setTimeout(() => {
          void tick()
        }, ELEVATE_POLL_MS)
      }

      flow.timer = setTimeout(() => {
        void tick()
      }, ELEVATE_POLL_MS)
    }

    function dismissPrompt() {
      // 用户明确取消：连在飞的那次探测一起作废（epoch +1），它回来时不得再自动熄屏。
      abortElevate()
      shared.set({ prompt: null, waiting: false, busy: false })
    }

    /** 逃生口：杀掉守卫并立刻还原拓扑（面板马上亮回来）。 */
    async function endHold() {
      shared.set({ busy: true, error: null })
      try {
        await api('/on', { method: 'POST' })
        // busy 必须等状态刷新完再放：否则那一瞬间按钮又按旧状态变成可点，
        // 用户连点两下就是两条 POST /on。
        await loadStatus(true).catch(() => {})
      } catch (cause) {
        fail(cause)
      } finally {
        shared.set({ busy: false })
      }
    }

    /** 提权说明弹层：文案全部来自宿主（= scripts/vdd-device.messages.zh.txt 的 [enable] 段）。 */
    function ElevateDialog(props) {
      const prompt = props.prompt
      /**
       * 这一份弹层是不是**已经送出坞那一行**（`createPortal` 到 document.body）。
       * 送出 ⇒ 两颗键可以是原生 `<button>`；退回行内 ⇒ 只能 `div[role=button]`
       * （行内已经在 `<button data-guif-dock-action>` 里，再嵌 `<button>` 会被 React 19 判非法嵌套）。
       */
      const outOfRow = props.outOfRow === true
      const elevation = prompt?.elevation ?? {}
      const wording = typeof elevation.wording === 'string' && elevation.wording.length > 0 ? elevation.wording : String(prompt?.error ?? '')
      const check = elevation.check ?? prompt?.vdd?.check ?? null
      const lines = []
      if (check !== null && check !== undefined) {
        lines.push('—— 环境与版本检查（只读，不需要管理员）——')
        lines.push('虚拟显示器驱动：' + (check.driverVersion !== '' ? check.driverVersion : '未知') + '（' + (check.infName !== '' ? check.infName : '无 INF') + '，驱动包' + (check.driverStore === true ? '在' : '**不在**') + '）')
        lines.push('设备状态：' + (check.verdict === 'ready' ? '就绪（已启用）' : check.verdict === 'disabled' ? '已安装但处于禁用（默认态）' : check.verdict === 'missing' ? '未安装' : String(check.verdict)) + '，虚拟屏 ' + String(check.monitors ?? 0) + ' 个，显卡 ' + String(check.gpuCount ?? 0) + ' 个')
        if (check.gpuChanged === true) lines.push('⚠ 显卡/显示驱动自上次启用以来**变过**：启用前请先确认面板能正常回来')
        if (check.vddChanged === true) lines.push('⚠ 虚拟显示器驱动版本也变过')
      }
      /** 弹层里的一颗键（两种档位的形状差异只在这一个工厂里，调用点保持一行）。 */
      const action = (className, label, onClick) =>
        outOfRow
          ? h('button', { type: 'button', className, onClick }, label)
          : h(
              'div',
              {
                className,
                role: 'button',
                tabIndex: 0,
                onClick,
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onClick()
                },
              },
              label,
            )
      return h(
        'div',
        { className: 'lo-modal', role: 'dialog', 'aria-modal': 'false', 'aria-label': '启用虚拟显示器' },
        h('p', { className: 'lo-modal-title' }, '启用虚拟显示器？（会弹一次 UAC）'),
        h('pre', { className: 'lo-modal-body' }, wording),
        lines.length > 0 ? h('pre', { className: 'lo-modal-body' }, lines.join('\n')) : null,
        h(
          'div',
          { className: 'lo-modal-actions' },
          h('span', { className: 'lo-modal-hint' }, '管理员授权只用于启用这一个设备'),
          action('lo-modal-btn', '取消', () => dismissPrompt()),
          action('lo-modal-btn lo-modal-btn-primary', '授权并启用', () => {
            void confirmElevate()
          }),
        ),
      )
    }

    /**
     * 往上找「坞那一行」—— GUIFrame 给每个动作行套的 `<button data-guif-dock-action="…">`。
     * 找不到就退回直接父节点（装配细节变了也不至于失联）。
     */
    function dockRowOf(node) {
      try {
        if (node === null || node === undefined) return null
        if (typeof node.closest === 'function') {
          const row = node.closest('[data-guif-dock-action]')
          if (row !== null && row !== undefined) return row
        }
        return node.parentElement ?? null
      } catch {
        return null
      }
    }

    /** 事件目标是不是落在我们自己的元素里（是 ⇒ 归我们的 onClick 管，行上的监听让路）。 */
    function insideNode(node, target) {
      try {
        if (node === null || node === undefined || target === null || target === undefined) return false
        if (node === target) return true
        return typeof node.contains === 'function' && node.contains(target)
      } catch {
        return false
      }
    }

    /**
     * 弹层的落点判定：**能送出栈就送**（`createPortal` → `document.body`）。
     *
     * 为什么不能留在行内：坞那一行本身就是 `<button data-guif-dock-action>`，弹层自带两颗键
     * （取消 / 授权并启用），留在行内就是 `<button>` 套 `<button>`（React 19 判非法嵌套），
     * 而且点它俩会冒泡触发行的 onClick（取消不掉，还会多打一次 /off）。
     *
     * 三种拿不到宿主的情形（没 `react-dom` / 没有 DOM（SSR 与单测）/ 没有 `document.body`）
     * 一律退回**行内渲染**：那时弹层的控件改用 `div[role=button]`（见 ElevateDialog 的 outOfRow）。
     * 判据只算一次 —— 形状必须跟着**真实落点**走，不能两处各判一次。
     *
     * @returns {object|null} 弹层该送进去的 DOM 宿主；`null` ＝ 留在行内
     */
    function modalHost() {
      if (createPortal === null) return null
      try {
        if (typeof document === 'undefined') return null
        return document.body ?? null
      } catch {
        return null
      }
    }

    /**
     * 坞面板里的那一行（GUIFrame **原样渲染**这个组件）。
     *
     * ⚠ 这里渲染的是**可点的 `<div>`**，不是 `<button>`：行的壳已经是 button 了（文件头硬约束①）。
     * 行的盒子/悬停底色/字号全归坞（`[data-guif-dock-action]`），本组件只画「图标 + 文字」。
     */
    function LightOutRow() {
      const snap = useShared()
      const view = viewState(snap.status)
      const failed = typeof snap.error === 'string' && snap.error.length > 0
      const holding = view.holdActive

      let label = '熄屏'
      if (snap.busy) label = '熄屏中…'
      else if (snap.waiting) label = '等待 UAC…'
      else if (snap.armed) label = '仍要熄屏？'
      else if (failed) label = '熄屏失败'
      else if (view.warn && !holding) label = '熄屏（有风险）'
      else if (holding) label = '结束熄屏'

      const className =
        'lo-btn' +
        (snap.busy || snap.waiting ? ' lo-btn-busy' : '') +
        (failed ? ' lo-btn-error' : snap.armed || view.warn ? ' lo-btn-warn' : '')

      const title = failed ? '熄屏失败：' + snap.error : describe(snap.status)
      const nodeRef = React.useRef(null)
      /**
       * 这一下点什么都不敢跳过：`trigger()` 每次都现读共享状态（`shared.get()`），
       * 所以 `act` 不必随状态变化重建 —— 行上的监听**只挂一次**。
       */
      const act = () => {
        void trigger()
      }

      /**
       * 键盘可达性：焦点在坞那一行（就是那个 `<button>`）上时，Enter/Space 产生的 click 的
       * target 是**那一行**，不是我们的 `<div>` —— 只靠 div 的 onClick 会漏掉键盘。
       * ⇒ 挂载时给行接一个原生 click 监听；点在我们自己元素上的那一下由 div 的 onClick 管，
       * 这里靠 `insideNode` 让路（否则一次点击执行两遍）。
       */
      React.useEffect(() => {
        const node = nodeRef.current
        const row = dockRowOf(node)
        if (row === null || typeof row.addEventListener !== 'function') return undefined
        const onRowClick = (event) => {
          if (insideNode(node, event?.target)) return
          act()
        }
        row.addEventListener('click', onRowClick)
        return () => {
          try {
            row.removeEventListener('click', onRowClick)
          } catch {
            /* 行已经没了就算了 */
          }
        }
      }, [])

      const row = h(
        'div',
        {
          className,
          ref: nodeRef,
          title,
          onClick: act,
          'data-dsh-lightout-entry': ENTRY_ID,
          'data-dsh-lightout-state': holding ? 'holding' : snap.busy ? 'busy' : snap.waiting ? 'waiting' : snap.armed ? 'armed' : failed ? 'error' : view.warn ? 'warn' : 'idle',
        },
        h(PowerIcon, { key: 'icon', size: 16 }),
        h('span', { key: 'label', className: 'lo-label' }, label),
      )

      // 提权弹层：默认送出栈（与行同级 = 在坞那一行之外）；拿不到宿主就留在行内（控件形状随之降级）。
      // `build(outOfRow)` 与真实落点**同源**：送出栈失败时按行内那一档重建，绝不让「以为送出去了」的
      // 形状留在行里（那就是嵌套 `<button>`）。
      const host = modalHost()
      const build = (outOfRow) =>
        snap.prompt !== null && snap.prompt !== undefined ? h(ElevateDialog, { key: 'modal', prompt: snap.prompt, outOfRow }) : null
      const modal = build(host !== null)
      let modalNode = modal
      if (modal !== null && host !== null) {
        try {
          modalNode = createPortal(modal, host)
        } catch {
          modalNode = build(false) // createPortal 自己抛（极异常）：退回行内那一档，宁可结构降级也不能丢弹层
        }
      }
      return h(React.Fragment, null, row, modalNode)
    }

    /** 熄屏图标：一个电源符号（与「月亮」相比更不容易和主题图标混淆）。 */
    function PowerIcon(props) {
      const size = props.size ?? 16
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }
      return h(
        'svg',
        { className: 'lo-icon', width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: 'M8 2.2v5.2', ...stroke }),
        h('path', { d: 'M4.6 4.4a5 5 0 1 0 6.8 0', ...stroke }),
      )
    }

    /**
     * **不声明任何服务**：坞入口只在 `ctx.inject(['gui-frame'], …)` 里按需取。
     * 历史：2026-10-05 之前这里是 `['slots']`，因为那时还占 DSH 官方座位 `sidebar.footer.action` ——
     * 那颗按钮按用户指令删掉了（改成 GUIFrame 按钮面板里的一个动作型入口）。
     * 写进这里会让缺服务时**整个模块 fiber 悬置** ⇒ 插件不激活，所以恒为空表。
     */
    const inject = []

    /** 坞入口的显示名（坞也用它做侧栏/管理页的自绘读数）。 */
    const ENTRY_LABEL = '熄屏'

    /**
     * 把入口注册进 **GUIFrame 的按钮面板**（`kind:'action'` ⇒ 只进坞面板，不占任何官方座位）。
     *
     * 为什么是 `ctx.inject(...)` 而不是模块的 `inject: ['gui-frame']`、也不是一次性 `ctx.get(...)`：
     *   前者缺服务时会让本模块 fiber 悬置 ⇒ 外壳 `assertEntriesActive` 直接抛错打死整页
     *   （GUIFrame 接入指南 §2 的红线）；后者读不到**晚到**的服务（坞先装、插件后装）。
     * 服务始终不出现 ⇒ 本插件只是不注册按钮，页面照常（宿主路由与 lib/index.js 全不受影响）。
     *
     * @param {object} ctx 本模块的 ctx
     * @returns {boolean} 是否成功声明了这次运行时注入（不代表服务已经就位）
     */
    function registerInto(ctx) {
      if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') return false
      try {
        ctx.inject(['gui-frame'], (panelCtx) => {
          if (panelCtx === null || typeof panelCtx !== 'object') return
          const mount = () => {
            let gui = null
            try {
              gui = typeof panelCtx.get === 'function' ? panelCtx.get('gui-frame') : panelCtx['gui-frame']
            } catch (cause) {
              warn('取 gui-frame 服务失败，坞入口跳过', cause)
              return undefined
            }
            if (gui === null || gui === undefined || typeof gui.register !== 'function') return undefined
            let off = null
            try {
              off = gui.register(
                {
                  id: ENTRY_ID,
                  label: () => ENTRY_LABEL,
                  order: ENTRY_ORDER,
                  kind: 'action',
                  source: SOURCE,
                  // 动作型入口在面板行里**不画图标槽**（那一行的图标由本组件自己画，见 LightOutRow）；
                  // 这一项留着是注册面的形状，坞自绘字形的那些位置继续用它。
                  icon: PowerIcon,
                },
                LightOutRow,
              )
            } catch (cause) {
              // 同名入口已在册（上一次没归还干净）等：只降级，不抛 —— 面板少一行，页面照常。
              warn('坞入口未注册', cause)
              return undefined
            }
            if (typeof off !== 'function') return undefined
            // **自持 disposer**：GUIFrame 的服务面不是 cordis 的 traceable Service，`register()` 的清理
            // 挂在**它的** fiber 上 ⇒ 不归还的话，本插件卸载/热重载之后面板里会留下指向旧模块的僵尸入口
            // （实测结论）。disposer 幂等，重复调无副作用。
            return () => {
              try {
                off()
              } catch (cause) {
                warn('坞入口归还失败（已吞）', cause)
              }
            }
          }
          if (typeof panelCtx.effect === 'function') panelCtx.effect(mount, 'dsh-lightout: gui-frame dock entry')
          else mount()
        })
        return true
      } catch (cause) {
        warn('坞入口注入声明失败（已吞）', cause)
        return false
      }
    }

    /** 一行控制台警告（客户端 apply 里抛错会打死整页，所以失败一律只留痕、不冒泡）。 */
    function warn(message, cause) {
      try {
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn('[dsh-lightout] ' + message + (cause === undefined ? '' : '：' + String(cause?.message ?? cause)))
        }
      } catch {
        /* 控制台不可用不追究 */
      }
    }

    /** 客户端半入口：把入口交给 GUIFrame 的按钮面板，并先拉一次状态。 */
    function apply(ctx) {
      ensureStyle()
      registerInto(ctx)
      // 递归 setTimeout 而不是 setInterval：宿主一次 /status 要起 2 个 PowerShell（数秒），
      // 固定间隔会把探测堆起来（和提权轮询同一个坑）。
      let disposed = false
      let statusTimer = null
      const pollStatus = async () => {
        statusTimer = null
        if (disposed) return
        await loadStatus().catch(() => {})
        if (disposed) return
        statusTimer = setTimeout(() => {
          void pollStatus()
        }, STATUS_POLL_MS)
      }
      void pollStatus()
      // 用户回到这个页面/标签 ⇒ 带 refresh 探一次：宿主据此 kickWatchdog。
      // 为什么需要它：暗窗期间会话被锁时守卫会放弃还原、退避升到 30 s 档，用户解锁回来面对的可能
      // 还是全黑屏；这一下让"面板还没回来"的重试立刻发生，不必等下一次 60 s 轮询
      // 修 restoreFailed 落盘必须**同时**加"解锁/键鼠回来立即重试"。
      const onWake = () => {
        if (disposed) return
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void loadStatus(true).catch(() => {})
      }
      const canListenWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function'
      const canListenDocument = typeof document !== 'undefined' && typeof document.addEventListener === 'function'
      if (canListenWindow) window.addEventListener('focus', onWake)
      if (canListenDocument) document.addEventListener('visibilitychange', onWake)
      ctx.effect(() => () => {
        disposed = true
        if (statusTimer !== null) clearTimeout(statusTimer)
        if (armTimer !== null) clearTimeout(armTimer)
        if (errorTimer !== null) clearTimeout(errorTimer)
        abortElevate()
        removeStyle()
        if (canListenWindow) window.removeEventListener('focus', onWake)
        if (canListenDocument) document.removeEventListener('visibilitychange', onWake)
      })
    }

    exports.apply = apply
    exports.inject = inject
    /** 测试缝：离线用例用它做真实 React SSR 渲染断言与注入夹具。 */
    exports.__shared = shared
    /**
     * 测试缝：提权链的行为用例必须能直接驱动这三个函数（"点过「取消」之后旧链不得复活"）。
     * 用假定时器也能测，但真实 3 s 轮询更贴近线上。
     */
    exports.__test = { trigger, confirmElevate, dismissPrompt }
    /** 测试缝：坞入口的注册形状与两处结构约束（不嵌套 `<button>`、弹层送出栈）。 */
    exports.__internals = { ENTRY_ID, ENTRY_LABEL, ENTRY_ORDER, SOURCE, ElevateDialog, LightOutRow, dockRowOf, insideNode, registerInto }
    return exports
  },
})
