# Zvibe Editor feature and MCP inventory

> Generated from the current source with `yarn workspace babylonjs-editor-mcp-server sync-feature-inventory`. Do not hand-edit generated tables.

## Current verified scope

| Surface                                                 |   Built status |                                                     Testing status | Evidence                        |
| ------------------------------------------------------- | -------------: | -----------------------------------------------------------------: | ------------------------------- |
| Original portable Unity feature-family matrix           | 50/50 Complete |                                                    Matrix-recorded | `UNITY-6-5-PARITY.md`           |
| Unity 6000.5 final release-delta workstreams            | 27/27 Complete |                                                       27/27 Tested | `UNITY-6-5-PARITY.md`           |
| Portable Runtime AI (`.onnx`, `.tflite`, `.pt2`)        |       Complete |                                                           Complete | `ROADMAP.md` #757               |
| Portable Occlusion Culling                              |       Complete |                                                           Complete | `ROADMAP.md` #758               |
| Integrated generative asset creation                    |       Complete |                                                           Complete | `ROADMAP.md` #763               |
| Portable ML-Agents-style training                       |       Complete |                                                           Complete | `ROADMAP.md` #764               |
| Hosted services and deployment adapters                 |       Complete |                                                           Complete | `ROADMAP.md` #765               |
| Portable Alembic (`.abc`) import/playback               |       Complete |                                    Real Blender/MCP/direct UI pass | Section #760                    |
| Portable Aseprite (`.ase`, `.aseprite`) import/playback |       Complete | Automated/MCP/direct UI pass; Claude-compatible contract validated | Section #761                    |
| Portable FBX export/round-trip                          |       Complete |                          Automated/real Blender/MCP/direct UI pass | Section #762                    |
| Editor MCP endpoint mappings                            |           1721 |                                                      Source mapped | `editor/src/mcp/mcp.ts`         |
| Client-visible MCP tools                                |           1722 |                                          Strict contract validated | `mcp/manifest.json`             |
| Permanent editor tabs                                   |             21 |                           Complete stateful pointer/keyboard audit | `editor/src/editor/layout.json` |

The client-visible catalog is the 1:1 union of every editor endpoint plus the MCP server-owned `execute_batch` tool. `.mcp.json` and `.codex/config.toml` both launch `mcp/server/index.mjs`, so Claude-compatible clients and Codex CLI share the same catalog.
The feature-family names retain Unity terminology for comparison. A Complete status means the bounded portable Babylon/JavaScript equivalent documented in the detailed matrix is complete; it does not claim C#, Unity package/API, binary, or serialization compatibility.

## Work that is genuinely left

### Confirmed implementation or contract gaps

None identified after the complete live MCP lifecycle suite, stateful 21-tab pointer/keyboard audit, endpoint/tool inventory, and repository gates recorded below.

Current Assets Browser guard extensions (64): `.3dl`, `.3ds`, `.abc`, `.anim`, `.animation`, `.animations`, `.animator`, `.ase`, `.aseprite`, `.b3d`, `.babylon`, `.blend`, `.bmp`, `.cinematic`, `.controller`, `.dae`, `.dds`, `.dxf`, `.env`, `.exr`, `.fbx`, `.flac`, `.gif`, `.glb`, `.gltf`, `.gui`, `.hdr`, `.jpeg`, `.jpg`, `.lwo`, `.m4a`, `.material`, `.mov`, `.mp3`, `.mp4`, `.ms3d`, `.mtl`, `.npss`, `.obj`, `.ogg`, `.ogv`, `.onnx`, `.otf`, `.png`, `.psb`, `.psd`, `.pt2`, `.ragdoll`, `.stl`, `.svg`, `.tflite`, `.tga`, `.tif`, `.tiff`, `.ttf`, `.uss`, `.uxml`, `.wav`, `.wave`, `.webm`, `.webp`, `.woff`, `.woff2`, `.x`.

Intentional project-file exclusions (1): `.json`. Generic JSON may be a project configuration file; typed JSON-backed assets still require `/assets`.

