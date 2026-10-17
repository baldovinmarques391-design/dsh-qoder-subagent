/**
 * @local/dsh-qoder-subagent  v0.2.0
 *
 * 把 Qoder CN 自带的 CLI（qoderclicn）当成 DSH 的"免费子代理"。
 * 免费模型：Qwen3.8-Flash（实测 billable=false、0 credits）。
 *
 * v0.2.0 修的四件事（对应两份报障单）：
 *   1. 【完成即注入】不再只靠人肉轮询：用 DSH 的 systemPrompt.context() 注册一条动态上下文，
 *      在每次组装提示词时把"已结束但尚未取回"的子代理报给发起它的那个会话。
 *   2. 【失败也注入】启动失败 / 子进程异常退出 / 超时 / 被掐，全部算终态，同样进入通知。
 *   3. 【cwd 不存在不再谎报 ENOENT】spawn 前校验 cwd 与可执行文件；错误里带
 *      stage（discovery/spawn/child-exit）、code、path、spawnargs、实际 cwd，并把子进程 stderr 落盘。
 *   4. 【事件流必有收尾】子进程关闭时若没收到 result 事件，由插件补写一条终止记录；
 *      meta.json 增加 progress/collected/stage 等字段，便于事后核对它是"活着"还是"结束了"。
 *
 * 保留的原设计：逐次选模型、逐次传权限（readonly/edit/full）、零提示词注入、逐 run 留痕。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'qoder-subagent'
export const inject = ['tools']

/**
 * 模型表：`free: true` 只能给**实测确认免费**的模型。
 * 2026-10-16 教训：早先把「Flash / Preview 档看着像免费」直接写成了 free: true，
 * 于是 4 个没实测过的模型被当成免费放行——用户发现只有 Qwen3.8-Flash 免费。
 * 这类假设会直接花掉真钱，所以规则改成：没实测过的一律 `free: false, unverified: true`，
 * 要用必须显式 allow_paid=true。要新增免费模型，先实测 result 事件的 total_credits/total_cost_usd。
 */
const MODEL_TABLE = {
  'Qwen3.8-Flash': { free: true, note: '唯一已验证免费（实测 billable=false、credits=0）' },
  'Qwen3.7-Flash': { free: false, unverified: true, note: '未实测是否免费（曾被我错标为免费）' },
  'DeepSeek-Flash': { free: false, unverified: true, note: '未实测是否免费（曾被我错标为免费）' },
  'GLM-5.3-Flash': { free: false, unverified: true, note: '未实测是否免费（曾被我错标为免费）' },
  'Kimi-K2.8-Preview': { free: false, unverified: true, note: '未实测是否免费（曾被我错标为免费）' },
  'Qwen3.8-Max': { free: false },
  'Qwen3.7-Max': { free: false },
  'Qwen3.7-Plus': { free: false },
  'DeepSeek-V4-Pro': { free: false },
  'GLM-5.3': { free: false },
  'GLM-5.2': { free: false },
  'Kimi-K3': { free: false },
  'MiniMax-M2.7': { free: false },
}

const DEFAULT_MODEL = 'Qwen3.8-Flash'
const NOTICE_LIMIT = 5 // 同一条完成通知最多重复注入几次（取回后立刻停止）

function installRoots() {
  const out = []
  for (const key of ['ProgramFiles(x86)', 'ProgramFiles', 'ProgramW6432']) {
    const v = process.env[key]
    if (v) out.push(v)
  }
  out.push('D:\\Program Files (x86)', 'C:\\Program Files (x86)', 'D:\\Program Files', 'C:\\Program Files')
  return [...new Set(out)]
}

/** 发现 Qoder 的 exe 与 worker；返回绝对路径，便于报错时核对（本机存在版本漂移）。 */
function discoverQoder() {
  if (process.env.DSH_FREESUB_QODER_EXE && process.env.DSH_FREESUB_QODER_WORKER) {
    return { exe: process.env.DSH_FREESUB_QODER_EXE, worker: process.env.DSH_FREESUB_QODER_WORKER }
  }
  const tried = []
  for (const root of installRoots()) {
    const dir = join(root, 'Qoder CN')
    const exe = join(dir, 'Qoder CN.exe')
    const worker = join(
      dir, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai',
      'qoder-cn-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs',
    )
    tried.push({ exe, worker, exeExists: existsSync(exe), workerExists: existsSync(worker) })
    if (existsSync(exe) && existsSync(worker)) return { exe, worker, tried }
  }
  const err = new Error('找不到 Qoder CN（发现阶段失败）')
  err.stage = 'discovery'
  err.detail = { tried }
  throw err
}

