/**
 * dsh-breather — 浏览器半
 *
 * 在输入框右侧（`conversation.input.right`，list 插槽）加一个「暂停 / 继续」按钮：
 *  - 会话正在运行时显示「暂停」；
 *  - 点了之后，当前这一步跑完、下一次模型请求之前挂住，按钮变成「继续」；
 *  - 挂住之前显示「暂停中…」，再点一次可以取消这次暂停请求。
 *
 * 状态来源是宿主那条 `/api/session-pause` 路由（轮询，纯本机 HTTP，无 Remote、
 * 无生成代码）。所有已打开的会话共用一份快照，避免每个输入框各自打一份请求。
 */

window.__ModuleLoader__.load({
	id: 'dsh-breather',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')
		/** 失败提示要和按钮并列渲染，所以需要一个 Fragment；旧运行时退回字符串标记。 */
		const Fragment = React.Fragment ?? 'Fragment'

		const ENDPOINT = '/api/session-pause'
		const POLL_VISIBLE_MS = 900
		const POLL_HIDDEN_MS = 4000
		const STYLE_ID = 'dsh-breather/style'
		/** 样式版本：和 package.json 的 version 一起升，用来替换上一版留下的旧 <style>。 */
		const STYLE_VERSION = '0.3.2'
		/** 单个请求的上限；超时不是「失败」，是「结果未知 → 立刻重新同步」。 */
		const SEND_TIMEOUT_MS = 5000
		/** 连续两次 404 才认定宿主路由还没就绪，退到慢速探测（只降频，不放弃）。 */
		const HOST_MISSING_TICKS = 2
		const HOST_RETRY_MS = 20000
		/** 失败提示在按钮旁停留的时间。 */
		const NOTICE_TTL_MS = 5000

		//#region 文案
		//
		// 界面文案跟随核心的语言（`<html lang>`，退而求其次看 navigator.language）。
		// 惰性求值：测试里可以随时改 lang 再断言另一套文案。

		const STRINGS = {
			zh: {
				pause: '暂停',
				resume: '继续',
				pending: '暂停中…',
				idleTitle: '在当前步骤结束后、下一次模型请求之前暂停这一轮',
				pendingTitle: '暂停请求已发出：当前步骤结束后停住，点击可取消',
				pausedTitle: '已暂停，点击继续（从停住的地方接着跑，不重发请求）',
				degradedSuffix: '（部分接管失效：核心页面结构变了，详见控制台）',
				rowTitle: '已暂停，等待继续',
				rowAria: '已暂停',
				hoverPaused: '已暂停 · 点输入框旁的「继续」从停住的地方接着跑',
				hoverPending: '正在暂停：当前步骤结束后停住',
				pausedMarker: '已暂停',
				noticeEnded: '这一轮已经结束了',
				noticeNetwork: '暂停请求没送到宿主',
				noticeTimeout: '请求结果未知，正在核对状态',
			},
			en: {
				pause: 'Pause',
				resume: 'Resume',
				pending: 'Pausing…',
				idleTitle: 'Pause this turn after the current step, before the next model request',
				pendingTitle: 'Pause requested: it stops after the current step — click again to cancel',
				pausedTitle: 'Paused — click to resume from where it stopped, without re-sending the request',
				degradedSuffix: ' (partial takeover inactive: the core DOM changed, see console)',
				rowTitle: 'Paused, waiting to resume',
				rowAria: 'Paused',
				hoverPaused: 'Paused · click Resume beside the composer to continue from where it stopped',
				hoverPending: 'Pausing: stops after the current step',
				pausedMarker: 'Paused',
				noticeEnded: 'This turn already ended',
				noticeNetwork: 'The pause request did not reach the host',
				noticeTimeout: 'Request outcome unknown — re-checking state',
			},
		}

		/** 当前界面语言；核心把语言写在 `<html lang>` 上时以它为准，其余（含读不到）一律按英文。 */
		function lang() {
			try {
				const declared = typeof document !== 'undefined' && document.documentElement
					? document.documentElement.lang
					: ''
				if (typeof declared === 'string' && declared !== '') {
					return /^zh/i.test(declared) ? 'zh' : 'en'
				}
				const nav = typeof navigator !== 'undefined' ? String(navigator.language ?? '') : ''
				if (/^zh/i.test(nav)) return 'zh'
			} catch {
				// 读不到就按英文兜底
			}
			return 'en'
		}

		/** 取当前语言的一套文案。 */
		function t() {
			return STRINGS[lang()]
		}
		//#endregion

		/** 所有输入框共享的快照：{ running, paused, clocks, degraded, notices } */
		let snapshot = { running: [], paused: [], clocks: [], degraded: {}, notices: {} }
		let snapshotKey = ''
		const listeners = new Set()
		/** 接管失效登记：只报一次，并让按钮的 title 显示出来。 */
		const degraded = { rows: false, timer: false }
		/** 一次性的失败提示：sessionId → { text, until }。只在宿主明确说不的时候用。 */
		const notices = new Map()
		let pollTimer
		let polling = false
		let inFlight = false
		/** 轮询代数：停止 / 重开时 +1，用来丢弃上一代还在路上的响应。 */
		let pollGeneration = 0
		let missingTicks = 0
		let hostMissing = false
		let reportedFailure = false

		function notifyListeners() {
			for (const listener of [...listeners]) listener()
		}

		/** 尚未过期的失败提示（喂给组件，不出现在 dedupe key 里）。 */
		function noticesObject() {
			// 用无原型对象：sessionId 当键，别让 __proto__ 之类的值从原型上读出一个字符串。
			const value = Object.create(null)
			const now = Date.now()
			for (const [sessionId, entry] of notices) {
				if (entry.until > now) value[sessionId] = entry.text
			}
			return value
		}

		/**
		 * 说一句「这次没成」。话只说一遍，到点自己消失；不替代按钮上的状态文字，
		 * 否则用户会看不出它现在到底是不是暂停着。
		 * @param {string} sessionId - 会话 id
		 * @param {string} text - 要说的话
		 */
		function setNotice(sessionId, text) {
			if (typeof sessionId !== 'string' || sessionId === '' || text === '') return
			notices.set(sessionId, { text, until: Date.now() + NOTICE_TTL_MS })
			snapshot = { ...snapshot, notices: noticesObject() }
			notifyListeners()
			const handle = setTimeout(() => {
				const entry = notices.get(sessionId)
				if (entry === undefined || entry.until > Date.now()) return
				notices.delete(sessionId)
				snapshot = { ...snapshot, notices: noticesObject() }
				notifyListeners()
			}, NOTICE_TTL_MS + 30)
			if (typeof handle?.unref === 'function') handle.unref()
		}

		/**
		 * 快照去重用的键。刻意不含 degraded / notices：那两样是本地提示，
		 * 由各自的通知路径推送，不该让轮询把过期的提示又「复活」一遍。
		 */
		function snapshotKeyOf(value) {
			const running = Array.isArray(value?.running) ? value.running : []
			const paused = Array.isArray(value?.paused) ? value.paused : []
			const clocks = Array.isArray(value?.clocks) ? value.clocks : []
			return JSON.stringify([
				running.slice().sort(),
				paused
					.map((entry) => [entry.sessionId, entry.engaged === true, entry.since, entry.turn, entry.step, entry.baseMs])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
				clocks
					.map((entry) => [entry.sessionId, entry.baseMs, entry.resumedAt])
					.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
			])
		}

		function publish(value) {
			const next = {
				running: Array.isArray(value?.running) ? value.running : [],
				paused: Array.isArray(value?.paused) ? value.paused : [],
				clocks: Array.isArray(value?.clocks) ? value.clocks : [],
				degraded: { ...degraded },
				notices: noticesObject(),
			}
			const key = snapshotKeyOf(next)
			if (key === snapshotKey) return
			snapshotKey = key
			snapshot = next
			notifyListeners()
		}

		/**
		 * 登记一处「接管失效」：核心的 DOM 钩子改名了、或者结构换掉了。
		 * 只在第一次报控制台，并让所有停靠点重渲染一次（按钮 title 会带出来），
		 * 其余功能不受影响——失效的样子是「回到原样」，不是「弄坏界面」。
		 * @param {string} kind - 失效的种类（rows / timer）
		 * @param {string} message - 报给用户的一句话
		 */
		function degrade(kind, message) {
			if (degraded[kind] === true) return
			degraded[kind] = true
			recoverTicks[kind] = 0
			console.warn(`[breather] ${message}；其余功能正常`)
			snapshot = { ...snapshot, degraded: { ...degraded } }
			notifyListeners()
		}

		/** 恢复计数：钩子重新出现要连续两次才相信，避免一抖动就来回报。 */
		const recoverTicks = { rows: 0, timer: 0 }

		/**
		 * 接管恢复：之前登记过失效、现在钩子又能用上了，把标记撤掉。
		 * 连续两次看到钩子才清（`degrade` 之后恢复计数从 0 开始）。
		 * @param {string} kind - 失效的种类（rows / timer）
		 */
		function recover(kind) {
			if (degraded[kind] !== true) {
				recoverTicks[kind] = 0
				return
			}
			recoverTicks[kind] += 1
			if (recoverTicks[kind] < 2) return
			recoverTicks[kind] = 0
			degraded[kind] = false
			console.info(`[breather] ${kind} 接管已恢复`)
			snapshot = { ...snapshot, degraded: { ...degraded } }
			notifyListeners()
		}

		//#region 侧栏会话行：暂停的会话把转圈换成暂停图标
		//
		// 侧栏每一行是 `[data-row-key="session:<id>"]`，运行中的行在 leading 里渲染
		// StateDot：`svg[data-state="ongoing"]` 里两个 circle 转圈。核心里这个位置是二选一
		// （有状态时画点，没状态时才渲染 `sidebar.session.row.leading` 插槽），所以运行中
		// 的行拿不到插槽。两条路：
		//  - 默认（不改核心）：给暂停的行打属性，CSS 藏掉那个 svg，用 mask 画暂停符号；
		//  - 打了 tools/patch-core-row-slot.mjs 之后：插槽会挂到行首，图标改由真实插槽
		//    渲染，mask 规则自动让位（html[data-dshp-rowslot]）。
		// 两条路都只认 data 属性，不碰 hashed class；钩子被改名时由自检报出来（degrade）。

		const ROW_MARK = 'data-dsh-paused-session'
		const ROW_KEY_PREFIX = 'session:'
		const ROW_SLOT_FLAG = 'data-dshp-rowslot'
		/** 插槽渲染的行首图标上的属性（CSS 靠它自己算该藏谁，不再依赖行标记）。 */
		const ROW_ICON = 'data-dshp-row-icon'
		/** 行钩子的候选选择器：核心改掉其中一个时还能从另一个认出来。 */
		const ROW_SELECTORS = [`[data-row-key^="${ROW_KEY_PREFIX}"]`, '[role="treeitem"][data-row-key]']
		const PAUSE_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Crect x='1.6' y='1' width='2.3' height='8' rx='1.1' fill='%23000'/%3E%3Crect x='6.1' y='1' width='2.3' height='8' rx='1.1' fill='%23000'/%3E%3C/svg%3E\")"

		function hasDom() {
			return typeof document !== 'undefined' && typeof document.querySelectorAll === 'function'
		}

		/** 核心补丁是否在生效：由插槽组件在真的画出暂停图标时置位。 */
		function slotModeOn() {
			if (!hasDom()) return false
			const root = document.documentElement
			if (root === undefined || root === null || typeof root.getAttribute !== 'function') return false
			return root.getAttribute(ROW_SLOT_FLAG) === '1'
		}

		/** 收集侧栏会话行；认不出 id 的行跳过。 */
		function sessionRows() {
			if (!hasDom()) return []
			const rows = []
			const seen = new Set()
			for (const selector of ROW_SELECTORS) {
				let nodes = []
				try {
					nodes = Array.from(document.querySelectorAll(selector))
				} catch {
					nodes = []
				}
				for (const row of nodes) {
					if (seen.has(row)) continue
					const key = typeof row.getAttribute === 'function' ? row.getAttribute('data-row-key') : null
					if (typeof key !== 'string' || !key.startsWith(ROW_KEY_PREFIX)) continue
					// 只认 `session:<id>` / `session:<id>:<suffix>`；别的键（workspace:…）一律不当会话行，
					// 免得把工作区分组行也打上暂停标记。
					const sessionId = key.slice(ROW_KEY_PREFIX.length).split(':')[0]
					if (sessionId === '') continue
					seen.add(row)
					rows.push({ row, sessionId })
				}
			}
			return rows
		}

		/**
		 * 行还在、但整页都没有任何 data-row-key → 核心把键的约定换掉了。
		 * 要求「整页一个都没有」，避免把别的树形控件（文件树等）误判成会话行改名。
		 */
		function rowHookRenamed() {
			if (!hasDom()) return false
			let treeitems = []
			let keyed = []
			try {
				treeitems = Array.from(document.querySelectorAll('[role="treeitem"]'))
				keyed = Array.from(document.querySelectorAll('[data-row-key]'))
			} catch {
				return false
			}
			if (treeitems.length === 0) return false
			if (keyed.length > 0) return false
			return true
		}

		/** 给「已经挂住」的会话行打标记，其余行清掉；每秒随轮询对齐一次。 */
		function markPausedRows() {
			// 借每次轮询对一遍：宿主那边的基准没了（换轮/结束）就交还核心计时。
			reconcileTimer()
			if (!hasDom()) return
			// 补丁模式：图标由插槽渲染，核心状态点也由 CSS 按「有没有我们的图标」自己隐藏，
			// 所以这里不再给行打属性——不打标记、也不需要行键，顺带省掉一轮全表扫描。
			if (slotModeOn()) {
				clearPausedRows()
				return
			}
			const rows = sessionRows()
			if (rows.length === 0 && rowHookRenamed()) {
				degrade('rows', '侧栏会话行的 data-row-key 钩子找不到了，暂停图标不会显示')
			} else if (rows.length > 0) {
				recover('rows')
			}
			const engaged = new Set()
			for (const entry of snapshot.paused) {
				if (entry.engaged === true) engaged.add(String(entry.sessionId))
			}
			for (const { row, sessionId } of rows) {
				if (engaged.has(sessionId)) {
					if (row.getAttribute(ROW_MARK) !== '1') row.setAttribute(ROW_MARK, '1')
				} else if (typeof row.removeAttribute === 'function') {
					row.removeAttribute(ROW_MARK)
				}
			}
		}

		function clearPausedRows() {
			if (!hasDom()) return
			for (const row of document.querySelectorAll(`[${ROW_MARK}]`)) {
				if (typeof row.removeAttribute === 'function') row.removeAttribute(ROW_MARK)
			}
		}
		//#endregion

		function schedulePoll() {
			if (!polling) return
			if (pollTimer !== undefined) {
				clearTimeout(pollTimer)
				pollTimer = undefined
			}
			const delay = hostMissing
				? HOST_RETRY_MS
				: typeof document !== 'undefined' && document.visibilityState === 'hidden'
					? POLL_HIDDEN_MS
					: POLL_VISIBLE_MS
			pollTimer = setTimeout(poll, delay)
			if (typeof pollTimer?.unref === 'function') pollTimer.unref()
		}

		/**
		 * 宿主路由 404（插件被禁用 / 还没注册上）：降频继续探活，**不永久关掉**。
		 * 一次 404 就藏按钮的话，DSH 启动早期的那次探空会让功能凭空消失、还没入口解释。
		 */
		function noteHostMissing() {
			missingTicks += 1
			if (missingTicks < HOST_MISSING_TICKS || hostMissing) return
			hostMissing = true
			console.info(`[breather] 宿主路由还没就绪（404），已降到每 ${Math.round(HOST_RETRY_MS / 1000)} 秒探测一次`)
			publish({ running: [], paused: [], clocks: [] })
			clearPausedRows()
		}

		function noteHostPresent() {
			missingTicks = 0
			if (hostMissing !== true) return
			hostMissing = false
			console.info('[breather] 宿主路由已恢复')
		}

		async function poll() {
			if (!polling || inFlight) return
			const generation = pollGeneration
			inFlight = true
			try {
				const response = await fetch(ENDPOINT, {
					method: 'GET',
					headers: { accept: 'application/json' },
					cache: 'no-store',
					credentials: 'same-origin',
				})
				// 等响应期间可能已经停过轮询（组件卸载）又重开过：上一代的结果不能再用，
				// 否则会把刚清掉的旧快照又刷回界面上。
				if (generation !== pollGeneration) return
				if (response.status === 404) {
					noteHostMissing()
					return
				}
				if (!response.ok) throw new Error(`HTTP ${response.status}`)
				noteHostPresent()
				const body = await response.json()
				if (generation !== pollGeneration) return
				publish(body)
				markPausedRows()
				reportedFailure = false
			} catch (error) {
				if (!reportedFailure) {
					reportedFailure = true
					console.warn('[breather] 读取暂停状态失败（宿主插件可能未加载）:', error)
				}
			} finally {
				inFlight = false
				schedulePoll()
			}
		}

		/** 立刻重新读一次宿主状态（POST 结果未知时用）：界面必须跟着真相走，不能停在猜的状态。 */
		async function refreshNow() {
			if (!polling) return
			if (pollTimer !== undefined) {
				clearTimeout(pollTimer)
				pollTimer = undefined
			}
			await poll()
		}

		function startPolling() {
			if (polling) return
			polling = true
			pollGeneration += 1
			poll()
		}

		function stopPolling() {
			polling = false
			pollGeneration += 1
			inFlight = false
			if (pollTimer !== undefined) {
				clearTimeout(pollTimer)
				pollTimer = undefined
			}
			clearPausedRows()
			// 不保留过期快照：重新订阅时要先拿到宿主的真相，别拿上一轮的残影去渲染。
			snapshot = { running: [], paused: [], clocks: [], degraded: { ...degraded }, notices: noticesObject() }
			snapshotKey = ''
			reportedFailure = false
			missingTicks = 0
			hostMissing = false
		}

		/**
		 * 发一条动作给宿主。
		 * 超时**不等于**失败：POST 可能已经落地了。所以超时后不报错，而是立刻重新读一次
		 * 真实状态，让界面跟着真相走——「失败提示」只在宿主明确回绝时才用。
		 * @param {string} action - pause / resume / baseline
		 * @param {string} sessionId - 会话 id
		 * @param {object} [extra] - 附加字段
		 * @returns {Promise<{ok?: boolean, code?: string, unknown?: boolean, state?: object}>} 宿主响应
		 */
		async function send(action, sessionId, extra) {
			const controller = typeof AbortController === 'function' ? new AbortController() : undefined
			const handle = controller === undefined ? undefined : setTimeout(() => controller.abort(), SEND_TIMEOUT_MS)
			if (typeof handle?.unref === 'function') handle.unref()
			try {
				const response = await fetch(ENDPOINT, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json' },
					cache: 'no-store',
					credentials: 'same-origin',
					body: JSON.stringify({ action, sessionId, ...extra }),
					signal: controller?.signal,
				})
				const payload = await response.json().catch(() => undefined)
				if (payload?.state !== undefined) publish(payload.state)
				markPausedRows()
				return payload ?? { ok: false, code: 'transport', unknown: true }
			} catch (error) {
				console.warn('[breather] 暂停请求没送达，正在重新读取状态:', error)
				refreshNow()
				return { ok: false, code: 'transport', unknown: true }
			} finally {
				if (handle !== undefined) clearTimeout(handle)
			}
		}

		function subscribe(listener) {
			listeners.add(listener)
			startPolling()
			return () => {
				listeners.delete(listener)
				if (listeners.size === 0) stopPolling()
			}
		}

		function getSnapshot() {
			return snapshot
		}

		/** React 18 的 useSyncExternalStore；旧运行时退化成 useState + effect。 */
		const usePauseSnapshot = typeof React.useSyncExternalStore === 'function'
			? () => React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
			: () => {
				const [value, setValue] = React.useState(getSnapshot)
				React.useEffect(() => subscribe(() => setValue(getSnapshot())), [])
				return value
			}

		/** 样式装了没有；同一次页面里只查一次 DOM，省掉每次 apply 的选择器查询。 */
		let styleInstalled = false

		/**
		 * 注入样式。
		 * 判重不能只看「有没有这个选择器」：插件升版之后旧的 `<style>` 还在文档里，
		 * 新 CSS 永远不生效，而且刷新前不会有任何提示。所以按版本号判，版本不同就换掉。
		 */
		function installStyle() {
			if (typeof document === 'undefined') return
			if (styleInstalled === true) return
			let existing = null
			try {
				existing = typeof document.querySelector === 'function'
					? document.querySelector(`style[data-plugin-style="${STYLE_ID}"]`)
					: null
			} catch {
				existing = null
			}
			if (existing !== null) {
				const version = typeof existing.getAttribute === 'function'
					? existing.getAttribute('data-plugin-version')
					: null
				if (version === STYLE_VERSION) {
					styleInstalled = true
					return
				}
				// 上一版留下的旧样式：删掉重装，别让过期 CSS 一直生效
				if (typeof existing.remove === 'function') existing.remove()
				else if (existing.parentNode !== null && existing.parentNode !== undefined
					&& typeof existing.parentNode.removeChild === 'function') existing.parentNode.removeChild(existing)
			}
			const style = document.createElement('style')
			style.dataset.plugin = 'dsh-breather'
			style.dataset.pluginStyle = STYLE_ID
			style.dataset.pluginVersion = STYLE_VERSION
			style.textContent = [
				'.dshp-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;margin-right:4px;',
				'border:.5px solid var(--dsw-alias-border-l4,rgba(128,128,128,.32));border-radius:999px;background:transparent;',
				'color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:12px;line-height:1;white-space:nowrap;',
				'cursor:pointer;user-select:none;transition:background .12s ease,color .12s ease,border-color .12s ease}',
				'.dshp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));',
				'color:var(--dsw-alias-label-primary,inherit)}',
				'.dshp-btn:disabled{opacity:.55;cursor:default}',
				'.dshp-btn[data-paused="true"]{border-color:var(--dsw-static-neutral-bluish-400,#4d6bfe);',
				'color:var(--dsw-static-neutral-bluish-400,#4d6bfe)}',
				'.dshp-btn[data-pending="true"]{opacity:.72}',
				'.dshp-icon{display:block;flex:none}',
				// 由插槽渲染的行首图标（只有打了核心补丁才走这条路）。
				'.dshp-row-icon{display:inline-flex;align-items:center;justify-content:center;',
				'width:14px;height:14px;flex:none;color:var(--dsw-static-neutral-bluish-400,#4d6bfe)}',
				// 行悬停卡里的状态字（上游插槽，永远反映真实状态）。
				'.dshp-hover{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}',
				// 暂停时把这一个计时器的扫光动画也停掉（只标它自己，别影响子代理的）。
				'[' + TIMER_PAUSED_ATTR + '] *{animation-play-state:paused!important}',
				// 侧栏：暂停的会话行藏掉转圈。
				'[' + ROW_MARK + '] svg[data-state="ongoing"]{display:none}',
				// 补丁模式：藏状态点改成「按我们的图标自己算」——不依赖行标记，也不会和图标不同步。
				// 两条规则，兼容插槽返回 Fragment（图标是兄弟）或被包一层（用行做锚点）两种结构。
				'[data-row-key]:has([' + ROW_ICON + ']) svg[data-state="ongoing"]{display:none}',
				'*:has(> [' + ROW_ICON + ']) > *:not([' + ROW_ICON + ']) svg[data-state="ongoing"]{display:none}',
				// 没打核心补丁时用 mask 在行首补一个暂停符号；打了补丁（html[data-dshp-rowslot]）
				// 就交给插槽渲染，别画两遍。
				// 用 :has 兜住——只有这一行确实在转圈时才替换，等待审批等状态不要被盖掉。
				'html:not([' + ROW_SLOT_FLAG + ']) [' + ROW_MARK + ']:has(svg[data-state="ongoing"]) > span:first-child::before{',
				'content:"";display:inline-block;width:14px;height:14px;',
				'vertical-align:middle;background-color:var(--dsw-static-neutral-bluish-400,#4d6bfe);',
				'-webkit-mask:' + PAUSE_MASK + ' center/10px 10px no-repeat;',
				'mask:' + PAUSE_MASK + ' center/10px 10px no-repeat}',
				// 一次性失败提示：贴在按钮右边，不抢按钮自己的状态文字。
				'.dshp-notice{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.9));',
				'margin-right:4px;white-space:nowrap}',
			].join('')
			document.head.appendChild(style)
			styleInstalled = true
		}

		function PauseIcon() {
			return React.createElement('svg', {
				className: 'dshp-icon',
				width: 10,
				height: 10,
				viewBox: '0 0 10 10',
				'aria-hidden': 'true',
			}, React.createElement('rect', { x: 1.5, y: 1, width: 2.5, height: 8, rx: 1, fill: 'currentColor' }),
			React.createElement('rect', { x: 6, y: 1, width: 2.5, height: 8, rx: 1, fill: 'currentColor' }))
		}

		function PlayIcon() {
			return React.createElement('svg', {
				className: 'dshp-icon',
				width: 10,
				height: 10,
				viewBox: '0 0 10 10',
				'aria-hidden': 'true',
			}, React.createElement('path', { d: 'M2 1.2 L8.4 5 L2 8.8 Z', fill: 'currentColor' }))
		}

		//#region 运行计时器：暂停时冻住，继续后扣掉暂停时间
		//
		// 那个计时器由 chat 插件的 RunningStatus 渲染：它只判断「会话是否在运行」，并且
		// 每秒用 Date.now() - startTime 重算一遍，所以暂停后数字还在跳、继续后还会把暂停
		// 那段时间一次性补上。核心没给这段文案留插槽，这里用 MutationObserver 在 React
		// 提交之后、绘制之前把文案换成自己的值：
		//  - 暂停：显示「已暂停 · 累计用时」；
		//  - 继续：显示「前缀 +（墙钟 − 累计暂停）+ 后缀」，暂停的时间不再计入。
		// 前缀/后缀/单位都从第一份真实文案里抓，不猜语言、不硬编码模板。

		const RUNNING_SELECTOR = '[data-chat-running]'
		/** 聊天节点的钩子：子代理内嵌会话的那些计时器长在节点里面，主对话的在节点外面。 */
		const TIMER_NODE_SELECTOR = '[data-chat-node-key]'
		/** 见过计时器之后又连续找不到：6 次（700ms 一次 ≈ 4.2 秒）就判定钩子失效。 */
		const TIMER_MISSING_TICKS_SEEN = 6
		/** 从没找到过（刚刷新/刚打开会话）：给 20 次（≈14 秒）宽限，别把「还没渲染出来」误判成失效。 */
		const TIMER_MISSING_TICKS_COLD = 20
		/** TextShimmer 扫光层的文字属性（CSS 用 :after{content:attr(...)} 渲染）。 */
		const SHIMMER_ATTR = 'data-shimmer-text'
		/** 标在计时器元素上，用来只冻结这一个计时器的动画（不影响子代理内嵌会话的）。 */
		const TIMER_PAUSED_ATTR = 'data-dsh-timer-paused'
		const TIMER_REATTACH_MS = 700

		/** 时长单位表：与 chat 插件的 formatRunDuration 对齐（中文「1分23秒」、英文「2m 5s」）。 */
		const DURATION_UNITS = {
			zh: [{ unit: '小时', ms: 3600000 }, { unit: '分', ms: 60000 }, { unit: '秒', ms: 1000 }],
			en: [{ unit: 'h ', ms: 3600000 }, { unit: 'm ', ms: 60000 }, { unit: 's', ms: 1000 }],
		}

		let timer

		function hasCjk(text) {
			return /[\u3400-\u9fff]/.test(text)
		}

		function unitsFor(text) {
			return hasCjk(text) ? DURATION_UNITS.zh : DURATION_UNITS.en
		}

		/**
		 * 从一段文案里认出时长部分，顺带把前后缀带出来。
		 * @param {string} text - 例如「深度求索中，用时 1分23秒 …」
		 * @returns {{ms: number, prefix: string, suffix: string, units: object[]} | undefined} 解析结果
		 */
		function parseDuration(text) {
			const value = String(text)
			const units = unitsFor(value)
			const alternatives = units.map((entry) => entry.unit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
			const pattern = new RegExp(`(\\d+)(${alternatives})`, 'g')
			let ms = 0
			let start = -1
			let end = -1
			let match
			while ((match = pattern.exec(value)) !== null) {
				const entry = units.find((candidate) => candidate.unit === match[2])
				if (entry === undefined) continue
				ms += Number(match[1]) * entry.ms
				if (start === -1) start = match.index
				end = match.index + match[0].length
			}
			if (start === -1) return undefined
			return { ms, prefix: value.slice(0, start), suffix: value.slice(end), units }
		}

		/**
		 * 按 chat 插件的规则把毫秒写成时长文案：有小时才写小时，满 60 秒才写分钟，秒必写。
		 * @param {number} ms - 时长
		 * @param {object[]} units - 单位表
		 * @returns {string} 例如「1分23秒」
		 */
		function formatDuration(ms, units) {
			const total = Math.max(0, Math.floor(ms / 1000))
			const hours = Math.floor(total / 3600)
			const minutes = Math.floor(total / 60) % 60
			const seconds = total % 60
			let text = ''
			if (hours > 0) text += `${hours}${units[0].unit}`
			if (total >= 60) text += `${minutes}${units[1].unit}`
			text += `${seconds}${units[2].unit}`
			return text
		}

		/**
		 * 可见文案里的文本节点（跳过 aria-live 的隐藏说明）。
		 * 只有 TextShimmer 的基础层是文本节点；扫光高亮层的文字在 `data-shimmer-text`
		 * 属性里（见 shimmerTextElements），两层都要写。
		 * @param {object} root - 计时器根元素
		 * @returns {object[]} 文本节点，按文档顺序
		 */
		function labelTextNodes(root) {
			if (root === null || root === undefined || typeof document.createTreeWalker !== 'function') return []
			const walker = document.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */)
			const nodes = []
			let node
			while ((node = walker.nextNode()) !== null) {
				const value = node.nodeValue
				if (value === null || value === undefined || value.trim() === '') continue
				const parent = node.parentElement
				if (parent !== null && parent !== undefined && typeof parent.closest === 'function'
					&& parent.closest('[role="status"]') !== null) continue
				nodes.push(node)
			}
			return nodes
		}

		/**
		 * 同屏可能同时有主对话和子代理内嵌会话的计时器。子代理那些在聊天节点里面，
		 * 主对话的在节点外面。认不出来时**一个都不碰**：宁可让计时继续走，
		 * 也不能把别人的数字改成我们的（那是「主动显示错信息」，比不接管更糟）。
		 * @returns {object[]} 应当接管的计时器元素（可能是空数组）
		 */
		function runningElements() {
			if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return []
			const all = Array.from(document.querySelectorAll(RUNNING_SELECTOR))
			if (all.length <= 1) return all
			const free = all.filter((element) => !isNestedTimer(element))
			return free.length === 1 ? free : []
		}

		/** 这个计时器是不是长在某个聊天节点（子代理内嵌会话）里面。 */
		function isNestedTimer(element) {
			if (element === null || element === undefined || typeof element.closest !== 'function') return false
			try {
				return element.closest(TIMER_NODE_SELECTOR) !== null
			} catch {
				return false
			}
		}

		/** 页面上有几个计时器：用来区分「钩子没了」和「有多个但认不出哪个是我们的」。 */
		function timerElementCount() {
			if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return 0
			return document.querySelectorAll(RUNNING_SELECTOR).length
		}

		/** 扫光层的文字承载元素（TextShimmer 用属性 + CSS :after 渲染，没有文本节点）。 */
		function shimmerTextElements(root) {
			if (root === null || root === undefined || typeof root.querySelectorAll !== 'function') return []
			return Array.from(root.querySelectorAll(`[${SHIMMER_ATTR}]`))
		}

		/** 从当前页面上的计时器文案里抓一份基准（第一次暂停时用）。 */
		function captureTimer() {
			for (const element of runningElements()) {
				for (const node of labelTextNodes(element)) {
					const parsed = parseDuration(node.nodeValue)
					if (parsed !== undefined) return parsed
				}
			}
			return undefined
		}

		/** 这一轮已经跑了多久（暂停时冻住）。还没抓到基准时返回 undefined。 */
		function timerMs() {
			const state = timer
			if (state === undefined || state.captured !== true) return undefined
			return state.phase === 'paused'
				? state.baseMs
				: state.baseMs + Math.max(0, Date.now() - state.resumedAt)
		}

		/**
		 * 按某一份文案的形状渲染：前后缀用这份文案自己的，绝不拿别人的模板去套。
		 * @param {{prefix: string, suffix: string, units: object[]}} shape - 形状
		 * @param {boolean} [includeMarker] - 暂停时是否整句换成「已暂停 · X」
		 * @returns {string | undefined} 渲染结果
		 */
		function renderShape(shape, includeMarker = true) {
			const state = timer
			const elapsed = timerMs()
			if (state === undefined || elapsed === undefined) return undefined
			const duration = formatDuration(elapsed, shape.units)
			if (state.phase === 'paused' && includeMarker) return `${state.marker} · ${duration}`
			return `${shape.prefix}${duration}${shape.suffix}`
		}

		/** 当前该显示的整句文案（按第一次抓到的全局形状）。还没抓到基准时返回 undefined。 */
		function timerText() {
			const state = timer
			if (state === undefined || state.captured !== true) return undefined
			return renderShape({ prefix: state.prefix, suffix: state.suffix, units: state.units })
		}

		/**
		 * 记住这个节点/元素自己的前后缀与单位：**第一次**见到（还没被我们改过）时从真实
		 * 文案里抓。之后不再重新解析——「已暂停 · 1分23秒」要是被当成新文案，
		 * 前缀就变成「已暂停 · 」，继续之后会拼出错的句子。
		 * @param {object} target - 文本节点或扫光元素
		 * @param {string} text - 它当前的文案
		 * @returns {{prefix: string, suffix: string, units: object[]} | undefined} 形状
		 */
		function shapeOf(target, text) {
			const state = timer
			if (state === undefined || target === null || target === undefined) return undefined
			const known = state.shapes.get(target)
			if (known !== undefined) return known
			const parsed = parseDuration(text)
			if (parsed === undefined) return undefined
			const shape = { prefix: parsed.prefix, suffix: parsed.suffix, units: parsed.units }
			state.shapes.set(target, shape)
			return shape
		}

		/**
		 * 把每个计时器的可见文案换成我们的值。
		 * 只动「本来就装着时长」的节点和扫光属性——容器里别的文字（标签、隐藏说明）
		 * 一个字都不碰：核心哪天把时长拆成两个节点，也不会写出「1分23秒1分23秒」。
		 * TextShimmer 的扫光高亮层没有文本节点，文字在 `data-shimmer-text` 属性里，
		 * 由 CSS `._text:after{content:attr(...)}` 渲染，所以属性也要一起写。
		 */
		function enforceTimer() {
			const state = timer
			if (state === undefined || state.captured !== true) return
			for (const element of runningElements()) {
				const nodes = labelTextNodes(element)
				// 只有一个文本节点 = 整句都是它，可以换成「已暂停 · X」；
				// 拆成多段时只冻结里面的数字，不能把标签吃掉。
				const single = nodes.length === 1
				for (const node of nodes) {
					const shape = shapeOf(node, node.nodeValue)
					if (shape === undefined) continue
					const text = renderShape(shape, single)
					if (text === undefined || node.nodeValue === text) continue
					try {
						node.nodeValue = text
					} catch {
						// 文本节点被 React 换掉时可能写不进去；下一轮 reattach 会重新抓。
					}
				}
				for (const shimmer of shimmerTextElements(element)) {
					const current = typeof shimmer.getAttribute === 'function' ? shimmer.getAttribute(SHIMMER_ATTR) : null
					const shape = shapeOf(shimmer, current === null ? '' : current)
					if (shape === undefined) continue
					const text = renderShape(shape, true)
					if (text === undefined || current === text) continue
					try {
						shimmer.setAttribute(SHIMMER_ATTR, text)
					} catch {
						// 同上：下一轮 reattach 会再试。
					}
				}
			}
		}

		/**
		 * 宿主那边已经没有这一轮的基准了（换轮 / 回合结束 / 宿主重启）→ 本地接管作废。
		 * 不能靠「核心写的墙钟比基准小」来判断：React 每秒才写一次文案，后台标签页还会被
		 * 节流到每分钟一次，文案很容易滞后于我们的基准，那样会误判成换轮、把接管掐掉。
		 * @param {number} graceMs - 刚继续之后的宽限，避免与在途的轮询响应抢跑
		 */
		function reconcileTimer(graceMs = 3000) {
			const state = timer
			if (state === undefined || state.phase !== 'offset') return
			if (typeof state.sessionId !== 'string' || typeof state.resumedAt !== 'number') return
			// 这一轮又暂停了（含还没挂住的「暂停中…」）：此时宿主本来就不给 clock，
			// 不能当成换轮——本地基准要留着，等闸门挂住时接着用。
			if (snapshot.paused.some((entry) => entry.sessionId === state.sessionId)) return
			if (Date.now() - state.resumedAt < graceMs) return
			if (snapshot.clocks.some((entry) => entry.sessionId === state.sessionId)) return
			stopTimerOverride()
		}
		function observeElement(element) {
			const state = timer
			if (state === undefined || state.observed.has(element)) return
			state.observed.add(element)
			state.observer.observe(element, {
				subtree: true,
				characterData: true,
				childList: true,
				attributes: true,
				attributeFilter: [SHIMMER_ATTR],
			})
		}

		/**
		 * 从真实文案里吸收前缀/后缀/单位（只在第一次成功时生效）。
		 * @param {object | undefined} captured - captureTimer() 的结果
		 * @returns {boolean} 是否已经有可用的文案基准
		 */
		function adoptCapture(captured) {
			const state = timer
			if (state === undefined) return false
			if (state.captured === true) return true
			if (captured === undefined) return false
			state.prefix = captured.prefix
			state.suffix = captured.suffix
			state.units = captured.units
			// 「已暂停」这几个字是我们自己写的，没有地方可以从文案里抓：有前缀就跟着前缀的
			// 语言走（和时长单位同一个来源），前缀是空的（只抓到数字）才回退到界面语言。
			const prefix = String(captured.prefix ?? '').trim()
			state.marker = prefix === ''
				? t().pausedMarker
				: hasCjk(prefix) ? STRINGS.zh.pausedMarker : STRINGS.en.pausedMarker
			if (typeof state.baseMs !== 'number') state.baseMs = captured.ms
			state.captured = true
			return true
		}

		/** 相机上报基准（只在还没上报过、且确实处于暂停时）。 */
		function maybeSendBaseline() {
			const state = timer
			if (state === undefined || state.baselineSent === true) return
			if (state.captured !== true || state.phase !== 'paused') return
			if (typeof state.sessionId !== 'string' || typeof state.baseMs !== 'number') return
			state.baselineSent = true
			send('baseline', state.sessionId, { elapsedMs: Math.floor(state.baseMs) }).then((payload) => {
				if (payload?.ok === true) return
				// 只有「结果未知」才重试。宿主明确拒了（比如那一瞬间已经不在暂停）就停手，
				// 否则每 700ms 一发会变成小风暴；本地基准还在，显示不受影响。
				if (payload?.unknown === true && timer === state) state.baselineSent = false
			})
		}

		/** 只冻结我们接管的那几个计时器的动画，别把子代理内嵌会话的扫光也停了。 */
		function markTimerElements() {
			const state = timer
			if (state === undefined || typeof document === 'undefined') return
			const paused = state.phase === 'paused'
			for (const element of runningElements()) {
				if (typeof element.setAttribute !== 'function') continue
				if (paused) {
					if (element.getAttribute(TIMER_PAUSED_ATTR) !== '1') element.setAttribute(TIMER_PAUSED_ATTR, '1')
				} else if (typeof element.removeAttribute === 'function') {
					element.removeAttribute(TIMER_PAUSED_ATTR)
				}
			}
		}

		/** 撤掉「这个计时器被我们冻住了」的标记（扫光动画随之恢复）。 */
		function clearTimerMarks() {
			if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return
			for (const element of document.querySelectorAll(`[${TIMER_PAUSED_ATTR}]`)) {
				if (typeof element.removeAttribute === 'function') element.removeAttribute(TIMER_PAUSED_ATTR)
			}
		}

		/** React 可能重建这个节点：重新找到、重新观察，基准值保持不变。 */
		function reattachTimer() {
			const state = timer
			if (state === undefined) return
			const elements = runningElements()
			if (elements.length === 0 && timerElementCount() > 1) {
				// 同屏有多个计时器（主对话 + 子代理内嵌），但认不出哪一个是主对话的：
				// 不接管、也不停手——等局面清楚了自动恢复。改到子代理的数字比显示不准更糟。
				degrade('timer', '同屏有多个运行计时器，认不出哪一个是主对话的；为不改到子代理的数字，暂不接管计时')
				// 别留痕：认不出来的时候连冻结标记也撤掉，否则扫光动画会一直停着。
				clearTimerMarks()
				return
			}
			// 核心把计时器的钩子换掉时，这里会一直找不到元素。连续几次都空就登记失效并停手：
			// 免得 700ms 一次空转，也免得用户把「暂停时计时还在走」当成别的 bug。
			// 冷启动（还没见过这个钩子）给更长的宽限：刷新一个长会话时页面可能是几秒后才渲染出来。
			if (elements.length === 0) {
				state.missingTicks = (state.missingTicks ?? 0) + 1
				const limit = state.seenTimer === true ? TIMER_MISSING_TICKS_SEEN : TIMER_MISSING_TICKS_COLD
				if (state.missingTicks >= limit) {
					degrade('timer', '找不到运行计时器的 [data-chat-running] 钩子，暂停时计时不会冻结')
					stopTimerOverride()
					return
				}
			} else {
				state.seenTimer = true
				state.missingTicks = 0
				recover('timer')
			}
			if (state.captured !== true) {
				// 暂停那一刻文案里可能还没有时长（刚开回合）；等它出现再抓，别把这段时间漏掉。
				if (!adoptCapture(captureTimer())) return
			}
			for (const element of elements) observeElement(element)
			enforceTimer()
			markTimerElements()
			maybeSendBaseline()
		}

		/**
		 * 进入暂停：第一次进来时确定基准，之后只切换阶段。
		 * @param {object | undefined} entry - 宿主返回的暂停状态（带 baseMs 时优先用它）
		 * @param {string} sessionId - 会话 id
		 */
		function startTimerPause(entry, sessionId) {
			if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return
			if (timer === undefined) {
				// 前缀/后缀/单位只能从真实文案里拿；基准优先用宿主存的那份，
				// 这样暂停中切走会话或刷新页面再回来，扣减不会丢。
				const captured = captureTimer()
				const hostBase = typeof entry?.baseMs === 'number' ? entry.baseMs : undefined
				timer = {
					phase: 'paused',
					baseMs: captured === undefined ? hostBase : (hostBase === undefined ? captured.ms : hostBase),
					resumedAt: 0,
					prefix: '',
					suffix: '',
					// 抓不到文案时才用这两个默认值；抓到之后由 adoptCapture 按真实文案改。
					marker: t().pausedMarker,
					units: DURATION_UNITS[lang()],
					captured: false,
					baselineSent: false,
					sessionId,
					shapes: new WeakMap(),
					observer: new MutationObserver(() => { enforceTimer() }),
					observed: new Set(),
					loop: setInterval(reattachTimer, TIMER_REATTACH_MS),
				}
				if (captured !== undefined) adoptCapture(captured)
			} else {
				if (timer.phase === 'offset' && typeof timer.resumedAt === 'number' && timer.resumedAt > 0) {
					const since = Date.now() - timer.resumedAt
					if (Number.isFinite(since) && since > 0) timer.baseMs += since
				}
				timer.phase = 'paused'
				timer.resumedAt = 0
				timer.baselineSent = false
			}
			reattachTimer()
		}

		/** 继续：从这一刻起按「基准 + 继续后的时长」走，暂停的时间不进账。 */
		function startTimerOffset() {
			if (timer === undefined || timer.phase !== 'paused') return false
			timer.phase = 'offset'
			timer.resumedAt = Date.now()
			reattachTimer()
			return true
		}

		/**
		 * 刷新页面 / 切走会话再回来：宿主记着这一轮的基准和继续时刻，按它接着算。
		 * @param {string} sessionId - 会话 id
		 */
		function restoreTimerClock(sessionId) {
			if (timer !== undefined) return
			const clock = snapshot.clocks.find((entry) => entry.sessionId === sessionId)
			if (clock === undefined || typeof clock.resumedAt !== 'number' || typeof clock.baseMs !== 'number') return
			timer = {
				phase: 'offset',
				baseMs: clock.baseMs,
				resumedAt: clock.resumedAt,
				prefix: '',
				suffix: '',
				marker: t().pausedMarker,
				units: DURATION_UNITS[lang()],
				captured: false,
				baselineSent: true,
				sessionId,
				shapes: new WeakMap(),
				observer: new MutationObserver(() => { enforceTimer() }),
				observed: new Set(),
				loop: setInterval(reattachTimer, TIMER_REATTACH_MS),
			}
			// 文案还没出现时长就先等着，reattach 定时器会补上。
			adoptCapture(captureTimer())
			reattachTimer()
		}

		/** 回合结束 / 切走会话：恢复核心自己的计时（下一轮重新开始）。 */
		function stopTimerOverride() {
			const state = timer
			if (state === undefined) return
			timer = undefined
			clearInterval(state.loop)
			state.observer.disconnect()
			clearTimerMarks()
		}
		//#endregion

		/**
		 * 输入框右侧的暂停 / 继续控件。会话不在运行时渲染 null，完全不占位。
		 * @param {object} props - 插槽标准 props + 注入的 pauseSessionId
		 * @returns {object | null} React 元素
		 */
		function PauseControl(props) {
			const sessionId = props.pauseSessionId
			const current = usePauseSnapshot()
			const [busy, setBusy] = React.useState(false)

			const entry = typeof sessionId === 'string'
				? current.paused.find((candidate) => candidate.sessionId === sessionId)
				: undefined
			const running = typeof sessionId === 'string' && current.running.includes(sessionId)
			const paused = entry?.engaged === true

			// 真正挂住之后才接管计时器：还在「暂停中…」时这一轮确实还在干活，数字该继续走。
			// 钩子必须写在下面的提前 return 之前，否则 hooks 数量会变。
			// deps 里带 sessionId：两个都在运行的会话之间切换时，上面那个 cleanup 会把旧计时器
			// 停掉，这里要按新会话重新决定接管。
			React.useEffect(() => {
				if (!running) {
					stopTimerOverride()
					return undefined
				}
				if (paused) startTimerPause(entry, sessionId)
				else if (!startTimerOffset()) restoreTimerClock(sessionId)
				return undefined
			}, [paused, running, sessionId])

			// 切走会话 / 卸载时收尾，下一轮从核心自己的计时重新开始。
			React.useEffect(() => () => { stopTimerOverride() }, [sessionId])

			if (typeof sessionId !== 'string' || (entry === undefined && !running)) return null

			const pending = entry !== undefined && !paused
			const copy = t()
			const label = paused ? copy.resume : pending ? copy.pending : copy.pause
			// 接管失效时把话说清楚：功能还在，只是核心 DOM 钩子变了。
			const broken = current.degraded?.timer === true || current.degraded?.rows === true
				? copy.degradedSuffix
				: ''
			const title = (paused
				? copy.pausedTitle
				: pending
					? copy.pendingTitle
					: copy.idleTitle) + broken
			// 一次性提示（宿主明确回绝 / 结果未知），不占用按钮自己的状态文字。
			const notice = typeof current.notices?.[sessionId] === 'string' ? current.notices[sessionId] : ''

			/** 宿主回话之后的处理：只有它明确说「不行」才提示，竞态和超时分开说。 */
			const reportResult = (result) => {
				if (result?.ok !== false) return
				if (result.unknown === true) {
					// 结果未知：send() 已经去重新读状态了，这里只说一句，别当失败吓人。
					setNotice(sessionId, copy.noticeTimeout)
					return
				}
				const code = String(result.code ?? '')
				if (code === 'session/idle' || code === 'session/not-paused' || code === 'session/unknown') {
					// 竞态：点下去的那一瞬间这一轮刚好结束。不是故障。
					setNotice(sessionId, copy.noticeEnded)
					return
				}
				setNotice(sessionId, copy.noticeNetwork)
			}

			const onClick = () => {
				if (busy) return
				setBusy(true)
				// 发「目标状态」，不是 toggle：按钮上的状态可能比宿主慢半拍，
				// 宿主对重复的 pause / resume 是幂等的，发错方向的代价却很大。
				const action = entry === undefined ? 'pause' : 'resume'
				send(action, sessionId).then(reportResult).finally(() => setBusy(false))
			}

			const button = React.createElement('button', {
				type: 'button',
				className: 'dshp-btn',
				title,
				'aria-label': title,
				'aria-pressed': paused,
				'data-paused': paused ? 'true' : 'false',
				'data-pending': pending ? 'true' : 'false',
				disabled: busy,
				onClick,
			}, paused || pending ? React.createElement(PlayIcon) : React.createElement(PauseIcon),
			React.createElement('span', null, label))

			if (notice === '') return button
			return React.createElement(Fragment, null, button,
				React.createElement('span', { className: 'dshp-notice', role: 'status' }, notice))
		}

		/** 行级暂停状态：0 无 / 1 暂停中（还没挂住）/ 2 已挂住。 */
		function rowPauseKind(sessionId) {
			for (const entry of snapshot.paused) {
				if (entry.sessionId !== sessionId) continue
				return entry.engaged === true ? 2 : 1
			}
			return 0
		}

		/**
		 * 只订阅「本行状态」这个整数：React 只在值变化时重渲染。用整份快照当订阅值的话，
		 * 几百个会话行会因为他处一次暂停而全部重渲染一遍。
		 */
		const useRowPauseKind = typeof React.useSyncExternalStore === 'function'
			? (sessionId) => React.useSyncExternalStore(
				subscribe,
				() => rowPauseKind(sessionId),
				() => rowPauseKind(sessionId),
			)
			: (sessionId) => {
				const [kind, setKind] = React.useState(() => rowPauseKind(sessionId))
				React.useEffect(() => subscribe(() => setKind(rowPauseKind(sessionId))), [sessionId])
				return kind
			}

		/** 从插槽 props 里取会话 id（核心 `renderSlot(name, { sessionId })` 这样传）。 */
		function slotSessionId(props) {
			const value = props?.sessionId ?? props?.pauseSessionId ?? props?.id
			return typeof value === 'string' ? value : undefined
		}

		/**
		 * 侧栏行首图标。**只有打了 tools/patch-core-row-slot.mjs 的核心才会渲染它**——
		 * 原版核心在「运行中」这一支里根本不渲染 `sidebar.session.row.leading` 插槽。
		 * 渲染过一次就把 `<html>` 标记上，CSS 据此关掉 mask 方案，避免图标画两遍。
		 * @param {object} props - 插槽 props（含 sessionId）
		 * @returns {object | null} React 元素
		 */
		function RowLeadingIcon(props) {
			const sessionId = slotSessionId(props)
			const kind = useRowPauseKind(sessionId ?? '')
			// 只有「真的在行首画出了暂停图标」（kind === 2）才把 html 标记上、让 mask 让位。
			// 不能一渲染就标记：原版核心只在**空闲行**渲染这个插槽，那样标记会在页面加载时就
			// 被置上，于是暂停行的 mask 规则被全局关掉——行首就什么都不剩了。
			React.useEffect(() => {
				if (kind !== 2) return
				if (typeof document === 'undefined' || document.documentElement === undefined) return
				if (typeof document.documentElement.setAttribute !== 'function') return
				document.documentElement.setAttribute(ROW_SLOT_FLAG, '1')
			}, [kind])
			if (sessionId === undefined || kind !== 2) return null
			const copy = t()
			return React.createElement('span', {
				className: 'dshp-row-icon',
				title: copy.rowTitle,
				'aria-label': copy.rowAria,
				[ROW_ICON]: sessionId,
			}, React.createElement(PauseIcon))
		}

		/**
		 * 侧栏行悬停卡里的一行状态字。这是上游本来就有的插槽（`sidebar.session.row.hover`），
		 * 空闲态、运行态都能渲染，不依赖任何 DOM 钩子——所以它永远说的是真话。
		 * @param {object} props - 插槽 props（含 sessionId）
		 * @returns {object | null} React 元素
		 */
		function RowHoverHint(props) {
			const sessionId = slotSessionId(props)
			const kind = useRowPauseKind(sessionId ?? '')
			if (sessionId === undefined || kind === 0) return null
			const copy = t()
			const text = kind === 2 ? copy.hoverPaused : copy.hoverPending
			return React.createElement('div', { className: 'dshp-hover' }, text)
		}

		/** 只需要 slots；状态走宿主 HTTP 路由，不依赖 Remote。 */
		const inject = ['slots']

		function apply(ctx) {
			installStyle()

			ctx.slots.inject('conversation.input.right', () => {
				try {
					return ctx.slots.register({
						name: 'conversation.input.right',
						id: 'breather',
						order: 40,
						// 用独立 prop 名，避开与外层标准 props 撞名（撞名会触发 SlotAssemblyError）。
						inject: (sessionId) => ({ pauseSessionId: sessionId }),
					}, PauseControl)
				} catch (error) {
					console.warn('[breather] 注册输入框按钮失败:', error)
					return () => {}
				}
			})

			// 上游插槽两处：行首图标（核心补丁之后才会被渲染）和行悬停卡的状态字（原版就有）。
			for (const [name, id, order, component] of [
				['sidebar.session.row.leading', 'breather-icon', 20, RowLeadingIcon],
				['sidebar.session.row.hover', 'breather-hint', 20, RowHoverHint],
			]) {
				ctx.slots.inject(name, () => {
					try {
						return ctx.slots.register({ name, id, order }, component)
					} catch (error) {
						console.warn(`[breather] 注册插槽 ${name} 失败:`, error)
						return () => {}
					}
				})
			}

			ctx.effect(() => () => stopPolling(), 'breather: poller')
		}

		exports.name = 'dsh-breather'
		exports.inject = inject
		exports.apply = apply
		// 仅供自测使用（test-client.mjs 里跑计时器接管 / 侧栏标记逻辑），运行时不会用到。
		exports.__test = {
			parseDuration,
			formatDuration,
			startTimerPause,
			startTimerOffset,
			stopTimerOverride,
			isTimerActive: () => timer !== undefined,
			timerText,
			mainTimerCount: () => runningElements().length,
			timerElementCount,
			markPausedRows,
			clearPausedRows,
			sessionRows,
			RowLeadingIcon,
			RowHoverHint,
			degrade,
			degradedState: () => ({ ...degraded }),
			// 轮询 / 提示 / 样式：自测要能手动触发这些边缘路径。
			pollNow: () => poll(),
			stopPolling,
			snapshotState: () => snapshot,
			setNotice,
			clearNotices: () => {
				notices.clear()
				snapshot = { ...snapshot, notices: {} }
				notifyListeners()
			},
			hostState: () => ({ missingTicks, hostMissing }),
			endpoint: ENDPOINT,
			installStyle,
			resetStyle: () => { styleInstalled = false },
		}
		return module.exports
	},
})