Unexplained built/exported extensions missing from that guard (0): none.

### Portable feature family in progress

None. The audited provider-neutral Babylon/JavaScript feature families are complete within their documented boundaries.

### Broader Unity ecosystem/package families not implemented

No remaining implementable provider-neutral Babylon/JavaScript feature family is currently identified. Lobby/relay remains part of the existing first-party networking owner rather than a separate hosted-service adapter.

Future additions require a newly scoped portable feature family; the remaining differences below are external compatibility boundaries, not unfinished editor code.

### External compatibility boundaries, not missing portable editor code

- C#, Mono, IL2CPP, Burst, Unity assemblies, and Unity package/API/serialization identity.
- Unity SRP/URP/HDRP HLSL and binary identity; Zvibe supplies portable Babylon rendering equivalents.
- Proprietary console SDKs, devkits, platform certification, and vendor release approval.
- Vendor signing/notarization credentials and native platform-holder services or binaries.
- Unity/Umbra, Sentis/Inference Engine, DirectStorage, and other vendor binary or numerical identity where the roadmap explicitly claims only portable behavior.

## Permanent editor surfaces

Every tab is externally selectable through the shared `list_editor_tabs` and `select_editor_tab` MCP tools. The final column records the completed stateful physical pointer/keyboard audit on the real Electron editor.

| Tab                                     | Component           | MCP selection | Fresh direct UI audit |
| --------------------------------------- | ------------------- | ------------- | --------------------- |
| Graph (`graph`)                         | `graph`             | Available     | Complete              |
| Preview (`preview`)                     | `preview`           | Available     | Complete              |
| Assets Browser (`assets-browser`)       | `assets-browser`    | Available     | Complete              |
| Animations (`animations`)               | `animations`        | Available     | Complete              |
| Console (`console`)                     | `console`           | Available     | Complete              |
| Profiler (`profiler`)                   | `profiler`          | Available     | Complete              |
| Entities (`entities`)                   | `entities`          | Available     | Complete              |
| Lighting Search (`lighting-search`)     | `lighting-search`   | Available     | Complete              |
| Script Debugger (`script-debugger`)     | `script-debugger`   | Available     | Complete              |
| Project Auditor (`project-auditor`)     | `project-auditor`   | Available     | Complete              |
| Runtime AI (`runtime-ai`)               | `runtime-ai`        | Available     | Complete              |
| ML Training (`ml-training`)             | `ml-training`       | Available     | Complete              |
| Generative Assets (`generative-assets`) | `generative-assets` | Available     | Complete              |
| Services (`services`)                   | `services`          | Available     | Complete              |
| Occlusion Culling (`occlusion-culling`) | `occlusion-culling` | Available     | Complete              |
| Networking (`networking`)               | `networking`        | Available     | Complete              |
| Mobile (`mobile`)                       | `mobile`            | Available     | Complete              |
| Console & Server (`console-server`)     | `console-server`    | Available     | Complete              |
| Terminal (`terminal`)                   | `terminal`          | Available     | Complete              |
| Marketplace (`marketplace`)             | `marketplace`       | Available     | Complete              |
| Inspector (`inspector`)                 | `inspector`         | Available     | Complete              |

## MCP endpoint domains

The exact tool names and descriptions are generated into `mcp/manifest.json`; this table prevents domain-level coverage from being confused with per-tool manual testing.

