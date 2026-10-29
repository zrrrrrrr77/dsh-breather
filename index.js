/**
 * dsh-breather
 *
 * 给「对话」加一个介于「正在运行」和「终止」之间的状态：暂停 / 继续。
 *
 * 做法：
 *  - 宿主动词挂在 Agent 循环的 `agent/pre-step` 上。这个钩子在每次「发起模型请求
 *    之前」被调用，可以返回 `{ kind: 'reject' }` 或放行；监听器返回 Promise 时
 *    循环会等它——所以在这里 await 一个闸门 = 把这一轮真正挂住。
 *  - 闸门只持有「下一次模型请求」。点暂停时如果模型正在流式输出、或工具正在跑，
 *    当前这一步会先跑完，然后在下一步开始前停住（不会丢 token，也不会重发请求）。
 *  - 继续 = 放行闸门，循环从停住的地方接着跑，零成本。
 *  - 会话被终止（Stop / Esc Esc / 归档）时 `payload.signal` 会 abort，闸门随之
 *    松开并拒绝这一步，回合干净结束，不会卡死。
 *  - 暂停期间用户自己又发了消息会自动恢复（避免看起来像卡住）；子代理结算、定时
 *    提醒之类的后台唤醒不会解除暂停。
 *  - 没有超时兜底：暂停之后不点继续就一直停着，只有下面几种情况会松开闸门——
 *    点「继续」、自己发了新消息、这一轮被终止（Stop / Esc Esc / 归档）、插件卸载。
 *    「回收状态」不是第五种：回收只清既没暂停也没计时基准的垃圾条目，暂停中的
 *    状态永远不会被主动删掉（误删 = 用户在暂停中，会话自己开跑）。
 *  - 浏览器侧通过一条固定的 HTTP 路由 `GET|POST /api/session-pause` 读写状态；
 *    只有 owner peer（本机浏览器）能访问。
 *
 * 状态：
 *  - requested：用户点了暂停，还没停住（模型正在输出 / 工具正在跑）
 *  - engaged：闸门真的挂住了，等待继续
 *
 * 配置（cordis.patch.yml 里 config）：
 *  - enabled：总开关，默认 true
 *  - engagedTimeoutMs：可选的挂住超时，默认 0 = 永不自动放行
 *
 * 没有 path 配置项：浏览器半把路由写死了，留一个客户端不知道的开关只会造成
 * 「按钮永远读不到状态」这种最难查的故障。要改路由就得两个半一起改。
 */

export const name = 'dsh-breather'

/** 需要 Agent 注册表（按会话 id 取 Agent）和 Connection（精确 HTTP 路由）。 */
export const inject = ['agents', 'connection']

const DEFAULT_PATH = '/api/session-pause'
/** 默认不设超时：暂停之后用户不点继续就一直停着。 */
const DEFAULT_ENGAGED_TIMEOUT_MS = 0
/** 浏览器上报的基准上限：超过 30 天一律当脏数据拒掉（不夹紧——夹紧会让计时数字往回跳）。 */
const MAX_BASELINE_MS = 30 * 24 * 60 * 60 * 1000
/** 连续多少次快照都取不到 agent，才把这条暂停从前端视野里藏起来（闸门状态本身保留）。 */
const GHOST_TICKS = 3

/**
 * 暂停控制器：纯状态机 + 闸门，不直接依赖 Cordis，便于单测。
 * @param {object} deps - 依赖
 * @param {() => object[]} deps.listAgents - 列出存活 Agent
 * @param {(sessionId: string) => object | undefined} deps.getAgent - 按会话 id 取 Agent
 * @param {(message: string) => void} [deps.warn] - 警告日志
 * @param {number} [deps.engagedTimeoutMs] - 可选的挂住超时；0 或负数表示永不自动放行（默认）
 * @returns {object} 控制器
 */
