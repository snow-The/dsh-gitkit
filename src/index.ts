/**
 * dsh-gitkit — structured Git tools for DeepSeek Harness (TypeScript).
 *
 * Design rules:
 *  1. every git invocation goes through execFile('git', args) — no shell,
 *     no string interpolation, no injection surface;
 *  2. every path argument is validated: relative only, no '..' segments,
 *     no drive letters, no shell metacharacters;
 *  3. commit messages are length/NUL validated and passed as argv;
 *  4. runtime dependencies: node builtins only (devDeps: typescript only).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { IncomingMessage, ServerResponse } from 'node:http'

const execFileP = promisify(execFile)

export const name = 'gitkit'
export const inject = ['tools']

// --- minimal DSH tool surface (kept local: no dsh package imports) ---
// undefined values are allowed for optional fields; JSON.stringify drops them.
type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined }

interface Tool {
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, Json>; required?: string[] }
  output: {
    schema: Json
    render: (args: Json, value: Json) => { type: 'text'; text: string }[]
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  presentCall?: (args: Json) => Json
  execute: (args: Json, exec: { signal?: AbortSignal }) => Promise<Json>
}

/** Official web-server surface (host/webserver/src/index.ts:42-47, 166). */
interface WebServer {
  register: (route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void
}

/** The child context handed to the ctx.inject callback — here webServer is legal to read. */
interface InjectedCtx {
  webServer: WebServer
  effect?: (fn: () => unknown, label?: string) => unknown
}

interface Ctx {
  tools: { register: (tool: Tool) => void }
  inject?: (deps: string[], cb: (ctx: InjectedCtx) => unknown) => unknown
}

const MAX_MSG_LEN = 2000

const textOutput = (): Tool['output'] => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

/** Validate a repo-relative path argument. Throws on anything suspicious. */
function checkPath(p: unknown, label: string): string | undefined {
  if (typeof p !== 'string' || p.trim() === '' || p.trim() === '.') return typeof p === 'string' ? p.trim() : undefined
  const v = p.trim()
  if (v.startsWith('/') || /^[A-Za-z]:/.test(v)) {
    throw new Error(`${label}: absolute paths are not allowed`)
  }
  if (v === '..' || v.split(/[\\/]/).includes('..')) {
    throw new Error(`${label}: '..' traversal is not allowed`)
  }
  if (!/^[^\\/:*?"<>|]+$/.test(v.replaceAll('\\', '/'))) {
    throw new Error(`${label}: invalid path characters`)
  }
  return v
}

function checkCwd(cwd: unknown): string {
  if (cwd === undefined || cwd === null) return process.cwd()
  if (typeof cwd !== 'string') throw new Error('cwd must be a string')
  return cwd
}

interface GitOk { ok: true; stdout: string; stderr: string }
interface GitErr { ok: false; error: string; code: number | string | null }

async function git(args: string[], opts: { cwd?: unknown; timeoutMs?: number } = {}): Promise<GitOk | GitErr> {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd: checkCwd(opts.cwd),
      timeout: opts.timeoutMs ?? 30000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: string | number }
    return { ok: false, error: e.stderr?.trim() || e.message, code: e.code ?? null }
  }
}

function present(args: Json, kind: string): Json {
  return { card: 'generic', title: 'git ' + kind, kind: 'read', rawInput: args }
}

function str(a: Json, k: string): string | undefined {
  const v = (a as Record<string, Json>)?.[k]
  return typeof v === 'string' ? v : undefined
}
function bool(a: Json, k: string): boolean | undefined {
  const v = (a as Record<string, Json>)?.[k]
  return typeof v === 'boolean' ? v : undefined
}
function num(a: Json, k: string): number | undefined {
  const v = (a as Record<string, Json>)?.[k]
  return typeof v === 'number' ? v : undefined
}

