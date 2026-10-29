/**
 * dsh-breather 浏览器半的自测：不开浏览器，用假的 window/document/React 把
 * ModuleLoader 注册、插槽注册、按钮三态和点击动作跑一遍。
 * 运行：node test-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./client.js', import.meta.url), 'utf8')
const packageVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// ---- 假浏览器 ---------------------------------------------------------------
const headChildren = []
/** 计时器元素登记表：模拟 [data-chat-running]。 */
const runningElements = []
const htmlAttrs = new Map()
const observers = []

globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.active = true; observers.push(this) }
  observe() {}
  disconnect() { this.active = false }
}

function fakeTextNodes(root) {
  const out = []
  const visit = (node) => {
    if (node.kind === 'text') { out.push(node); return }
    for (const child of node.children) visit(child)
  }
  visit(root)
  return out
}

function fakeElements(root) {
  const out = []
  const visit = (node) => {
    if (node.kind !== 'element') return
    out.push(node)
    for (const child of node.children) visit(child)
  }
  visit(root)
  return out
}

/**
 * 假元素：带属性存储、closest、querySelectorAll（只支持测试用到的那几个选择器）。
 */
function fakeElement(attributes, children) {
  const store = new Map(Object.entries(attributes ?? {}))
  const element = {
    kind: 'element',
    children,
    parentElement: null,
    getAttribute: (name) => (store.has(name) ? store.get(name) : null),
    setAttribute: (name, value) => { store.set(name, String(value)) },
    removeAttribute: (name) => { store.delete(name) },
    querySelectorAll: (selector) => {
      if (selector === '[data-shimmer-text]') {
        return fakeElements(element).filter((node) => node !== element && node.getAttribute('data-shimmer-text') !== null)
      }
      return []
    },
    closest: (selector) => {
      // 支持 `[attr]` 和 `[attr="value"]` 两种写法（role="status" / data-chat-node-key）
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(String(selector))
      if (match === null) return null
      const name = match[1]
      const expected = match[2]
      let node = element
      while (node !== null && node !== undefined) {
        if (node.kind === 'element' && typeof node.getAttribute === 'function') {
          const value = node.getAttribute(name)
          if (value !== null && (expected === undefined || value === expected)) return node
        }
        node = node.parentElement
      }
      return null
    },
  }
  for (const child of children) child.parentElement = element
  return element
}

/** 侧栏会话行的假 DOM：[data-row-key="session:<id>"]。 */
const sessionRows = []
function fakeSessionRow(sessionId) {
  const attrs = new Map([['data-row-key', `session:${sessionId}`]])
  return {
    getAttribute: (name) => attrs.get(name) ?? null,
    setAttribute: (name, value) => { attrs.set(name, String(value)) },
    removeAttribute: (name) => { attrs.delete(name) },
  }
}

globalThis.document = {
  visibilityState: 'visible',
  querySelector: () => null,
  querySelectorAll: (selector) => {
    if (selector === '[data-chat-running]') return runningElements.slice()
    if (selector === '[data-row-key^="session:"]') return sessionRows.slice()
    if (selector === '[role="treeitem"][data-row-key]') return sessionRows.slice()
    if (selector === '[role="treeitem"]') return sessionRows.slice()
    if (selector === '[data-dsh-timer-paused]') {
      return runningElements.filter((element) => element.getAttribute('data-dsh-timer-paused') !== null)
    }
    if (selector === '[data-dsh-paused-session]') {
      return sessionRows.filter((row) => row.getAttribute('data-dsh-paused-session') !== null)
    }
    return []
  },
  createTreeWalker: (root) => {
    const list = fakeTextNodes(root)
    let index = 0
    return { nextNode: () => (index < list.length ? list[index++] : null) }
  },
  createElement: () => ({ dataset: {}, textContent: '', setAttribute() {} }),
  head: { appendChild: (node) => headChildren.push(node) },
  documentElement: {
    // 核心把界面语言写在 <html lang> 上；插件据此选文案。
    lang: 'zh-CN',
    setAttribute: (name, value) => htmlAttrs.set(name, value),
    removeAttribute: (name) => htmlAttrs.delete(name),
    getAttribute: (name) => htmlAttrs.get(name) ?? null,
  },
}

let registered
globalThis.window = {
  __ModuleLoader__: {
    load: (definition) => { registered = definition },
  },
}

// ---- 假 React ---------------------------------------------------------------
const effectQueue = []
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: (fn) => { effectQueue.push(fn) },
  useSyncExternalStore: (subscribe, getSnapshot) => {
    subscribe(() => {})
    return getSnapshot()
  },
}

/**
 * 模拟 React 提交后的 effect 冲刷：把这一轮排队的 effect 都跑一遍。
 * （不跑 cleanup——测试里没有卸载场景，而 cleanup 只用于卸载收尾。）
 */
function flushEffects() {
  for (const fn of effectQueue.splice(0)) fn()
}

/** 模拟 React 重新渲染计时器文案后触发的 MutationObserver 回调。 */
function fireMutations() {
  for (const observer of observers) if (observer.active) observer.callback()
}

