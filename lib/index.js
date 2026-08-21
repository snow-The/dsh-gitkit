/**
 * dsh-gitkit — structured Git tools for DeepSeek Harness.
 *
 * Design rules (borrowed from the security audits that motivated this build):
 *  1. every git invocation goes through execFile('git', args) — no shell,
 *     no string interpolation, no injection surface;
 *  2. every path argument is validated: must be relative, no '..' segments,
 *     no backslash escapes, no drive letters, no shell metacharacters;
 *  3. commit messages are length/NUL validated and passed as argv, never
 *     concatenated into a command line;
 *  4. zero runtime dependencies (node builtins only) — nothing to audit
 *     downstream of this package.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export const name = 'gitkit'
export const inject = ['tools']

const MAX_MSG_LEN = 2000
const PATH_RE = /^[^\/:*?"<>|]+$/ // no drive letters, no separators outside '\' handling below

/** Validate a repo-relative path argument. Throws on anything suspicious. */
function checkPath(p, label) {
  if (typeof p !== 'string' || p.trim() === '' || p.trim() === '.') return p?.trim()
  const v = p.trim()
  if (v.startsWith('/') || /^[A-Za-z]:/.test(v)) {
    throw new Error(`${label}: absolute paths are not allowed`)
  }
  if (/..[\/\\]/.test(v) || v === '..' || v.split(/[\/\\]/).includes('..')) {
    throw new Error(`${label}: '..' traversal is not allowed`)
  }
  if (!PATH_RE.test(v.replaceAll('\\', '/'))) {
    throw new Error(`${label}: invalid path characters`)
  }
  return v
}

/** Resolve cwd: default to process.cwd(); reject absolute override? No — a
 *  caller may legitimately target another repo, so cwd is allowed but must
 *  exist. */
function checkCwd(cwd) {
  if (!cwd) return process.cwd()
  if (typeof cwd !== 'string') throw new Error('cwd must be a string')
  return cwd
}

async function git(args, { cwd, timeoutMs } = {}) {
  try {
    const { stdout, stderr } = await execFileP('git', args, {
      cwd: checkCwd(cwd),
      timeout: timeoutMs ?? 30000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() }
  } catch (err) {
    return { ok: false, error: err.stderr?.trim() || err.message, code: err.code ?? null }
  }
}

function present(args, kind) {
  return { card: 'generic', title: 'git ' + kind, kind: 'read', rawInput: args }
}

/** DSH requires every tool to declare output { schema, render }. */
const textOutput = () => ({
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

export function apply(ctx) {
  const statusTool = {
    name: 'git_status',
    description:
      'Show working tree status. Returns porcelain lines (XY path) plus an optional short summary. Path filters are repo-relative and validated (no absolute paths, no "..").',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory (default: current workspace root)' },
        path: { type: 'string', description: 'Optional repo-relative path filter' },
      },
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'status'),
    async execute(args) {
      const path = args?.path ? checkPath(args.path, 'path') : undefined
      const argv = ['status', '--porcelain=v1']
      if (path) argv.push('--', path)
      const res = await git(argv, { cwd: args?.cwd })
      if (!res.ok) return { ok: false, error: res.error }
      const lines = res.stdout.split('\n').filter(Boolean)
      const counts = {}
      for (const l of lines) {
        const xy = l.slice(0, 2).trim()
        counts[xy] = (counts[xy] ?? 0) + 1
      }
      return { ok: true, lines, count: lines.length, summary: counts }
    },
  }

  const diffTool = {
    name: 'git_diff',
    description:
      'Show diff of the working tree (unstaged), staged (--cached), or between two refs (base/head). Use --stat for a summary. Path filters are validated.',
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
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'diff'),
    async execute(args) {
      const path = args?.path ? checkPath(args.path, 'path') : undefined
      const argv = ['diff']
      if (args?.cached) argv.push('--cached')
      if (args?.base && args?.head) argv.push(args.base, args.head)
      if (args?.stat) argv.push('--stat')
      if (path) argv.push('--', path)
      const res = await git(argv, { cwd: args?.cwd })
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, diff: res.stdout, bytes: Buffer.byteLength(res.stdout) }
    },
  }

  const logTool = {
    name: 'git_log',
    description:
      'Show recent commits (default 20). Returns oneline list: hash, author, date, subject. Path filters are validated.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
        count: { type: 'number', description: 'Number of commits (default 20, max 200)' },
        path: { type: 'string', description: 'Optional repo-relative path filter' },
      },
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'log'),
    async execute(args) {
      const path = args?.path ? checkPath(args.path, 'path') : undefined
      const n = Math.min(Math.max(1, args?.count ?? 20), 200)
      const argv = ['log', '-' + n, '--date=short', '--pretty=format:%h %ad %an %s']
      if (path) argv.push('--', path)
      const res = await git(argv, { cwd: args?.cwd })
      if (!res.ok) return { ok: false, error: res.error }
      const commits = res.stdout.split('\n').filter(Boolean).map((l) => {
        const m = l.match(/^(\S+) (\S+) (.*?) (.*)$/)
        return m ? { hash: m[1], date: m[2], author: m[3], subject: m[4] } : { raw: l }
      })
      return { ok: true, commits, count: commits.length }
    },
  }

  const commitTool = {
    name: 'git_commit',
    description:
      'Commit staged changes (or all tracked changes with --all) in the repository. The message is validated (1..2000 chars, no NUL) and passed as a single argv — never interpolated into a shell command.',
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
    timeoutMs: 40000,
    isConcurrencySafe: () => false,
    presentCall: (a) => present(a, 'commit'),
    async execute(args) {
      const msg = args?.message
      if (typeof msg !== 'string' || msg.trim() === '' || msg.length > MAX_MSG_LEN || msg.includes('\0')) {
        throw new Error(`message must be 1..${MAX_MSG_LEN} chars without NUL`)
      }
      const argv = ['commit', '-m', msg]
      if (args?.all) argv.push('-a')
      if (args?.allowEmpty) argv.push('--allow-empty')
      const res = await git(argv, { cwd: args?.cwd })
      if (!res.ok) return { ok: false, error: res.error }
      const hash = res.stdout.match(/\[([^\]]+)\s+([0-9a-f]+)\]/)?.[2] ?? null
      return { ok: true, output: res.stdout, hash }
    },
  }

  const branchTool = {
    name: 'git_branch',
    description:
      'List branches. Shows current branch marker, name, and optional tracking/last-commit info.',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'Repository directory' },
        all: { type: 'boolean', description: 'Include remote branches (-a)' },
      },
    },
    timeoutMs: 40000,
    isConcurrencySafe: () => true,
    presentCall: (a) => present(a, 'branch'),
    async execute(args) {
      const argv = ['branch']
      if (args?.all) argv.push('-a')
      const res = await git(argv, { cwd: args?.cwd })
      if (!res.ok) return { ok: false, error: res.error }
      const branches = res.stdout.split('\n').filter(Boolean).map((l) => ({
        current: l.startsWith('*'),
        name: l.replace(/^[*\s]+/, '').trim(),
      }))
      return { ok: true, branches, current: branches.find((b) => b.current)?.name ?? null }
    },
  }

  for (const tool of [statusTool, diffTool, logTool, commitTool, branchTool]) {
    tool.output = textOutput()
    try {
      ctx.tools.register(tool)
    } catch (err) {
      console.error(`[gitkit] ${tool.name} registration skipped: ${err}`)
    }
  }
}
