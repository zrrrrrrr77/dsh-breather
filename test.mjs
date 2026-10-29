/**
 * dsh-breather 宿主半的自测：不启动 DSH，用假的 Agent 注册表把状态机和闸门跑一遍。
 * 运行：node test.mjs
 */
import assert from 'node:assert/strict'
import { createPauseController, name, inject } from './index.js'

const SESSION = 'session-1'

function makeAgent(status = 'running') {
  return {
    status,
    session: { header: { id: SESSION } },
  }
}

function makeController(agent, options = {}) {
  return createPauseController({
    listAgents: () => (agent === undefined ? [] : [agent]),
    getAgent: () => agent,
    warn: () => {},
    ...options,
  })
}

const pending = (promise) => {
  let settled = false
  promise.then(() => { settled = true }, () => { settled = true })
  return new Promise((resolve) => setTimeout(() => resolve(!settled), 30))
}

// 1) 元数据
assert.equal(name, 'dsh-breather')
assert.deepEqual(inject, ['agents', 'connection'])

// 2) 空闲会话不能暂停
{
  const controller = makeController(makeAgent('idle'))
  const result = controller.requestPause(SESSION)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session/idle')
  assert.deepEqual(controller.snapshot().paused, [])
}

// 3) 未知会话不能暂停
{
  const controller = makeController(undefined)
  const result = controller.requestPause(SESSION)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'session/unknown')
}

// 4) 暂停 → pre-step 挂住 → 快照显示 engaged → 继续后放行
{
  const agent = makeAgent()
  const controller = makeController(agent)
  assert.equal(controller.requestPause(SESSION).ok, true)

  const before = controller.snapshot()
  assert.deepEqual(before.running, [SESSION])
  assert.equal(before.paused.length, 1)
  assert.equal(before.paused[0].engaged, false)

  let released = false
  const signal = new AbortController().signal
  const decision = controller.preStep(
    { agent, signal, turn: 3, step: 2 },
    () => { released = true; return { kind: 'enter', messages: [] } },
  )

  assert.equal(await pending(decision), true, '闸门应当挂住')
  assert.equal(released, false, '挂住期间不能放行')

  const engaged = controller.snapshot().paused[0]
  assert.equal(engaged.engaged, true)
  assert.equal(engaged.turn, 3)
  assert.equal(engaged.step, 2)

  controller.requestResume(SESSION)
  assert.deepEqual(await decision, { kind: 'enter', messages: [] })
  assert.equal(released, true)
  assert.deepEqual(controller.snapshot().paused, [])
}

// 5) 挂住时回合被取消：拒绝这一步，状态清干净
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)

  const ac = new AbortController()
  const decision = controller.preStep({ agent, signal: ac.signal, turn: 1, step: 1 }, () => ({ kind: 'enter' }))
  assert.equal(await pending(decision), true)

  ac.abort(new Error('stopped'))
  assert.deepEqual(await decision, { kind: 'reject' })
  assert.deepEqual(controller.snapshot().paused, [])
}

// 6) 已经 abort 的信号直接拒绝
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  const ac = new AbortController()
  ac.abort()
  assert.deepEqual(await controller.preStep({ agent, signal: ac.signal }, () => ({ kind: 'enter' })), { kind: 'reject' })
}

// 7) 没暂停时直接放行（不等待）
{
  const agent = makeAgent()
  const controller = makeController(agent)
  const decision = await controller.preStep({ agent, signal: new AbortController().signal }, () => ({ kind: 'enter' }))
  assert.deepEqual(decision, { kind: 'enter' })
}

// 8) 回合结束（status 变 idle）清掉暂停，避免残留到下一轮
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.onStatus(agent, 'idle')
  assert.deepEqual(controller.snapshot().paused, [])
}

// 9) 暂停期间用户又发了消息：自动恢复
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.onInboxInserted(agent, { source: { kind: 'user', rpcId: 'r1' } })
  assert.deepEqual(controller.snapshot().paused, [])
}

