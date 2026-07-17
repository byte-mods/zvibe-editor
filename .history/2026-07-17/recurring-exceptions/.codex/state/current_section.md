# Section Snapshot — 2026-07-17T11:58:30+05:30

## Just completed

- Section: 405A recurring exception stabilization
- Tasks closed: T1 corrupt/mislabeled image fallback and resize isolation; T2 Electron 39-safe development renderer reload; T3 Node 26 Vitest worker noise removal; T4 full regression/build/runtime verification
- Closure summary: Sharp thumbnail and metadata failures resolve to a generic image card; invalid files in a resize multi-selection are skipped while valid files continue.
- Closure summary: The legacy Electron reloader is restricted to main-process watching, while a debounced watcher reloads only live application windows and never traverses DevTools BrowserViews.
- Closure summary: Focused image tests pass 2/2, complete suites pass 232 tools and 495 editor tests, the sequential production build passes, and the real project with invalid PNG fixtures opens and reloads without Sharp or sandbox exceptions.

## Code-map updates this section

- runtime-exception-handling.md: created — image decode boundaries, safe development reload, worker configuration, tests, and remaining DevTools-only notices.

## Verified facts carried forward

- `AssetBrowserImageItem` catches missing/corrupt/mislabeled thumbnail and metadata inputs and renders a fallback (`editor/src/editor/layout/assets-browser/items/image-item.tsx:98`).
- Multi-image resize isolates decode/write failures per file and reports bounded success/failure counts (`editor/src/editor/layout/assets-browser/items/image-item.tsx:165`).
- Development reload debounces compiled file bursts and filters destroyed and DevTools windows (`editor/src/index.ts:45`).
- Vitest workers disable only Node 26 experimental web storage, eliminating per-worker warnings without silencing application errors (`editor/vitest.config.ts:7`, `tools/vitest.config.ts:7`).
- Regression coverage exercises invalid mount decode and mixed valid/invalid resize selection (`editor/test/editor/image-item.test.mts:53`, `editor/test/editor/image-item.test.mts:66`).

## Open invariants for next section

- Generated LOD reduction must remain non-mutating and preserve exact vertex/skin/morph provenance (`tools/src/assets/model-lods.ts:340`).
- Artist-authored LOD geometry is source truth and must never be passed through generated simplification (`tools/src/assets/model-importer.ts:646`).
- Any new model-import setting must share editor artifact, CLI build, Inspector, exact-lease MCP, and runtime reload semantics.
- Expected asset decode failures must remain UI state or bounded results, never unhandled renderer promises (`editor/src/editor/layout/assets-browser/items/image-item.tsx:107`).

## Next section

- Goal: #405 add production bone/morph-aware generated-LOD error metrics and additional bounded reduction-quality controls.
- Entry blast radius: `tools/src/assets/model-lods.ts`, `tools/src/assets/model-importer.ts`, `editor/src/editor/layout/inspector/file/model.tsx`, `editor/src/mcp/assets/assets.ts`, `mcp/src/tools/assets.mts`, model-import tests.
- Open questions: Select metrics deterministic across Babylon simplifier output and meaningful for static, skinned, morph, and combined deformation without weakening exact provenance guarantees.
