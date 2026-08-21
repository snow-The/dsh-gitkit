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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
export const name = 'gitkit';
export const inject = ['tools'];
const MAX_MSG_LEN = 2000;
const textOutput = () => ({
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});
/** Validate a repo-relative path argument. Throws on anything suspicious. */
function checkPath(p, label) {
    if (typeof p !== 'string' || p.trim() === '' || p.trim() === '.')
        return typeof p === 'string' ? p.trim() : undefined;
    const v = p.trim();
    if (v.startsWith('/') || /^[A-Za-z]:/.test(v)) {
        throw new Error(`${label}: absolute paths are not allowed`);
    }
    if (v === '..' || v.split(/[\\/]/).includes('..')) {
        throw new Error(`${label}: '..' traversal is not allowed`);
    }
    if (!/^[^\\/:*?"<>|]+$/.test(v.replaceAll('\\', '/'))) {
        throw new Error(`${label}: invalid path characters`);
    }
    return v;
}
function checkCwd(cwd) {
    if (cwd === undefined || cwd === null)
        return process.cwd();
    if (typeof cwd !== 'string')
        throw new Error('cwd must be a string');
    return cwd;
}
async function git(args, opts = {}) {
    try {
        const { stdout, stderr } = await execFileP('git', args, {
            cwd: checkCwd(opts.cwd),
            timeout: opts.timeoutMs ?? 30000,
            maxBuffer: 16 * 1024 * 1024,
        });
        return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() };
    }
    catch (err) {
        const e = err;
        return { ok: false, error: e.stderr?.trim() || e.message, code: e.code ?? null };
    }
}
function present(args, kind) {
    return { card: 'generic', title: 'git ' + kind, kind: 'read', rawInput: args };
}
function str(a, k) {
    const v = a?.[k];
    return typeof v === 'string' ? v : undefined;
}
function bool(a, k) {
    const v = a?.[k];
    return typeof v === 'boolean' ? v : undefined;
}
function num(a, k) {
    const v = a?.[k];
    return typeof v === 'number' ? v : undefined;
}
export function apply(ctx) {
    const statusTool = {
        name: 'git_status',
        description: 'Show working tree status. Returns porcelain lines (XY path) plus a summary. Path filters are repo-relative and validated (no absolute paths, no "..").',
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
            const path = str(args, 'path') ? checkPath(str(args, 'path'), 'path') : undefined;
            const argv = ['status', '--porcelain=v1'];
            if (path)
                argv.push('--', path);
            const res = await git(argv, { cwd: str(args, 'cwd') });
            if (!res.ok)
                return { ok: false, error: res.error };
            const lines = res.stdout.split('\n').filter(Boolean);
            const summary = {};
            for (const l of lines) {
                const xy = l.slice(0, 2).trim();
                summary[xy] = (summary[xy] ?? 0) + 1;
            }
            return { ok: true, lines, count: lines.length, summary };
        },
    };
    const diffTool = {
        name: 'git_diff',
        description: 'Show diff of the working tree (unstaged), staged (--cached), or between two refs (base/head). Use stat for a summary. Path filters are validated.',
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
            const path = str(args, 'path') ? checkPath(str(args, 'path'), 'path') : undefined;
            const argv = ['diff'];
            if (bool(args, 'cached'))
                argv.push('--cached');
            const base = str(args, 'base');
            const head = str(args, 'head');
            if (base && head)
                argv.push(base, head);
            if (bool(args, 'stat'))
                argv.push('--stat');
            if (path)
                argv.push('--', path);
            const res = await git(argv, { cwd: str(args, 'cwd') });
            if (!res.ok)
                return { ok: false, error: res.error };
            return { ok: true, diff: res.stdout, bytes: Buffer.byteLength(res.stdout) };
        },
    };
    const logTool = {
        name: 'git_log',
        description: 'Show recent commits (default 20). Returns list: hash, date, author, subject. Path filters are validated.',
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
            const path = str(args, 'path') ? checkPath(str(args, 'path'), 'path') : undefined;
            const n = Math.min(Math.max(1, num(args, 'count') ?? 20), 200);
            const argv = ['log', '-' + n, '--date=short', '--pretty=format:%h %ad %an %s'];
            if (path)
                argv.push('--', path);
            const res = await git(argv, { cwd: str(args, 'cwd') });
            if (!res.ok)
                return { ok: false, error: res.error };
            const commits = res.stdout.split('\n').filter(Boolean).map((l) => {
                const m = l.match(/^(\S+) (\S+) (.*?) (.*)$/);
                return m ? { hash: m[1], date: m[2], author: m[3], subject: m[4] } : { raw: l };
            });
            return { ok: true, commits, count: commits.length };
        },
    };
    const commitTool = {
        name: 'git_commit',
        description: 'Commit staged changes (or all tracked changes with all) in the repository. Message is validated (1..2000 chars, no NUL) and passed as a single argv.',
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
            const msg = str(args, 'message');
            if (typeof msg !== 'string' || msg.trim() === '' || msg.length > MAX_MSG_LEN || msg.includes('\0')) {
                throw new Error(`message must be 1..${MAX_MSG_LEN} chars without NUL`);
            }
            const argv = ['commit', '-m', msg];
            if (bool(args, 'all'))
                argv.push('-a');
            if (bool(args, 'allowEmpty'))
                argv.push('--allow-empty');
            const res = await git(argv, { cwd: str(args, 'cwd') });
            if (!res.ok)
                return { ok: false, error: res.error };
            const hash = res.stdout.match(/\[([^\]]+)\s+([0-9a-f]+)\]/)?.[2] ?? null;
            return { ok: true, output: res.stdout, hash };
        },
    };
    const branchTool = {
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
            const argv = ['branch'];
            if (bool(args, 'all'))
                argv.push('-a');
            const res = await git(argv, { cwd: str(args, 'cwd') });
            if (!res.ok)
                return { ok: false, error: res.error };
            const branches = res.stdout.split('\n').filter(Boolean).map((l) => ({
                current: l.startsWith('*'),
                name: l.replace(/^[*\s]+/, '').trim(),
            }));
            return { ok: true, branches, current: branches.find((b) => b.current)?.name ?? null };
        },
    };
    for (const tool of [statusTool, diffTool, logTool, commitTool, branchTool]) {
        try {
            ctx.tools.register(tool);
        }
        catch (err) {
            console.error(`[gitkit] ${tool.name} registration skipped: ${err}`);
        }
    }
}