// ---- 假 fetch ---------------------------------------------------------------
let hostState = { running: [], paused: [] }
/** ok / missing(404) / fail(网络层抛错) / refuse(宿主明确回绝) */
let hostMode = 'ok'
const posts = []
globalThis.fetch = async (url, init = {}) => {
  if ((init.method ?? 'GET') === 'POST') {
    const body = JSON.parse(init.body)
    posts.push(body)
    if (hostMode === 'fail') throw new Error('network down')
    if (hostMode === 'missing') return { ok: false, status: 404, json: async () => ({}) }
    if (hostMode === 'refuse') return { ok: true, status: 200, json: async () => ({ ok: false, code: 'session/idle', state: hostState }) }
    if (body.action === 'pause') {
      hostState = { ...hostState, paused: [{ sessionId: body.sessionId, engaged: false, since: 1, turn: 1, step: 1 }] }
    }
    if (body.action === 'resume') hostState = { ...hostState, paused: [] }
    return { ok: true, status: 200, json: async () => ({ ok: true, state: hostState }) }
  }
  if (hostMode === 'fail') throw new Error('network down')
  if (hostMode === 'missing') return { ok: false, status: 404, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => hostState }
}

// ---- 装配 -------------------------------------------------------------------
eval(source) // 注册 window.__ModuleLoader__

assert.ok(registered, 'client.js 应当通过 __ModuleLoader__.load 注册')
assert.equal(registered.id, 'dsh-breather')

const exports = registered.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})

assert.equal(exports.name, 'dsh-breather')
assert.deepEqual(exports.inject, ['slots'])
// 端点必须和宿主半写死的那条一致：宿主那边已经没有 path 配置项了，两边漂移过一次。
assert.equal(exports.__test.endpoint, '/api/session-pause')

const registrations = []
const injectedKeys = []
const ctx = {
  slots: {
    inject: (key, callback) => {
      injectedKeys.push(key)
      callback()
    },
    register: (options, Component) => {
      registrations.push({ options, Component })
      return () => {}
    },
  },
  effect: () => () => {},
}

exports.apply(ctx)
assert.deepEqual(injectedKeys, ['conversation.input.right', 'sidebar.session.row.leading', 'sidebar.session.row.hover'])
assert.equal(registrations.length, 3)

const inputRegistration = registrations.find((entry) => entry.options.name === 'conversation.input.right')
assert.ok(inputRegistration, '应当注册输入框右侧的暂停按钮')
const { options, Component } = inputRegistration
assert.equal(options.id, 'breather')
assert.equal(typeof options.inject, 'function')

// 上游插槽两处：行首图标 + 行悬停卡状态字
const leadingRegistration = registrations.find((entry) => entry.options.name === 'sidebar.session.row.leading')
const hoverRegistration = registrations.find((entry) => entry.options.name === 'sidebar.session.row.hover')
assert.ok(leadingRegistration, '应当注册 sidebar.session.row.leading（核心补丁之后由它渲染图标）')
assert.ok(hoverRegistration, '应当注册 sidebar.session.row.hover（原版核心就有的插槽）')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 场景 1：会话没在运行 → 不渲染 ------------------------------------------
hostState = { running: [], paused: [] }
await wait(60)
assert.equal(Component({ pauseSessionId: 's1' }), null)
assert.equal(Component({}), null, '没有 sessionId 时也不渲染')

// ---- 场景 2：运行中 → 「暂停」 -----------------------------------------------
hostState = { running: ['s1'], paused: [] }
await wait(60)
let node = Component({ pauseSessionId: 's1' })
assert.equal(node.type, 'button')
assert.equal(node.children[1].children[0], '暂停')
assert.equal(node.props['data-paused'], 'false')

// ---- 场景 3：点了暂停 → 请求已发出、还没停住 → 「暂停中…」 -------------------
await node.props.onClick()
await wait(40)
assert.deepEqual(posts[0], { action: 'pause', sessionId: 's1' })
node = Component({ pauseSessionId: 's1' })
assert.equal(node.children[1].children[0], '暂停中…')
assert.equal(node.props['data-pending'], 'true')

// ---- 场景 4：闸门挂住 → 「继续」，再点发出 resume -----------------------------
hostState = { running: ['s1'], paused: [{ sessionId: 's1', engaged: true, since: 1, turn: 1, step: 1 }] }
await wait(1000) // 等一轮轮询把「已挂住」刷进快照
node = Component({ pauseSessionId: 's1' })
assert.equal(node.children[1].children[0], '继续')
assert.equal(node.props['data-paused'], 'true')

await node.props.onClick()
await wait(40)
assert.deepEqual(posts[1], { action: 'resume', sessionId: 's1' })
node = Component({ pauseSessionId: 's1' })
assert.equal(node.children[1].children[0], '暂停', '继续之后会话仍在跑 → 回到「暂停」')

