# Phase 3 — packaging & publication notes

## Pi package manifest

- `keywords` includes exact `pi-package` (gallery eligibility per https://pi.dev/docs/latest/packages).
- `pi.extensions`: `./extensions`
- `pi.image`: `./assets/gentle-logo-only.png`
- Host packages listed in `peerDependencies` with `"*"` (not bundled).

## Install sources (official)

```text
pi install npm:gentle-voice
gentle-shell install npm:gentle-voice
pi install git:github.com/efolchmontiel/gentle-voice@<tag>
```

Do not advertise `npm:` until `npm publish` succeeds and a clean install is verified.

## Gallery

Keyword `pi-package` makes an npm package **eligible** for https://pi.dev/packages. Indexing delay is unknown; presence must be verified after publish.

## Release gate (human)

1. `npm whoami` on the publishing account
2. Confirm name `gentle-voice` still free / owned
3. Pin artifact URLs + SHA-256 in `lib/runtime/artifacts.ts`
4. License review for each binary/voice
5. Clean VM install from npm
6. Explicit approval for `npm publish --tag beta`
