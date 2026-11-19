# Development

Use [mise](https://mise.jdx.dev/) to provision the pinned versions in `mise.toml`. The built-in mise
registry supplies hk; don't install a second hook manager or a system copy of hk.

```sh
mise install
mise exec -- bun install --frozen-lockfile --ignore-scripts
mise exec -- bun run hooks:install
mise exec -- bun run verify
```

Local hooks run formatting and lint checks before a commit, and type checks and unit tests before a
push. The hook launcher needs mise on Git's `PATH`, including when Git runs from an editor. CI
installs the same workspace lockfile and runs all gates without installing hooks or deploying
anything.

The CLI in `apps/cli` imports the shared Effect-based state and operations in `packages/core` as
`@t1os/core`. Run it locally with `mise exec -- bun run t1os --help`. Add JSDoc to public APIs;
Oxfmt formats comments, sorts imports and package manifests, and applies the project's layout.
Oxlint uses the [tsrs backend](https://oxc.rs/blog/2026-11-17-faster-type-aware-linting-with-tsrs) for
type-aware rules; the standalone `check` script also runs tsrs. There is no tsgolint fallback.

Run `bun apps/platform/src/bench-stage.ts` on Linux to compare fresh staging and same-digest
reapply. Use the same `TMPDIR` filesystem across runs. It measures only staging with a disposable
64 MiB fixture, and reports process write bytes rather than physical disk traffic.
