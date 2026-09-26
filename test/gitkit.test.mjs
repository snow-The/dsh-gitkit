import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, registerHttpRoutes } from '../dist/index.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitkit-test-'))
  execFileSync('git', ['init', '-q', dir])
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  execFileSync('git', ['add', 'a.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'first'], { cwd: dir })
  return dir
}

function makeCtx() {
  const tools = []
  tools.register = (t) => tools.push(t)
  return { tools }
}

test('registers five tools', () => {
  const ctx = makeCtx()
  apply(ctx)
  assert.deepEqual(ctx.tools.map((t) => t.name).sort(), ['git_branch', 'git_commit', 'git_diff', 'git_log', 'git_status'])
})

test('git_status reports clean and modified', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const dir = makeRepo()
  const clean = await ctx.tools[0].execute({ cwd: dir })
  // find status tool by name
  const status = ctx.tools.find((t) => t.name === 'git_status')
  const r1 = await status.execute({ cwd: dir })
  assert.equal(r1.ok, true)
  assert.equal(r1.count, 0)
  writeFileSync(join(dir, 'a.txt'), 'changed\n')
  const r2 = await status.execute({ cwd: dir })
  assert.equal(r2.ok, true)
  assert.equal(r2.count, 1)
  assert.ok(Object.keys(r2.summary).length >= 1)
  rmSync(dir, { recursive: true, force: true })
})

test('path validation rejects traversal', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const status = ctx.tools.find((t) => t.name === 'git_status')
  await assert.rejects(() => status.execute({ cwd: process.cwd(), path: '../evil' }), /traversal/)
  await assert.rejects(() => status.execute({ cwd: process.cwd(), path: 'C:/Windows' }), /absolute/)
})

test('git_commit validates message and commits', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const commit = ctx.tools.find((t) => t.name === 'git_commit')
  await assert.rejects(() => commit.execute({ cwd: process.cwd(), message: '' }), /message/)
  const dir = makeRepo()
  writeFileSync(join(dir, 'b.txt'), 'x\n')
  execFileSync('git', ['add', 'b.txt'], { cwd: dir })
  const r = await commit.execute({ cwd: dir, message: 'second commit' })
  assert.equal(r.ok, true)
  assert.ok(r.hash)
  const log = execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' })
  assert.match(log, /second commit/)
  rmSync(dir, { recursive: true, force: true })
})

test('git_log returns commits', async () => {
  const ctx = makeCtx()
  apply(ctx)
  const dir = makeRepo()
  const log = ctx.tools.find((t) => t.name === 'git_log')
  const r = await log.execute({ cwd: dir })
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.equal(r.commits[0].subject, 'first')
  rmSync(dir, { recursive: true, force: true })
})

// 捕获 registerHttpRoutes 注册的路由, 并用假 res 调用它 —— 直接测我们自己的 handler
// (原生 node:http req/res), 而不是 Hono 的 Request/Response 适配层。
function captureRoutes(ctx) {
  // The fence asks the composition's `connection` service for a rejection before serving. These
  // helpers are handed a bare object ({} or a deps bag), so that read returned undefined, the fence
  // failed CLOSED with 503 -- correctly -- and the health tests asserted 503 instead of 200. The
  // stub never modelled a host; this makes it model one. The caller's object is preserved, because
  // dsh-busyloop passes { llm } and its providers tests need it.
  const withAdmittingConnection = (base) => {
    const own = base ?? {};
    return {
      ...own,
      get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : own.get?.(name)),
    };
  };
  
  const routes = new Map()
  registerHttpRoutes(withAdmittingConnection(ctx), (kind, path, handler) => { routes.set(path, { kind, handler }) })
  const call = async (path, method = 'GET') => {
    const route = routes.get(path)
    if (!route) throw new Error('no route registered at ' + path)
    const res = { statusCode: 0, headers: {}, body: undefined, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
    await route.handler({ method, url: path }, res)
    return res
  }
  return { routes, call }
}

test('health and version routes are exact and answer 200', async () => {
  const { routes, call } = captureRoutes({})
  assert.deepEqual([...routes.keys()].sort(), ['/api/gitkit/health', '/api/gitkit/version'])
  assert.equal(routes.get('/api/gitkit/health').kind, 'exact')

  const health = await call('/api/gitkit/health')
  assert.equal(health.statusCode, 200)
  assert.equal(health.headers['content-type'], 'application/json; charset=utf-8')
  const hb = JSON.parse(String(health.body))
  assert.equal(hb.ok, true)
  assert.equal(hb.plugin, 'dsh-gitkit')
  assert.equal(hb.hono, undefined)

  const version = await call('/api/gitkit/version')
  assert.equal(version.statusCode, 200)
  assert.deepEqual(JSON.parse(String(version.body)), { name: '@snow-the/dsh-gitkit', version: '0.1.0' })
})

test('non-GET is rejected with 405 + allow: GET', async () => {
  const { call } = captureRoutes({})
  for (const p of ['/api/gitkit/health', '/api/gitkit/version']) {
    const res = await call(p, 'POST')
    assert.equal(res.statusCode, 405)
    assert.equal(res.headers['allow'], 'GET')
  }
})

test('apply registers on the official ctx.webServer, not the absent ctx.http', () => {
  const registered = []
  let effectLabel = null
  const ctx = cordisCtx({
    webServer: { register: (r) => { registered.push(r); return () => {} } },
    extra: { tools: makeCtx().tools, effect: (fn, label) => { effectLabel = label; fn() } },
  })
  apply(ctx)
  assert.deepEqual(registered.map((r) => r.path).sort(), ['/api/gitkit/health', '/api/gitkit/version'])
  assert.match(String(effectLabel), /gitkit/)
})

// 复刻 cordis 的 ctx 代理: 读一个已注册但**未声明 inject** 的服务时, get 陷阱先抛
// "cannot get property X without inject" —— 可选链 `ctx.webServer?.x` 挡不住。
// 这正是本次迁移踩到的坑: 在 apply 里直接读 ctx.webServer 会让整个插件激活失败。
function cordisCtx({ webServer, extra = {} } = {}) {
  let inInject = false
  const target = {
    ...extra,
    inject: (deps, cb) => {
      if (!deps.includes('webServer') || !webServer) return undefined
      const prev = inInject
      inInject = true
      try { return cb({ webServer, effect: extra.effect }) } finally { inInject = prev }
    },
  }
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'webServer' && !inInject) throw new Error('cannot get property "webServer" without inject')
      return t[prop]
    },
  })
}

test('the cordis trap is real, and apply avoids it by using ctx.inject', () => {
  const ctx = cordisCtx({ webServer: { register: () => () => {} } })
  assert.throws(() => ctx.webServer, /without inject/)
  assert.doesNotThrow(() => apply(ctx))
})

test('apply tolerates a host without webServer (no throw)', () => {
  apply(makeCtx())
  assert.doesNotThrow(() => apply(cordisCtx({ extra: { tools: makeCtx().tools } })))
})