function permissionArgs(permission) {
  const p = permission ?? 'readonly'
  if (p === 'readonly') return ['--permission-mode', 'dont_ask', '--tools', 'Read,Glob,Grep,WebSearch,WebFetch']
  if (p === 'edit') return ['--permission-mode', 'accept_edits', '--tools', 'Read,Glob,Grep,Write,Edit,WebSearch,WebFetch']
  return ['--permission-mode', 'bypass_permissions', '--dangerously-skip-permissions']
}

/**
 * 组装命令行。这里做显式校验，避免"cwd 不存在"被 spawn 报成"程序找不到"：
 *   - cwd 给了但不存在 → stage=spawn、明确说"工作目录不存在"
 *   - 可执行文件/worker 不在 → stage=spawn、明确说哪个路径不存在
 */
function buildCommand(opts) {
  const discovery = discoverQoder()
  const { exe, worker } = discovery

  if (!existsSync(exe)) {
    const err = new Error(`可执行文件不存在：${exe}`)
    err.stage = 'spawn'
    err.detail = { exe, worker }
    throw err
  }
  if (!existsSync(worker)) {
    const err = new Error(`Qoder worker 脚本不存在：${worker}`)
    err.stage = 'spawn'
    err.detail = { exe, worker }
    throw err
  }

  const cwd = opts.cwd
  if (cwd !== undefined) {
    if (!existsSync(cwd)) {
      const err = new Error(`工作目录不存在：${cwd}`)
      err.stage = 'spawn'
      err.detail = { cwd, hint: '改成存在的目录，或省略 cwd（会用插件进程的工作目录）' }
      throw err
    }
    let isDir = false
    try { isDir = statSync(cwd).isDirectory() } catch { isDir = false }
    if (!isDir) {
      const err = new Error(`工作目录不是目录：${cwd}`)
      err.stage = 'spawn'
      err.detail = { cwd }
      throw err
    }
  }

  const args = [
    worker,
    '-p', '--output-format', 'stream-json',
    '--model', opts.model,
    ...permissionArgs(opts.permission),
    '--strict-mcp-config', '--mcp-config', opts.emptyMcp,
  ]
  if (opts.resumeId) args.push('--resume', opts.resumeId)
  args.push(opts.task)

  return {
    command: exe,
    args,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    cwd: cwd ?? process.cwd(),
    discovery: { exe, worker },
  }
}

function freeStatus(model) {
  const entry = MODEL_TABLE[model]
  if (!entry) return { known: false, free: false, reason: `模型 ${model} 不在已知表里，无法确认是否免费` }
  if (entry.free === true) return { known: true, free: true, reason: entry.note ?? '已验证免费' }
  return {
    known: true,
    free: false,
    unverified: entry.unverified === true,
    reason: entry.note ?? '已知计费模型',
  }
}

const textBlock = (text) => [{ type: 'text', text }]
const lossless = (v) => JSON.parse(JSON.stringify(v ?? null))
const TERMINAL = new Set(['done', 'error', 'failed', 'timeout', 'killed'])

