# Changelog

## 1.1.0

An end-to-end pass over the whole editor (all 81 live MCP scenarios against a running editor, the marketplaces, and a complete game built through MCP) and fixes for everything it found. Details and evidence: [E2E-TEST-REPORT.md](E2E-TEST-REPORT.md).

### Projects and publishing

- New projects install this editor's own `babylonjs-editor-tools` and `babylonjs-editor-cli`: `yarn build` packs them into `editor/packages`, project creation vendors them into `.zvibe/packages/`, and project load reinstalls them whenever the installed build stamp (`zvibeEditorBuild`) differs. Previously projects got the upstream npm packages of the same names and versions.
- The runtime and CLI now install cleanly outside the monorepo (declared `@recast-navigation/*`, `babylonjs-gui` and `@babylonjs/*` peer dependencies).
- `babylonjs-editor-cli` (and `yarn generate`) runs under plain Node: the command line is bundled as CommonJS and the runtime's ESM output uses explicit file extensions.
- FFmpeg and FFprobe are bundled with the editor (`editor/bin`, from `ffmpeg-static` and `@ffprobe-installer/ffprobe`) and used by editor and CLI audio/video export.
- Runtime AI inference is opt-in via `import "babylonjs-editor-tools/runtime-ai-backends"`; games that do not use it no longer ship ~64 MB of ONNX Runtime WebAssembly. Web build plans report the `runtime-ai` module.
- Template lockfiles regenerated to match their manifests (Babylon.js 9.12.1).

### Runtime and templates

- Exported games create an Audio V2 engine, so authored sounds play.
- Havok speed limits are scaled to centimeters (previously every body was capped at 2 m/s), and templates plus editor Play mode step physics at a fixed 60 Hz.
- Scripts without exported values no longer crash on load; agents can attach scripts to the scene itself.
- Normalized audio keeps its source sample rate instead of FFmpeg loudnorm's 192 kHz.

### Editor

- Asset registry refreshes are coalesced, the registry file is replaced atomically (no more spurious full rebuilds), and path scans/sidecar reads are batched; the queue is visible in `get_asset_indexing_status`.
- Deleting or importing large folders takes seconds instead of minutes (the Assets Browser rendered once per file event), and it falls back to an existing folder when the browsed one is deleted.
- Cinematic capture reads frames from the engine's rendering canvas at the profile resolution.
- Timed-out or cancelled project code tests terminate the whole process tree.
- Project Auditor discovery reads sources in batches.
- `create_primitive_mesh` applies its options; NavMesh agent sizes are documented as voxel counts; web build plans keep modules the runtime loader needs.
- Marketplace downloads are confined to the asset folder and verified against provider checksums.

### Examples and tests

- New example: [Orb Rush](examples/orb-rush), a complete physics game authored end to end through MCP, with an automated 18-check play-test.
- New and fixed tests across the editor, runtime and CLI; several live MCP scenarios made robust on slow or Linux hosts.

## 1.0.0

Initial Zvibe Editor release.
