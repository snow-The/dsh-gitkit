# dsh-gitkit

Structured Git tools for DeepSeek Harness — an own-built replacement for
third-party git plugins. No bare-shell git calls: every command goes through
`child_process.execFile('git', args)` with path validation (no absolute
paths, no `..` traversal, no shell metacharacters).

## Tools

- `git_status` — working tree status (porcelain), optional path filter
- `git_diff` — diff of working tree or between refs (`--stat` or full)
- `git_log` — recent commits (count, optional path filter)
- `git_commit` — commit staged changes with validated message
- `git_branch` — list branches / current branch

## Install

```
dsh plugin --profile web add file:~/dsh-own-plugins/dsh-gitkit
```

## License

MIT
