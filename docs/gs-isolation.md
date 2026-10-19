# Gentle Shell isolation (phase 3.4)

## Effective GS home (from Gentle Shell sources)

| Concept | Source | Default |
| --- | --- | --- |
| Isolated agent home | `GENTLE_SHELL_HOME` or `~/.gentle-shell/agent` | `lib/gentle-shell-launcher.ts` `isolatedDir` |
| Session agent dir | `PI_CODING_AGENT_DIR` / `GENTLE_PI_AGENT_HOME` | set by launcher to resolved home |
| User Pi home (read-only / `--link`) | `GENTLE_SHELL_USER_PI_HOME` | user’s `~/.pi/agent` |
| Bundled prefix | `GENTLE_SHELL_PREFIX` | `~/.gentle-shell` (bundled layout) |

Modes (`resolveHome`): `isolated` (default), `link` (`--link`), `path` (`--home`).

Gentle Voice **never** decides isolation by finding `.gentle-shell` on disk alone. It only reads process env.

## Storage design

API: `resolveGentleVoiceStorage()` in `lib/runtime/storage.ts`.

Preferred GS root: `<prefix>/gentle-voice/` with `bin/`, `models/`, `config/`, `cache/`, `tmp/`, `logs/`.

Does not write into GS `versions/` or `runtime/`.

## Exact routes

| Mode | `hostKind` | Storage root |
| --- | --- | --- |
| Pi alone | `pi-standalone` | XDG / LocalAppData / Application Support |
| GS bundled | `gs-bundled` | `$GENTLE_SHELL_PREFIX/gentle-voice` |
| GS isolated default | `gs-isolated` | `~/.gentle-shell/gentle-voice` |
| GS `--link` | `gs-link` | portable Pi layout |
| GS custom home | `gs-custom-home` | `<agentHome>/gentle-voice` |
| Overrides | `override` | `$GENTLE_VOICE_HOME` |

## Uninstall / cleanup

- Package: `gentle-shell remove npm:gentle-voice` or `pi remove npm:gentle-voice`
- Data: `/gentle:voice storage` dry-run only; no automatic delete