export function apply(ctx: Ctx): void {
  const statusTool: Tool = {
    name: 'git_status',
    description:
      'Show working tree status. Returns porcelain lines (XY path) plus a summary. Path filters are repo-relative and validated (no absolute paths, no "..").',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory (default: current workspace root)' },
        path: { type: 'string', description: 'Optional repo-relative path filter' },
      },
    },
    output: textOutput(),
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'status'),
    async execute(args) {
      const path = str(args, 'path') ? checkPath(str(args, 'path'), 'path') : undefined
      const argv = ['status', '--porcelain=v1']
      if (path) argv.push('--', path)
      const res = await git(argv, { cwd: str(args, 'cwd') })
      if (!res.ok) return { ok: false, error: res.error }
      const lines = res.stdout.split('\n').filter(Boolean)
      const summary: Record<string, number> = {}
      for (const l of lines) {
        const xy = l.slice(0, 2).trim()
        summary[xy] = (summary[xy] ?? 0) + 1
      }
      return { ok: true, lines, count: lines.length, summary }
    },
  }

  const diffTool: Tool = {
    name: 'git_diff',
    description:
      'Show diff of the working tree (unstaged), staged (--cached), or between two refs (base/head). Use stat for a summary. Path filters are validated.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
        cached: { type: 'boolean', description: 'Diff staged changes (--cached)' },
        base: { type: 'string', description: 'Base ref for ref-to-ref diff (with head)' },
        head: { type: 'string', description: 'Head ref for ref-to-ref diff' },
        stat: { type: 'boolean', description: 'Only a diffstat (--stat)' },
        path: { type: 'string', description: 'Optional repo-relative path filter' },
      },
    },
    output: textOutput(),
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'diff'),
    async execute(args) {
      const path = str(args, 'path') ? checkPath(str(args, 'path'), 'path') : undefined
      const argv = ['diff']
      if (bool(args, 'cached')) argv.push('--cached')
      const base = str(args, 'base')
      const head = str(args, 'head')
      if (base && head) argv.push(base, head)
      if (bool(args, 'stat')) argv.push('--stat')
      if (path) argv.push('--', path)
      const res = await git(argv, { cwd: str(args, 'cwd') })
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, diff: res.stdout, bytes: Buffer.byteLength(res.stdout) }
    },
  }

  const logTool: Tool = {
    name: 'git_log',
    description:
      'Show recent commits (default 20). Returns list: hash, date, author, subject. Path filters are validated.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
        count: { type: 'number', description: 'Number of commits (default 20, max 200)' },
        path: { type: 'string', description: 'Optional repo-relative path filter' },
      },
    },
    output: textOutput(),
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'log'),
    async execute(args) {
      const path = str(args, 'path') ? checkPath(str(args, 'path'), 'path') : undefined
      const n = Math.min(Math.max(1, num(args, 'count') ?? 20), 200)
      const argv = ['log', '-' + n, '--date=short', '--pretty=format:%h %ad %an %s']
      if (path) argv.push('--', path)
      const res = await git(argv, { cwd: str(args, 'cwd') })
      if (!res.ok) return { ok: false, error: res.error }
      const commits = res.stdout.split('\n').filter(Boolean).map((l) => {
        const m = l.match(/^(\S+) (\S+) (.*?) (.*)$/)
        return m ? { hash: m[1], date: m[2], author: m[3], subject: m[4] } : { raw: l }
      })
      return { ok: true, commits, count: commits.length }
    },
  }

  const commitTool: Tool = {
    name: 'git_commit',
    description:
      'Commit staged changes (or all tracked changes with all) in the repository. Message is validated (1..2000 chars, no NUL) and passed as a single argv.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
        message: { type: 'string', description: 'Commit message (required)' },
        all: { type: 'boolean', description: 'Stage tracked modifications first (-a)' },
        allowEmpty: { type: 'boolean', description: 'Allow empty commit (--allow-empty)' },
      },
      required: ['message'],
    },
    output: textOutput(),
    timeoutMs: 40000,
    isConcurrencySafe: () => false,
    presentCall: (a) => present(a, 'commit'),
    async execute(args) {
      const msg = str(args, 'message')
      if (typeof msg !== 'string' || msg.trim() === '' || msg.length > MAX_MSG_LEN || msg.includes('\0')) {
        throw new Error(`message must be 1..${MAX_MSG_LEN} chars without NUL`)
      }
      const argv = ['commit', '-m', msg]
      if (bool(args, 'all')) argv.push('-a')
      if (bool(args, 'allowEmpty')) argv.push('--allow-empty')
      const res = await git(argv, { cwd: str(args, 'cwd') })
      if (!res.ok) return { ok: false, error: res.error }
      const hash = res.stdout.match(/\[([^\]]+)\s+([0-9a-f]+)\]/)?.[2] ?? null
      return { ok: true, output: res.stdout, hash }
    },
  }

  const branchTool: Tool = {
    name: 'git_branch',
    description: 'List branches. Shows current branch marker and name.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
        all: { type: 'boolean', description: 'Include remote branches (-a)' },
      },
    },
    output: textOutput(),
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'branch'),
    async execute(args) {
      const argv = ['branch']
      if (bool(args, 'all')) argv.push('-a')
      const res = await git(argv, { cwd: str(args, 'cwd') })
      if (!res.ok) return { ok: false, error: res.error }
      const branches = res.stdout.split('\n').filter(Boolean).map((l) => ({
        current: l.startsWith('*'),
        name: l.replace(/^[*\s]+/, '').trim(),
      }))
      return { ok: true, branches, current: branches.find((b) => b.current)?.name ?? null }
    },
  }

  for (const tool of [statusTool, diffTool, logTool, commitTool, branchTool]) {
    try {
      ctx.tools.register(tool)
    } catch (err) {
      console.error(`[gitkit] ${tool.name} registration skipped: ${err}`)
    }
  }

  // HTTP: 注册到官方 ctx.webServer。
  //
  // **不能**直接读 `ctx.webServer` —— cordis 的 ctx 是代理, 读一个已注册但未声明 inject
  // 的服务会抛 "cannot get property ... without inject", 可选链挡不住(get 陷阱先抛)。
  // 官方写法是用 ctx.inject 把依赖收进子 context (client/connection/src/index.ts:139-159):
  //   ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => webCtx.webServer.register(route), 'label'))
  // 没有 webServer 的 profile 里回调不执行 —— 路由不注册, 插件其余部分照常加载。
  // (原先的 `ctx.http?.mount?.()` —— ctx.http 不是 DSH 服务, 那两条路由从未生效。)
  ctx.inject?.(['webServer'], (webCtx) => {
    const register = (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
      webCtx.webServer.register({ kind, path, handler })
    }
    const mount = (): void => registerHttpRoutes(ctx, register)
    if (typeof webCtx.effect === 'function') webCtx.effect(mount, 'gitkit: GET /api/gitkit/{health,version}')
    else mount()
  })
}

