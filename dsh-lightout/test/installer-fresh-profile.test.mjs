/**
 * 安装器回归门禁（tools/install-lightout.ps1）。
 *
 * 覆盖 t3 隔离验证交回的缺陷与它带出的同类问题：
 *   F1  【blocker】出厂态 profile（`cordis.patch.yml` 末尾是裸 `[]`）上无条件追加
 *        `- insert:` ⇒ 同一 YAML 文档出现两个顶层节点 ⇒ 该 profile 下次启动起不来。
 *   F1b 【medium】compose 校验失败只打印 "dump-config exited with 1"，真正的原因
 *        （dump 输出尾部那段 YAMLException / bundle 解析失败）被吞掉。
 *   F5  【blocker，本次新增】卸载把 `[]` 那一行一起删掉 ⇒ 文件只剩注释 ⇒ 加载器报
 *        "overlay ... must be a top-level YAML array of loader patch entries"
 *        ⇒ 卸载过的出厂态 profile 同样起不来，且「卸载字节还原」不成立。
 *
 * 判据全部对着 dsh 加载器真正执行的那条规则写：**补丁文件必须解析成顶层 YAML 数组**。
 * 用法例覆盖四种输入形态：裸 `[]` 结尾 / 空文件 / 只有注释 / 已有人工条目；
 * 另加幂等、`-DryRun` 无副作用、compose 失败必须带回 dump 尾部且整体回滚。
 *
 * 硬边界：本用例只操作自己造的临时目录（os.tmpdir() 下的 sandbox）与临时 DSH_HOME，
 * 用例结束时会再断言一次**用户真实 profile 的补丁文件与 junction 指纹未变**。
 * 刻意不做的事：不触发真实熄屏/锁屏，不重启任何 dsh web。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const INSTALLER = path.join(REPO, 'tools', 'install-lightout.ps1')
const PLUGIN = 'dsh-lightout'
const ROW_ID = 'lightout'
const MARKER = `# --- ${PLUGIN} (managed by tools/install-lightout.ps1; -Uninstall removes it) ---`
/** 安装器追加的那一段，逐字抄自 Get-RowBlock（LF）。 */
const ROW_BLOCK = [MARKER, '- insert:', `    - id: ${ROW_ID}`, `      name: '${PLUGIN}'`].join('\n')
/** dsh 的出厂模板补丁文件（实测 217 字节：3 行注释 + 末尾裸 `[]` + 行尾换行）。 */
const FACTORY_PATCH = [
  '# Your patch layer for this dsh profile, applied after every bundle layer:',
  '# a top-level YAML array of loader patch entries (id-targeted config',
  '# overrides, disables, and insert lists; `!!js` expressions allowed).',
  '[]',
  '',
].join('\n')
/** 模拟「已有人工条目」的补丁文件（结尾不带换行，与用户真实 profile 同形）。 */
const EXISTING_PATCH = [
  '- id: auto-permission-mode',
  '  config: {}',
  '  disabled: true',
  '- insert:',
  '    - id: prompt-log',
  '      name: dsh-prompt-log',
].join('\n')

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lightout-installer-'))
process.on('exit', (code) => {
  if (code === 0) {
    try {
      fs.rmSync(SANDBOX, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响结论 */
    }
  } else {
    console.error(`\n失败现场保留在 ${SANDBOX}`)
  }
})

// ── 环境定位：dsh 入口与它自带的那份 YAML 解析器（加载器用的就是它）────────────
function findDshBin() {
  const candidates = [
    process.env.DSH_LIGHTOUT_DSH_BIN,
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : null,
  ].filter(Boolean)
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true })
  if (npmRoot.status === 0 && npmRoot.stdout) {
    const candidate = path.join(npmRoot.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

const DSH_BIN = findDshBin()

function loadYamlParser() {
  if (!DSH_BIN) return null
  const anchor = path.join(path.resolve(path.dirname(DSH_BIN), '..'), 'package.json')
  if (!fs.existsSync(anchor)) return null
  const req = createRequire(pathToFileURL(anchor))
  for (const name of ['js-yaml', 'yaml']) {
    try {
      return { name, mod: req(name) }
    } catch {
      /* 换下一个 */
    }
  }
  return null
}

const YAML = loadYamlParser()

// ── 小工具 ────────────────────────────────────────────────────────────────
function runInstaller(args, env = {}) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, ...args],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  )
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function installerArgs(dir, profileName, extra = []) {
  const args = [...extra, '-ProfileDir', dir, '-ProfileName', profileName]
  if (DSH_BIN) args.push('-DshBin', DSH_BIN)
  return args
}