export function createPauseController(deps) {
  const listAgents = deps.listAgents
  const getAgent = deps.getAgent
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  const engagedTimeoutMs = Number.isFinite(deps.engagedTimeoutMs) && deps.engagedTimeoutMs > 0
    ? deps.engagedTimeoutMs
    : DEFAULT_ENGAGED_TIMEOUT_MS

  /** @type {Map<string, {sessionId: string, requested: boolean, engaged: boolean, since: number, turn: number | null, step: number | null, baseMs: number | null, waiters: Set<() => void>, timer: any, missingAgent: number}>} */
  const sessions = new Map()

  function ensureState(sessionId) {
    let state = sessions.get(sessionId)
    if (state === undefined) {
      state = {
        sessionId,
        requested: false,
        engaged: false,
        since: 0,
        turn: null,
        step: null,
        // 暂停那一刻这一轮已经跑了多久（浏览器半上报）。存在这里，页面刷新 / 切走再回来
        // 时仍然按这个基准冻结，不会重新按墙钟算（那样会把暂停时间算进去）。
        baseMs: null,
        waiters: new Set(),
        timer: undefined,
        /** 连续几次快照没取到 agent；到 GHOST_TICKS 才从界面上藏起来。 */
        missingAgent: 0,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  /**
   * agent 还在不在。拿不准（抛错）时按「还在」算：宁可留一条看不见的状态，
   * 也绝不因为一次读取失败就把暂停放掉。
   * @param {string} sessionId - 会话 id
   * @returns {boolean} 是否还能取到 agent
   */
  function agentAlive(sessionId) {
    try {
      return getAgent(sessionId) !== undefined
    } catch {
      return true
    }
  }

  /**
   * 垃圾回收：只清理「既没在暂停、也没有计时基准」的条目。
   * 暂停中的状态绝不主动回收——闸门只由用户、回合终止或插件卸载松开。
   */
  function prune() {
    for (const [sessionId, state] of sessions) {
      if (state.requested || state.engaged) continue
      if (typeof state.baseMs === 'number' && typeof state.resumedAt === 'number') continue
      sessions.delete(sessionId)
    }
  }

  /**
   * 松开闸门：清状态、解掉所有等待者、停掉兜底定时器。
   * @param {object} state - 会话状态
   * @param {boolean} [keepClock] - 保留暂停基准（继续之后还要用它扣掉暂停时间）
   * @returns {boolean} 之前是否处于暂停
   */
  function release(state, keepClock = false) {
    const wasActive = state.requested || state.engaged
    state.requested = false
    state.engaged = false
    state.since = 0
    state.turn = null
    state.step = null
    state.missingAgent = 0
    if (!keepClock) {
      state.baseMs = null
      state.resumedAt = null
    }
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.waiters.size > 0) {
      const waiters = [...state.waiters]
      state.waiters.clear()
      for (const resolve of waiters) resolve()
    }
    return wasActive
  }

  /**
   * 在闸门前挂住，直到被放行或回合被取消。
   * @param {object} state - 会话状态
   * @param {AbortSignal | undefined} signal - 本回合的中止信号
   * @returns {Promise<void>}
   */
  function hold(state, signal) {
    return new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        state.waiters.delete(done)
        signal?.removeEventListener?.('abort', done)
        resolve()
      }
      state.waiters.add(done)
      signal?.addEventListener?.('abort', done, { once: true })
      if (signal?.aborted === true) done()
    })
  }

  /**
   * 可选的挂住超时兜底。默认关闭（engagedTimeoutMs = 0）：暂停之后用户不点继续就一直停着，
   * 只有「继续」、发新消息、这一轮被终止或插件卸载才会松开闸门。
   */
  function armTimeout(state) {
    if (engagedTimeoutMs <= 0) return
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (!state.engaged) return
      warn(`会话 ${state.sessionId} 暂停超过 ${Math.round(engagedTimeoutMs / 60_000)} 分钟无人继续，已自动恢复`)
      // 和「继续」一样保留基准并记下恢复时刻：这一轮还在跑，计时不该因此跳一下。
      release(state, true)
      if (typeof state.baseMs === 'number') state.resumedAt = Date.now()
    }, engagedTimeoutMs)
    if (typeof state.timer?.unref === 'function') state.timer.unref()
  }

  /**
   * 请求暂停。只有正在运行的会话可以暂停。
   * @param {string} sessionId - 会话 id
   * @returns {{ok: boolean, code?: string, message?: string}}
   */
  function requestPause(sessionId) {
    const agent = getAgent(sessionId)
    if (agent === undefined) {
      return { ok: false, code: 'session/unknown', message: '这个会话当前没有活着的 Agent' }
    }
    if (agent.status !== 'running') {
      return { ok: false, code: 'session/idle', message: '这个会话当前没有在运行' }
    }
    const state = ensureState(sessionId)
    state.missingAgent = 0
    if (state.since === 0) state.since = Date.now()
    // 先按「上一次继续到现在」把基准走一遍，再进入暂停。这样宿主持有的 baseMs 永远是
    // 此刻的准确值：浏览器半哪怕丢了本地状态（刷新、切走再回来），拿到的也不会是旧数字。
    if (typeof state.baseMs === 'number' && typeof state.resumedAt === 'number') {
      state.baseMs += Math.max(0, Date.now() - state.resumedAt)
    }
    state.requested = true
    state.resumedAt = null
    return { ok: true }
  }

  /**
   * 继续：放行闸门，并把基准保留下来（继续之后计时仍要扣掉暂停时间）。
   * @param {string} sessionId - 会话 id
   * @returns {{ok: boolean}}
   */
  function requestResume(sessionId) {
    const state = sessions.get(sessionId)
    if (state !== undefined) resumeKeepingClock(state)
    return { ok: true }
  }

  /**
   * `agent/pre-step` 监听体：暂停中则挂住。
   * @param {{agent?: object, signal?: AbortSignal, turn?: number, step?: number}} payload - 钩子载荷
   * @param {() => any} next - 放行到下一个监听器 / 循环本身
   * @returns {Promise<any>}
   */
  async function preStep(payload, next) {
    const sessionId = payload?.agent?.session?.header?.id
    const state = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
    if (state === undefined || !state.requested) return next()

    const signal = payload?.signal
    if (signal?.aborted === true) {
      release(state)
      return { kind: 'reject' }
    }

    state.engaged = true
    state.turn = typeof payload.turn === 'number' ? payload.turn : null
    state.step = typeof payload.step === 'number' ? payload.step : null
    armTimeout(state)
    try {
      await hold(state, signal)
    } finally {
      state.engaged = false
      state.turn = null
      state.step = null
      if (state.timer !== undefined) {
        clearTimeout(state.timer)
        state.timer = undefined
      }
    }

    // 挂住期间回合被取消：干净拒绝这一步（循环随后按取消路径收尾）。
    if (signal?.aborted === true) {
      release(state)
      return { kind: 'reject' }
    }
    return next()
  }

  /** 回合结束 / 用户又发了消息时自动恢复，避免暂停状态残留到下一轮。 */
  function onStatus(agent, status) {
    if (status === 'running') return
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId !== 'string') return
    const state = sessions.get(sessionId)
    if (state === undefined) return
    // 回合真的结束了：基准也一起清掉，下一轮重新开始计。
    release(state)
    // 没有基准要留给下一轮 → 这条状态可以立刻回收（否则 Map 会随会话数一直长）。
    if (typeof state.baseMs !== 'number') sessions.delete(sessionId)
  }

  /**
   * 恢复并保留基准（继续 / 用户发言都走这里）：之后计时仍要扣掉暂停时间。
   * @param {object} state - 会话状态
   */
  function resumeKeepingClock(state) {
    const hasBase = typeof state.baseMs === 'number'
    release(state, hasBase)
    if (hasBase) state.resumedAt = Date.now()
  }

  /**
   * 只有「用户自己发来的消息」才自动恢复暂停（source.kind === 'user'）。
   * 子代理结算、定时提醒、后台任务之类的唤醒不会偷偷解除暂停。
   * @param {object | undefined} agent - 目标 Agent
   * @param {object | undefined} message - 插入的 inbox 消息
   */
  function onInboxInserted(agent, message) {
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId !== 'string') return
    const source = message?.source
    if (source?.kind !== 'user') return
    const state = sessions.get(sessionId)
    if (state !== undefined && state.requested) resumeKeepingClock(state)
  }

  /**
   * 记录暂停基准：这一轮在暂停那一刻已经跑了多久（浏览器半上报）。
   * 存下来之后，页面刷新或切走会话再回来仍按这个数字冻结，不会重新按墙钟算。
   * 超限的脏数据一律拒绝（不夹紧）：夹紧会让计时数字往回跳，宁可让浏览器保留本地基准。
   * @param {string} sessionId - 会话 id
   * @param {number} elapsedMs - 浏览器上报的毫秒数
   * @returns {{ok: boolean, code?: string}}
   */
  function recordBaseline(sessionId, elapsedMs) {
    const state = sessions.get(sessionId)
    if (state === undefined || (!state.requested && !state.engaged)) {
      return { ok: false, code: 'session/not-paused' }
    }
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_BASELINE_MS) {
      return { ok: false, code: 'bad-elapsed' }
    }
    state.baseMs = Math.floor(elapsedMs)
    return { ok: true }
  }

  /** 快照：正在运行的会话 id + 已暂停的会话。 */
  function snapshot() {
    // 每次读取都是一次顺手回收：轮询 900ms 一次，垃圾条目不会堆积。
    prune()
    const running = []
    let agents = []
    try {
      agents = listAgents() ?? []
    } catch {
      agents = []
    }
    for (const agent of agents) {
      if (agent?.status !== 'running') continue
      const sessionId = agent?.session?.header?.id
      if (typeof sessionId === 'string') running.push(sessionId)
    }
    const paused = []
    const clocks = []
    for (const state of sessions.values()) {
      if (state.requested || state.engaged) {
        // agent 已经没了（会话被删 / 归档）的暂停条目：从界面上藏起来，但**不解除**——
        // 解除只可能发生在用户操作或回合终止。连续几次确认才藏，避免注册表抖动时图标闪。
        if (!agentAlive(state.sessionId)) {
          state.missingAgent = (state.missingAgent ?? 0) + 1
          if (state.missingAgent >= GHOST_TICKS) continue
        } else {
          state.missingAgent = 0
        }
        paused.push({
          sessionId: state.sessionId,
          engaged: state.engaged,
          since: state.since === 0 ? null : state.since,
          turn: state.turn,
          step: state.step,
          baseMs: typeof state.baseMs === 'number' ? state.baseMs : null,
        })
      } else if (typeof state.baseMs === 'number' && typeof state.resumedAt === 'number') {
        // 已经继续、但这一轮还没结束：告诉浏览器从哪个基准、什么时候开始接着算，
        // 这样刷新页面或切走再回来，暂停时间仍然不会被算进去。
        clocks.push({ sessionId: state.sessionId, baseMs: state.baseMs, resumedAt: state.resumedAt })
      }
    }
    return { running, paused, clocks }
  }

  /** 释放全部（插件卸载时）。 */
  function disposeAll() {
    for (const state of sessions.values()) release(state)
    sessions.clear()
  }

  return { requestPause, requestResume, recordBaseline, preStep, onStatus, onInboxInserted, snapshot, prune, disposeAll, sessions }
}