// --- HTTP routes (official ctx.webServer; native node:http req/res, no Hono, no bridge) ---

/**
 * 原先这里返回一个 Hono app 供 `ctx.http?.mount?.()` 挂载, 而 `ctx.http` 不是 DSH 的
 * 服务(官方 90 个 ctx.* 里没有它), 所以路由从未响应过任何请求, `hono` 依赖却一直背着。
 * 官方 web 层本来就是 node:http, handler 拿的是原生 IncomingMessage/ServerResponse,
 * 官方既不依赖 hono 也没有 Node↔Fetch 桥 —— 所以这里直接写 res, 不造桥、不引 hono。
 */
/**
 * Apply the official Host/Origin + browser-auth fence to one plugin's health routes.
 *
 * SOURCE — copied from the official DSH 0.1.7-rc.2 package `@deepseek-ai/dsh-host-open-in-app`,
 * which states the contract in its own module comment
 * (`lib/types/index.js:1-21`): "Security has one home, here. **Every route** asks the
 * composition's `connection` service for a rejection first (`requestRejection`): its Host/Origin
 * fence defeats DNS rebinding and cross-site calls, and its browser authentication (the
 * login-token cookie) gates every caller". The helper shape is `lib/index.js:1263-1270` and its
 * use is the first line of every handler there (`lib/index.js:1274-1275`).
 *
 * `requestRejection` itself (`dsh-client-connection/lib/index.js:586-589`):
 *   403 -> the Host is not loopback/trusted, or `sec-fetch-site: cross-site`, or Origin != Host
 *   401 -> the fence passed but there is no valid login-token cookie
 * so an anonymous request gets 401 and a forged one gets 403. Authentication accepts the
 * `dsh-auth-*` cookie ONLY (minted by the 303 set-cookie on `GET /?token=...`); the boot token
 * itself does not authenticate an API call. A browser that loaded the page first is unaffected.
 *
 * DO NOT "simplify" this away, and do not replace the read with `Reflect.get(ctx, 'connection')`.
 * The official helper is written that way because its own plugin declares `inject: ['connection']`;
 * from a plugin that does not, MEASURED on a live 127.0.0.1 instance, BOTH
 * `ctx.connection` AND `Reflect.get(ctx, 'connection')` throw
 * `cannot get property "connection" without inject` (cordis's proxy get-trap throws before any
 * optional chaining can help), while `ctx.get('connection')` returned the live
 * `HostConnectionService` with `requestRejection` present. `ctx.get` is also the official
 * inject-free service read — `dsh-web-app/lib/index.js:216` gates the ready banner on
 * `connectionCtx.get("connection") !== void 0`.
 *
 * FAIL-CLOSED. When the service is unreachable the request is answered 503, never forwarded:
 * silently serving would reopen exactly the hole this helper exists to close. In this profile
 * the branch is unreachable by construction — the route only registers under
 * `ctx.inject(['webServer'])`, and every composition that has `webServer` also carries
 * `connection` (`dsh-web-app/cordis.patch.yml:210-217` registers it beside the webserver).
 *
 * Each plugin carries its OWN copy on purpose: they are independent packages, and a shared
 * module would create a new deployment coupling (the ACP-graph contract already showed what
 * that costs, with 5 copies to re-sync on every edit).
 */

