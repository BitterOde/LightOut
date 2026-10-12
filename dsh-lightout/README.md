# dsh-lightout

**给 DSH 用的一键熄屏插件（Windows）**：点一下 → 面板**物理断电**（不是盖一层黑图），而 DSH 会话与后台任务
**照常继续跑**；人一碰键盘或鼠标 → 面板亮起、落在**锁屏登录界面**。

> **先读这一段**：本插件是**针对一台具体机器标定**的，不是通用工具，而且**大部分代码由 AI 生成**
> （作者提需求、真机验收、逐轮取舍）——**请预设有瑕疵**。
> 它按设备实例路径与显示拓扑的精确形状工作（见「[可移植性](#可移植性先说清楚)」）。
> 换机器能用吗？能，但需要先按你自己机器的实际形状核对两处常量。请把它当作
> **可移植的设计参考 + 可运行的实现**，而不是开箱即用的产品。
>
> **界面入口还有第二个前置**：那一行按钮挂在 **GUIFrame**（同样自研、**尚未公开**）的按钮面板里。
> 没有它，插件**照常挂载**、HTTP 路由与 `/status` 全部可用，只是**界面上没有可点的按钮**——
> 用 `curl` / 脚本照样能熄屏。详见「[依赖](#依赖)」。

---

## 它做什么

Windows 上"关屏"有两条常见路线，都有坑：

| 路线 | 问题 |
|---|---|
| 广播休眠/关屏消息（`SC_MONITORPOWER` 之类） | 在 Modern Standby（S0）机器上等于"进待机会话"：系统会挂起桌面应用，DSH 连同进程树一起停摆 |
| 只把内容画成黑色 | 面板并没有断电，只是看起来黑了、背光还在烧 |

本插件的做法是第三条：**把内置屏移出活动显示集**，让一块**虚拟显示器**接管输出。
面板因此真正断电，而系统仍认为"有屏"，桌面应用一律继续跑。

完整时序：

| 顺序 | 动作 | 由谁做 | 结果 |
|---|---|---|---|
| 0 | 确认虚拟显示器（VDD）设备**已启用** | 宿主 `lib/index.js` | 没启用就返回 `needsVdd`，界面弹说明并请你授权（**不会静默提权**） |
| 1 | 取 `PowerRequestDisplayRequired` + `PowerRequestSystemRequired` | 守卫 `scripts/lightout-hold.ps1` | 这段暗窗里不会发生空闲熄屏/睡眠 |
| 2 | 切拓扑：内置屏移出活动集，虚拟屏接管 | 守卫 → `scripts/lightout-topology.ps1` | 面板断电黑掉；会话**保持未锁定** |
| 3 | 落状态文件，驻留监听输入 | 守卫 | 宿主据此回答 `/status`；看门狗据此判断守卫是否还活着 |
| 4 | 键鼠一动 / 到 `maxDarkSeconds` / 宿主进程消失 | 守卫 | **先还原拓扑（每 2 s 重试，最多 60 s）**，成功后才 `LockWorkStation()` |
| 5 | 守卫若被杀（任务管理器 / 异常） | 宿主看门狗（默认每 5 s） | 发现"状态文件说还黑着、进程却没了"就立刻还原拓扑 |

### 三条铁律

这三条都是真机上撞出来的，别再"优化"回去：

1. **暗窗期间绝不能锁屏。** `SetDisplayConfig` 在锁屏状态下返回 `5`（拒绝访问）——锁着就永远还原不回来，
   只能盲打 PIN 救场。所以顺序只能是"**先还原、再锁屏**"，代价是暗窗期间会话处于未锁定状态。
2. **设备级状态才是权威。** 判虚拟屏可用性要看设备实例的 `ConfigFlags`（禁用＝1）/`Status`（禁用＝Error）。
   设备停用时拓扑枚举里**仍会残留一个 VDD 目标**，"有 VDD 目标"不能当判据；"虚拟屏在不在"也不行。
3. **守卫窗口必须隐藏，且必须有看门狗。** 可见窗口被误关就等于守卫消失；隐藏窗口让"误关"不可能发生，
   看门狗兜住"被杀"。

## 提权与虚拟显示器

虚拟显示器驱动（Virtual-Display-Driver / MttVDD）是**开机自启**的常驻设备。它在显卡/芯片组驱动大更新时
可能让机器更新完黑屏起不来，所以本插件的约定是：

- **平时设备是禁用的**（禁用位写在设备键里，**重启后仍然是禁用**，不需要常驻服务）；
- 需要熄屏时，界面弹说明并请你**授权一次**（UAC）→ 启用设备；这一步同时把"DSH 退出后自动禁用"的
  常驻守卫挂上，所以**整个会话只需授权一次**；
- 想手动回到默认态：`POST /api/dsh-lightout/vdd {"action":"disable"}`，或
  `scripts\vdd-device.ps1 -Action disable -Elevate`。

`scripts/vdd-device.ps1` 是本插件**唯一会提权**的脚本，它只做两件事：`pnputil /enable-device` 与
`/disable-device`（外加启用后把保存的布局 normalize 成"仅内置屏"）。提权后的窗口默认**隐藏**
（`-ShowWindow` 可改成可见，供人工排查）。

### 取消授权会怎样

- **点「否」＝ 什么都不会发生**：设备保持禁用，注册表 / 电源策略 / 分辨率全都没动，熄屏功能不可用，
  其余功能（体检、tooltip、keep-awake 探测）照常。
- 取消会被**立刻**读出来：`-Elevate` 把 UAC 结果写进提权结果文件（`launched/declined/error`），
  界面轮询到 `declined=true` 就停手并提示"已取消授权"，**不会让你白等**。
- `/status` 里一直能看到最近一次提权的结果：`elevation: {requested, launched, declined, at, error}`。

### 环境与版本检查（只读，不需要管理员）

插件**挂载时立刻预热一次**（后台起，不等它，宿主启动不被几个 PowerShell 拖住），结果落进 `/status` 用的
那份缓存 ⇒ 面板第一次打开就有环境与版本检查。之后每次 `/status` 走 15 s 缓存（并发请求单飞），
带 `?refresh=1` 强制重跑。

`scripts/vdd-device.ps1 -Action verify` 是**纯只读**的，取消授权之后照样能用：

| 看什么 | 从哪来 |
|---|---|
| VDD 设备在不在、启用/禁用、状态 | `Get-PnpDevice` + `ConfigFlags` |
| 虚拟显示器驱动版本 / INF / 日期 / 驱动包还在不在 DriverStore | `DEVPKEY_Device_DriverVersion` / `DriverInfPath` + `Test-Path %WINDIR%\INF\<inf>` |
| **真实**显卡驱动版本（虚拟显示器自身不算） | `Win32_VideoController`，排除虚拟显示器 |
| 拓扑是否正常（`activePaths/internalActive/vddActive`） | `lightout-topology.ps1 -Action check` |
| **与上次启用时的差异** | 基线文件，在启用成功那一刻写入 |

⇒ 于是"显卡驱动在那之后更新过"这件事会在**熄屏之前**就报出来（`gpuChanged=true`，`/status.warnings` 也会写）。
手动重记基线：`vdd-device.ps1 -Action verify -Record`。

```powershell
# 只读：设备 + 驱动版本 + 显卡驱动 + 拓扑 + 与基线的差异
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\vdd-device.ps1 -Action verify
```

## 它不做什么

- **暗窗期间会话不锁定**（硬约束，见铁律 1）。键鼠一动才先亮屏、再落锁屏界面。要"离开即锁"，
  目前没有可行写法——先锁就还原不回来。
- **不承担"防人"。** 熄屏**不是锁屏**：它只把面板断电，会话一直是解锁的、键鼠一直是活的，
  **第一下按键在守卫反应过来之前就已送达前台窗口**（守卫是 200 ms 轮询后的事后补救）。
  用户态的输入拦截手段没有一种能与"面板黑"共存。要安全请用 `Win+L`，或把重要任务移出交互桌面。
- **不保证电源键。** 物理电源键走电源策略里的「电源按钮操作」（`PBUTTONACTION`），与本插件无关。
  若该策略项**没有显式值**，随附默认值读作 `3 = 关机`，黑屏期间误按可能直接关机——见「加固」。
- **不碰系统电源策略**，也**不会静默提权**：唯一需要管理员的动作是启用/禁用那一个设备，
  且必须由界面上的一次点击发起。
- **不保证键盘/鼠标之外的唤醒源**（触摸板一般等同于鼠标）。
- **暗窗期间机器不会因为本插件而保持清醒**：那件事由保活插件负责（持 `ES_SYSTEM_REQUIRED`）。
  本插件按钮会探测它：**明确探到没持唤醒锁**时第一次点击不执行，按钮变成「仍要熄屏？」；
  探不到一律按**未知**处理，**不阻塞**熄屏，只在 tooltip 写明。

## 安装

### 前置：虚拟显示器驱动（一次性，需管理员）

```powershell
winget install VirtualDrivers.Virtual-Display-Driver
# 装完用包里的签名驱动 devcon 安装（非管理员会静默失败）
& "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\Dependencies\devcon.exe" `
  install "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\VirtualDrivers.Virtual-Display-Driver_Microsoft.Winget.Source_8wekyb3d8bbwe\SignedDrivers\x86\VDD\MttVDD.inf" "Root\MttVDD"
```

- 驱动配置文件 `C:\VirtualDisplayDriver\vdd_settings.xml` **必须零注释**：XML 注释里出现 `--`
  会让整个文件解析失败、虚拟屏根本不会创建（踩过，排查了两轮）。
- 装好后确认：`scripts\vdd-device.ps1 -Action status`（只读）应报
  `device : ROOT\DISPLAY\0000 status=OK`（实例路径按你的机器填，见「可移植性」）。
- 日常让它保持**禁用**（本插件的默认约定）：`scripts\vdd-device.ps1 -Action disable -Elevate`。

### 插件本体（不需要管理员）

```powershell
# 默认：用户层 cordis.patch.yml 插行（live 层）⇒ 宿主半可热挂载，不用重启
.\tools\install-lightout.ps1 -Install
# 只看它准备做什么（不写任何东西）：
.\tools\install-lightout.ps1 -Install -DryRun
```

安装器做三件事：建 junction（`<profile>\node_modules\dsh-lightout` → 本仓库的 `dsh-lightout\`）
→ 往**用户层** `<profile>\cordis.patch.yml` 追加一段 `- insert:` → 跑
`node <dsh>\lib\bin.js --profile web --dump-config` 组合校验；校验看不到那一行就**整段回滚**。

- 改文件是**字节安全**的：原编码（无 BOM 的 UTF-8）、原行尾（LF）都保留，只动被改的那一段；
  改前先备份成 `<文件名>.bak-<时间戳>-lightout`。
- 卸载：`install-lightout.ps1 -Uninstall`（先删补丁行 → 再删 junction）；`-Status` 看当前接线状态。

### 提权守护（计划任务，一次 UAC 安装）

```powershell
# 注册计划任务（登录时以最高权限启动守护，不弹 UAC）并立即起一次
.\tools\install-vdd-guard.ps1 -Install -Elevate
# 看任务状态 / 守护进程 / 守护状态文件
.\tools\install-vdd-guard.ps1 -Status
# 回退：停任务 + 注销任务 + 杀守护（设备本身不动，守护只会禁用它、从不启用）
.\tools\install-vdd-guard.ps1 -Uninstall -Elevate
```

守护维持的不变量：**没有 DSH 宿主进程 ⇒ managed 虚拟屏设备处于禁用**。它**绝不启用任何东西**
（启用永远是你点「授权并启用」的那一次 UAC）。三条纪律写在脚本里，也都是踩出来的：

- 判活用**命令行指纹**而不是裸 pid——pid 会被回收，裸 pid 会把"别人家的 node"读成"DSH 还活着"；
- 还要排掉 DSH 自己的 subprocess runner：**它也是一个 node.exe，命令行里带着被执行命令的整段载荷**，
  会把演练用的测试字符串误判成宿主；
- **找守护进程不能只看命令行**：提权进程的 `CommandLine` 普通权限读不到（WMI 返回 null），
  只按命令行匹配会把活着的守护报成"未运行"，停它也跟着失效。判据因此是两条腿：
  守护自己状态文件里的 `pid` + 命令行（读得到时作第二意见）。

**改了守护脚本之后怎么生效？** PowerShell 的 `-File` 是**进程启动时把脚本读进内存**的，所以改动
**不会**进到正在跑的那个守护里；`-Status` 会把这件事直接说出来（freshness 行）：

```powershell
.\tools\install-vdd-guard.ps1 -Status
#   guard freshness  script (…) is NEWER than the guard -- run -Restart to pick it up
.\tools\install-vdd-guard.ps1 -Restart -Elevate
```

三条通道别混，各自生效方式不同：

| 改了什么 | 怎么生效 |
|---|---|
| `scripts/lightout-vdd-guard.ps1`（守护本体） | `-Restart -Elevate`；重跑 `-Install -Elevate` 也行（它会**先停旧进程**，否则 `MultipleInstances=IgnoreNew` 会让旧脚本继续跑） |
| `scripts/vdd-device.ps1`（真正跑 pnputil 的那个） | **立即生效**：守护每一拍都是新起一个 PowerShell 去调它 |
| `lib/index.js`（宿主半） | 重启 `dsh web`（用户手动） |

### 什么时候需要重启 `dsh web`

| 接线路径 | 生效方式 | 需要重启吗 |
|---|---|---|
| **用户层** `cordis.patch.yml`（安装器默认） | web profile 的 `patchReload = "live"`，该文件被监视重载 | 正常**不用**；若几秒后 `/status` 仍是 404 ⇒ 需要手动重启作为兜底 |
| **bundle 层** `dsh.profile.bundles`（`-Install -Bundles`） | bundles 只在启动时读一次 | **必须重启 `dsh web`** |

两条路二选一（同一行 id 插两次会冲突，安装器直接拒绝）。**浏览器半改动永远需要刷新页面**（Ctrl+Shift+R）。

## 用法

**入口在 GUIFrame 的「按钮面板」里**：点侧栏 GUIFrame 那一行 → 浮出的面板里就有「熄屏」这一行。

- **点一下** → 熄屏（面板断电）。若虚拟屏未启用 → 弹出说明，点「授权并启用」→ 一次 UAC → 自动继续熄屏。
- **熄屏保持期间**（例如面板被别的程序点亮了）那一行变成「结束熄屏」：点它就杀掉守卫、立刻还原（＝逃生口）。
- 悬停看 tooltip：虚拟屏状态、熄屏保持是否进行中、防休眠、电源键当前动作、上次动作时间，
  以及宿主的 `warnings`。
- 界面判据只有一份：告警与"虚拟屏是否就绪"都由宿主 `/status` 算好（`warnings` / `vddReady`），
  客户端不自己重算一遍（两边各写一份必然漂移）。

**两条界面结构约束**（都来自坞的形态，改前端时别踩）：

1. 面板里那一行的壳**本身就是 `<button data-guif-dock-action>`**（GUIFrame 造的）⇒
   本插件的行内控件是**可点的 `<div>`**，不是 `<button>`（嵌套会被 React 判非法嵌套）；
   键盘激活由挂在行上的原生 click 监听补。
2. 提权说明弹层自带两颗键，所以它**不能留在行内**：经 `createPortal` 送到 `document.body`
   （`z-index:1000`，要盖住坞面板那一档）。拿不到 `react-dom` / 没有 DOM 时退回行内渲染，
   那一档的弹层控件改用 `div[role=button]`——结构上仍不嵌套 `<button>`。

**依赖关系**：GUIFrame 是**可选增强**，不是硬依赖——它没装/没激活时，本插件只是**不出现入口**，
页面照常启动，宿主路由与熄屏能力一字不变。写法上是 `ctx.inject(['gui-frame'], …)` 运行时注入：
**不写**声明式 `inject`（缺服务会让整个客户端模块悬置 ⇒ 整页启动失败）。

### HTTP 接口

只服务**回环连接**；改状态的请求还要求**同源**。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-lightout/status` | 体检：VDD 设备状态、版本检查、拓扑、熄屏保持、最近一次提权结果、keep-awake、电源键、看门狗、`envCheck`、`warnings[]`、最近一条事件 `last`（只读） |
| POST | `/api/dsh-lightout/off` | 熄屏；VDD 未就绪时返回 `needsVdd` + 提权文案（不执行）；守卫已在跑 ⇒ **409**；守卫起不来 ⇒ **500**（绝不报假成功） |
| POST | `/api/dsh-lightout/on` | 逃生口：杀掉守卫并还原拓扑（**只清自己杀掉的 pid 的回执**） |
| POST | `/api/dsh-lightout/vdd` | `{"action":"enable"}` / `{"action":"disable"}` → 发起一次提权请求（同动作在去重窗口内只发一次） |

自检（POST 必须带同源头，否则会被挡下，这是有意的）：

```powershell
curl.exe http://127.0.0.1:3080/api/dsh-lightout/status
# 演练：把 config: { dryRun: true } 加进 profile 那一行（用户层 live，改完即生效）
curl.exe -H "origin: http://127.0.0.1:3080" -X POST http://127.0.0.1:3080/api/dsh-lightout/off
# 逃生口（熄屏后想立刻亮回来）
curl.exe -H "origin: http://127.0.0.1:3080" -X POST http://127.0.0.1:3080/api/dsh-lightout/on
```

**演练开关 `dryRun` 只在 profile 行的 `config` 里生效**，请求体或查询串里传它**不会**改变行为。

## 配置项（profile 行的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `maxDarkSeconds` | `28800` | 暗窗绝对上限（秒）；到点守卫自己还原并锁屏 |
| `darkPollMs` | `200` | 守卫检测键鼠输入的轮询间隔 |
| `stateFile` | `""` | 守卫状态文件；空串＝`%TEMP%\lightout-hold.json` |
| `elevateLog` | `""` | 提权结果文件（`declined` 就是"用户点了否"）；空串＝`%TEMP%\lightout-vdd-elevate.json` |
| `vddBaseline` | `""` | 版本检查基线；空串＝`%TEMP%\lightout-vdd-baseline.json` |
| `eventLog` | `""` | 事件日志（JSONL，每次动作追加一行，只留最近若干条）；空串＝`%TEMP%\lightout-events.jsonl` |
| `guardLog` | `""` | 守卫/提权进程的 stdout+stderr 滚动日志；空串＝`%TEMP%\lightout-guard.log` |
| `vddWatchdogMs` | `5000` | 看门狗间隔；`0` ＝ 关闭 |
| `darkReceiptMs` | `8000` | 等守卫落状态文件的上限（决定 `/off` 多久返回回执） |
| `vddGate` | `true` | 熄屏前是否强制要求 VDD 已启用 |
| `restoreRetryMs` | `20000` | 看门狗还原失败后的退避（前 5 次） |
| `restoreRetrySlowMs` | `30000` | 连续失败超过 5 次之后的退避（降级） |
| `bodyMaxBytes` | `8192` | `/off` 的请求体上限（busy 位覆盖 body 读取，不能没有上限） |
| `vddDedupMs` | `60000` | `/vdd` 同动作去重窗口 |
| `vddInstance` | `ROOT\DISPLAY\0000` | 期望的 VDD managed 设备实例；与 verify 报回来的实例比对，不一致/多实例/选不出都进 `warnings`（空串＝不检查） |
| `statusCacheMs` / `helperTimeoutMs` / `probeKeepAwake` / `dryRun` | 见 `lib/index.js` 的 `DEFAULTS` | 通用 |
| `scripts.{machine,topology,hold,vdd}` | `""` | 脚本路径覆盖（**测试用桩**；空串＝包内 `scripts/`） |
| `psExe` | `""` | PowerShell 可执行文件覆盖（**测试用桩**：用来演练"spawn 失败"这条错误路径） |

## 逃生口与恢复

面板黑了但你想马上看到屏幕，按可靠程度排序：

1. **碰一下键盘/鼠标**（正常路径）：守卫立刻还原拓扑，然后锁屏 → 输入 PIN 即可。
2. `POST /api/dsh-lightout/on` 或 `scripts\lightout-hold.ps1 -Action restore`：不依赖守卫，直接还原。
3. `Win+P` → 方向键选「仅电脑屏幕」→ 回车；或重新插拔外接显示器触发重枚举。
4. 重启机器：显示拓扑的"保存布局"始终是**仅内置屏**，重启必然回到正常。
5. 若连登录界面都进不去：安全模式 → `scripts\lightout-topology.ps1 -Action normalize`。

## 加固（可选，自己动手，非插件行为）

若电源策略里「电源按钮操作」没有显式值，按电源键会走随附默认（读作 `3 = 关机`），
暗窗无人值守时误按是灾难。插件**不提供**这条路（写 HKLM 超出插件边界），请自行以管理员身份执行：

```powershell
powercfg /query SCHEME_CURRENT SUB_BUTTONS     # 先看当前值
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS 7648efa3-dd9c-4e3e-b566-50f929386280 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS 96996bc0-ad50-47ec-923b-6f41874dd9eb 0
powercfg /setactive SCHEME_CURRENT
```

注意：改成「不采取任何操作」后，电源键**也不会再唤醒屏幕**了（它什么都不做）。

## 目录

```
dsh-lightout/
  lib/index.js          宿主半：四条路由 + VDD 预检 + 看门狗（重入闸/退避/降级）+ 事件落盘（回环 + 同源守卫）
  lib/client.js         浏览器半：GUIFrame 按钮面板里的动作型入口 + 提权弹层 + 授权后自动继续熄屏
  scripts/lightout-topology.ps1
                        显示拓扑：check|normalize|dark|restore（内置屏/虚拟屏活动集切换）
  scripts/lightout-hold.ps1
                        熄屏守卫：持电源请求、切拓扑、先还原再锁屏、失败落回执
  scripts/vdd-device.ps1
                        虚拟显示器设备按需启停：status|verify|enable|disable
                        （verify 纯只读、不需要管理员；其余是唯一提权入口）
  scripts/vdd-device.messages.zh.txt
                        提权时给用户看的中文说明（界面与脚本共用同一份）
  scripts/lightout-vdd-guard.ps1
                        提权常驻守护：没有 DSH 宿主 ⇒ 虚拟屏禁用（只禁不启）
  scripts/lightout.ps1  只读的电源键/合盖策略报告，/status 的 machine 段用它
  cordis.patch.yml      bundle patch：把插件行插入 profile 花名册
  test/                 三套离线用例（见下）
```

单独跑执行器：

```powershell
.\scripts\vdd-device.ps1 -Action verify                      # 只读：设备 + 驱动/显卡版本 + 拓扑 + 与基线差异
.\scripts\vdd-device.ps1 -Action status                      # 只读：设备/虚拟屏/拓扑
.\scripts\vdd-device.ps1 -Action verify -Record              # 把当前版本记为基线（不启用设备）
.\scripts\lightout-topology.ps1 -Action check                # 只读：活动路径摘要
.\scripts\lightout-hold.ps1 -Action dark -MaxSeconds 600     # 真熄屏（会黑屏，10 分钟上限）
.\scripts\lightout-hold.ps1 -Action restore                  # 还原
.\scripts\lightout.ps1 -Action status                        # 只读：电源键/盖子/睡眠键策略
```

## 测试

```powershell
cd tools\testdeps; npm install        # 一次性：给客户端用例准备 react / react-dom
cd ..\..\dsh-lightout; npm test       # 三套用例全离线、只读
```

| 用例 | 覆盖 |
|---|---|
| `test/host.test.mjs` | 守卫 / 端口来源 / 真实只读端到端 / 桩驱动的链路 / 并发互斥 / spawn 失败 / 看门狗退避与唤醒 / 脚本契约 |
| `test/client.test.mjs` | 真实 React SSR 渲染断言 + 坞入口注册断言 + 行内不出现 `<button>` + 弹层两档落位 + 坞缺席时不注册 |
| `test/installer-fresh-profile.test.mjs` | 安装器回归门禁（补丁文件四形态 / compose 失败回滚 / 卸载字节还原 / 幂等 / 不动真实 profile） |

**真实黑屏必须由人工点一次确认**——程序侧拿不到"面板当前是否点亮"的可读状态，这一条无法自动化。

## 可移植性（先说清楚）

本插件的两处关键常量是按**一台具体机器**标定的，换机器要核对：

| 常量 | 位置 | 你要做的事 |
|---|---|---|
| 期望的 VDD 设备实例（默认 `ROOT\DISPLAY\0000`） | 配置项 `vddInstance`（空串＝不检查） | 用 `Get-PnpDevice` 找到你自己虚拟显示器的实例路径填进去 |
| "内置屏 ⇄ 虚拟屏"的活动路径集合 | `scripts/lightout-topology.ps1` 的枚举与匹配逻辑 | 先用 `-Action check` 看你机器的 `availablePaths` 形状，再按它调整匹配 |

`-Action check` 是纯只读的：先跑它，再动任何切换逻辑。

## 已知边界

- **会话在暗窗期间不锁定**（见铁律 1）——**因此它也不承担"防人"**：输入在守卫的一个轮询周期内
  就已送达前台窗口，而用户态的六种拦截手段（`LockWorkStation`／`BlockInput`／低级键鼠钩子／
  私有桌面／全屏置顶窗口／设备级禁用）**没有一种能与"面板黑"共存**。
- **宿主被硬杀 + 守卫同时被杀**这种双重故障下，没有东西会去还原拓扑（看门狗随宿主一起没了）。
  此时面板不亮但会话还活着，用「逃生口与恢复」第 2/3/4 条恢复；`maxDarkSeconds` 是时间兜底。
- **守卫进程是隐藏窗口后台进程**：这是机制的一部分。任务管理器里可见、可杀（杀了有看门狗兜）。
- **`detached: true` 不能用**：实测 PowerShell 子进程会直接不执行（`stdio:'ignore'` + detached 时
  4 秒后 `ESRCH`、脚本一行没跑）。所以宿主的 `spawnHidden()` 只隐藏窗口、不脱离控制台。
- **`powershell -File <不存在>` 会把版权横幅打到 stdout** 并退出非零：只看"有没有输出"会把它当成
  一次成功的探测。所以契约要求"必须解析出至少一个 `key=value`"，否则抛错（用例钉住了这条）。
- **PowerShell 变量名与参数名同名会静默变味**：脚本里有 `-Record` 开关时，局部变量 `$record`
  就是它本身（不区分大小写），把 `[ordered]@{}` 赋给它会被当成"往 bool 参数写字典"而抛错。
- **提权记录有 10 分钟的有效期**，且两侧都按**本地墙钟**解释——别拿 `toISOString()`（UTC）去比。
- **关屏广播路线的历史事实**（保留备查，别重试）：`SC_MONITORPOWER` 在 Modern Standby 机器上
  "能生效但等于进待机会话"；`SendMessageTimeout` 配 `HWND_BROADCAST` 不真广播（几十毫秒返回、
  面板纹丝不动）；状态值必须是正数 `2`（写成 `-2` 是非法值 ⇒ 静默忽略、毫秒级返回而"看似成功"）；
  DDC/CI 往往读不通。这条路线的执行器已整体删除，不存在"回退开关"。
- **插件的卸载不会丢下黑屏**：插件被卸载/热重载时，disposer 会**先还原拓扑、再结束守卫**，
  并把样式与在飞的提权流程一起收掉（顺序反过来的话，还原没跑完宿主就可能退出）。

## 设计与事故记录

下面这些不是花边，而是"为什么代码长这样"的依据。改任何一处之前先读对应那节。

> 想先看**问题—约束—方案—新问题**的整体论述（而不是逐条实现细节），读仓库根的
> [`VDD实现笔记本熄屏方案.md`](../VDD实现笔记本熄屏方案.md)（最短的一版）或
> [`熄屏方案技术报告.md`](../熄屏方案技术报告.md)（完整论证版）。两版技术事实一致。

### 事故：反复熄屏 + 风扇狂转

**现象**：用户点「授权并启用」后，面板反复黑/亮、机器风扇狂转。

**根因链：三处缺陷叠加，缺一不会这么糟**

1. **宿主 `/off` 的 busy 位得太晚**：旧代码在 `probeVdd()` **之后**才置 `busy`，而 `probeVdd`
   要起一个 PowerShell（数秒）。这段时间里并发到达的 `/off` 全部通过了 busy 检查 ⇒ 每个都起了一个守卫。
2. **浏览器提权轮询会堆积**：`setInterval(1500ms)` 不等上一次 `/status` 返回，而一次 `/status`
   要跑好几个 PowerShell（数秒）⇒ 同时有 N 个探测在飞；设备就绪那一刻，**每一个**在飞的
   回调都会各自调一次 `runOff()`。`stopElevatePolling()` 只停未来的 tick，停不掉在飞的。
3. **守卫的还原重试窗口取自暗窗上限**：一旦还原被拒（会话已锁时 `SetDisplayConfig` 返回 5），
   就是**每 ~2 秒起 2 个 PowerShell、持续 8 小时**，每个进程都要 `Add-Type` 重新编译 C# 助手
   ⇒ CPU 打满（风扇狂转）外加面板被反复重配置（反复黑）。

**修复（三重防线，缺一不可）**

- `lib/index.js`：`busy` 在进入 `/off` 的第一时间置位；spawn 之前先问"已有守卫在跑吗"，
  是则返回 **409** 并报出它的 pid，绝不叠第二个。
- `lib/client.js`：提权与状态轮询都改成**递归 `setTimeout`**（上一次有结论才排下一次）。
- `scripts/lightout-hold.ps1`：① 单实例锁（`FileShare.None` 文件句柄，进程死即释放，不留死锁）；
  ② 还原重试窗口独立成 `-RestoreSeconds`（默认 **60 秒**，不再取暗窗上限）；③ 会话已锁时不再空转；
  ④ 放弃还原时把 `restoreFailed` 落盘，宿主看门狗接手。

### 加固批次（全量审计 + 对抗验证后的必修项）

- **假成功回执**：`spawnHidden()` 挂 `'error'` 监听（没有监听时未捕获的 `'error'` 会打死宿主进程），
  并让 `spawnHidden()` 能表达失败——守卫起不来时 `/off` 返回 **500 + ok:false**，绝不落进
  "pending 就算成功"那条分支（旧写法会报 200 `ok:true`，而屏幕根本没黑）。
- **`/on` ↔ `/off` 互斥**：两者共用一个**意图序号**，`/off` 在 spawn 之前复核序号 ⇒
  期间收到 `/on`（用户点了「结束熄屏」）就作废这次熄屏。`/on` **只清自己杀掉的那个 pid 的回执**，
  别人的活守卫回执留着（否则看门狗失明、界面丢「结束熄屏」）。
- **看门狗**：**重入闸**（tick 不重叠；被挡下的 kick 会排队补跑）+ **退避与降级**（前 5 次 20 s，
  之后 30 s，不再永久空转）+ **用户回来立刻重试**（`/on`、`refresh=1`，以及浏览器回到前台时的
  `focus`/`visibilitychange`）+ 把「面板尚未还原（已重试 N 次）」写进 `/status.warnings`。
- **`/off` 遇到未完成的工作单**：上一次的还原还没收尾时，`/off` **接管**它
  （kick 看门狗、返回 `ok:false reason=panel-not-restored`），不再"删掉回执 + 再起一个 8 小时守卫"。
- **提权链**：每次「授权并启用」是一条**独立流程**（自增 epoch + 自己的 timer/deadline）——
  旧的模块级状态会被后一次流程重置成"未定"，让上一次在飞的探测复活，甚至替已经点过「取消」的
  用户自动熄屏。
- **弹层落位**：提权说明弹层与按钮**同级**（不再嵌在 `<button>` 里）。旧写法里点「取消」/「授权并启用」
  会冒泡触发外层按钮的 `onClick` ⇒ 取消不掉、且每次多打一次 `/off`。
- **收据 pid 身份**：回执过了 `deadline + 120 s` 就不再算"还黑着"（pid 复用不再能撑出假守卫状态）。
- **`/vdd` 去重**：同一动作在窗口内只发起一次，不再弹第二个 UAC、也不再冲掉上一次的授权结论。
- **诊断落盘**：事件写 JSONL（跨宿主重启仍在）；守卫/提权进程的 stdout+stderr 写滚动日志；
  `/off` 的「守卫启动后立刻退出」会按退出码分成「已有守卫持锁 / 切黑后崩溃 / 没有回执」
  三种并附上这个日志路径。

### 提权守护（跨重启那一半）

**问题定性**：`vdd-device.ps1 -Action enable` 起的那次提权进程兼作常驻守卫，监视 DSH 宿主 pid
——「一次 UAC 管启用＋禁用」本来就是这个设计。但它**与 DSH 同生共死**：系统关机/重启把宿主与守卫
一起杀掉，禁用那一半没跑，设备留在启用态；而设备一旦是启用态，`/off` 直接过预检
⇒ **此后每个 DSH 会话连该弹的那次 UAC 都不弹了**。

**解法**：新增提权常驻守护 + 计划任务（登录时以最高权限启动，不弹 UAC），维持
「没有 DSH 宿主 ⇒ 虚拟屏禁用」；宿主半接关闭拓展，在被动关闭那一趟（只有很短的时间预算）
**同步写一个禁用请求文件**——因为禁用设备要管理员权限，宿主只能发令，由守护执行。

### 一条被删除的功能（保留原因，别加回来）

曾经有一个「守护 24 小时到点自行禁用 VDD」的看门狗上限，已按用户裁定**删除**。原因：它会
**在 DSH 仍活着时**禁用虚拟屏——正在用的暗窗被打断；而设备一旦回到启用态被清掉，同一个 DSH
生命周期里再点熄屏还要**再弹一次 UAC**。它原本防的是"守卫按裸 pid 判活时的 pid 复用"，
这条防线改由**进程启动时间**承担：同一个 pid 若换成另一个进程（`StartTime` 不同）照样算
"被监视的会话已消失"，理由独立报 `pid-reused`。跨重启兜底仍由计划任务守护承担
（它按命令行指纹判活，不依赖 pid）。

### 没有 GUIFrame 时，怎么自己给一个入口

界面按钮不是必需的：**熄屏能力全在宿主半 + `scripts/` 里**，一条 `POST /api/dsh-lightout/off` 就能触发。
如果你想让它在界面上有个按钮，有两条路。

**路 1：照现成契约接自己的坞。** `lib/client.js` 只依赖一个形状很小的服务面——服务取到后必须暴露
`register(entry, Component)`，并**返回一个 disposer 函数**。注册的就是这些字段（都有用例钉着）：

```js
const off = gui.register(
  {
    id: 'dsh-lightout/off',   // 带命名空间前缀，避免与别的插件撞名
    kind: 'action',           // 动作型入口：只进按钮面板，不占任何官方座位
    source: 'dsh-lightout',
    order: 10,                // 面板里的排序位
    label: () => '熄屏',       // 传 thunk：坞每次读取时重新求值（状态会变，如「结束熄屏」）
    icon: PowerIcon,          // 传组件，不是图标名字符串
  },
  LightOutRow,                // 行内渲染的组件
)
// off() 归还入口。必须自己持有并调用：GUIFrame 的服务面不是 cordis 的 traceable Service，
// 不归还的话，本插件卸载/热重载后面板里会留下指向旧模块的僵尸入口。
```

把 `ctx.inject(['gui-frame'], cb)` 里的 `'gui-frame'` 与 `panelCtx.get('gui-frame')` 换成你的服务名即可；
行内组件那一层不用动。也可以直接从 `lib/client.js` 的 `registerInto()`（约 710 行起）改。

**路 2：不接坞，只留 HTTP。** 自己写个小脚本调 `POST /api/dsh-lightout/off`／`/on` 绑到快捷键或
启动项，能力与按钮完全一致。

> **一条红线（别踩）**：注册必须发生在 `ctx.inject(['gui-frame'], cb)` **的回调里**，
> 不能写成模块级的 `inject: ['gui-frame']`，也不能在 `apply` 期一次性 `ctx.get`。
> 前者在服务缺席时会让整个客户端模块 **fiber 悬置**，外壳的 `assertEntriesActive` 会直接抛错
> **打死整页**；后者读不到**晚到**的服务（坞先装、插件后装是常态）。
> 现行写法下服务始终不出现只是"不注册按钮"，页面照常。

## 依赖

| 依赖 | 必需？ | 缺失时 |
|---|---|---|
| **DSH**（`@deepseek-ai/dsh`） | 必需 | 插件的宿主 |
| **Windows 10/11 + PowerShell 5.1** | 必需 | `scripts/` 下全是 PowerShell 执行器 |
| **虚拟显示器驱动**（`VirtualDrivers.Virtual-Display-Driver`） | 熄屏功能必需 | 设备没装 ⇒ 熄屏不可用，其余体检功能照常 |
| **GUIFrame**（自研，**尚未公开**） | 可选增强 | 插件照常挂载、四条路由照常，**但界面入口不出现**（只能走 HTTP 触发） |
| **SafelyQuit**（自研，**尚未公开**） | 可选增强 | 「关机时自动恢复成禁用」不登记，其余照常 |

两个可选依赖都走 `ctx.inject([...])` 运行时注入，**缺席是正常一态**：不注册、不抛、页面与宿主照常启动
（有回归用例钉住这条：「服务缺席 → 不注册、不抛、页面照常」）。因此**在没有这两个插件的机器上，
本插件仍可正常工作，只是没有界面按钮**——用 `POST /api/dsh-lightout/off` 即可熄屏。

## 许可证

[MIT](../LICENSE)
