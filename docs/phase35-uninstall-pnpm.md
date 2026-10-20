# Phase 3.5 — `pi remove` / ERR_PNPM_IGNORED_BUILDS

## Root cause (verified on this machine)

`~/.pi/agent/settings.json` sets `npmCommand` to the local `pi-npm-gate` wrapper + `pnpm`
(path varies per machine under `~/.local/share/pi-npm-gate/…`).

`pi remove` → pi-npm-gate **passthrough** → `pnpm uninstall …` (and often a follow-up install/rebuild of the npm root).

`~/.pi/agent/npm/pnpm-workspace.yaml` contains:

```yaml
allowBuilds:
  '@ast-grep/cli': set this to true or false
```

That placeholder string is **not** a valid pnpm `allowBuilds` boolean. pnpm ≥11 with strict dependency builds then fails with `ERR_PNPM_IGNORED_BUILDS` for `@ast-grep/cli@0.45.0`.

`@ast-grep/cli` is a **dependency of `pi-lens@4.3.0`**, not of `gentle-voice`. Gentle Voice does not introduce this package.

## Ownership split

| Layer | Role |
| --- | --- |
| Gentle Voice | Package to install/remove; private data under its storage root |
| Pi | Writes `settings.json` packages[] and drives npmCommand |
| pi-npm-gate | Wraps pnpm for visibility; uninstall is passthrough (does not invent allowBuilds) |
| pnpm | Enforces `allowBuilds` / ignored builds policy |

## Localized fix (preserve supply-chain policy)

**Do not** run `pnpm approve-builds --all`.

Edit only `~/.pi/agent/npm/pnpm-workspace.yaml` and set an explicit decision for the known transitive:

```yaml
allowBuilds:
  '@ast-grep/cli': true   # required by pi-lens native CLI postinstall
  '@google/genai': true
  esbuild: true
  # … keep other existing entries …
```

Or set `false` if you accept pi-lens without that native helper (may degrade pi-lens features).

Then retry:

```bash
pi remove npm:gentle-voice
```

### Optional pi-npm-gate improvement (dev only — needs consent)

Translate `ERR_PNPM_IGNORED_BUILDS` on stderr into a clear Spanish/English message naming the package and the `allowBuilds` key. Apply only in a **development copy** of pi-npm-gate; do not overwrite `~/.local/share/pi-npm-gate` without explicit approval.

## State observed after failed remove (this host)

| Artifact | State |
| --- | --- |
| `~/.pi/agent/settings.json` → `packages` | still contains `npm:gentle-voice` |
| `~/.pi/agent/npm/package.json` | **no** `gentle-voice` dependency |
| `~/.pi/agent/npm/node_modules/gentle-voice` | **absent** |

Interpretation: **partial uninstall** — settings still registered, npm root already dropped the package (or never finished linking). Pi may still try to load it from the packages list.

## Recovery (manual — no agent mutation of principal install)

1. Fix `allowBuilds['@ast-grep/cli']` as above.
2. Remove the stale settings entry if remove still fails:
   - Edit `~/.pi/agent/settings.json` and delete `"npm:gentle-voice"` from `packages`.
3. Optional data cleanup (after reviewing paths):
   - While installed: `/gentle:voice purge` then confirm token.
   - Or: `npx --package gentle-voice@0.1.2 gentle-voice-cleanup` (after 0.1.2 is published).
4. Reinstall when ready: `pi install npm:gentle-voice@0.1.2` (after publish) or `@0.1.1` for current latest.

Never delete Voxtype, WD-Black, other Pi packages, or `~/.gentle-shell/{versions,runtime}`.