assert.ok(headChildren.length >= 1, '应当注入样式')
assert.match(headChildren[0].textContent, /\.dshp-btn/)
assert.match(headChildren[0].textContent, /\[data-dsh-timer-paused\] \*\{animation-play-state:paused/, '样式里要有暂停时停动画的规则')

// ---- 场景 5：运行计时器（暂停冻结 + 继续后扣掉暂停时间） ----------------------
const { parseDuration, formatDuration, startTimerPause, startTimerOffset, stopTimerOverride, isTimerActive } = exports.__test

function fakeText(value) {
  return { kind: 'text', nodeValue: value, parentElement: null }
}

/**
 * 复刻 chat 插件里 RunningStatus + TextShimmer 的真实结构：
 *
 *   [data-chat-running]
 *     ├ span[role=status]              "深度求索中"（给读屏的隐藏说明）
 *     ├ span                           divider（无文字）
 *     └ span
 *        └ span[data-shimmer]          基础层
 *           ├ span.content > span.text  ← 文本节点
 *           └ span.decoration          扫光高亮层
 *              └ span.sweep > span.content.highlight > span.text[data-shimmer-text]
 *
 * 关键：高亮层**没有文本节点**，文字来自 `data-shimmer-text` 属性 + CSS
 * `._text:after{content:attr(data-shimmer-text)}`。只改文本节点会留下旧数字叠在上面。
 */
function buildTimer(text) {
  const status = fakeElement({ role: 'status' }, [fakeText('深度求索中')])
  const base = fakeText(text)
  const baseSpan = fakeElement({}, [base])
  const highlight = fakeElement({ 'data-shimmer-text': text }, [])
  const decoration = fakeElement({ 'aria-hidden': 'true' }, [fakeElement({}, [highlight])])
  const shimmer = fakeElement({ 'data-shimmer': '' }, [baseSpan, decoration])
  const root = fakeElement({ 'data-chat-running': '' }, [status, fakeElement({}, []), fakeElement({}, [shimmer])])
  return { root, label: base, highlight }
}

// 解析 / 格式化与核心的 formatRunDuration 对齐
const zhParsed = parseDuration('深度求索中，用时 1分23秒 …')
assert.equal(zhParsed.ms, 83000)
assert.equal(zhParsed.prefix, '深度求索中，用时 ')
assert.equal(zhParsed.suffix, ' …')
assert.equal(formatDuration(83000, zhParsed.units), '1分23秒')
assert.equal(formatDuration(3723000, zhParsed.units), '1小时2分3秒')
assert.equal(formatDuration(45000, zhParsed.units), '45秒')

const enParsed = parseDuration('Deep diving for 2m 5s …')
assert.equal(enParsed.ms, 125000)
assert.equal(enParsed.prefix, 'Deep diving for ')
assert.equal(enParsed.suffix, ' …')
assert.equal(formatDuration(125000, enParsed.units), '2m 5s')
assert.equal(parseDuration('深度求索中'), undefined, '没有时长时应当解析失败')

/** 文本节点与扫光属性必须完全一致，否则界面上会叠出两个数字。 */
function expectTimer(target, text, note) {
  assert.equal(target.label.nodeValue, text, note)
  assert.equal(target.highlight.getAttribute('data-shimmer-text'), text, `${note ?? ''}（扫光层属性也要一致）`)
}

/** 模拟 React 每秒重渲染：文本节点和扫光属性都写墙钟值，然后触发观察器。 */
function reactWrites(target, text) {
  target.label.nodeValue = text
  target.highlight.setAttribute('data-shimmer-text', text)
  fireMutations()
}

// 暂停：冻在 1分23秒
const timer = buildTimer('深度求索中，用时 1分23秒 …')
runningElements.push(timer.root)
startTimerPause()
assert.equal(isTimerActive(), true)
expectTimer(timer, '已暂停 · 1分23秒')
assert.equal(timer.root.getAttribute('data-dsh-timer-paused'), '1', '暂停时只标这一个计时器，别把别人的动画也停了')

// React 继续每秒刷新 → 观察器把两层都改回去
reactWrites(timer, '深度求索中，用时 1分24秒 …')
expectTimer(timer, '已暂停 · 1分23秒', '被 React 刷新后应当立刻改回冻结值')

// 元素被 React 重建：reattach 抓新的、基准保持不变
const rebuilt = buildTimer('深度求索中，用时 9分31秒 …')
runningElements.length = 0
runningElements.push(rebuilt.root)
await wait(800) // 等 reattach 定时器
expectTimer(rebuilt, '已暂停 · 1分23秒', '重建后应沿用原来的基准')

// 继续：核心会写「墙钟」11分23秒（中间停了 10 分钟），要改回 1分23秒
startTimerOffset()
reactWrites(rebuilt, '深度求索中，用时 11分23秒 …')
expectTimer(rebuilt, '深度求索中，用时 1分23秒 …', '暂停的 10 分钟不该计入')
assert.equal(rebuilt.root.getAttribute('data-dsh-timer-paused'), null, '继续后撤掉标记（扫光动画恢复）')

// 继续后再走 ~1.2 秒 → 1分24秒（核心那边已经是 11分24秒）
await wait(1200)
reactWrites(rebuilt, '深度求索中，用时 11分24秒 …')
expectTimer(rebuilt, '深度求索中，用时 1分24秒 …')

// 再暂停一次：基准应当是 1分24秒
startTimerPause()
expectTimer(rebuilt, '已暂停 · 1分24秒')

// 回合结束：交还给核心
stopTimerOverride()
assert.equal(isTimerActive(), false)
assert.equal(rebuilt.root.getAttribute('data-dsh-timer-paused'), null, '交还后不该留着标记')
reactWrites(rebuilt, '深度求索中，用时 12分00秒 …')
expectTimer(rebuilt, '深度求索中，用时 12分00秒 …', '解除后不再干预')

// ---- 场景 6：组件按 running / paused 自动接管与交还 ------------------------------
hostState = { running: ['s1'], paused: [{ sessionId: 's1', engaged: true, since: 1, turn: 1, step: 1 }] }
await wait(1000)
runningElements.length = 0
const wired = buildTimer('深度求索中，用时 5秒 …')
runningElements.push(wired.root)
const pausedNode = Component({ pauseSessionId: 's1' })
assert.equal(pausedNode.children[1].children[0], '继续')
flushEffects()
assert.equal(isTimerActive(), true, '渲染到 engaged 状态时应当自动接管')
assert.equal(wired.label.nodeValue, '已暂停 · 5秒')

// 继续（会话仍在跑）→ 继续接管，但文案回到「深度求索中…」
hostState = { running: ['s1'], paused: [] }
await wait(1000)
Component({ pauseSessionId: 's1' })
flushEffects()
assert.equal(isTimerActive(), true, '继续后仍要接管，才能扣掉暂停时间')
assert.match(wired.label.nodeValue, /^深度求索中，用时 /)

// 回合结束 → 交还给核心
hostState = { running: [], paused: [] }
await wait(1000)
Component({ pauseSessionId: 's1' })
flushEffects()
assert.equal(isTimerActive(), false, '回合结束后不该继续接管')

stopTimerOverride()

// ---- 场景 7：侧栏会话行的暂停图标标记 ----------------------------------------
hostState = { running: ['s1', 's2'], paused: [{ sessionId: 's1', engaged: true, since: 1, turn: 1, step: 1 }] }
sessionRows.length = 0
const rowS1 = fakeSessionRow('s1')
const rowS2 = fakeSessionRow('s2')
sessionRows.push(rowS1, rowS2)
await wait(1000) // 等轮询刷新快照再标记
assert.equal(rowS1.getAttribute('data-dsh-paused-session'), '1', '已挂住的会话行应当打标记')
assert.equal(rowS2.getAttribute('data-dsh-paused-session'), null, '没暂停的会话行不标记')

// 继续之后标记撤销
hostState = { running: ['s1', 's2'], paused: [] }
await wait(1000)
assert.equal(rowS1.getAttribute('data-dsh-paused-session'), null, '恢复后应当撤掉标记')

// 只标记「已挂住」而不标记「暂停中…」
hostState = { running: ['s1'], paused: [{ sessionId: 's1', engaged: false, since: 1, turn: 1, step: 1 }] }
await wait(1000)
assert.equal(rowS1.getAttribute('data-dsh-paused-session'), null, '还在跑的一步不换图标')

// 侧栏样式规则
const styleText = headChildren[0].textContent
assert.match(styleText, /\[data-dsh-paused-session\] svg\[data-state="ongoing"\]\{display:none\}/)
assert.match(styleText, /\[data-dsh-paused-session\]:has\(svg\[data-state="ongoing"\]\) > span:first-child::before/)

// ---- 场景 8：刷新 / 切走再回来，按宿主记的基准接着算 ---------------------------
stopTimerOverride()
hostState = {
  running: ['s1'],
  paused: [],
  clocks: [{ sessionId: 's1', baseMs: 83000, resumedAt: Date.now() - 1500 }],
}
await wait(1000) // 等轮询拿到 clocks
runningElements.length = 0
const restored = buildTimer('深度求索中，用时 11分25秒 …')
runningElements.push(restored.root)
Component({ pauseSessionId: 's1' })
flushEffects()
assert.equal(isTimerActive(), true, '有宿主基准时应当重新接管计时')
assert.match(restored.label.nodeValue, /^深度求索中，用时 1分2[3-5]秒 …$/, '应当按基准继续，而不是显示墙钟的 11 分')
expectTimer(restored, restored.label.nodeValue)

// 宿主还记着这一轮的基准 → 过了宽限期也不能被误清
await wait(3400)
assert.equal(isTimerActive(), true, '宿主还有基准时不该交还')

stopTimerOverride()

// ---- 场景 9：宿主那边基准没了（换轮 / 回合结束）→ 交还控制权 ------------------
stopTimerOverride()
hostState = { running: ['s1'], paused: [], clocks: [] }
runningElements.length = 0
const nextTurn = buildTimer('深度求索中，用时 1分23秒 …')
runningElements.push(nextTurn.root)
startTimerPause({ baseMs: 83000 }, 's1')
startTimerOffset()
assert.equal(isTimerActive(), true)
await wait(4300) // 宽限期 3s + 一轮轮询（~0.9s），轮询才会发现宿主已经没有这一轮的基准
assert.equal(isTimerActive(), false, '宿主没有这一轮的基准 → 交还核心，避免旧基准串到新回合')
reactWrites(nextTurn, '深度求索中，用时 2秒 …')
expectTimer(nextTurn, '深度求索中，用时 2秒 …', '交还后不该再被改写')

// ---- 场景 10：暂停那一刻文案还没有时长 → 等它出现再冻 -------------------------
stopTimerOverride()
runningElements.length = 0
const late = buildTimer('深度求索中')
runningElements.push(late.root)
startTimerPause({}, 's1')
assert.equal(isTimerActive(), true, '没时长时也要先占住，等文案出现')
expectTimer(late, '深度求索中', '没有数字就不要动它')

late.label.nodeValue = '深度求索中，用时 2秒 …'
late.highlight.setAttribute('data-shimmer-text', '深度求索中，用时 2秒 …')
fireMutations()
await wait(800) // 等 reattach 定时器抓到时长
expectTimer(late, '已暂停 · 2秒', '时长一出现就该冻住')
stopTimerOverride()

// ---- 场景 11：多次暂停/继续的计时算术（虚拟时钟，确定性） ---------------------
{
  const realNow = Date.now
  let virtualNow = 1_000_000
  Date.now = () => virtualNow
  try {
    const { timerText } = exports.__test
    stopTimerOverride()
    runningElements.length = 0
    const clocked = buildTimer('深度求索中，用时 10秒 …')
    runningElements.push(clocked.root)

    // 跑到 10 秒时暂停，停 60 秒
    startTimerPause({}, 's1')
    assert.equal(timerText(), '已暂停 · 10秒')
    virtualNow += 60_000
    assert.equal(timerText(), '已暂停 · 10秒', '暂停期间不动')

    // 继续 5 秒 → 15 秒
    startTimerOffset()
    virtualNow += 5_000
    assert.equal(timerText(), '深度求索中，用时 15秒 …')

    // 再暂停 30 秒 → 仍是 15 秒
    startTimerPause({}, 's1')
    virtualNow += 30_000
    assert.equal(timerText(), '已暂停 · 15秒')

    // 再继续 7 秒 → 22 秒；墙钟已经是 10+60+5+30+7=112 秒
    startTimerOffset()
    virtualNow += 7_000
    assert.equal(timerText(), '深度求索中，用时 22秒 …', '暂停的 90 秒不该计入')
    assert.ok(timerText().includes('22秒'))

    stopTimerOverride()
  } finally {
    Date.now = realNow
  }
}

// ---- 场景 12：核心墙钟短暂落后时不要误判（文案会滞后，不能拿它当换轮依据） ------
{
  stopTimerOverride()
  runningElements.length = 0
  const drift = buildTimer('深度求索中，用时 3分 …')
  runningElements.push(drift.root)
  startTimerPause({}, 's1')
  startTimerOffset()
  reactWrites(drift, '深度求索中，用时 2分58秒 …')
  assert.equal(isTimerActive(), true, '墙钟小幅回退不该停掉接管')
  expectTimer(drift, '深度求索中，用时 3分0秒 …', '以我们的基准为准，跟着核心一起乱跳才是 bug')
  stopTimerOverride()
}

// ---- 场景 13：二次暂停（还没挂住）时本地基准不能被 reconcile 丢掉 --------------
{
  stopTimerOverride()
  // 宿主快照正是「点了暂停、还没挂住」的样子：在 paused 里，但没有 clocks
  hostState = {
    running: ['s1'],
    paused: [{ sessionId: 's1', engaged: false, since: Date.now(), turn: 1, step: 1, baseMs: 10000 }],
    clocks: [],
  }
  await wait(1000)
  runningElements.length = 0
  const second = buildTimer('深度求索中，用时 5分10秒 …')
  runningElements.push(second.root)
  startTimerPause({ baseMs: 10000 }, 's1')
  startTimerOffset()
  await wait(3300) // 过了宽限期
  exports.__test.markPausedRows() // 轮询里会跑 reconcile
  assert.equal(isTimerActive(), true, '暂停中（未挂住）不该被当成换轮')
  stopTimerOverride()
}

// ---- 场景 14：在两个运行中的会话之间切换，要按新会话恢复 ------------------------
{
  stopTimerOverride()
  hostState = {
    running: ['s1', 's2'],
    paused: [],
    clocks: [{ sessionId: 's2', baseMs: 5000, resumedAt: Date.now() - 4000 }],
  }
  await wait(1000)
  runningElements.length = 0
  const other = buildTimer('深度求索中，用时 2分 …')
  runningElements.push(other.root)
  effectQueue.length = 0 // 只跑这一次渲染的 effect，避免历史 effect 干扰
  Component({ pauseSessionId: 's2' })
  flushEffects()
  assert.equal(isTimerActive(), true, '切到另一个运行中的会话也要按它的基准恢复')
  assert.match(other.label.nodeValue, /^深度求索中，用时 (9|10|11)秒 …$/)
  stopTimerOverride()
}

// ---- 场景 15：行选择器 / 插槽渲染 / 失效自检 -----------------------------------
{
  const { sessionRows: collectRows, degradedState, degrade, RowLeadingIcon, RowHoverHint, markPausedRows } = exports.__test

  // 只认 `session:` 前缀：工作区分组行的键里即使含 session 也不该被当成会话行
  sessionRows.length = 0
  const workspaceRow = fakeSessionRow('x')
  workspaceRow.setAttribute('data-row-key', 'workspace:session:abc')
  sessionRows.push(workspaceRow)
  assert.equal(collectRows().length, 0, 'workspace: 行不该被当成会话行')

  sessionRows.length = 0
  sessionRows.push(fakeSessionRow('s9'))
  const rows = collectRows()
  assert.equal(rows.length, 1, '多重选择器下同一行只算一次')
  assert.equal(rows[0].sessionId, 's9')

  // 插槽渲染：engaged 的会话出行首图标，一次渲染就把 html 标记上（CSS 让位）
  hostState = { running: ['s1'], paused: [{ sessionId: 's1', engaged: true, since: 1, turn: 1, step: 1 }] }
  await wait(1000)
  // 空闲的行也会被核心渲染这个插槽（原版核心只在空闲分支渲染它），但它绝不能因此
  // 把 html 标记成「插槽可用」——否则暂停行的 mask 规则会被全局关掉，行首空空如也。
  effectQueue.length = 0
  assert.equal(RowLeadingIcon({ sessionId: 's9' }), null, '没暂停的会话不渲染图标')
  flushEffects()
  assert.equal(htmlAttrs.get('data-dshp-rowslot'), undefined, '空闲行渲染插槽不能关掉 mask')

  effectQueue.length = 0
  const icon = RowLeadingIcon({ sessionId: 's1' })
  assert.equal(icon.type, 'span')
  assert.equal(icon.props.className, 'dshp-row-icon')
  flushEffects()
  assert.equal(htmlAttrs.get('data-dshp-rowslot'), '1', '真的画出暂停图标后才标记 html，让 mask 方案让位')

  // 补丁模式：行标记不再需要（藏核心状态点由 CSS 按「有没有我们的图标」自己算）
  sessionRows.length = 0
  sessionRows.push(fakeSessionRow('s1'))
  markPausedRows()
  assert.equal(sessionRows[0].getAttribute('data-dsh-paused-session'), null, '补丁模式下不该再打行标记')
  htmlAttrs.delete('data-dshp-rowslot') // 回到未打补丁的状态，继续测 mask 路径

  const hint = RowHoverHint({ sessionId: 's1' })
  assert.equal(hint.type, 'div')
  assert.match(hint.children[0], /已暂停/)
  assert.equal(RowHoverHint({ sessionId: 's9' }), null, '没暂停的会话不要在悬停卡片里显得有事')

  // 冷启动宽限：刚刷新时还没渲染出计时器，5 秒内不该被判成钩子失效
  stopTimerOverride()
  runningElements.length = 0
  startTimerPause({}, 's1')
  await wait(5000)
  assert.equal(isTimerActive(), true, '刚刷新时找不到元素是正常的，不该马上判失效')
  stopTimerOverride()

  // 树还在、但整页一个 data-row-key 都没有 → 登记 rows 失效（只报一次）
  sessionRows.length = 0
  const warned = []
  const realWarn = console.warn
  const realQuery = document.querySelectorAll
  const fakeTree = [{ getAttribute: () => null }]
  console.warn = (message) => warned.push(String(message))
  document.querySelectorAll = (selector) => {
    if (selector === '[role="treeitem"]') return fakeTree
    if (selector === '[data-row-key]') return []
    return realQuery(selector)
  }
  try {
    markPausedRows()
  } finally {
    document.querySelectorAll = realQuery
  }
  assert.equal(degradedState().rows, true, '整页没有 data-row-key 时应登记 rows 失效')
  assert.equal(warned.length, 1, 'rows 失效只报一次控制台')

  // 计时失效同样只报一次，并带进快照，按钮 title 能显示出来
  try {
    degrade('timer', '测试用失效')
    degrade('timer', '测试用失效')
  } finally {
    console.warn = realWarn
  }
  assert.equal(warned.length, 2, 'timer 失效各报一次（合计两条）')
  assert.equal(degradedState().timer, true)

  hostState = { running: ['s1'], paused: [] }
  await wait(1000)
  const afterDegrade = Component({ pauseSessionId: 's1' })
  assert.match(afterDegrade.props.title, /部分接管失效/, '按钮 title 要能看出接管失效')
}

// ---- 场景 16：文案跟随界面语言 ------------------------------------------------
{
  document.documentElement.lang = 'en'
  hostState = { running: ['s1'], paused: [] }
  await wait(1000)
  const enButton = Component({ pauseSessionId: 's1' })
  assert.equal(enButton.children[1].children[0], 'Pause', '英文界面下按钮应当是 Pause')
  assert.match(enButton.props.title, /Pause this turn/)

  document.documentElement.lang = 'zh-CN'
  const zhButton = Component({ pauseSessionId: 's1' })
  assert.equal(zhButton.children[1].children[0], '暂停', '中文界面下回到中文文案')
}

// ---- 场景 17：钩子恢复后，失效标记要能自愈 -------------------------------------
{
  const { degradedState, markPausedRows } = exports.__test
  assert.equal(degradedState().rows, true, '前置条件：rows 已被判失效')

  // 行又出现了：连续两轮轮询后清掉标记
  sessionRows.length = 0
  sessionRows.push(fakeSessionRow('s1'))
  markPausedRows()
  assert.equal(degradedState().rows, true, '第一次看到钩子只是计数，不立刻翻案')
  markPausedRows()
  assert.equal(degradedState().rows, false, '连续两次看到钩子应撤销失效标记')

  // 计时器同理：重新暂停、元素在，两次 reattach 后自愈
  assert.equal(degradedState().timer, true, '前置条件：timer 已被判失效')
  runningElements.length = 0
  runningElements.push(buildTimer('深度求索中，用时 3秒 …').root)
  startTimerPause({}, 's1')
  assert.equal(degradedState().timer, true, '第一次重新看到计时器只是计数')
  await wait(800) // 等 reattach 再跑一次
  assert.equal(degradedState().timer, false, '连续两次看到计时器应撤销失效标记')
  stopTimerOverride()
}

// ---- 场景 18：同屏有子代理内嵌会话的计时器 → 只接管主对话那个 ------------------
{
  const { degradedState, mainTimerCount } = exports.__test
  stopTimerOverride()
  hostMode = 'ok'
  hostState = { running: ['s1'], paused: [{ sessionId: 's1', engaged: true, since: 1, turn: 1, step: 1 }] }
  await wait(1000)

  const main = buildTimer('深度求索中，用时 1分23秒 …')
  const nested = buildTimer('深度求索中，用时 40秒 …')
  fakeElement({ 'data-chat-node-key': 'sub-1' }, [nested.root]) // 只为了把 parentElement 挂上去
  runningElements.length = 0
  runningElements.push(main.root, nested.root)

  startTimerPause({ baseMs: 83000 }, 's1')
  assert.equal(main.label.nodeValue, '已暂停 · 1分23秒', '主对话的计时器要冻住')
  assert.equal(nested.label.nodeValue, '深度求索中，用时 40秒 …', '子代理内嵌会话的计时器一个字都不能动')
  assert.equal(nested.root.getAttribute('data-dsh-timer-paused'), null, '子代理的扫光动画也不能停')
  assert.equal(degradedState().timer, false, '认得出主对话时不该报失效')
  assert.equal(mainTimerCount(), 1, '作用域里只该有一个计时器')
  stopTimerOverride()
}

// ---- 场景 19：核心把文案拆成两个文本节点 → 只冻结数字，不吃掉标签 --------------
{
  stopTimerOverride()
  runningElements.length = 0
  const labelNode = fakeText('深度求索中，用时 ')
  const valueNode = fakeText('1分23秒')
  const splitRoot = fakeElement({ 'data-chat-running': '' }, [labelNode, valueNode])
  runningElements.push(splitRoot)
  startTimerPause({}, 's1')
  assert.equal(labelNode.nodeValue, '深度求索中，用时 ', '标签节点不该被改写')
  assert.equal(valueNode.nodeValue, '1分23秒', '数字节点冻在暂停值')

  // React 把数字写成墙钟 11分24秒 → 只改数字节点，标签原样
  valueNode.nodeValue = '11分24秒'
  fireMutations()
  assert.equal(labelNode.nodeValue, '深度求索中，用时 ')
  assert.equal(valueNode.nodeValue, '1分23秒')

  // 继续 1.2 秒 → 数字 +1，标签仍不动
  startTimerOffset()
  await wait(1200)
  valueNode.nodeValue = '11分25秒'
  fireMutations()
  assert.equal(labelNode.nodeValue, '深度求索中，用时 ')
  assert.equal(valueNode.nodeValue, '1分24秒')
  stopTimerOverride()
}

// ---- 场景 20：宿主明确回绝时给一句提示，且不替换按钮的状态文字 ------------------
{
  const { clearNotices } = exports.__test
  stopTimerOverride()
  hostMode = 'refuse'
  hostState = { running: ['s1'], paused: [] }
  await wait(1000)
  const before = Component({ pauseSessionId: 's1' })
  assert.equal(before.type, 'button')
  await before.props.onClick()
  await wait(60)
  const after = Component({ pauseSessionId: 's1' })
  assert.equal(after.type, 'Fragment', '提示要和按钮并列，不能把按钮换成一句话')
  assert.equal(after.children[0].type, 'button')
  assert.equal(after.children[0].children[1].children[0], '暂停', '按钮自己的状态文字不能被提示顶掉')
  assert.match(after.children[1].children[0], /这一轮已经结束/)
  clearNotices()

  // 请求根本没送到（网络层抛错）→ 说的是「结果未知，正在核对」，不是「失败」
  const realWarn = console.warn
  console.warn = () => {}
  hostMode = 'fail'
  try {
    const again = Component({ pauseSessionId: 's1' })
    await again.props.onClick()
    await wait(60)
    const failed = Component({ pauseSessionId: 's1' })
    assert.equal(failed.type, 'Fragment')
    assert.match(failed.children[1].children[0], /结果未知/, '送不到和宿主回绝要分开说')
  } finally {
    console.warn = realWarn
    clearNotices()
    hostMode = 'ok'
  }
}

// ---- 场景 21：宿主 404 → 降频探活 + 隐藏按钮；恢复后自己回来 -------------------
{
  const { hostState: hostFlags, pollNow } = exports.__test
  stopTimerOverride()
  hostMode = 'missing'
  await wait(30)
  await pollNow()
  await wait(20)
  await pollNow()
  await wait(20)
  assert.equal(hostFlags().hostMissing, true, '连续 404 应当进入降频状态')
  assert.equal(Component({ pauseSessionId: 's1' }), null, '宿主不可用时不该留一个按钮')

  hostMode = 'ok'
  hostState = { running: ['s1'], paused: [] }
  await pollNow()
  await wait(40)
  assert.equal(hostFlags().hostMissing, false, '宿主回来要自动恢复')
  assert.equal(Component({ pauseSessionId: 's1' }).type, 'button')
}

// ---- 场景 22：既不是中文也不是英文的界面语言 → 英文兜底 ------------------------
{
  hostState = { running: ['s1'], paused: [] }
  await wait(1000)
  document.documentElement.lang = 'ja'
  const jaButton = Component({ pauseSessionId: 's1' })
  assert.equal(jaButton.children[1].children[0], 'Pause', '非中英文界面按英文兜底')
  document.documentElement.lang = 'zh-CN'
  assert.equal(Component({ pauseSessionId: 's1' }).children[1].children[0], '暂停')
}

// ---- 场景 23：停止轮询要把快照一起清掉（别让重新订阅时先渲染旧状态） ----------
{
  const { snapshotState, stopPolling } = exports.__test
  hostState = { running: ['s1'], paused: [{ sessionId: 's1', engaged: true, since: 1, turn: 1, step: 1 }] }
  await wait(1000)
  assert.equal(snapshotState().paused.length, 1)
  stopPolling()
  assert.deepEqual(snapshotState().paused, [], '停止轮询后不该留着上一轮的暂停状态')
  assert.equal(snapshotState().running.length, 0)
  // 重新订阅（渲染会调用 subscribe）→ 立刻再拿一次真相
  Component({ pauseSessionId: 's1' })
  hostState = { running: ['s1'], paused: [] }
  await wait(80)
  assert.equal(snapshotState().running.length, 1, '重新订阅后应当恢复轮询')
}

// ---- 场景 24：插件升版后要换掉旧的 <style> ------------------------------------
{
  const removed = []
  const stale = {
    getAttribute: (name) => (name === 'data-plugin-version' ? '0.2.0' : null),
    remove: () => removed.push('stale'),
  }
  const realQuerySelector = document.querySelector
  document.querySelector = (selector) => (String(selector).includes('data-plugin-style') ? stale : realQuerySelector(selector))
  try {
    const before = headChildren.length
    exports.__test.resetStyle()
    exports.__test.installStyle()
    assert.equal(removed.length, 1, '旧版本的样式要删掉')
    assert.equal(headChildren.length, before + 1, '要装一份新样式')
    assert.equal(headChildren[headChildren.length - 1].dataset.pluginVersion, packageVersion)
  } finally {
    document.querySelector = realQuerySelector
  }
}

// ---- 场景 25：多个计时器且认不出主对话 → 一个都不动，并撤掉冻结标记 --------------
{
  const { degradedState } = exports.__test
  stopTimerOverride()
  hostMode = 'ok'
  runningElements.length = 0
  const first = buildTimer('深度求索中，用时 1分23秒 …')
  runningElements.push(first.root)
  startTimerPause({}, 's1')
  assert.equal(first.root.getAttribute('data-dsh-timer-paused'), '1', '只有一个计时器时正常冻结并打标记')

  // 又冒出一个计时器、两个都不在聊天节点里 → 认不出哪一个是主对话
  const second = buildTimer('深度求索中，用时 5秒 …')
  runningElements.push(second.root)
  await wait(800) // 等 reattach 跑一轮
  assert.equal(first.label.nodeValue, '已暂停 · 1分23秒', '认不出之后不再继续改数字')
  assert.equal(second.label.nodeValue, '深度求索中，用时 5秒 …', '更不该改别人的数字')
  assert.equal(first.root.getAttribute('data-dsh-timer-paused'), null, '认不出来时冻结标记也要撤掉，别让扫光一直停着')
  assert.equal(second.root.getAttribute('data-dsh-timer-paused'), null)
  assert.equal(degradedState().timer, true, '认不出要报失效，不能静默')

  // 多余的计时器消失 → 自愈：重新认出来并恢复接管
  runningElements.length = 0
  runningElements.push(first.root)
  second.root.parentElement = null
  await wait(1600) // 两次 reattach（恢复要连续两次才算数）
  assert.equal(degradedState().timer, false, '局面清楚了要撤销失效标记')
  assert.equal(first.root.getAttribute('data-dsh-timer-paused'), '1', '恢复后继续冻结')
  stopTimerOverride()
}

console.log('✓ dsh-breather client: module/registration/states/actions/timer/clock-restore/new-turn-guard/late-capture/timer-math/second-pause/session-switch/sidebar-mark/row-slot/self-check/subagent-scope/split-nodes/notice/host-404/i18n-fallback/stop-reset/style-version/ambiguous-scope passed')
