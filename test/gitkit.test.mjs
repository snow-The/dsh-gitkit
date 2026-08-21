import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../dist/index.js'

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