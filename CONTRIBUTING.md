# Contributing to Kikimora

Thanks for helping the sprite! Contributions of all kinds are welcome — bug reports, docs, code.

## Setup

- Node.js ≥ 22.16 and [pnpm](https://pnpm.io) (`corepack enable` is enough)
- `pnpm install`
- `pnpm dev` starts kikimora in watch mode (tsx); `pnpm start` runs it once

## Before you open a PR

```bash
pnpm check   # typecheck + lint + format:check + test
```

CI runs the same command, so a green `pnpm check` locally means a green build.

- **Tests are required.** Coverage thresholds (statements 92%, lines 94%) are enforced in `vitest.config.ts` — untested code fails the build. Tests live in `test/` and mirror `src/`. Claude sessions are tested against a fake binary (`test/fixtures/claude`) driven by `FAKE_CLAUDE_*` variables — never against the real CLI.
- **Formatting is Prettier's job**: `pnpm format` fixes everything.

## Conventions

- Code, user-facing messages, errors, and commit messages are in English.
- No comments in the code — the code should speak for itself.
- Agent prompt content lives **only** in markdown files (`prompts/*.system.md` in the package, `.kikimora/prompts/*.prompt.md` in projects) — never as string constants in the code.
- A new configuration option = a key in `settingsSchema` (`src/config.ts`) + a mapping in `loadWorkerConfig` + usually a wizard question in `src/configure.ts`.
- `src/paths.ts` is the single source of truth for the filesystem layout.

See [CLAUDE.md](CLAUDE.md) for the full architecture walkthrough.

## Demo GIF

The README demo is scripted and reproducible — after UI changes, re-record it:

```bash
pnpm build
node scripts/demo/setup.mjs
vhs scripts/demo/demo.tape   # requires https://github.com/charmbracelet/vhs
```

## Releasing (maintainers)

1. Bump the version in `package.json` and move the entries in `CHANGELOG.md` from _Unreleased_ to a new dated section.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin main --tags`.
3. The [release workflow](.github/workflows/release.yml) runs `pnpm check`, publishes to npm through [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC — no tokens in secrets, provenance attached automatically), and creates the GitHub release with generated notes.
4. The same tag triggers the [Docker workflow](.github/workflows/docker.yml), which builds both image variants (`runtime` and `browser` stages of the `Dockerfile`) natively on an x64 and an arm64 runner, pushes each architecture by digest and stitches them into one manifest list per variant: `ghcr.io/kikimoradev/kikimora:<version>` and `ghcr.io/kikimoradev/kikimora:<version>-browser` (`<version>` is the tag without the `v`; `<major>.<minor>` and `latest` move along). Layer cache lives in the same package under the `buildcache-amd64` and `buildcache-arm64` tags. The workflow can be re-run for an existing tag from the Actions tab (`Run workflow` → the tag name).

One-time bootstrap for a brand-new package: npm only lets you configure a trusted publisher once the package exists, so publish the first version manually (`npm login && npm publish`), then add the trusted publisher on npmjs.com (package settings → Trusted Publisher → GitHub Actions, repository `kikimoradev/kikimora`, workflow `release.yml`). Pushing the tag afterwards is safe — the workflow skips `npm publish` when the version is already in the registry and still creates the GitHub release.