// 9b) 后台唤醒（子代理结算 / 定时提醒）不该解除暂停
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.onInboxInserted(agent, { source: { kind: 'subagent' } })
  controller.onInboxInserted(agent, { source: { kind: 'schedule' } })
  controller.onInboxInserted(agent, {})
  assert.equal(controller.snapshot().paused.length, 1, '非用户消息不能解除暂停')
}

// 10) 默认没有超时：挂住之后就是一直挂着，等多久都不会自己放行
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  const decision = controller.preStep({ agent, signal: new AbortController().signal }, () => ({ kind: 'enter' }))
  assert.equal(await pending(decision), true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(await pending(decision), true, '没有超时就该一直挂着')
  assert.equal(controller.snapshot().paused[0].engaged, true)
  controller.requestResume(SESSION)
  assert.deepEqual(await decision, { kind: 'enter' })
}

// 10b) 显式配置超时才启用兜底（默认关闭）
{
  const agent = makeAgent()
  const controller = makeController(agent, { engagedTimeoutMs: 40 })
  controller.requestPause(SESSION)
  const decision = controller.preStep({ agent, signal: new AbortController().signal }, () => ({ kind: 'enter' }))
  assert.equal(await pending(decision), true)
  // 兜底定时器是 unref 的（不该拖住宿主退出），所以这里用一条普通定时器把事件循环撑住。
  const settled = await Promise.race([decision, new Promise((resolve) => setTimeout(() => resolve('timeout'), 400))])
  assert.deepEqual(settled, { kind: 'enter' })
  assert.deepEqual(controller.snapshot().paused, [])
}

// 11) 卸载时释放全部等待者
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  const decision = controller.preStep({ agent, signal: new AbortController().signal }, () => ({ kind: 'enter' }))
  assert.equal(await pending(decision), true)
  controller.disposeAll()
  assert.deepEqual(await decision, { kind: 'enter' })
}

// 12) 暂停 → 继续 → 再暂停：基准要被新的上报覆盖
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.recordBaseline(SESSION, 83000)
  controller.requestResume(SESSION)
  assert.equal(controller.snapshot().clocks.length, 1, '继续后要留着基准')
  assert.equal(controller.snapshot().clocks[0].baseMs, 83000)

  controller.requestPause(SESSION)
  const second = controller.snapshot()
  assert.deepEqual(second.clocks, [], '重新暂停后不该再出现在 clocks 里')
  assert.equal(second.paused[0].baseMs, 83000, '新一次暂停沿用上一个基准，等浏览器上报新的')
  controller.recordBaseline(SESSION, 95000)
  assert.equal(controller.snapshot().paused[0].baseMs, 95000, '新上报应当覆盖旧基准')
}

// 13) 挂住时回合被取消：基准也一起清掉
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.recordBaseline(SESSION, 83000)
  const ac = new AbortController()
  const decision = controller.preStep({ agent, signal: ac.signal }, () => ({ kind: 'enter' }))
  assert.equal(await pending(decision), true)
  ac.abort(new Error('stopped'))
  assert.deepEqual(await decision, { kind: 'reject' })
  const after = controller.snapshot()
  assert.deepEqual(after.paused, [])
  assert.deepEqual(after.clocks, [], '取消之后不该留下基准')
}

// 14) 只影响被暂停的会话：另一个会话的 pre-step 直接放行
{
  const main = makeAgent()
  const other = { status: 'running', session: { header: { id: 'session-2' } } }
  const controller = createPauseController({
    listAgents: () => [main, other],
    getAgent: (id) => (id === 'session-2' ? other : main),
    warn: () => {},
  })
  controller.requestPause(SESSION)
  const decision = await controller.preStep({ agent: other, signal: new AbortController().signal }, () => ({ kind: 'enter' }))
  assert.deepEqual(decision, { kind: 'enter' }, '其他会话不该被挂住')
}

// 15) 用户发言自动恢复时保留基准（继续之后计时还要扣）
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.recordBaseline(SESSION, 83000)
  controller.onInboxInserted(agent, { source: { kind: 'user' } })
  const after = controller.snapshot()
  assert.deepEqual(after.paused, [])
  assert.equal(after.clocks.length, 1, '用户发言等同继续，基准要留着')
  assert.equal(after.clocks[0].baseMs, 83000)
}

