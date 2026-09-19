# Contributing to Kikimora

Bug reports, documentation and code contributions are welcome.

## Setup

- Node.js `^22.16.0` or `>=24.0.0` and [pnpm](https://pnpm.io); `corepack enable` installs the pnpm version pinned in `package.json`.
- `pnpm install`
- `pnpm dev` starts kikimora in watch mode (tsx); `pnpm start` runs it once.

## Before you open a PR

```bash
pnpm check   # typecheck + lint + format:check + test
```

CI runs `pnpm check` and `pnpm build` on Ubuntu and macOS with Node 22.16 and 24 (`.github/workflows/ci.yml`).

- **Tests are required.** `vitest.config.ts` enforces coverage thresholds (statements 92%, branches 75%, functions 90%, lines 94%); code below them fails the build.
- Tests live in `test/` and mirror `src/`.
- Claude sessions are tested against a fake binary (`test/fixtures/claude`) driven by `FAKE_CLAUDE_*` variables. Tests do not call the real CLI.
- **Prettier owns formatting**: `pnpm format` fixes it.

## Conventions

- Code, user-facing messages, errors and commit messages are in English.
- No comments in the code.
- Agent prompt content lives **only** in markdown files: `prompts/*.system.md` in the package, `.kikimora/prompts/*.prompt.md` in projects. Do not put it in string constants.
- A new configuration option needs a key in `settingsSchema` (`src/config.ts`), a mapping in `loadWorkerConfig`, a leaf assignment in `applySettings` (`src/settings-controller.ts`), and usually a slash command in `src/ui/commands.ts`.
- `src/paths.ts` is the single source of truth for the filesystem layout.

[CLAUDE.md](CLAUDE.md) describes the architecture in full.

## Demo GIF

The README demo is scripted. Re-record it after UI changes:

```bash
pnpm build
node scripts/demo/setup.mjs
vhs scripts/demo/demo.tape   # requires https://github.com/charmbracelet/vhs
```

## Releasing (maintainers)

1. Bump the version in `package.json` and move the entries in `CHANGELOG.md` from _Unreleased_ to a new dated section.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin main --tags`.
3. The [release workflow](.github/workflows/release.yml) runs `pnpm check` and publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no tokens in secrets; npm attaches provenance). It then creates the GitHub release with generated notes.
4. The same tag triggers the [Docker workflow](.github/workflows/docker.yml). It builds both image variants (the `runtime` and `browser` stages of the `Dockerfile`) natively on an x64 and an arm64 runner and pushes each architecture by digest. It then joins them into one manifest list per variant:
   - `ghcr.io/kikimoradev/kikimora:<version>`
   - `ghcr.io/kikimoradev/kikimora:<version>-browser`

   `<version>` is the tag without the `v`; the `<major>.<minor>` and `latest` tags move with it. The layer cache lives in the same package under the `buildcache-amd64` and `buildcache-arm64` tags. To re-run the workflow for an existing tag, use `Run workflow` in the Actions tab and enter the tag name.

### First release of a new package

npm accepts a trusted publisher only for a package that already exists.

1. Publish the first version by hand: `npm login && npm publish`.
2. On npmjs.com, open the package settings, then Trusted Publisher, then GitHub Actions. Enter repository `kikimoradev/kikimora` and workflow `release.yml`.
3. Push the tag. The workflow skips `npm publish` when the version is already in the registry and still creates the GitHub release.
