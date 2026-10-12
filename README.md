# LightOut

让一台 Windows 笔记本能**无人值守整夜跑 DSH**，并且能**一键把屏幕熄掉、人回来时落在锁屏界面**。

两件事都是在真机上反复撞出来的：这里的脚本不是示例，是**一台机器上跑通并留下回归门禁的实现**。
不少"为什么这么写"是踩坑换来的，代码注释里保留了原因——改任何一处之前先读注释。

> **关于 AI 生成**：本仓库的代码与文档**大部分由 AI（DeepSeek Harness 上的编码 agent）生成**。
> 作者负责提需求、真机验收、逐轮判读与取舍，以及指出问题（注释风格、冗余信息、隐私面这些都靠人工复核才发现）。
> 因此**请预设有瑕疵**：能跑、也留下了回归门禁，但仍有粗糙处；以你自己的判断为准。
> 本仓库公开代码**仅供交流学习**——它按一台具体机器标定，且界面入口依赖另一个同样自研、**尚未公开**的
> 插件（GUIFrame）。没有它，插件本身照常工作（HTTP 路由与 `/status` 都可用），但**界面上不会出现按钮**，
> 所以它现在是**可读、可跑的机制参考**，而不是能直接装给普通人用的成品。详见「[依赖](#依赖)」。

> **适用范围（先读）**：本文所有自动化都是 **Windows + PowerShell 5.1 + DSH** 的组合，
> 而且熄屏那一半按**具体机器的显示拓扑**标定。它不会在你的机器上开箱即用，
> 见「[可移植性](#可移植性)」。

---

## 它解决什么问题

| # | 问题 | 现象 | 本仓库的解法 |
|---|---|---|---|
| A1 | 机器半夜自己睡了 | 空闲/合盖触发睡眠，DSH 停摆到早上 | `tools/night-keep-awake.ps1` 写"整夜电源档"（永不空闲睡眠、可选合盖不动作） |
| A2 | 断网后不会自愈 | 校园网/热点掉线，没人重连，DSH 一直离线 | `tools/net-watchdog.ps1`：探测可达性 → 阶梯式修复（重连 → 复位网卡 → 复位 WLAN 栈） |
| A3 | DSH 进程崩了就真没了 | 凌晨挂了没人按回车，一直 down 到白天 | `tools/dsh-web-supervisor.ps1` + 计划任务：守住端口，进程退出就按退避重启 |
| A4 | 更新/重启打断夜里的事 | 计划任务默认"只在交流电时启动"，笔记本电池上静默跳过 | `tools/install-night-tasks.ps1` 显式写 `AllowStartIfOnBatteries` / `StartWhenAvailable` 等 |
| A5 | 断网那几十秒会**打断正在跑的轮次** | 默认重试预算约 15 秒（退避 0.5/1/2/4/8），而复位网卡/WLAN 栈要数十秒 ⇒ 轮次以 `TRANSPORT` 失败告终 | `tools/cordis.patch.retry-policy.snippet.yml`：把重试预算覆盖到约 15 分钟（**片段，未自动应用**，需你自己加进 profile 补丁层） |
| B | 想熄屏，但不想"锁上加黑" | 广播关屏在 Modern Standby 机器上等于**挂起桌面应用**（DSH 停摆）；画黑图又不断电 | `dsh-lightout/`：**把内置屏移出活动显示集**，由虚拟显示器接管 ⇒ 面板真正断电、系统仍认为有屏、应用照跑；键鼠一动先还原拓扑再锁屏 |

熄屏那条链路值得单独看：[`dsh-lightout/README.md`](dsh-lightout/README.md) 里有完整时序、
三条铁律、HTTP 接口、配置项，以及两次真实事故的根因链与修复。

## 目录

```
dsh-lightout/                     DSH 插件：一键熄屏（宿主半 + 浏览器半 + PowerShell 执行器 + 三套回归）
  lib/                            宿主半 / 浏览器半
  scripts/                        显示拓扑、熄屏守卫、虚拟显示器设备、提权守护
  test/                           三套离线用例（宿主 / 客户端 / 安装器门禁）
  cordis.patch.yml                把插件行插入 profile 花名册
  README.md                       插件自己的文档（机制、接口、配置、事故记录）

tools/                            这台机器上"夜间无人值守"的装置
  night-keep-awake.ps1            整夜电源档：永不空闲睡眠（-Apply / -Revert / -Status）
  net-watchdog.ps1                断网探测 + 阶梯修复（探测目标必须按你的网络标定）
  net-watchdog.config.example.psd1  给它用的配置样例（复制成 .config.psd1 后生效）
  dsh-web-supervisor.ps1          守住 127.0.0.1:3080，进程退出就重启
  install-night-tasks.ps1         把上面两个注册成计划任务（-Install / -Uninstall / -Status）
  install-lightout.ps1            把插件接进 DSH web profile（字节安全、可整段回滚）
  install-vdd-guard.ps1           注册提权常驻守护计划任务
  testdeps/                       仅测试用的 react / react-dom（不是插件依赖）

VDD实现笔记本熄屏方案.md           为什么这么做（**最短的一版**，作者手写：问题&需求 / 约束 /
                                  失败方案 / 解决方案-VDD / 原理 / 新问题）——先读这篇
熄屏方案技术报告.md                同一内容的学术版（完整论证：既有路线实测代价、派生问题的
                                  现象—根因—处置、局限）——要细节读这篇
                                  两版技术事实一致，只是叙述口径与详略不同
LICENSE                           MIT
```

## 快速开始

```powershell
# 0) 先看清楚每一步会做什么，这一步不写任何东西
.\tools\install-lightout.ps1 -Install -DryRun
.\tools\night-keep-awake.ps1 -Status
.\tools\net-watchdog.ps1 -Once -DryRun
.\tools\install-night-tasks.ps1 -Status

# 1) 插件本体（不需要管理员）
.\tools\install-lightout.ps1 -Install

# 2) 熄屏前置：虚拟显示器驱动（一次性，需管理员，见插件 README）
#    之后再注册提权守护（一次 UAC）
.\tools\install-vdd-guard.ps1 -Install -Elevate

# 3) 夜间无人值守（一次 UAC：计划任务要以最高权限跑）
.\tools\install-night-tasks.ps1 -Install -Elevate

# 4) 回归（全离线、只读；不会碰真设备、不黑你的屏）
cd tools\testdeps; npm install; cd ..\..
cd dsh-lightout; npm test
```

**每一步都可回退**，且回退只动它自己加的东西：

```powershell
.\tools\install-night-tasks.ps1 -Uninstall -Elevate   # 只删那两个计划任务，并把原来的启动快捷方式恢复回来
.\tools\install-vdd-guard.ps1   -Uninstall -Elevate   # 只删守护任务；设备本身不动
.\tools\install-lightout.ps1    -Uninstall            # 先删补丁行、再删 junction，卸载后与安装前字节一致
.\tools\night-keep-awake.ps1    -Revert               # 把电源档还原成 -Apply 之前的基线
```

## 安全与边界（务必读）

这些装置**会改动系统状态**，每一项都写在对应脚本的头部注释里，这里集中列一遍：

| 动作 | 改了什么 | 什么时候发生 |
|---|---|---|
| `night-keep-awake.ps1 -Apply` | 当前电源方案的**交流电**档：`STANDBYIDLE=0`、`UNATTENDSLEEP=0`；`-LidNothing` 才会额外动 `LIDACTION`；`-IncludeBattery` 才会动直流电档 | 只有你显式运行 `-Apply` 时 |
| `install-night-tasks.ps1` | 注册两个计划任务（当前用户；watchdog 以最高权限运行）；`-TakeOverAutostart` 才会重命名你的启动快捷方式 | 只有你显式 `-Install` 时 |
| `net-watchdog.ps1` | 掉线时重连 Wi-Fi、复位网卡；`-AllowWlanSvcRestart` 才会重启 WLAN 服务 | 探测连续失败达到阈值时 |
| `install-vdd-guard.ps1` | 注册一个登录时以最高权限启动的计划任务（**不弹 UAC**），它只会在"没有 DSH 宿主"时**禁用**虚拟显示器 | 只有你显式 `-Install` 时 |
| `install-lightout.ps1` | 在 `%USERPROFILE%\.dsh\profiles\web\` 下建一个 junction、往 `cordis.patch.yml` 追加一段（改前备份、可整段回滚） | 只有你显式 `-Install` 时 |
| `vdd-device.ps1 enable/disable` | 启用/禁用虚拟显示器设备（唯一需要管理员的动作，且必须从界面点一次发起） | 你点「授权并启用」时 |

**没有一件事在后台偷偷做**：所有常驻动作都以计划任务形式注册，`-Status` 随时可查，`-Uninstall` 可撤。

本仓库**不写入**：注册表策略、系统电源策略（`powercfg` 只读）、分辨率/缩放、任何网络下载或安装。

## 可移植性

| 部分 | 可移植性 |
|---|---|
| `dsh-lightout/lib/`、`test/` | 逻辑与 DSH 绑定，不绑机器；用例全离线可跑 |
| `dsh-lightout/scripts/lightout-topology.ps1` | **绑机器**：按显示拓扑的精确形状切换活动路径，换机器要按 `-Action check` 的输出调整 |
| `dsh-lightout` 的 `vddInstance` 默认值 | **绑机器**：默认 `ROOT\DISPLAY\0000`，需换成你自己虚拟显示器的实例路径（或置空＝不检查） |
| `tools/net-watchdog.ps1` | 探测目标**必须重标定**：不同网络能答通的地址完全不同（校园网可能屏蔽公共 DNS）。用 `-Once -DryRun` 先看结果 |
| `tools/night-keep-awake.ps1` | 通用（写的是 Windows 电源策略项） |
| `tools/dsh-web-supervisor.ps1` | 通用（按端口判活、按 `npm root -g` 找 dsh 入口） |
| `tools/install-*.ps1` | 通用（路径均可参数化；默认值来自环境变量而非硬编码盘符） |

## 依赖

### 必需的

- **Windows 10/11**（用 PowerShell 5.1 的 `-File` 语义；`.ps1` 一律纯 ASCII，避免 5.1 把无 BOM 的
  文件按 ANSI 解析而乱码）
- **Node.js**（跑回归用例与 DSH 本体）
- **DSH**（`@deepseek-ai/dsh`）
- **虚拟显示器驱动**：`VirtualDrivers.Virtual-Display-Driver`（仅熄屏功能需要，见插件 README）

### 两个自研插件：你的机器上还没有，且它们**尚未公开**

熄屏插件的**界面入口**与**关机联动**依赖两个同样在这台机器上开发、但**还没有公开**的插件。
缺了它们插件不会崩——只是能力少两块：

| 依赖 | 它提供什么 | 缺失时的实际后果 |
|---|---|---|
| **GUIFrame** | 侧栏那个浮出的「按钮面板」容器 | 插件照常挂载、四条 HTTP 路由与 `/status` 全部照常，**但界面入口不出现** —— 没有可点的按钮，只能用 `curl` 或脚本触发熄屏 |
| **SafelyQuit** | DSH 主动关闭时的关机拓展点 | 「关机时顺手把虚拟屏恢复成禁用」那一步不登记；其余功能一字不变 |

两者都是**运行时注入**（`ctx.inject([...])`），因此缺席是**正常一态**，不会让页面或宿主启动失败。
这条降级行为有回归用例钉着（「服务缺席 → 不注册、不抛、页面照常」）。

> **因此：本仓库当前的可运行性只对作者这台机器成立。**
> 公开它的是**实现本身**——熄屏机制的完整时序、三条铁律、看门狗与提权链的设计、
> 以及两次真实事故的根因链。想在自己的机器上跑通，需要先满足「可移植性」那两处常量，
> 再自己提供一个入口（`POST /api/dsh-lightout/off` 就够了，界面不是必需的）。

### 仅测试用

- `react` / `react-dom`（`tools/testdeps`，**不随插件加载**，只给客户端用例做 SSR 断言）

## 许可证

[MIT](LICENSE)。这些脚本会在你的机器上改动系统设置——请先读「安全与边界」，并**自担风险**。
