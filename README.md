# PR Diff Plus

Browser extension that makes GitHub PR review actually pleasant. Works in Chrome and Firefox.

What you get on top of GitHub's default `/files` page:

- **Sticky sidebar** with file tree (or flat list — toggle with `t` or the header buttons)
- **Per-file Approve button** injected into every diff's header — the missing "hide what I've already approved" workflow GitHub never shipped
- **Hide-approved toggle** in the sidebar (`h` to toggle) — focus on what's left
- **Complexity score** per file: churn × file weight (lockfiles 0.05, tests 0.4, docs 0.5, code 1.0). Sort by it.
- **Auto-collapse** lockfiles, snapshots, `dist/`, generated protobufs — click the badge to expand if you actually need to look
- **Keyboard navigation**: `j` / `k` next/prev file, `n` / `p` next/prev hunk, `a` approve, `gg` / `G` first/last, `/` filter, `s` sidebar, `?` help
- **Progress bar**: approved / total
- **Persistent approval state** per PR (via `chrome.storage.local`)
- **Mirrors GitHub's native "Viewed" checkbox** when it's present, so collaborators see your progress
- **SPA-aware** — re-injects on PR navigation, refreshes as GitHub lazy-loads more diffs

## Install

### Chrome / Edge / Brave (development)

1. `git clone https://github.com/sudo-vaibhav/pr-diff-plus.git`
2. Open `chrome://extensions`
3. Toggle **Developer mode** (top right)
4. **Load unpacked** → pick the `extension/` folder

> **Heads-up for Chrome 137+:** loading unpacked extensions via the UI may be restricted on some channels. If you hit issues, install Chromium directly or use a Beta channel.

### Firefox (temporary install)

1. Open `about:debugging` → **This Firefox**
2. **Load Temporary Add-on** → pick `extension/manifest.json`

## Usage

Open any GitHub PR `/files` (or `/changes`) page. The sidebar appears on the right. Press `?` for the keyboard cheatsheet.

Approve files via the green button next to each diff header, or via the checkbox in the sidebar, or with `a` on the active file. Toggle "Hide approved" to fade out everything you've already cleared.

## Layout

```
extension/
  manifest.json            MV3, cross-browser via globalThis.browser ?? globalThis.chrome
  src/
    lib.js                 Pure helpers (path detection, complexity, tree builder) — testable in Node
    content.js             DOM injection, keyboard handling, state, rendering
    styles.css             Sidebar + tree + inline button + help overlay
  popup.html / popup.js    Toolbar popup with settings + clear-state action

tests/
  unit/                    Vitest. 61 tests covering lib.js (deterministic, fast)
  e2e/                     Playwright. 24 tests against a local fixture mimicking GitHub markup
  fixtures/pr-page.html    The fixture
```

## Tests

Pure-function tests run in milliseconds. End-to-end tests load the real extension into Playwright's bundled Chromium against a local fixture (deterministic — no GitHub markup drift, no auth needed).

```bash
npm install
npx playwright install chromium
npm test         # unit (vitest)
npm run test:e2e # e2e (playwright)
npm run test:all # both
```

The e2e harness rewrites `manifest.json` to match `<all_urls>` and serves the fixture via a local Node http server, then launches Chromium with `--load-extension=`.

## Why complexity scoring matters

A 2000-line `yarn.lock` change isn't 100x more important than a 20-line auth refactor. Default file weights:

| File type | Weight | Reason |
|---|---|---|
| Lockfiles, generated protobufs, `dist/`, `.snap` | 0.05 | Glance, don't read |
| Tests | 0.4 | Verify intent, not implementation |
| Docs, configs (`.md`, `.yml`, `.json`) | 0.5 | Skim |
| Source code | 1.0 | Actually read |

Sort by complexity to start where it matters.

## Architecture notes

- `lib.js` is a plain script (no `import`/`export`) — content scripts in MV3 share a single isolated world per origin, so `lib.js` writes to `globalThis.PRDP_LIB` and `content.js` consumes it. Same file, no bundler.
- Unit tests load `lib.js` via `vm.runInNewContext` so the same code is exercised.
- Tree view collapses single-child directory chains (`src` → `src/components` → `src/components/Foo.tsx` becomes one row when there's nothing else in those dirs).
- Approval state lives at `approved:<owner>/<repo>#<number>` in `chrome.storage.local`. View-mode preference at `settings.viewMode`. Hide-approved is intentionally session-only.

## License

MIT.