/**
 * @param {object} ctx - cordis 上下文
 * @param {object} [config] - 插件配置
 * @param {boolean} [config.enabled] - 总开关，默认 true
 * @param {number} [config.engagedTimeoutMs] - 可选的挂住超时，默认 0 = 永不自动放行
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const controller = createPauseController({
    listAgents: () => ctx.agents.list(),
    getAgent: (sessionId) => ctx.agents.get(sessionId),
    warn: (message) => ctx.logger?.warn?.(`[breather] ${message}`),
    engagedTimeoutMs: config.engagedTimeoutMs,
  })

  /** 路由注册失败这类问题必须喊出来：静默吞掉等于「装好了但没反应」。 */
  function reportError(message, error) {
    const text = `[breather] ${message}${error === undefined ? '' : `: ${error?.message ?? String(error)}`}`
    const logger = ctx.logger
    const write = typeof logger?.error === 'function'
      ? logger.error.bind(logger)
      : typeof logger?.warn === 'function' ? logger.warn.bind(logger) : console.error.bind(console)
    try {
      write(text)
    } catch {
      // 记日志本身失败不该影响插件加载
    }
  }

  /** JSON 响应，永远不缓存。 */
  function json(status, value) {
    return new Response(JSON.stringify(value), {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }

  async function handle(request) {
    if (request.method === 'GET') return json(200, controller.snapshot())
    if (request.method !== 'POST') return json(405, { ok: false, code: 'method-not-allowed' })

    let body
    try {
      body = await request.json()
    } catch {
      return json(400, { ok: false, code: 'bad-json' })
    }
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return json(400, { ok: false, code: 'missing-session' })

    if (body?.action === 'pause') {
      const result = controller.requestPause(sessionId)
      return json(200, { ...result, state: controller.snapshot() })
    }
    if (body?.action === 'resume') {
      const result = controller.requestResume(sessionId)
      return json(200, { ...result, state: controller.snapshot() })
    }
    if (body?.action === 'baseline') {
      const result = controller.recordBaseline(sessionId, body?.elapsedMs)
      return json(200, { ...result, state: controller.snapshot() })
    }
    return json(400, { ok: false, code: 'unknown-action' })
  }

  ctx.on('agent/pre-step', (payload, next) => controller.preStep(payload, next))
  ctx.on('agent/status', (payload) => controller.onStatus(payload?.agent, payload?.status))
  ctx.on('agent/inbox/inserted', (payload) => controller.onInboxInserted(payload?.agent, payload?.message))

  ctx.effect(() => () => controller.disposeAll(), 'breather: gate release')

  ctx.effect(() => {
    try {
      return ctx.connection.fetch.register({
        path: DEFAULT_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => handle(request),
      })
    } catch (error) {
      // 路由被别的插件占了：浏览器半会永远读不到状态。不能静默，否则看起来就像插件没装。
      reportError(`路由 ${DEFAULT_PATH} 注册失败（可能已被其他插件占用），浏览器半将无法工作`, error)
      return () => {}
    }
  }, `breather: ${DEFAULT_PATH}`)
}
