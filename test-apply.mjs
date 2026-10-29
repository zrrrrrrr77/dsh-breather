/**
 * dsh-breather 的装配测试：用假的 cordis ctx 跑真实 `apply()`，
 * 验证事件监听名、路由注册和 GET/POST 全链路。
 * 运行：node test-apply.mjs
 */
import assert from 'node:assert/strict'
import { apply, name, inject } from './index.js'

const SESSION = 'session-apply'
const AGENT = { status: 'running', session: { header: { id: SESSION } } }

function fakeCtx(agent) {
  const listeners = new Map()
  const routes = []
  const ctx = {
    agents: {
      list: () => (agent === undefined ? [] : [agent]),
      get: () => agent,
    },
    connection: {
      fetch: {
        register: (route) => {
          routes.push(route)
          return () => {}
        },
      },
    },
    on: (event, listener) => {
      const existing = listeners.get(event) ?? []
      existing.push(listener)
      listeners.set(event, existing)
      return () => {}
    },
    effect: (factory) => {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: { warn: () => {} },
  }
  return { ctx, listeners, routes }
}

const GET = (url = 'http://127.0.0.1:14752/api/session-pause') => ({
  method: 'GET',
  url,
  headers: { get: () => null },
})

const POST = (body, url = 'http://127.0.0.1:14752/api/session-pause') => ({
  method: 'POST',
  url,
  headers: { get: () => 'application/json' },
  json: async () => body,
})

const readJson = async (response) => ({ status: response.status, body: await response.json() })

// 1) 元数据 + 装配
assert.equal(name, 'dsh-breather')
assert.deepEqual(inject, ['agents', 'connection'])

{
  const { ctx, listeners, routes } = fakeCtx(AGENT)
  apply(ctx, {})

  assert.ok(listeners.has('agent/pre-step'), '应当挂 agent/pre-step')
  assert.ok(listeners.has('agent/status'), '应当监听 agent/status')
  assert.ok(listeners.has('agent/inbox/inserted'), '应当监听 inbox 插入')

  assert.equal(routes.length, 1)
  const route = routes[0]
  assert.equal(route.path, '/api/session-pause')
  assert.deepEqual(route.methods, ['GET', 'POST'])
  assert.equal(route.requestBody, 'buffered')
  assert.equal(typeof route.fetch, 'function')
}

// 2) GET：空状态
{
  const { ctx, routes } = fakeCtx(AGENT)
  apply(ctx, {})
  const { status, body } = await readJson(await routes[0].fetch(GET()))
  assert.equal(status, 200)
  assert.deepEqual(body, { running: [SESSION], paused: [], clocks: [] })
}

// 3) POST pause → GET 显示 pending → pre-step 挂住 → POST resume 放行
{
  const { ctx, listeners, routes } = fakeCtx(AGENT)
  apply(ctx, {})
  const route = routes[0]

  const paused = await readJson(await route.fetch(POST({ action: 'pause', sessionId: SESSION })))
  assert.equal(paused.status, 200)
  assert.equal(paused.body.ok, true)
  assert.equal(paused.body.state.paused.length, 1)
  assert.equal(paused.body.state.paused[0].engaged, false, '还没到步边界，应当是 pending')

  const preStep = listeners.get('agent/pre-step')[0]
  let forwarded = false
  const decision = preStep({ agent: AGENT, signal: new AbortController().signal, turn: 2, step: 4 },
    () => { forwarded = true; return { kind: 'enter', messages: [] } })

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(forwarded, false, '暂停中不应放行到循环')

  const engaged = await readJson(await route.fetch(GET()))
  assert.equal(engaged.body.paused[0].engaged, true, '闸门应当已挂住')
  assert.equal(engaged.body.paused[0].turn, 2)
  assert.equal(engaged.body.paused[0].step, 4)

  const resumed = await readJson(await route.fetch(POST({ action: 'resume', sessionId: SESSION })))
  assert.equal(resumed.body.ok, true)
  assert.deepEqual(await decision, { kind: 'enter', messages: [] })
  assert.equal(forwarded, true, '继续后应当放行')

  const idle = await readJson(await route.fetch(GET()))
  assert.deepEqual(idle.body.paused, [])
}

// 3b) 暂停基准：上报 → 快照带上 → 继续后变成 clocks → 回合结束清掉
{
  const { ctx, listeners, routes } = fakeCtx(AGENT)
  apply(ctx, {})
  const route = routes[0]

  await readJson(await route.fetch(POST({ action: 'pause', sessionId: SESSION })))
  const baseline = await readJson(await route.fetch(POST({ action: 'baseline', sessionId: SESSION, elapsedMs: 83000 })))
  assert.equal(baseline.body.ok, true)
  assert.equal(baseline.body.state.paused[0].baseMs, 83000, '基准应当随暂停状态返回')
  assert.deepEqual(baseline.body.state.clocks, [], '暂停中不该出现在 clocks 里')

  const resumed = await readJson(await route.fetch(POST({ action: 'resume', sessionId: SESSION })))
  assert.deepEqual(resumed.body.state.paused, [])
  assert.equal(resumed.body.state.clocks.length, 1, '继续后要留下基准，好让刷新/切走回来还能扣')
  assert.equal(resumed.body.state.clocks[0].baseMs, 83000)
  assert.equal(typeof resumed.body.state.clocks[0].resumedAt, 'number')

  // 回合结束：基准清空，下一轮重新开始
  const status = listeners.get('agent/status')[0]
  status({ agent: AGENT, status: 'idle' })
  const idle = await readJson(await route.fetch(GET()))
  assert.deepEqual(idle.body.clocks, [], '回合结束后基准应当清掉')
}

// 3c) 基准参数校验
{
  const { ctx, routes } = fakeCtx(AGENT)
  apply(ctx, {})
  const route = routes[0]
  const notPaused = await readJson(await route.fetch(POST({ action: 'baseline', sessionId: SESSION, elapsedMs: 1 })))
  assert.equal(notPaused.body.ok, false)
  assert.equal(notPaused.body.code, 'session/not-paused')

  await readJson(await route.fetch(POST({ action: 'pause', sessionId: SESSION })))
  const bad = await readJson(await route.fetch(POST({ action: 'baseline', sessionId: SESSION, elapsedMs: -5 })))
  assert.equal(bad.body.ok, false)
  assert.equal(bad.body.code, 'bad-elapsed')
}

// 4) 不存在 / 未运行的会话：POST 返回 ok:false，但仍然 200 + 状态
{
  const { ctx, routes } = fakeCtx(undefined)
  apply(ctx, {})
  const result = await readJson(await routes[0].fetch(POST({ action: 'pause', sessionId: 'nope' })))
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, false)
  assert.equal(result.body.code, 'session/unknown')
}

