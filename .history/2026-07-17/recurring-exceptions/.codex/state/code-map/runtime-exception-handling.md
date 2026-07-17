# code-map: runtime exception handling

**Scope:** Electron development reload, asset-browser image decoding, and Vitest worker runtime configuration
**Last verified:** 2026-07-17 — recurring-exceptions section

## Purpose

This area prevents malformed project images and obsolete Electron development-reload behavior from becoming unhandled renderer exceptions, while keeping test output free of Node 26 experimental web-storage noise.

## Public API

- `AssetBrowserImageItem.componentDidMount` (`editor/src/editor/layout/assets-browser/items/image-item.tsx:81`) — asynchronously loads an image preview but resolves with a generic fallback when the file is missing, corrupt, or mislabeled.
- `setupDevelopmentRendererReloader` (`editor/src/index.ts:45`) — watches compiled renderer assets and reloads application windows only after writes settle.

## Invariants

- Sharp thumbnail or metadata rejection never escapes the image-card mount lifecycle (`editor/src/editor/layout/assets-browser/items/image-item.tsx:98`).
- An invalid image in a resize multi-selection is skipped without rejecting the event handler or blocking valid images (`editor/src/editor/layout/assets-browser/items/image-item.tsx:165`).
- Development renderer reload never traverses DevTools or destroyed windows (`editor/src/index.ts:61`).
- Node's experimental web-storage global is disabled only in test workers; application errors and ordinary warnings remain enabled (`editor/vitest.config.ts:7`, `tools/vitest.config.ts:7`).

## Concurrency model

- Image decode work uses independent promises; counters are updated on the single renderer event loop after each write completes (`editor/src/editor/layout/assets-browser/items/image-item.tsx:168`).
- File watcher bursts share one 150 ms debounce timer; a later event replaces the pending reload (`editor/src/index.ts:50`).

## Error idioms

- Expected media decode failures become visible fallback state or a bounded toast, not console exceptions (`editor/src/editor/layout/assets-browser/items/image-item.tsx:107`, `editor/src/editor/layout/assets-browser/items/image-item.tsx:214`).
- Watcher shutdown clears pending work and closes asynchronously during application quit (`editor/src/index.ts:69`).

## Callers / callees

- React mount → `AssetBrowserImageItem.componentDidMount` → Sharp preview and metadata decode (`editor/src/editor/layout/assets-browser/items/image-item.tsx:81`).
- Development initialization → legacy main-process-only reloader + `setupDevelopmentRendererReloader` (`editor/src/index.ts:35`).

## Gotchas

- `electron-reloader` 1.2.3 must remain `watchRenderer: false`; its renderer path traverses BrowserViews removed from Electron 39 (`editor/src/index.ts:36`).
- Files with `.png`, `.jpg`, `.jpeg`, or `.webp` extensions are not assumed to contain decodable image bytes (`editor/src/editor/layout/assets-browser/items/image-item.tsx:107`).

## Open questions

- Chromium DevTools can emit unsupported Autofill protocol notices in development; these are DevTools diagnostics, not editor exceptions.