| Domain                                                            | Editor endpoints |
| ----------------------------------------------------------------- | ---------------: |
| Editor state & control                                            |               50 |
| Scene & project                                                   |               38 |
| Node generic operations                                           |              137 |
| Meshes                                                            |               38 |
| Animator controllers                                              |               63 |
| Physics constraints                                               |               41 |
| Rigging / IK                                                      |               56 |
| Cloth physics                                                     |                7 |
| Physics 2D                                                        |              425 |
| Splines                                                           |               33 |
| Lights & shadows                                                  |               42 |
| Cameras                                                           |                4 |
| Camera post-processes / rendering pipelines                       |              147 |
| Materials & textures                                              |               68 |
| Assets browser                                                    |               90 |
| Particle systems                                                  |               41 |
| Sprites                                                           |               55 |
| GUI                                                               |               59 |
| Cinematics                                                        |               32 |
| Navigation                                                        |               33 |
| Ragdolls                                                          |                3 |
| Project settings                                                  |               17 |
| Prefabs                                                           |               47 |
| Export                                                            |               55 |
| Editor controls                                                   |                7 |
| Sounds                                                            |               36 |
| Video players                                                     |                5 |
| Alembic caches                                                    |                9 |
| Aseprite assets                                                   |                8 |
| FBX export and round-trip                                         |                4 |
| Animations                                                        |               24 |
| Marketplace                                                       |                3 |
| Scripts                                                           |               34 |
| Agent automation scripts (.js run in the editor via main(editor)) |                4 |
| Verification & utility                                            |                6 |
| MCP server-owned batching                                         |                1 |
| **Total client-visible tools**                                    |         **1722** |

## Feature-family matrix

| Area                       | Unity capability family                                                                                                                                  | Status   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Scene                      | Hierarchy, transforms, layers, tags, multiple scenes, prefabs                                                                                            | Complete |
| Asset pipeline             | Asset database, GUIDs, dependencies, importer settings, reimport, labels                                                                                 | Complete |
| Texture/image workflow     | PNG/JPG/TGA/PSD/SVG import settings, sprites, conversion, compression, packing                                                                           | Complete |
| Prefabs                    | Prefab assets, variants, nested prefabs, overrides, Apply/Revert                                                                                         | Complete |
| ProBuilder                 | Vertex/edge/face authoring, topology operations, UVs, smoothing, vertex colors, validation/repair, pivots, and editable-source/runtime-export separation | Complete |
| Terrain                    | Terrain assets, sculpt/paint/layers/details/trees/holes/tiled streaming                                                                                  | Complete |
| Splines                    | Spline assets, knots, extrusion, follower, terrain/camera integration                                                                                    | Complete |
| 2D                         | 2D scene mode, sprites, atlas, tilemap, rule tiles, sorting layers, 2D physics                                                                           | Complete |
| UI                         | uGUI/UI Toolkit authoring, layout, event system, font workflow                                                                                           | Complete |
| Animation                  | Clips, keyframes, curves, import/export, timeline                                                                                                        | Complete |
| Animator                   | Controllers, state machines, parameters, transitions, blend trees/layers/masks                                                                           | Complete |
| Rigging                    | Humanoid mapping, retargeting, root motion, IK/constraints                                                                                               | Complete |
| Cinemachine                | Virtual cameras, blends, follow/look-at, dolly, target groups, impulses                                                                                  | Complete |
| Audio                      | Mixer, buses, sends, snapshots, effects, reverb zones, profiler                                                                                          | Complete |
| Materials                  | Standard/PBR library materials, texture assignment, variants                                                                                             | Complete |
| Shader Graph               | Subgraphs, blackboard, custom code, variants, diagnostics/stripping                                                                                      | Complete |
| VFX Graph                  | Graph assets, GPU events, collision, trails/ribbons, vector fields, budgets                                                                              | Complete |
| Lighting                   | Baked GI/lightmaps, probes/APV, reflection probes, lighting scenarios                                                                                    | Complete |
| Rendering                  | URP/HDRP profiles, volumes, custom render passes, render graph                                                                                           | Complete |
| Diagnostics                | Frame debugger, render graph viewer, overdraw/light complexity/GPU timing                                                                                | Complete |
| Physics 3D                 | Materials, joints, constraints, vehicles, layer matrix, simulation debugger                                                                              | Complete |
| Cloth physics              | Cloth component, painting constraints, collision, simulation                                                                                             | Complete |
| Physics 2D                 | Rigidbody2D/colliders/joints/materials/effectors                                                                                                         | Complete |
| Navigation                 | NavMesh surfaces/links/areas/agents/obstacles/crowds                                                                                                     | Complete |
| Input                      | Input Actions, devices, control schemes, rebinding                                                                                                       | Complete |
| Visual scripting           | Graph authoring/debugging/runtime                                                                                                                        | Complete |
| AI                         | Behavior trees/utility AI/navigation agents                                                                                                              | Complete |
| Addressables               | Catalogs, groups, remote content, labels, build reports                                                                                                  | Complete |
| Build                      | Build Profiles, target validation, reports, signing                                                                                                      | Complete |
| Editor/project settings    | Preferences, external script editor, serialization, project settings                                                                                     | Complete |
| Platforms                  | Desktop, mobile, Web, XR, dedicated server, console                                                                                                      | Complete |
| Device tooling             | Device simulator, remote device logs/profiling                                                                                                           | Complete |
| Testing                    | Unit/play-mode/integration/performance/visual regression runner                                                                                          | Complete |
| Profiling                  | CPU/GPU/memory/loading profiler and snapshots                                                                                                            | Complete |
| Source control             | Version Control UI, locks, semantic scene merges                                                                                                         | Complete |
| Package manager            | Registries, dependencies, samples, updates                                                                                                               | Complete |
| Collaboration              | Multi-user editing, roles, conflict resolution                                                                                                           | Complete |
| Services                   | Authentication, cloud save, analytics, IAP, ads, matchmaking                                                                                             | Complete |
| XR                         | AR/VR authoring, interaction, simulator, target validation                                                                                               | Complete |
| DOTS/ECS                   | Entities authoring/baking/debugging                                                                                                                      | Complete |
| Localization/accessibility | Localization tables, pseudo-localization, localized assets, RTL, and accessibility checks                                                                | Complete |
| Cinematic                  | Timeline tracks, clips, events, render output                                                                                                            | Complete |
| Video                      | Video clips, import/transcode, VideoPlayer, render-texture output                                                                                        | Complete |
| 2D animation               | Sprite skinning, bones, IK, PSD importer, animation authoring                                                                                            | Complete |
| Tile palette               | Tile palette painting, brushes, animated tiles, sprite colliders                                                                                         | Complete |
| Scripting workflow         | JavaScript/TypeScript compilation, debugger, script templates, execution order, and code coverage                                                        | Complete |
| Networking/multiplayer     | Netcode authoring, replication, prediction, transport, lobby/relay integration                                                                           | Complete |
| Mobile                     | Android/iOS build profiles, device settings, touch simulation, signing                                                                                   | Complete |
| Console/server             | Console platform targets, dedicated server build, headless validation                                                                                    | Complete |
| Editor extensibility       | Custom inspectors/windows, menus, packages, editor tests                                                                                                 | Complete |

