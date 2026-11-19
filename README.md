# pi-ide-connect

A [pi](https://pi.dev) extension that implements Claude Code's `/ide` protocol. pi acts as the client: it discovers
the lock files that Claude Code-compatible IDE extensions (VS Code, JetBrains, Neovim's claudecode.nvim, ...) write to
`~/.claude/ide/<port>.lock` (or `$CLAUDE_CONFIG_DIR/ide`), then connects over WebSocket (MCP / JSON-RPC 2.0) with the
`x-claude-code-ide-authorization` token.

## Install

```sh
npm install        # in this directory
pi install /path/to/pi-ide-connect   # or: pi -e /path/to/pi-ide-connect
```

## Features

| IDE protocol feature | In pi |
|---|---|
| Auto-connect | On start, connects to the IDE whose workspace contains the cwd (`CLAUDE_CODE_SSE_PORT` wins, then the most specific workspace match). Reconnects with backoff. |
| `selection_changed` | Shown in the footer; the current selection / open file is added to the model's context once per change. |
| `at_mentioned` | Inserts `@path#L10-20` into the editor. |
| `openDiff` / `close_tab` | `edit` and `write` open a diff in the IDE and wait for accept/reject. Accepting (including with edits made in the diff) writes the file; rejecting blocks the call and ends the turn. |
| `getDiagnostics` | `ide_get_diagnostics` tool for the model. |
| `executeCode` | `ide_execute_code` tool (only if the IDE offers it). |

`/ide` selects an IDE; also `/ide <port>`, `/ide off`, `/ide status`, `/ide diff [on|off]`.

Environment: `PI_IDE_AUTOCONNECT=0` disables auto-connect; `PI_IDE_DIFF=off` disables diff review.

## Notes

- The client identifies as `claude-code` (title `Pi`) and names diff tabs `[Claude Code]` so IDE extensions that
  gate on those accept it.
- The protocol is reverse-engineered (see [claudecode.nvim's PROTOCOL.md](https://github.com/coder/claudecode.nvim/blob/main/PROTOCOL.md));
  it has been tested against a mock IDE server and real pi, not yet against every real IDE.
- `npm test` runs the unit and mock-IDE tests.
