# dot-test-digest

Bounded output compressor for test runs, compilers and build tools.
Implements [`specs/SPEC-002-DOT-TEST-DIGEST.md`](specs/SPEC-002-DOT-TEST-DIGEST.md).

```bash
dot-test-digest --tdd-phase=green -- vitest run
dot-test-digest --format=json -- cargo build
dot-test-digest --no-jev -- tsc --noEmit
```

- **Pass:** one line, at most 160 bytes (`[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: …`).
- **Fail:** deduplicated failure clusters with a pruned stack and an inlined source window, at most 600 tokens.
- **Always:** the child's exit code (or `128 + signal`) is returned unchanged, and the full raw stream is kept in `~/.cache/dot-test-digest/logs/<run_id>.log`.

Gear 1 (Jev `jev-1.13.0`) is used only for unstructured failures above 150 lines and needs `TYPESAFE_API_KEY`.
Without it, the heuristic fallback still narrows the log.

**Privacy.** Gear 1 is the only part of the tool that uses the network. When `TYPESAFE_API_KEY` is set and `--no-jev`
is not passed, it sends excerpts of the failing run's log (the failure windows and the tail, bounded in size) to
`api.typesafe.ai`. Pass `--no-jev` to keep every run local. Without a key, nothing leaves your machine.

TDD state lives in `~/.cache/dot-test-digest/state-<scope_id>.json`; `--scope-id` isolates concurrent runs.
`DOT_TEST_DIGEST_HOME` relocates both caches.

## Install

Needs Node >= 20 and [pnpm](https://pnpm.io). Clone, build, and put the `dot-test-digest` bin on your `PATH`:

```bash
git clone https://github.com/OctavioSardi/dot-test-digest && cd dot-test-digest
pnpm install && pnpm build && pnpm link --global
dot-test-digest --version
```

If `dot-test-digest` is not found afterwards, run `pnpm setup` and restart your shell: it puts pnpm's global bin directory on your `PATH`.

## Develop

```bash
pnpm install
pnpm verify     # typecheck + unit tests
pnpm build      # emits dist/ with the dot-test-digest bin
```

## License

[MIT](LICENSE) © 2026 Octavio Sardi and Flowdots.