export function apply(ctx, config = {}) {
  const stateDir = config.stateDir ?? join(process.cwd(), '.qoder-subagent-runs')
  const maxConcurrent = Number(config.maxConcurrent ?? 6)
  mkdirSync(stateDir, { recursive: true })
  const emptyMcp = join(stateDir, 'empty-mcp.json')
  if (!existsSync(emptyMcp)) writeFileSync(emptyMcp, '{"mcpServers":{}}\n', 'utf8')

  /** @type {Map<string, any>} */
  const runs = new Map()

  const runDir = (id) => {
    const dir = join(stateDir, id)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  function persist(run) {
    try {
      writeFileSync(join(run.dir, 'meta.json'), JSON.stringify({
        id: run.id, model: run.model, permission: run.permission,
        status: run.status, stage: run.stage ?? null,
        startedAt: run.startedAt, endedAt: run.endedAt ?? null,
        lastEventAt: run.lastEventAt ?? null, eventCount: run.eventCount,
        sessionId: run.sessionId ?? null,
        cwd: run.cwd ?? null, cwdRequested: run.cwdRequested ?? null,
        turns: run.turns,
        answer: run.answer ?? null, usage: run.usage ?? null, error: run.error ?? null,
        errorStage: run.errorStage ?? null,
        discovery: run.discovery ?? null,
        owner: run.owner ?? null,
        collected: run.collected === true,
        noticeCount: run.noticeCount ?? 0,
        freeCheck: run.freeCheck, resumeOf: run.resumeOf ?? null,
      }, null, 2), 'utf8')
    } catch { /* 留痕失败不该让任务失败 */ }
  }

  /** 子进程关闭时补写终止事件，保证 events.jsonl 一定有收尾记录。 */
  function appendTerminalEvent(run, payload) {
    try {
      appendFileSync(join(run.dir, 'events.jsonl'),
        JSON.stringify({ type: 'result', synthesized: true, at: new Date().toISOString(), num_turns: run.turns, result: run.answer ?? null, ...payload }) + '\n',
        'utf8')
    } catch { /* ignore */ }
  }

  function handleEvent(run, ev) {
    appendFileSync(join(run.dir, 'events.jsonl'), JSON.stringify(ev) + '\n', 'utf8')
    run.eventCount += 1
    run.lastEventAt = Date.now()
    if (run.eventCount % 10 === 0) persist(run) // 长任务也能从 meta 看出"它还活着"
    if (ev.type === 'system' && ev.session_id && !run.sessionId) run.sessionId = ev.session_id
    if (ev.type === 'assistant' && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === 'text' && block.text) run.answer = run.answer ? run.answer + '\n' + block.text : block.text
      }
    }
    if (ev.type === 'result') {
      run.sawResultEvent = true
      run.turns = ev.num_turns ?? run.turns
      run.usage = {
        duration_ms: ev.duration_ms, credits: ev.total_credits, usd: ev.total_cost_usd,
        is_error: ev.is_error === true, subtype: ev.subtype,
      }
      if (typeof ev.result === 'string' && ev.result.trim()) run.answer = ev.result
      if (ev.is_error === true || (ev.subtype && ev.subtype !== 'success')) {
        run.error = ev.result || ev.subtype || 'unknown error'
      }
    }
  }

  function finish(run, status, error, errorStage) {
    if (TERMINAL.has(run.status)) return
    run.status = status
    if (error) run.error = error
    if (errorStage) run.errorStage = errorStage
    run.endedAt = Date.now()
    run.stage = 'settled'
    if (!run.sawResultEvent) appendTerminalEvent(run, { status, error: run.error ?? null, errorStage: run.errorStage ?? null })
    persist(run)
    for (const w of run.waiters) w()
    run.waiters.length = 0
  }

  function startRun(opts) {
    const running = [...runs.values()].filter((r) => r.status === 'running').length
    if (running >= maxConcurrent) throw new Error(`并发子代理已达上限 ${maxConcurrent}；先用 freesub_list 看看谁还在跑`)

    const model = opts.model ?? DEFAULT_MODEL
    const freeCheck = freeStatus(model)
    if (!freeCheck.free && opts.allow_paid !== true) {
      const kind = freeCheck.unverified
        ? '没有实测过是否免费（可能直接花钱）'
        : '不是已验证免费的模型'
      throw new Error(`模型 ${model} ${kind}：${freeCheck.reason}。确认要用就再传 allow_paid=true。`)
    }

    // 校验发生在创建 run 之前：cwd / 可执行文件的问题在这里就抛明确错误，不留半成品 run。
    const built = buildCommand({
      model, permission: opts.permission, task: opts.task,
      resumeId: opts.resumeId, cwd: opts.cwd, emptyMcp,
    })

    const id = `qsub-${randomUUID().slice(0, 8)}`
    const run = {
      id, model, permission: opts.permission ?? 'readonly',
      task: opts.task, cwd: built.cwd, cwdRequested: opts.cwd ?? null, dir: runDir(id),
      status: 'running', stage: 'spawn', startedAt: Date.now(), turns: 0,
      answer: null, error: null, errorStage: null, sessionId: null, usage: null,
      eventCount: 0, lastEventAt: null, sawResultEvent: false,
      freeCheck, waiters: [], resumeOf: opts.resumeId ?? null, pid: null,
      owner: opts.owner ?? null, collected: false, noticeCount: 0,
      discovery: built.discovery,
    }
    runs.set(id, run)
    writeFileSync(join(run.dir, 'prompt.txt'), opts.task, 'utf8')
    persist(run)

    const child = spawn(built.command, built.args, {
      cwd: built.cwd, env: built.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    run.pid = child.pid
    run.stage = 'running'

    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try { handleEvent(run, JSON.parse(line)) } catch { appendFileSync(join(run.dir, 'events.jsonl'), JSON.stringify({ type: 'raw', line }) + '\n', 'utf8') }
      }
    })
    let err = ''
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8')
      try { appendFileSync(join(run.dir, 'stderr.log'), chunk) } catch { /* ignore */ }
    })
    child.on('error', (e) => {
      // cwd 不存在这类问题已在 buildCommand 拦下；这里是兜底，仍带全上下文。
      run.spawnError = { code: e.code, path: e.path, syscall: e.syscall, spawnargs: e.spawnargs, cwd: built.cwd }
      finish(run, 'error', `进程启动失败：${e.message}\n${JSON.stringify(run.spawnError)}`, 'spawn')
    })
    child.on('close', (code, signal) => {
      if (TERMINAL.has(run.status)) return
      if (code === 0) finish(run, 'done', null, null)
      else finish(run, run.error ? 'error' : 'failed',
        run.error ?? `退出码 ${code}${signal ? ` (signal ${signal})` : ''}\n${err.slice(-2000)}`, 'child-exit')
    })

    const timeoutMs = Number(opts.timeoutMs ?? 30 * 60 * 1000)
    const timer = setTimeout(() => {
      if (run.status === 'running') {
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }) } catch {}
        finish(run, 'timeout', `超过 ${Math.round(timeoutMs / 1000)}s 未完成，已终止`, 'timeout')
      }
    }, timeoutMs)
    timer.unref?.()
    return run
  }

  async function waitRun(run, waitMs) {
    const deadline = Date.now() + Number(waitMs ?? 0)
    while (run.status === 'running' && Date.now() < deadline) {
      await new Promise((res) => {
        const t = setTimeout(res, Math.min(500, Math.max(1, deadline - Date.now())))
        run.waiters.push(() => { clearTimeout(t); res() })
      })
    }
    return run
  }

  function snapshot(run) {
    return {
      agent_id: run.id,
      provider: 'qoder',
      model: run.model,
      permission: run.permission,
      status: run.status,
      stage: run.stage ?? null,
      session_id: run.sessionId,
      free: run.freeCheck?.free ?? null,
      free_reason: run.freeCheck?.reason ?? null,
      turns: run.turns,
      usage: run.usage,
      answer: run.answer,
      error: run.error,
      error_stage: run.errorStage ?? null,
      cwd: run.cwd,
      cwd_requested: run.cwdRequested,
      discovery: run.discovery,
      collected: run.collected === true,
      log_dir: run.dir,
    }
  }

  const findRun = (id) => {
    const run = runs.get(id)
    if (!run) throw new Error(`没有这个子代理：${id}。用 freesub_list 看看现有的。`)
    return run
  }

  // ── 完成通知：注册动态上下文，每次组装提示词时把"已结束未取回"的报给发起会话 ──
  const pendingFor = (owner) => [...runs.values()].filter((r) =>
    TERMINAL.has(r.status) && r.collected !== true && (r.noticeCount ?? 0) < NOTICE_LIMIT
    && (owner === undefined || r.owner === undefined || r.owner === owner))

  const systemPrompt = ctx.get?.('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => systemPrompt.context({
      name: 'freesub-completions',
      order: 100,
      text: (assemble) => {
        const scope = assemble?.scope
        const owner = scope && typeof scope.id === 'string' ? scope.id : undefined
        const pending = pendingFor(owner)
        if (pending.length === 0) return ''
        for (const r of pending) {
          r.noticeCount = (r.noticeCount ?? 0) + 1
          if (r.noticeCount === 1) persist(r) // 让磁盘上的 noticeCount 也能反映"通知已发出"
        }
        const lines = pending.map((r) => {
          const took = r.endedAt ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s` : '—'
          const head = r.answer ? `｜${r.answer.replace(/\s+/g, ' ').slice(0, 60)}` : ''
          const err = r.error ? `｜错误：${String(r.error).replace(/\s+/g, ' ').slice(0, 80)}` : ''
          return `- ${r.id} [${r.status}] ${r.model} ${took}${head}${err}`
        })
        return [
          '[免费子代理通知] 下面这些子代理已经结束，结果还没被取回：',
          ...lines,
          '取回结果：freesub_result(agent_id="…")；查看全部：freesub_list()。取回后本条通知自动消失。',
        ].join('\n')
      },
    }))
  }

  const register = (def) => ctx.effect(() => ctx.tools.register(def))

  register({
    name: 'freesub_run',
    description:
      '在 Qoder CN 里跑一个免费子代理（如 Qwen3.8-Flash）。发出去的就是 task 原文，不会加任何模板文字；每次调用单独选模型和权限。' +
      'wait_ms=0 时立刻返回句柄，子代理结束后会自动向本会话注入一条完成通知（不需要轮询）；wait_ms>0 时同步等结果。' +
      'cwd 必须是已存在的目录，否则启动前就会明确报错（不会出现 ENOENT 那种误导信息）。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整任务文本，原样发送，不追加任何内容' },
        model: { type: 'string', description: '模型名，留空用 Qwen3.8-Flash' },
        permission: { type: 'string', enum: ['readonly', 'edit', 'full'], description: 'readonly(默认,只读) / edit(可改文件) / full(含 Bash)' },
        cwd: { type: 'string', description: '子代理的工作目录（必须已存在；省略则用插件进程的工作目录）' },
        wait_ms: { type: 'integer', description: '同步等待上限（毫秒），0=不等直接返回句柄' },
        timeoutMs: { type: 'integer', description: '整个任务的最长运行时间，默认 30 分钟' },
        allow_paid: { type: 'boolean', description: '确认要用非免费模型时置 true' },
      },
      required: ['task'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textBlock(JSON.stringify(v, null, 2)) },
    timeoutMs: 35 * 60 * 1000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const a = args ?? {}
      const owner = exec?.agent?.id
      let run
      try {
        run = startRun({ ...a, owner })
      } catch (e) {
        // 启动前校验失败也要成为一条可注入的终态记录，而不是静默异常
        const id = `qsub-${randomUUID().slice(0, 8)}`
        const failed = {
          id, model: a.model ?? DEFAULT_MODEL, permission: a.permission ?? 'readonly',
          task: a.task, cwd: null, cwdRequested: a.cwd ?? null, dir: runDir(id),
          status: 'error', stage: e.stage ?? 'spawn',
          startedAt: Date.now(), endedAt: Date.now(), turns: 0,
          answer: null, error: e.message, errorStage: e.stage ?? 'spawn',
          sessionId: null, usage: null, eventCount: 0, lastEventAt: null,
          freeCheck: freeStatus(a.model ?? DEFAULT_MODEL), waiters: [],
          owner, collected: false, noticeCount: 0, discovery: e.detail ?? null,
        }
        runs.set(id, failed)
        appendTerminalEvent(failed, { status: 'error', error: e.message, errorStage: failed.errorStage })
        persist(failed)
        return lossless({ ...snapshot(failed), startup_failed: true, detail: e.detail ?? null })
      }
      await waitRun(run, a.wait_ms ?? 0)
      return lossless(snapshot(run))
    },
  })

  register({
    name: 'freesub_result',
    description: '取某个免费子代理的状态与结果。取回后这条完成通知不再重复注入。wait_ms>0 时最多等这么久。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        wait_ms: { type: 'integer', description: '最多等待毫秒数，默认 0' },
        tail: { type: 'integer', description: '同时回传最后 N 条原始事件（排障用）' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textBlock(JSON.stringify(v, null, 2)) },
    timeoutMs: 35 * 60 * 1000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const a = args ?? {}
      const run = findRun(a.agent_id)
      await waitRun(run, a.wait_ms ?? 0)
      // 先标记已取回，再快照：否则"取回这一次"的返回体里 collected 还是 false
      if (TERMINAL.has(run.status)) {
        run.collected = true
        persist(run)
      }
      const out = snapshot(run)
      if (a.tail) {
        try {
          const lines = readFileSync(join(run.dir, 'events.jsonl'), 'utf8').trim().split('\n')
          out.events_tail = lines.slice(-Math.abs(a.tail))
        } catch { out.events_tail = [] }
      }
      if (TERMINAL.has(run.status)) out.just_collected = true
      return lossless(out)
    },
  })

  register({
    name: 'freesub_send',
    description: '接着某个免费子代理继续说一句（复用它的会话上下文），相当于原版子代理的 send_message。完成后同样会注入通知。',
    parameters: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        message: { type: 'string', description: '要补发的话，原样发送' },
        wait_ms: { type: 'integer', description: '同步等待上限，默认 0' },
        permission: { type: 'string', enum: ['readonly', 'edit', 'full'] },
      },
      required: ['agent_id', 'message'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textBlock(JSON.stringify(v, null, 2)) },
    timeoutMs: 35 * 60 * 1000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const a = args ?? {}
      const prev = findRun(a.agent_id)
      if (prev.status === 'running') throw new Error(`${prev.id} 还在跑；先 freesub_interrupt 或者等它结束`)
      if (!prev.sessionId) throw new Error(`${prev.id} 没有可续聊的 session_id（那次可能启动失败，或在出 session 之前就退出了）`)
      const run = startRun({
        model: prev.model,
        permission: a.permission ?? prev.permission,
        task: a.message,
        cwd: prev.cwd,
        resumeId: prev.sessionId,
        timeoutMs: a.timeoutMs,
        owner: exec?.agent?.id ?? prev.owner,
      })
      await waitRun(run, a.wait_ms ?? 0)
      return lossless({ ...snapshot(run), continued_from: prev.id })
    },
  })

  register({
    name: 'freesub_list',
    description: '列出所有免费子代理：谁在跑、谁跑完了、哪些跑完但还没取回（pending_notifications）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textBlock(JSON.stringify(v, null, 2)) },
    isConcurrencySafe: () => true,
    async execute() {
      const all = [...runs.values()].map((r) => ({
        agent_id: r.id, model: r.model, status: r.status, stage: r.stage ?? null,
        turns: r.turns, events: r.eventCount,
        last_event_at: r.lastEventAt ? new Date(r.lastEventAt).toISOString() : null,
        startedAt: new Date(r.startedAt).toISOString(),
        collected: r.collected === true,
        cwd: r.cwd,
        answer_head: r.answer ? r.answer.slice(0, 120) : null, error: r.error,
      }))
      const pending = [...runs.values()].filter((r) => TERMINAL.has(r.status) && r.collected !== true)
      return lossless({
        running: all.filter((r) => r.status === 'running').length,
        total: all.length,
        pending_notifications: pending.length,
        pending_ids: pending.map((r) => r.id),
        runs: all,
        free_models: MODEL_TABLE,
      })
    },
  })

  register({
    name: 'freesub_interrupt',
    description: '掐掉一个正在跑的免费子代理（杀进程树）。被掐同样会产生一条完成通知。',
    parameters: {
      type: 'object',
      properties: { agent_id: { type: 'string' } },
      required: ['agent_id'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textBlock(JSON.stringify(v, null, 2)) },
    isConcurrencySafe: () => true,
    async execute(args) {
      const run = findRun(args?.agent_id)
      if (run.status !== 'running') return lossless({ agent_id: run.id, status: run.status, note: '本来就没在跑' })
      try { spawn('taskkill', ['/pid', String(run.pid), '/T', '/F'], { windowsHide: true }) } catch {}
      finish(run, 'killed', '被 freesub_interrupt 终止', 'killed')
      return lossless({ agent_id: run.id, status: run.status })
    },
  })

  register({
    name: 'freesub_models',
    description: '列出可用的免费模型表：哪些已实测确认免费、哪些未实测（可能花钱）、哪些已知计费，以及 Qoder 被发现的位置。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => textBlock(JSON.stringify(v, null, 2)) },
    isConcurrencySafe: () => true,
    async execute() {
      let discovery = null
      let discoveryError = null
      try {
        const d = discoverQoder()
        discovery = { exe: d.exe, worker: d.worker }
      } catch (e) {
        discoveryError = { message: e.message, detail: e.detail ?? null }
      }
      return lossless({
        now: new Date().toISOString(),
        qoder_found: Boolean(discovery),
        discovery,
        discovery_error: discoveryError,
        default_model: DEFAULT_MODEL,
        models: MODEL_TABLE,
      })
    },
  })
}