// 16) 再次暂停时宿主先把基准走到此刻：浏览器哪怕丢了本地状态也拿不到旧数字
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.recordBaseline(SESSION, 10000)
  controller.requestResume(SESSION)
  await new Promise((resolve) => setTimeout(resolve, 60))
  controller.requestPause(SESSION)
  const base = controller.snapshot().paused[0].baseMs
  assert.ok(base >= 10000, `基准不该倒退（实际 ${base}）`)
  assert.ok(base < 15000, `只过了 60ms，不该涨很多（实际 ${base}）`)
}

// 17) 暂停请求被取消（没挂住就继续）时基准不该被重复累加
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.recordBaseline(SESSION, 10000)
  controller.requestResume(SESSION)
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.requestPause(SESSION)
  const paused = controller.snapshot().paused[0].baseMs
  controller.requestResume(SESSION)
  const clock = controller.snapshot().clocks[0]
  assert.equal(clock.baseMs, paused, '取消暂停不该改变基准')
  assert.ok(Math.abs(clock.resumedAt - Date.now()) < 1000)
}

console.log('✓ dsh-breather host: state machine / gate / cancel / no-timeout / baseline-clamp / prune / ghost-hide passed')

// 18) 基准上限：超限的脏数据一律拒绝（不夹紧——夹紧会让计时数字往回跳）
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  assert.equal(controller.recordBaseline(SESSION, Number.POSITIVE_INFINITY).code, 'bad-elapsed')
  assert.equal(controller.recordBaseline(SESSION, 30 * 24 * 3600 * 1000 + 1).code, 'bad-elapsed', '超过 30 天拒掉')
  assert.equal(controller.recordBaseline(SESSION, 86_400_000).ok, true, '一天以内的时长是合法的')
  assert.equal(controller.snapshot().paused[0].baseMs, 86_400_000)
}

// 19) 回收：只清既没暂停也没基准的垃圾条目；暂停中的状态一动不动
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.onStatus(agent, 'idle') // 回合结束 → 暂停解除
  assert.equal(controller.sessions.size, 0, '回合结束后不该留下空条目')
  assert.deepEqual(controller.snapshot().paused, [])

  controller.requestPause(SESSION)
  controller.prune()
  assert.equal(controller.sessions.size, 1, '暂停中的状态绝不能被回收')
}

// 20) 继续之后还留着基准的条目也不能被回收（换轮计时还要用它）
{
  const agent = makeAgent()
  const controller = makeController(agent)
  controller.requestPause(SESSION)
  controller.recordBaseline(SESSION, 5000)
  controller.requestResume(SESSION)
  controller.prune()
  assert.equal(controller.sessions.size, 1, '带基准的条目要留着')
  assert.equal(controller.snapshot().clocks.length, 1)
}

// 21) agent 没了：暂停状态从界面上藏起来，但闸门状态本身保留（绝不自动解除）
{
  let agent = makeAgent()
  const controller = createPauseController({
    listAgents: () => (agent === undefined ? [] : [agent]),
    getAgent: () => agent,
    warn: () => {},
  })
  controller.requestPause(SESSION)
  agent = undefined
  assert.equal(controller.snapshot().paused.length, 1, '第一次取不到 agent 还不该藏（注册表会抖动）')
  assert.equal(controller.snapshot().paused.length, 1, '第二次也还留着')
  assert.equal(controller.snapshot().paused.length, 0, '连续三次取不到才从界面上藏起来')
  assert.equal(controller.sessions.size, 1, '藏起来不等于解除')
  assert.equal(controller.sessions.get(SESSION).requested, true, '闸门状态必须原封不动')
}

// 22) agent 回来了：藏起来的那条暂停重新出现在界面上
{
  let agent = makeAgent()
  const controller = createPauseController({
    listAgents: () => (agent === undefined ? [] : [agent]),
    getAgent: () => agent,
    warn: () => {},
  })
  controller.requestPause(SESSION)
  agent = undefined
  controller.snapshot()
  controller.snapshot()
  assert.equal(controller.snapshot().paused.length, 0)
  agent = makeAgent()
  assert.equal(controller.snapshot().paused.length, 1, 'agent 回来后要重新上报')
}