/** Just enough of the official HostConnectionService for the fence call. */
interface RequestFenceConnection {
  /** @returns 401/403 when the request must be refused, `undefined` when it may proceed. */
  requestRejection: (request: IncomingMessage) => number | undefined
}

/**
 * Build the fence for one plugin life.
 *
 * @param ctx - the plugin's context; only `get` is used, and only at call time.
 * @returns true when the request was answered by the fence and the handler must stop.
 */
function createRequestFence(ctx: unknown): (req: IncomingMessage, res: ServerResponse) => boolean {
  /** Read the service without declaring `inject` — see the read note above for why not Reflect.get. */
  const resolveConnection = (): RequestFenceConnection | undefined => {
    const read = (ctx as { get?: (name: string) => unknown } | null | undefined)?.get
    if (typeof read !== 'function') return undefined
    try {
      const connection = read.call(ctx, 'connection') as RequestFenceConnection | undefined
      return typeof connection?.requestRejection === 'function' ? connection : undefined
    } catch {
      return undefined
    }
  }

  return (req, res) => {
    const connection = resolveConnection()
    if (connection === undefined) {
      // Fail closed: an unreachable fence must not become an open route.
      res.statusCode = 503
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: 'connection service unavailable: the Host/Origin fence cannot be applied' }))
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }
}

export function registerHttpRoutes(
  ctx: unknown,
  register: (kind: 'exact' | 'prefix', path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) => void,
): void {
  const rejected = createRequestFence(ctx)
  const route = (path: string, payload: () => unknown): void => {
    register('exact', path, (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload()))
    })
  }
  route('/api/gitkit/health', () => ({ ok: true, plugin: 'dsh-gitkit', ts: true }))
  route('/api/gitkit/version', () => ({ name: '@snow-the/dsh-gitkit', version: '0.1.0' }))
}