/** 造一个临时 profile：只放安装器真正会碰的东西（node_modules + 清单 + 补丁文件）。 */
function makeProfile(name, patchText) {
  const dir = path.join(SANDBOX, name)
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: `dsh-profile-${name}`, private: true, dsh: { profile: { bundles: [] } } }, null, 2)}\n`,
  )
  if (patchText !== null) fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patchText)
  return dir
}

function patchPath(dir) {
  return path.join(dir, 'cordis.patch.yml')
}

/** 末尾第一个非空、非注释行（加载器眼里「有内容」的判据与安装器一致）。 */
function lastContentLine(text) {
  const lines = text.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line !== '' && !line.startsWith('#')) return line
  }
  return null
}

/** dsh 加载器的硬规则：补丁文件必须是顶层 YAML 数组。 */
function assertPatchArray(file, label) {
  const src = fs.readFileSync(file, 'utf8')
  if (YAML) {
    let value
    try {
      value = typeof YAML.mod.parse === 'function' ? YAML.mod.parse(src) : YAML.mod.load(src)
    } catch (err) {
      assert.fail(`${label}：补丁文件解析失败（${err.message}）`)
    }
    assert.ok(
      Array.isArray(value),
      `${label}：补丁文件必须解析成顶层数组，实际是 ${value === null || value === undefined ? String(value) : typeof value}`,
    )
    return
  }
  // 没有解析器时的退路：至少拦住「裸 [] 之后还有内容」这一类结构性错误
  const content = src
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('#'))
  const bare = content.indexOf('[]')
  assert.ok(bare === -1 || bare === content.length - 1, `${label}：裸 [] 之后不得再有内容`)
}

/** 反证用：判定一段文本**不是**合法补丁文件（结构性两个顶层节点，或解析不出数组）。 */
function assertNotPatchArray(text, label) {
  const content = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.startsWith('#'))
  const bare = content.indexOf('[]')
  const structural = bare !== -1 && bare !== content.length - 1

  let parseFailed = false
  let parsed
  if (YAML) {
    try {
      parsed = typeof YAML.mod.parse === 'function' ? YAML.mod.parse(text) : YAML.mod.load(text)
    } catch {
      parseFailed = true
    }
  }
  assert.ok(
    structural || parseFailed || (YAML && !Array.isArray(parsed)),
    `${label}：这段文本本应不是合法补丁文件`,
  )
}

const realPatch = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml')
const realLink = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', PLUGIN)
function realProfileFingerprint() {
  const patch = fs.existsSync(realPatch) ? fs.readFileSync(realPatch).toString('base64') : '<missing>'
  let link = '<missing>'
  if (fs.existsSync(realLink)) {
    try {
      link = fs.readlinkSync(realLink)
    } catch {
      link = '<exists>'
    }
  }
  return `${patch}|${link}`
}
const REAL_BEFORE = realProfileFingerprint()

// ── A0) 反证：旧行为（无条件追加）在出厂态文件上必然产出非法补丁文件 ───────────
{
  // 旧实现：$text.EndsWith(eol) 为真 ⇒ lead='' ⇒ 直接贴到末尾，裸 [] 留在原地
  const appended = FACTORY_PATCH + ROW_BLOCK + '\n'
  assertNotPatchArray(appended, 'F1 反证')
  console.log('  F1 反证            ok  （旧的无条件追加在裸 [] 之后产出的不是合法补丁数组）')
}

// ── A1) 出厂态：插入要替换裸 []，卸载要字节还原 ──────────────────────────────
{
  const dir = makeProfile('factory', FACTORY_PATCH)
  const file = patchPath(dir)
  const before = fs.readFileSync(file)

  const install = runInstaller(installerArgs(dir, 'factory', ['-SkipComposeCheck']))
  assert.equal(install.code, 0, `出厂态安装应成功，实际退出码 ${install.code}\n${install.out}`)
  assert.match(install.out, /patch file YAML self-check passed/)
  const installed = fs.readFileSync(file, 'utf8')
  assert.ok(installed.includes(`- id: ${ROW_ID}`), '插入后应出现插件行')
  assert.doesNotMatch(installed, /^\s*\[\]\s*$/m, '裸 [] 那一行应被替换掉，不能留在文件里')
  assertPatchArray(file, 'A1 安装后')

  const uninstall = runInstaller(installerArgs(dir, 'factory', ['-Uninstall']))
  assert.equal(uninstall.code, 0, `卸载应成功，实际退出码 ${uninstall.code}\n${uninstall.out}`)
  assert.match(uninstall.out, /patch file YAML self-check passed/)
  assert.ok(fs.readFileSync(file).equals(before), 'F5 回归：卸载后应与出厂态字节完全一致')
  assertPatchArray(file, 'A1 卸载后')
  console.log('  A1 出厂态 [] 结尾   ok  （替换而非追加；安装/卸载都过 YAML 自检；卸载字节还原）')
}

// ── A2) 空文件 / A3) 只有注释 ───────────────────────────────────────────────
{
  const emptyDir = makeProfile('empty', '')
  const emptyFile = patchPath(emptyDir)
  const installEmpty = runInstaller(installerArgs(emptyDir, 'empty', ['-SkipComposeCheck']))
  assert.equal(installEmpty.code, 0, `空补丁文件安装应成功\n${installEmpty.out}`)
  assertPatchArray(emptyFile, 'A2 安装后')
  assert.ok(fs.readFileSync(emptyFile, 'utf8').includes(`- id: ${ROW_ID}`), 'A2：插入后应含插件行')
  const uninstallEmpty = runInstaller(installerArgs(emptyDir, 'empty', ['-Uninstall']))
  assert.equal(uninstallEmpty.code, 0, `空补丁文件卸载应成功\n${uninstallEmpty.out}`)
  assertPatchArray(emptyFile, 'A2 卸载后')
  assert.equal(
    fs.readFileSync(emptyFile, 'utf8').trim(),
    '[]',
    'A2：空文件本身不是合法补丁层（解析成 undefined），卸载后应刻意规范成 []',
  )
  console.log('  A2 空文件           ok  （插入可用；卸载后规范成裸 [] 而不是留下不可启动的空文件）')
}
{
  const comments = '# 我的补丁层\n# 这里什么都不改\n'
  const dir = makeProfile('comments', comments)
  const file = patchPath(dir)
  const install = runInstaller(installerArgs(dir, 'comments', ['-SkipComposeCheck']))
  assert.equal(install.code, 0, `只有注释的补丁文件安装应成功\n${install.out}`)
  const installed = fs.readFileSync(file, 'utf8')
  assert.ok(installed.startsWith(comments), 'A3：原注释应原样保留在文件开头')
  assert.ok(installed.includes(`- id: ${ROW_ID}`), 'A3：插入后应含插件行')
  assertPatchArray(file, 'A3 安装后')

  const uninstall = runInstaller(installerArgs(dir, 'comments', ['-Uninstall']))
  assert.equal(uninstall.code, 0, `只有注释的补丁文件卸载应成功\n${uninstall.out}`)
  const restored = fs.readFileSync(file, 'utf8')
  assert.ok(restored.includes('# 我的补丁层'), 'A3：注释不应被删掉')
  assertPatchArray(file, 'A3 卸载后')
  console.log('  A3 只有注释         ok  （注释保留；卸载后仍必须是顶层数组）')
}

// ── A4) 已有人工条目：幂等、前缀不变、卸载还原 ──────────────────────────────
{
  const dir = makeProfile('existing', `${EXISTING_PATCH}\n`)
  const file = patchPath(dir)
  const original = fs.readFileSync(file, 'utf8')

  const install = runInstaller(installerArgs(dir, 'existing', ['-SkipComposeCheck']))
  assert.equal(install.code, 0, `已有人工条目时安装应成功\n${install.out}`)
  const installed = fs.readFileSync(file, 'utf8')
  assert.ok(installed.startsWith(original), 'A4：原有内容必须是新文件的前缀（只追加，不改写）')
  assert.ok(installed.includes(`- id: ${ROW_ID}`), 'A4：插入后应含插件行')
  assertPatchArray(file, 'A4 安装后')

  const again = runInstaller(installerArgs(dir, 'existing', ['-SkipComposeCheck']))
  assert.equal(again.code, 0, `重复安装应成功\n${again.out}`)
  assert.match(again.out, /already had the row/)
  assert.equal(fs.readFileSync(file, 'utf8'), installed, 'A4：重复安装必须幂等（文件不再变化）')

  const uninstall = runInstaller(installerArgs(dir, 'existing', ['-Uninstall']))
  assert.equal(uninstall.code, 0, `卸载应成功\n${uninstall.out}`)
  assert.ok(fs.readFileSync(file).equals(Buffer.from(original, 'utf8')), 'A4：卸载应字节还原')
  assertPatchArray(file, 'A4 卸载后')
  console.log('  A4 已有人工条目     ok  （只追加；重复安装幂等；卸载字节还原）')
}
{
  // 同形但结尾不带换行（用户真实 profile 就是这种形状）：允许只差一个行尾换行
  const dir = makeProfile('existing-noeol', EXISTING_PATCH)
  const file = patchPath(dir)
  const install = runInstaller(installerArgs(dir, 'existing-noeol', ['-SkipComposeCheck']))
  assert.equal(install.code, 0, `安装应成功\n${install.out}`)
  const uninstall = runInstaller(installerArgs(dir, 'existing-noeol', ['-Uninstall']))
  assert.equal(uninstall.code, 0, `卸载应成功\n${uninstall.out}`)
  const after = fs.readFileSync(file, 'utf8')
  assert.equal(after.trimEnd(), EXISTING_PATCH.trimEnd(), 'A4b：内容应还原（只允许行尾换行差异）')
  assertPatchArray(file, 'A4b 卸载后')
  console.log(
    `  A4b 结尾无换行      ok  （内容还原；字节${after === EXISTING_PATCH ? '完全一致' : `多一个行尾换行 ${Buffer.byteLength(after)}B vs ${Buffer.byteLength(EXISTING_PATCH)}B，语义等价`}）`,
  )
}

// ── A4c) 行块带 config:（README 教的调参写法）：卸载必须把 config 一起删掉 ──────
{
  const dir = makeProfile('withconfig', `${EXISTING_PATCH}\n`)
  const file = patchPath(dir)
  const original = fs.readFileSync(file, 'utf8')

  const install = runInstaller(installerArgs(dir, 'withconfig', ['-SkipComposeCheck']))
  assert.equal(install.code, 0, `安装应成功\n${install.out}`)

  // 模拟用户按 README 在行块下面写 config 调参
  fs.writeFileSync(
    file,
    `${fs.readFileSync(file, 'utf8')}      config:\n        lockWaitMs: 4000\n        offAttempts: 3\n`,
  )
  assertPatchArray(file, 'A4c 加 config 后')

  const uninstall = runInstaller(installerArgs(dir, 'withconfig', ['-Uninstall']))
  assert.equal(uninstall.code, 0, `带 config 的行块也必须能卸载\n${uninstall.out}`)
  const after = fs.readFileSync(file, 'utf8')
  assert.doesNotMatch(after, /lockWaitMs|offAttempts/, 'A4c：注入的 config 键必须一起删干净')
  assert.equal(after, original, 'A4c：带 config 的行块卸载后同样要字节还原')
  assertPatchArray(file, 'A4c 卸载后')
  console.log('  A4c 行块带 config    ok  （config 块一起删干净；卸载字节还原）')
}

// ── A5) compose 失败：必须带回 dump 尾部（F1b）且整体回滚 ───────────────────
{
  const dir = makeProfile('failcompose', FACTORY_PATCH)
  const file = patchPath(dir)
  const before = fs.readFileSync(file)
  // 替身 dsh：只负责「dump-config 失败并留下一句话」，路径形状保持 <root>\lib\bin.js
  const stub = path.join(SANDBOX, 'fake-dsh', 'lib', 'bin.js')
  fs.mkdirSync(path.dirname(stub), { recursive: true })
  fs.writeFileSync(
    stub,
    'console.error("SYNTHETIC COMPOSE FAILURE: cannot resolve profile bundle no-such-bundle"); process.exit(1)\n',
  )

  const run = runInstaller(['-ProfileDir', dir, '-ProfileName', 'failcompose', '-DshBin', stub])
  assert.equal(run.code, 1, 'compose 失败应让安装器以 1 退出')
  assert.match(run.out, /SYNTHETIC COMPOSE FAILURE/, 'F1b：必须带出 dump 输出的尾部，不能只说 exited with 1')
  assert.ok(fs.readFileSync(file).equals(before), '失败后补丁文件应字节还原')
  assert.ok(
    !fs.existsSync(path.join(dir, 'node_modules', PLUGIN)),
    '失败后 junction 应被删除（安装器自带的回滚）',
  )
  console.log('  A5 compose 失败     ok  （F1b 报出 dump 尾部；补丁文件与 junction 均回滚）')
}

// ── A6) -SkipComposeCheck 也不能留下坏文件；-DryRun 不写盘 ──────────────────
{
  const dir = makeProfile('skipcompose', FACTORY_PATCH)
  const file = patchPath(dir)
  const install = runInstaller(installerArgs(dir, 'skipcompose', ['-SkipComposeCheck']))
  assert.equal(install.code, 0, `-SkipComposeCheck 安装应成功\n${install.out}`)
  assert.match(install.out, /patch file YAML self-check passed/, '-SkipComposeCheck 时补丁文件自检仍必须跑')
  assertPatchArray(file, 'A6 安装后')

  const dryDir = makeProfile('dry', FACTORY_PATCH)
  const dryFile = patchPath(dryDir)
  const dryBefore = fs.readFileSync(dryFile)
  const dry = runInstaller(installerArgs(dryDir, 'dry', ['-Install', '-DryRun']))
  assert.equal(dry.code, 0, `-DryRun 应成功\n${dry.out}`)
  assert.ok(fs.readFileSync(dryFile).equals(dryBefore), '-DryRun 不得改动补丁文件')
  assert.ok(!fs.existsSync(path.join(dryDir, 'node_modules', PLUGIN)), '-DryRun 不得建 junction')
  console.log('  A6 跳过校验 / 演练  ok  （自检仍运行；-DryRun 零写入）')
}

// ── B) 真实出厂态 profile：组合校验 + 卸载往返后仍可启动（需要 dsh）─────────
if (!DSH_BIN) {
  console.log('  B  真实组合校验     skip（未找到 dsh 入口；可用 DSH_LIGHTOUT_DSH_BIN 指定）')
} else {
  const home = path.join(SANDBOX, 'home')
  fs.mkdirSync(home, { recursive: true })
  const dshEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }

  const created = spawnSync(
    'node',
    [DSH_BIN, '--profile', 'fresh', '--from-default-profile', 'web', '--dump-config'],
    { encoding: 'utf8', env: dshEnv },
  )
  assert.equal(created.status, 0, `构造出厂态 profile 失败：\n${created.stdout ?? ''}${created.stderr ?? ''}`)

  const dir = path.join(home, 'profiles', 'fresh')
  const file = patchPath(dir)
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
  const factoryBytes = fs.readFileSync(file)
  assert.equal(
    lastContentLine(factoryBytes.toString('utf8')),
    '[]',
    'B 前提：dsh 出厂模板的补丁文件确实以裸 [] 结尾（F1 的触发条件）',
  )

  const install = runInstaller(installerArgs(dir, 'fresh', []), { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })
  assert.equal(install.code, 0, `真实组合校验下安装应成功，实际退出码 ${install.code}\n${install.out}`)
  assert.match(install.out, /compose check passed/)

  const dumped = spawnSync('node', [DSH_BIN, '--profile', 'fresh', '--dump-config'], {
    encoding: 'utf8',
    env: dshEnv,
  })
  assert.equal(dumped.status, 0, '接线后组合树应能 dump')
  assert.match(dumped.stdout, /- id: lightout/)
  assert.match(dumped.stdout, /dsh-lightout/)

  const status = runInstaller(
    ['-Status', '-ProfileDir', dir, '-ProfileName', 'fresh', '-DshBin', DSH_BIN],
    { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  )
  assert.equal(status.code, 0, '-Status 应成功')
  assert.match(status.out, /CONTAINS the plugin row/)

  const uninstall = runInstaller(installerArgs(dir, 'fresh', ['-Uninstall']), {
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
  })
  assert.equal(uninstall.code, 0, `卸载应成功\n${uninstall.out}`)
  assert.ok(fs.readFileSync(file).equals(factoryBytes), 'B：卸载后应与出厂字节完全一致')

  const redumped = spawnSync('node', [DSH_BIN, '--profile', 'fresh', '--dump-config'], {
    encoding: 'utf8',
    env: dshEnv,
  })
  assert.equal(
    redumped.status,
    0,
    `F5 回归：卸载后该 profile 必须仍能启动\n${redumped.stdout ?? ''}${redumped.stderr ?? ''}`,
  )
  assert.doesNotMatch(redumped.stdout, /- id: lightout/, '卸载后组合树里不应再有插件行')
  console.log('  B  真实出厂态往返   ok  （组合树含行 → 卸载字节还原 → 仍能 --dump-config 启动）')
}

// ── 收尾：证明本用例没碰用户的真实 profile ──────────────────────────────────
{
  const after = realProfileFingerprint()
  assert.equal(after, REAL_BEFORE, '本用例不得改动用户真实 web profile 的补丁文件或 junction')
  console.log('  真实 profile 未动   ok  （补丁文件与 junction 指纹前后一致）')
}

console.log('installer-fresh-profile.test.mjs 全部通过')
process.exit(0)