## Unity 6000.5 release-delta matrix

| ID   | Workstream                                                                                                                                                                                 | Status            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| #729 | Real-time 2D texture-atlas profiler: SpriteManager/SpriteMap allocation, region usage, efficiency visualization, captured frame counters, strict v1 migration, and external MCP inspection | Complete / Tested |
| #730 | Extensible 2D lighting and shadow-caster providers with custom shape/behavior registration, editor authoring, runtime/export execution, and MCP lifecycle                                  | Complete / Tested |
| #731 | Adaptive Performance Basic provider plus Apple thermal warnings/scalers for iOS, tvOS, and visionOS                                                                                        | Complete / Tested |
| #732 | Android window-inset visibility/system-bar behavior and iOS thermal FPS controls; target-minimum visionOS and portable gRPC transport settings                                             | Complete / Tested |
| #733 | Asset import Accelerator result-cache policy, cache diagnostics, and upgrade/default behavior                                                                                              | Complete / Tested |
| #734 | Scriptable/generated audio clips with editor graph/script authoring and shared preview/export playback                                                                                     | Complete / Tested |
| #735 | Shared type-tree/schema extraction for portable asset bundles                                                                                                                              | Complete / Tested |
| #736 | Graph Toolkit additions: Expression nodes, untyped variables, multiline port/options, custom type styling, and editable list/array constants                                               | Complete / Tested |
| #737 | CanvasGroup alpha, UGUI usage tracking, RaycastReceiver, and complete list/array Inspector styling                                                                                         | Complete / Tested |
| #738 | Build Profile footer extension actions, installed-platform restart flow, and experimental Swift iOS project generation                                                                     | Complete / Tested |
| #739 | Texture Inspector grayscale/colorized channel-preview toggle                                                                                                                               | Complete / Tested |
| #740 | Compile-time serialization diagnostics plus asynchronous Project Auditor checks for texture Read/Write, obsolete/deprecated APIs, and atlas waste                                          | Complete / Tested |
| #741 | Linux/Embedded Linux LTO and IME settings plus macOS display-link/frame-pacing control                                                                                                     | Complete / Tested |
| #742 | Entities hidden/world hierarchy preferences, namespace/quick filtering, and assembly-wide type-registration policy                                                                         | Complete / Tested |
| #743 | Lighting Search workspace with lightmap browse/preview, query trees, pipeline selectors, and property editing                                                                              | Complete / Tested |
| #744 | On-tile validation, URP-style on-tile post-processing, and extensible tile-only rendering                                                                                                  | Complete / Tested |
| #745 | Package Manager Samples view, image metadata, locate/view-more actions, publish-date sorting, development technical-name editing, and detail cards                                         | Complete / Tested |
| #746 | Physics Core 2D per-world settings, world drawing, custom transform planes/write/tween events, multiple-world limits, contact filtering, and multi-camera debug rendering                  | Complete / Tested |
| #747 | Development-build code coverage and oldest-serialized-version session diagnostics                                                                                                          | Complete / Tested |
| #748 | Shader graph templates, multi-case Switch, static subgraph inputs, reflected functions, float-mode UX, and template search                                                                 | Complete / Tested |
| #749 | UI Toolkit UXML upgrades, PanelRenderer/world-space hierarchy, USS statistics, stylesheet drag/drop, animation, test-framework clicks, override bars, and staging sync                     | Complete / Tested |
| #750 | Direct/iterative hybrid physics solver workflow and Chain/Gears sample-equivalent project                                                                                                  | Complete / Tested |
| #751 | Version-control folder actions, branch explorer, changeset diff/properties, shelveset partial apply, richer empty states, persisted layout, and rename shortcuts                           | Complete / Tested |
| #752 | VFX batch-release policy and searchable/filterable VFX/Shader templates                                                                                                                    | Complete / Tested |
| #753 | Web build modular stripping, WebAssembly 2023 defaults, current Emscripten toolchain selection, and PNG/JPEG library stripping evidence                                                    | Complete / Tested |
| #754 | Windows DirectStorage-style asynchronous asset streaming setting and runtime                                                                                                               | Complete / Tested |
| #755 | Animation Event missing-method error policy, Android LTO/profile markers, automatic PSO trace/prewarm settings, and Linux ARM64 dedicated-server source build flow                         | Complete / Tested |

## Evidence inventory

| Evidence kind                 | Count | Location            | Meaning                                                             |
| ----------------------------- | ----: | ------------------- | ------------------------------------------------------------------- |
| Strict MCP tools              |  1722 | `mcp/manifest.json` | Complete external discovery catalog                                 |
| MCP tool modules              |    70 | `mcp/src/tools/`    | Server implementation families                                      |
| MCP evaluation specifications |    46 | `mcp/evaluations/`  | Agent-behavior evaluation coverage; not one file per tool           |
| Live scenario scripts         |    81 | `mcp/scripts/`      | Family/integration lifecycle evidence; not one script per component |
| Editor test files             |   324 | `editor/test/`      | Automated editor coverage                                           |
| Shared runtime test files     |   159 | `tools/test/`       | Automated exported-runtime coverage                                 |

## Inventory invariants

- Endpoint mappings: 1721; unique: 1721.
- Tool catalog: 1722; unique: 1722; every description is non-empty.
- MCP-only tools: `execute_batch`.
- Editor endpoints missing from MCP: none.
- Codex CLI config points to the shared server: yes.
- Claude-compatible MCP config points to the shared server: yes.