// 5) 参数错误
{
  const { ctx, routes } = fakeCtx(AGENT)
  apply(ctx, {})
  const missing = await readJson(await routes[0].fetch(POST({ action: 'pause' })))
  assert.equal(missing.status, 400)
  assert.equal(missing.body.code, 'missing-session')

  const unknown = await readJson(await routes[0].fetch(POST({ action: 'toggle', sessionId: SESSION })))
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.code, 'unknown-action')

  const badJson = await readJson(await routes[0].fetch({
    method: 'POST',
    url: 'http://127.0.0.1:14752/api/session-pause',
    headers: { get: () => 'application/json' },
    json: async () => { throw new Error('not json') },
  }))
  assert.equal(badJson.status, 400)
  assert.equal(badJson.body.code, 'bad-json')
}

// 6) inbox 插入：只有用户消息解除暂停（校验 apply 真的把 message 传进去了）
{
  const { ctx, listeners, routes } = fakeCtx(AGENT)
  apply(ctx, {})
  const route = routes[0]
  const inserted = listeners.get('agent/inbox/inserted')[0]

  const pause = async () => readJson(await route.fetch(POST({ action: 'pause', sessionId: SESSION })))
  const pausedCount = async () => (await readJson(await route.fetch(GET()))).body.paused.length

  await pause()
  inserted({ agent: AGENT, message: { source: { kind: 'subagent' } } })
  assert.equal(await pausedCount(), 1, '后台唤醒不该解除暂停')

  inserted({ agent: AGENT, message: { source: { kind: 'user', rpcId: 'r1' } } })
  assert.equal(await pausedCount(), 0, '用户自己发消息应当恢复')
}

// 7) 路由固定：path 配置项已被移除（客户端写死同一条路由），传了也不生效
{
  const custom = fakeCtx(AGENT)
  apply(custom.ctx, { path: '/api/pause-custom' })
  assert.equal(custom.routes.length, 1, '只该注册一条路由')
  assert.equal(custom.routes[0].path, '/api/session-pause', 'path 配置不再生效')

  const off = fakeCtx(AGENT)
  apply(off.ctx, { enabled: false })
  assert.equal(off.routes.length, 0)
  assert.equal(off.listeners.size, 0)
}

// 7b) 路由注册抛错：不能把整个插件加载带崩，但必须大声报出来（不能静默）
{
  const { ctx, listeners } = fakeCtx(AGENT)
  const errors = []
  ctx.connection.fetch.register = () => { throw new Error('route already registered') }
  ctx.logger = { warn: () => {}, error: (message) => errors.push(String(message)) }
  apply(ctx, {})
  assert.equal(listeners.size, 3, '事件监听照旧挂上')
  assert.equal(errors.length, 1, '注册失败要报一次')
  assert.match(errors[0], /注册失败/)
  assert.match(errors[0], /route already registered/)
}

console.log('✓ dsh-breather apply(): wiring + HTTP routes + gate passed')
