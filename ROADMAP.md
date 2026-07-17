# Babylon.js Editor — Unity-Class Roadmap

## Goal

Build Babylon.js Editor from a strong web-first 3D scene editor into a Unity-class production environment without copying Unity internals or abandoning the Babylon.js and TypeScript advantages.

The roadmap is organized around five product tracks:

1. Author scenes and reusable content.
2. Build gameplay, characters, 2D, UI, and effects.
3. Ship to supported platforms.
4. Measure, test, collaborate, and operate projects.
5. Extend everything through packages, plugins, and AI.

A literal Unity 6.5 clone is a multi-year engine and company effort. The priority is parity in workflows that matter to Babylon projects, then platform and service breadth.

## Current implementation snapshot (2026-07)

The phases below remain the long-term plan. They must be read alongside [UNITY-6-5-PARITY.md](UNITY-6-5-PARITY.md), which is the current capability audit, and [MCP-DEVELOPMENT.md](MCP-DEVELOPMENT.md), which is the implementation/test ledger.

Already delivered across the active editor, exported runtime, and MCP surface include:

- Prefabs, asset GUID metadata, importer presets, source watching, dependency scanning, and safe text-reference asset moves.
- Editable ProBuilder-style mesh topology, terrain sculpting/painting/details/tiles, spline followers, 2D sprite maps/rule tiles, and 2D physics/effectors.
- A standalone Animation Window with multi-track Dope Sheet and component Curve modes, animation events, Animator state graphs/layers/blend trees/special nodes/live runtime debugging, visual scripting, behavior-tree workspace, ragdoll assets, full-body/chain/two-bone IK, transform constraints, skin-weight painting, virtual cameras, and audio mixer buses/snapshots.
- Node Material blackboards, rendering profiles, particle force fields/collisions/trails, reflection probes, cloth collision/pinning, 3D physics layers, NavMesh agents/links/avoidance, and Input Actions.
- Web/Electron Build Profiles, build reports/warnings, project preferences/external editor, image bitmap conversion, localization authoring, scene tests, package management, source-control status, GUI control-tree editing, and script templates.

These capabilities are partial workflow parity, not a claim of full Unity equivalence. The remaining requirements in every phase are still active unless the parity matrix explicitly says otherwise.

## Phase 0 — Product and Architecture Foundation

**Duration:** 4–8 weeks  
**Outcome:** A stable base that can support all later systems.

- Define supported tiers:
    - Web-first: browser, PWA, Electron.
    - Native: Windows, macOS, Linux.
    - Mobile: Android and iOS.
    - Advanced: XR, console, and cloud multiplayer.
- Establish a public feature matrix: `supported`, `experimental`, `plugin`, and `planned`.
- Version the project format and create migrations from current `.bjseditor` and scene assets.
- Define canonical asset identity:
    - Stable GUID per asset.
    - Asset metadata sidecar.
    - Dependency graph.
    - Import settings.
    - Reimport and version rules.
- Standardize a command architecture:
    - Every mutation is an undoable command.
    - Commands are serializable for collaboration and automation.
    - MCP actions call the same commands as the UI.
- Create extension points for importers, inspector panels, asset types, build targets, render passes, and editor tools.
- Add local diagnostics, structured logging, and feature flags.

**Exit criteria:** Prefabs, packages, collaboration, build profiles, and plugins can rely on stable asset IDs and common undo/redo behavior.

## Phase 1 — Scene, Prefab, and Asset Pipeline

**Duration:** 3–5 months  
**Priority:** Highest.

### 1.1 Prefab System

- Current baseline: reusable mesh-hierarchy prefab assets support nested version-2 variants, stable source-node identities, recursive dynamic rebasing, exact base/resolved revision leases, explicit node/property/structural/component conflicts, conflict repair, and isolated Prefab Mode authoring. Existing serialized properties can be inspected, overridden, reset, and inherited through bounded safe JSON Pointers; protected identity/hierarchy/prototype paths cannot be changed. Stable-source subtree removals, dependency-ordered empty-transform, mesh-clone, serialized-mesh, or recursively resolved nested-prefab additions, cycle-safe reparents, and serialized metadata-component add/remove overrides persist through recursive composition and can be inspected/authored in Prefab Mode or shared MCP. Instantiation carries an ordered outer-to-inner provenance stack, namespaces nested identities, remaps referenced resource IDs, and assigns fresh runtime IDs while preserving internal hierarchy references. The Mesh Inspector and shared MCP select exact source boundaries for leased transform/component Apply/Revert, promote transform/property/component/descendant-structure overrides into a nested source with rollback, unpack only the outer boundary while preserving deeper prefab links, or unpack completely without changing source assets or live hierarchy. Live instance inspection derives additions, removals, reparents, transform differences, deterministic signatures, and explicit blockers without mutating the scene; exact-revision capture persists structure into a variant, including bounded genuinely new mesh geometry and separately instantiated nested-prefab hierarchies with repaired outer-to-inner provenance. The Inspector provides capture plus searchable multi-instance signature comparison, and shared MCP exposes the same inspection/capture/comparison paths.

### 1.2 Asset Database

- Persistent asset-registry foundation is complete: the Assets Browser and MCP share atomic GUID/path/type/label/tag/favorite/import-state/importer/hash indexing with incremental watcher refresh, duplicate diagnosis, and opt-in repair instead of rescanning files for each query.
- Persistent forward/reverse/missing dependency edges, bounded text/GLB extraction, cycle/deferred-scan diagnostics, incremental resolution, File Inspector UI, and shared MCP graph tools are complete.
- Persistent import fingerprints and current/stale/missing/error diagnostics, separate bounded tags, project-local favorites, Assets Browser filters/indicators, File Inspector controls, and shared MCP organization/diagnostic tools are complete.
- Versioned, type-specific importer contracts, defaults, validation, legacy migration, File Inspector controls, reusable presets, and shared MCP tools are complete for texture, model, audio, video, font, material, animation, and custom assets. Build-aware `includeInBuild`, executed GLB/glTF/Babylon/OBJ/STL model loading, bounded FBX/DAE/3DS Assimp-to-GLB2 conversion, external-resource embedding, scaling, unit conversion, material/texture/animation filtering, colliders, welding, index optimization, normals/tangents, vertex quantization, explicit and Unity-style searched project-material remapping, collision-safe editable embedded-material and PNG/JPEG texture extraction, deformation-safe static/skinned/morph LOD generation, exact artist-authored LOD groups, Web/Desktop model overrides, Avatar/rig optimization, and per-model clip authoring are implemented alongside the executed audio, video, font, material, and animation pipelines. Additional embedded texture codecs, mobile/console-specific model profiles, bone/morph-aware reduction metrics, and remaining format-specific texture consumers are the next importer gaps.
- Executed LDR texture importing is complete for PNG/JPEG/BMP/WebP/GIF/TIFF/SVG: resize, resampling, alpha policy, deterministic encoding, effective color-space sampling, quality mip variants, optional CPU-readable RGBA, Inspector preview/apply, editor/CLI export, runtime redirect manifests, KTX2 compatibility, and strict result/apply MCP are shared. Remaining texture-importer work is PSD/TGA, HDR/EXR/cubemap processing, per-platform override profiles, rotated atlas packing, and dependency-triggered automatic reimport.
- Imported-model material remapping, Unity-style material search, editable embedded-material/PNG/JPEG extraction, deformation-safe generated LODs, exact artist-authored LOD groups, and Web/Desktop overrides are complete: up to 128 explicit exact source names map to contained project `.material` assets; Source/Base Texture/Model + Material naming searches Local/Recursive-Up/Project-Wide scopes without guessing ambiguity; extracted assets are collision-safe and transactional; up to eight ordered retained-quality/distance levels execute bounded quadratic-error reduction with exact source-vertex provenance, every original vertex stream, four/eight-influence skin buffers, skeletons, morph targets, morph animation tracks, and runtime influence synchronization preserved; existing imported meshes can be assigned atomically as exact LOD0/lower-detail groups with runtime reload; and target-specific model processing resolves through editor/CLI builds and caches. Inspector authoring, live import, atomic artifacts, editor/CLI builds, dependency fingerprints, cache invalidation, runtime reload, and strict leased MCP workflows share the same contracts. Additional embedded codecs, mobile/console-specific model profiles, and bone/morph-aware reduction metrics remain future interoperability work.
- Bounded dependency extraction is complete for structured editor/source text, Babylon/glTF JSON, OBJ/MTL/DAE, GLB JSON chunks, ASCII/binary FBX string properties, 3DS texture-map chunks, and compound ZIP/TAR/TAR-GZip/Unity-package assets. Archives expose bounded member inventories, internal/project/missing references, Unity GUID-to-path remapping, virtual dependency-graph nodes, cycles, and explicit archive-bomb deferral/malformed diagnostics in the registry, Inspector, and shared MCP. Safe length-changing semantic rewriting is complete for every currently indexed text, GLB, ASCII/binary FBX, and 3DS reference source, including those formats inside supported archives. Additional opaque binary dependency formats remain future work.
- GUID-preserving semantic asset moves/renames are complete for indexed structured/editor/source text, OBJ/MTL/DAE, CSS URLs, GLB JSON references, ASCII/32-bit/64-bit binary FBX string properties, recursive 3DS texture-name chunks, and the same bounded members inside ZIP/TAR/TAR-GZip/Unity-package assets. Dry-run plans carry exact fingerprints plus archive format/member evidence, relative/root spellings are remapped without touching JSON keys or prefix lookalikes, whole-folder and archive-internal relative references remain unchanged, sidecars retain identity, malformed/oversized/semantically unmatched sources block explicitly, and failed writes roll back rebuilt models, archives, other references, the sidecar, and the asset move. The Assets Browser and shared MCP use the same transaction.
- Background worker indexing is complete: bounded pools use Electron node-enabled Web Worker isolates in the editor and `worker_threads` in Node, while the renderer retains only GUID/metadata reconciliation and atomic publication. Full rebuild and bounded refresh can start non-blocking, report discovery/analysis/metadata/publication progress, enforce one active job, keep 20 recent results, cancel before publication, and preserve the last authoritative registry on cancellation or failure. The Assets Browser and shared MCP expose the same controls.
- Visual dependency-graph canvas is complete: Assets Browser and File Inspector entry points open a bounded zoomable Uses/Used By graph with deterministic depth columns, path highlighting, rerooting, Inspector navigation, missing-reference and canonical-cycle evidence, and explicit truncation state. The shared graph model exports JSON, Graphviz DOT, or Mermaid through MCP, and MCP can open the same live canvas. Generated/dependency trees are pruned correctly and direct-folder queries avoid recursive pagination starvation.
- Named import presets, source reimport controls, and the dependency inspector for “used by,” “uses,” duplicate identities, and broken references are complete.
- Extend importer-aware cache invalidation and incremental reimport to remaining per-format conversion pipelines and worker-scale processing.

### 1.3 Content Delivery

- Add Addressables-like asset groups: local, preload, lazy-load, remote CDN, and optional downloadable content.
- Generate manifest and catalog files.
- Add content hashing, cache control, versioned remote catalogs, and build-size reports.

**Exit criteria:** Teams can build a reusable content library without manual copy/clone workflows.

## Phase 2 — Core Authoring: Geometry, Terrain, Splines, and 2D

**Duration:** 4–7 months

### 2.1 ProBuilder-Equivalent Mesh Tools

- Add object, vertex, edge, face, and UV editing modes.
- Implement extrude, inset, bevel, bridge, loop cut, subdivide, merge, weld, detach, flip normals, and smoothing groups.
- Add vertex painting and basic UV generation/editing.
- Add CSG operations: union, subtract, and intersect.
- Add mesh validation/repair and pivot editing.
- Keep editable source data separate from optimized exported geometry.

### 2.2 Terrain System

Build on the existing heightmap Ground support.

- Introduce a terrain asset type with tiled terrain support.
- Add sculpt, smooth, flatten, noise, erosion, stamp, and paint brushes.
- Add terrain layers with albedo, normal, and ORM blending.
- Support paintable detail meshes, grass, and trees.
- Add terrain holes, collision generation, LOD/chunk streaming, and runtime quality settings.
- Integrate terrain with NavMesh and physics.

### 2.3 Splines

- Create spline assets and an editor for knots, Bezier handles, branches, closed loops, and metadata.
- Extrude meshes, roads, and pipes along splines.
- Place and animate objects along splines.
- Integrate with camera, cinematic, terrain-conforming, and NavMesh-aware tools.

### 2.4 First-Class 2D Workflow

- Add 2D scene and camera modes.
- Add sprite importing and slicing.
- Add Sprite Atlas generation and packing profiles.
- Add grid, Tilemap, palette, painting tools, and Rule Tiles.
- Add 2D colliders, Box2D-oriented authoring, 2D lights/shadows, and sorting layers.
- Add 2D animation, skeletal-sprite integration, and a pixel-perfect camera.
- Add mobile safe-area preview.

**Exit criteria:** Users can make a complete 2D game or a terrain-heavy 3D game without relying on external authoring tools for routine work.

## Phase 3 — Animation, Characters, Cameras, and Audio

**Duration:** 4–7 months

### 3.1 Animator System

Build beside—not by replacing—the current animation timeline and cinematic editor.

- Current Animation baseline: the original timeline plus a standalone Animation Window provide clip selection, multi-track Dope Sheet and component Curve views, box/multi-selection, event markers, scrubbing/playback, direct curve dragging, frame scaling, duplication, deletion, value offsets, and linear/stepped interpolation through the same exact-leased MCP edit model. Remaining Animation gaps are arbitrary Inspector-property recording, Unity-depth tangent modes, compression/interoperability controls, and live recording/debugging.
- Current Animator baseline: persisted controllers and weighted override/additive layers provide typed float/int/bool/trigger parameters with consume-on-transition and explicit reset semantics, real Entry destinations with ordered conditional routing, ordered Any State transitions, immediate or faded Exit transitions, Unity Equals/NotEqual/numeric conditions, fixed or source-normalized cross-fade duration, normalized exit time, destination offset, source/destination interruption modes, ordered interruption priority, self-transition permission, cross-fades that preserve in-progress blended weights, active-state playback, masks, generic root motion, recursively nested 1D/2D/Direct blend trees with independent per-child time scale, cycle offset, and mirroring, nested sub-state machines with child-machine-source Exit routing, and reusable controller subgraphs that may be instantiated repeatedly in the base machine, layers, or other subgraphs. Additive layers use a normalized per-clip reference pose without mutating authored AnimationGroups. Synchronized layers inherit the base or an earlier layer's compiled state machine, support qualified state mapping and per-source Motion/ordered-behaviour overrides, always stretch their clips to the shared normalized state time, and optionally affect that shared duration through Unity-style weight-based Timing while retaining their own clips, masks, weights, and blend mode. Explicit empty behaviour overrides clear mapped callbacks. Base, layer, and reusable-subgraph states persist up to 16 ordered target-script behaviours that receive typed enter/update/exit callbacks in editor preview and exported runtime. The Base Layer and every additional or synchronized layer can independently enable Unity-style IK Pass execution; target-node scripts receive typed `onAnimatorIK` callbacks after animation sampling and before existing IK/rig observers in the same frame. Callback errors, missing bindings, bounded recent events, per-layer IK invocations, and active synchronized override source/clip evidence appear in the live debugger, and a built-in script template plus strict MCP author the same contract. Bounded Unity `%YAML` Animator Controller conversion imports parameters, layers, direct/nested state machines, conditional Entry and child-machine-source transitions, Blend Trees including child motion modifiers, graph positions, IK Pass settings, synchronized per-state Motion overrides, transitions, timing/interruption fields, and explicit external Motion/AvatarMask bindings through the File Inspector, CLI build, and exact-leased MCP. Entry/Exit routing, scoped Any State transitions, qualified leaf paths, cycle/depth/count validation, interactive root graph nodes, detailed nested/layer/behaviour/override/IK authoring controls, editor preview, exported runtime, and strict shared MCP all use one deterministic compiled graph. A live 4 Hz debugger reports base/layer states, blend/synchronization/override settings, qualified machine paths, normalized time, authored/effective transition duration, transitions and weights, interruption evidence, declared/runtime parameter types, additive/motion-clone evidence, clip playback/weights/speed/phase/frames, behaviour and IK calls/errors, root-motion health, and engine delta.
- Recursive nested 1D/2D and Direct Blend Trees now share one bounded editor/preview/export/import/MCP model, including Direct per-child parameter weights, Unity's Normalize Blend Values option, independent duplicate motions, reverse-capable Time Scale, normalized Cycle Offset, and mapped humanoid Mirror. Conditional Entry and child-machine-source transitions now share the same compiled graph across authoring, import, preview, export, and MCP. Extend controller import/runtime with automatic Unity clip/AvatarMask/MonoBehaviour binding (including serialized synchronized `m_Behaviours`), broader Unity-version fixtures, animation-event integration, controller-integrated muscle tracing, transition history, runtime breakpoints, and frame-step debugging.

### 3.2 Character Workflow

- Add skeleton/rig import inspection.
- Add humanoid rig mapping and avatar assets.
- Current baseline: generic Animator root motion plus persisted None/Generic/Humanoid Avatars, 55-role automatic/manual bone mapping, validation, captured rest poses, per-role XYZ muscle limits, reusable nine-group body-part Avatar Masks, human-scale root translation, baked cross-skeleton animation retargeting, Unity-style Optimize Game Object import, normalized -1…1 muscle-space pose inspection/preview, non-mutating retarget debugging, and ordered weighted Animation Rig layers are available in the Inspector, Animator layers/states, editor/CLI model builds, exported runtime, and shared MCP. Rig layers evaluate deterministically after animation and support offset-preserving weighted multi-parent constraints, signed local twist distribution across multiple bones, Unity-style Chain IK, weighted Multi-Position with maintain-offset and XYZ channel masks, weighted Multi-Aim with local aim/up axes plus world-up stabilization, bounded multi-effector Full-Body IK, captured-offset Override Transform, temporal Damped Transform, and two-source Blend Transform. Override, Damped, and Blend constraints independently weight and mask world-position and world-rotation XYZ channels; Damped Transform keeps frame-rate-aware temporal position/rotation state, while Blend Transform interpolates between two distinct offset-aware sources. Full-Body IK solves up to eight descendant effectors sharing one root through iterative shared/branch-joint corrections, per-effector position/target-rotation weights, and centimeter tolerance, with per-effector reachability/error plus aggregate reached/average/maximum diagnostics. Skinned meshes now support named-bone inspection and authoring over one to eight influences per vertex, selected-vertex or spherical replace/add/subtract/smooth painting, exact-state leases, normalization/pruning/repair, influence limiting, local-axis mirroring with Left/Right remapping, Inspector Undo/Redo, topology-safety checks, and main/extra-buffer persistence through editor save and export. The Skeleton Inspector creates/reorders/weights/toggles/removes layers and constraints, manages Full-Body IK effectors and skin weights, and provides the humanoid pose/retarget tools. Every rig layer also has a persisted draggable data-flow canvas that visualizes Transform and bone inputs, constraint nodes, driven-bone outputs, labeled dependency edges, validity, and deterministic auto-layout through exact-lease MCP. Temporary pose and retarget overlays remain outside authored data and are restored/disposed before scene save. Optimized models retarget Transform animation tracks to Babylon bones, remove skeleton-only Transform nodes, flatten retained proxies, automatically preserve attachment parents, and synchronize explicitly exposed hierarchy paths for scripts, sockets, and IK targets. Model importers now author up to 64 named animation clips from source AnimationGroups with inclusive frame slicing, zero-based rebasing, Loop Time/Loop Pose, exact target masks, and validated position/rotation-Y root-motion extraction through the same editor, CLI, Inspector, and exact-lease MCP pipeline.
- Add IK targets and constraints.
- Add animation rigging: aim, two-bone IK, multi-parent, twist, and look-at.
- Add character-controller templates.
- Integrate existing ragdoll assets with animator transitions.

### 3.3 Cinemachine-Like Cameras

- Add virtual camera assets.
- Add priority and blend systems.
- Add follow, look-at, composer, framing, orbit, dolly, rail, and target groups.
- Add camera shake/impulse systems.
- Add timeline/cinematic shot tracks, split-screen, and camera stacking.

### 3.4 Audio Workflow

- Executed audio importing is complete for MP3/OGG/WAV/FLAC/M4A assets: the File Inspector and shared MCP produce exact-fingerprint preview artifacts through shell-free FFmpeg/FFprobe execution, and editor/CLI builds publish portable runtime sidecars. Static decoded and streaming runtime load paths are supported.
- Add audio mixer assets, buses, sends, effects, and snapshots.
- Add audio routing inspector and mixer UI.
- Add random/playlist containers, reverb zones, and spatial-audio profiles.
- Add audio profiling and runtime event debugging.

**Exit criteria:** A character-driven game can be authored with state-driven animation, dynamic cameras, ragdolls, and layered audio.

## Phase 4 — Rendering, Lighting, Shader, and VFX Expansion

**Duration:** 5–9 months

### 4.1 Rendering Profiles

- Current baseline: reusable camera profiles, weighted edge-blended volumes, and a dependency-ordered arbitrary full-screen GLSL pass graph with depth, geometry-normal, project-texture, pass-produced named inputs, explicit formats, real MRT outputs, and shader/copy/scene-raster/native-WebGPU-compute pass types are implemented in preview/exported runtime, Scene Inspector, and shared MCP. Named output lifetimes drive compatible transient target aliasing. General non-full-screen graphics passes remain future work.
- Introduce project render profiles for Web performance, mobile, desktop high quality, and XR.
- Centralize quality tiers and renderer capabilities.
- Add per-target feature validation.

### 4.2 Lighting

- Add a lighting settings asset.
- Add a Babylon-compatible baked-lighting workflow.
- Add lightmap assignment/management, reflection probes, and probe volumes.
- Add dynamic/static object flags, baked/realtime shadow configuration, lighting scenarios, and diagnostics.

### 4.3 Shader System

Keep Node Material Editor as the visual base.

- Add shader graph subgraphs and reusable graph functions.
- Add exposed properties/blackboard and material variants.
- Add custom HLSL/WGSL blocks where supported.
- Add shader compilation errors, variant diagnostics, and build-time stripping.
- Extend the completed shader/copy/scene-raster/native-WebGPU-compute graph, typed draggable compute-node authoring with math/selection/storage operations, scalar/vector conversions, swizzles, typed comparisons, Boolean logic and branching, reusable project-local graph-function assets, tracked collapsed call instances, SHA-256 dependency diagnostics, safe compatible refresh, versioned semantic asset migrations with dry-run/backup-safe upgrade, deterministic numeric node previews, bounded project-texture thumbnails with pixel diagnostics, live raster/compute/MRT output capture, stable public-texture capture for single-output shader/copy passes, topology/compiler/runtime debugging, per-pass CPU submission metrics, isolated hardware GPU timestamp profiling, honest whole-frame GPU timing, shared-resource hazard synchronization, submission boundaries, buffer bindings, indirect dispatch, and runtime buffer update/readback. Native WebGPU MRT primary/secondary attachment readback and downstream copy/shader sampling are verified. Remaining render-graph work includes additional future-version migration steps and general non-full-screen graphics passes.

### 4.4 VFX System

Build on Node Particle Editor.

- Add reusable VFX graph assets, exposed parameters, and subgraphs.
- Add GPU events, collisions, trails, ribbons, mesh particles, and vector fields.
- Add pooling, LOD, bounds, and runtime budget diagnostics.
- Add VFX graph debugging and performance overlays.

### 4.5 Rendering Diagnostics

- Add a frame debugger and render-pass viewer.
- Add material/shader inspection.
- Add overdraw, wireframe, light complexity, normals, and shadow-cascade views.
- Add GPU timing overlays.

**Exit criteria:** Users can produce scalable visuals with authorable lighting, shaders, VFX, and performance visibility.

## Phase 5 — Runtime Gameplay Systems and Multiplayer

**Duration:** 4–8 months

### 5.1 Gameplay Framework

- Add an input-action asset editor.
- Support keyboard/mouse, touch, gamepad, and XR input mappings.
- Add control schemes and rebinding.
- Add character-controller and camera starter kits.
- Add common gameplay script templates.
- Explore visual scripting as an optional plugin track.

### 5.2 Physics and Navigation Expansion

- Add physics material assets, joints, constraints, vehicle helpers, cloth integration where supported, and a collision-layer matrix.
- Add physics debugging and simulation controls.
- Add NavMesh agent components, off-mesh links, area costs, crowd controls, and runtime obstacle carving.
- Define behavior-tree or utility-AI package/plugin interfaces.

### 5.3 Multiplayer

- Choose a transport and networking model before implementation.
- Add replicated prefab/entity models, authority, ownership, RPC/events, and interpolation.
- Add local multi-instance play testing, a network profiler, and a state inspector.
- Add lobby, relay, and matchmaking adapters.
- Add dedicated-server templates and headless build targets.

**Exit criteria:** Teams can author and test a networked game from the editor, not only integrate networking manually in application code.

## Phase 6 — Build Targets, Deployment, and Platform Support

**Duration:** 6–12 months; console targets require external platform approval.

### 6.1 Build Profiles

- Replace one-off export options with Build Profiles.
- Profiles define target, scene/content list, quality profile, compression, environment variables, signing, and development/release settings.
- Generate build reports with duration, size, asset breakdown, and warnings.

### 6.2 Target Order

1. Web, PWA, WebGPU, and WebGL improvements.
2. Electron desktop production templates.
3. Native desktop packaging path.
4. Android.
5. iOS.
6. XR/WebXR.
7. Dedicated server.
8. Console targets, after developer-program access and platform agreements.

### 6.3 Device Tooling

- Add a device simulator for sizes, DPI, orientation, safe areas, and touch.
- Add remote preview and on-device logs/profiling.
- Add Android/iOS signing and store packaging.
- Validate target capabilities before building.

**Exit criteria:** A project can select a build profile, validate it, package it, test it on target hardware, and receive a useful report.

## Phase 7 — Testing, Profiling, Debugging, and Reliability

**Duration:** 3–6 months

- Add an editor Test Runner for unit, scene, integration, runtime/play-mode, visual-regression, and performance tests.
- Expand the existing Vitest foundation into project-level tests.
- Add CPU, GPU, memory, and loading profilers.
- Add runtime inspection and remote debugging.
- Add memory snapshots and leak detection.
- Add project auditing for unused assets, duplicate textures/materials, missing references, oversized assets, unsupported target features, and draw-call/material-budget checks.
- Add crash/error-reporting adapters.
- Add automated screenshot/render comparison tests.
- Add CI commands for validation, testing, building, reporting, and publishing.

## Phase 8 — Team Workflow, Packages, and Services

**Duration:** 4–8 months

### 8.1 Collaboration

- Current baseline: project-local expiring asset leases coordinate binary and serialized-editor-file edits across editor/MCP processes sharing one project directory. Acquisition is atomic and conflict-safe; ownership, renewal, expiry, recovery, and invalid-entry diagnostics are visible in the Scene Inspector and shared MCP. Persistent changelists, semantic diff/merge, exact conflict choices, and reusable rules cover local collaboration. Opt-in collaboration adds hashed one-time credentials, admin/editor/viewer roles, expiring per-client presence, heartbeats, access-key rotation, admin-lockout protection, and central viewer read-only enforcement. An opt-in remote HTTP/HTTPS gateway executes the same authorized endpoint map and streams bounded replayable sanitized operation/presence events over SSE. Its sanitized event journal survives editor restarts with configurable bounded retention, monotonic sequence checkpointing, filtered/gap-aware pagination, corruption quarantine, and explicit administrator clearing. Presence includes stable colors/tools, primary/hover/selection state, bounded multi-viewport mouse/pen/touch/XR pointers with optional world rays/hits, backward-compatible legacy cursors, and shared camera framing. Independent revision-aware compare-and-set channels cover transforms, common node state, hierarchy parents, and exact safe dotted-property sets. Project scripts, shaders, JSON, markup, styles, Markdown, and text support stable-ID RGA character collaboration with deterministic concurrent inserts, tombstone deletes, paginated IDs/text, external-divergence blocking, and explicit hash-guarded rebasing. Named ordered JSON scene collections use stable IDs, deterministic anchored inserts, versioned updates/moves, tombstone deletes, pagination, external-divergence blocking, and hash-guarded rebasing. Dedicated authenticated remote lock routes share the same atomic lease store and broadcast sanitized lock events. Project-contained development TLS certificate generation, inspection, expiry/key-match diagnostics, explicit rotation, and review-first trust guidance are available without modifying the operating-system trust store. Opt-in LAN discovery query/response advertises only a sanitized label, random public ID, gateway endpoint, authentication requirement, short expiry, and optional TLS fingerprint over bounded multicast/local UDP. A NAT-friendly managed-relay client maintains the editor's outbound-only WSS connection, tunnels action/presence/event/lock workflows through central collaboration RBAC, reconnects with bounded backoff, and keeps relay credentials live/environment-only. A deployable relay service supplies authenticated editor registration, public bearer-authenticated HTTP forwarding, health, timeouts, concurrency/frame/rate bounds, and single-editor replacement.
- Current Git workflow: inspect project-scoped status/history/diffs; selectively or completely stage and unstage; create explicitly confirmed commits; and explicitly confirm non-force pushes through the Scene Inspector or shared MCP. Argument-safe Git execution, path containment, nested-project index isolation, collaboration roles, remote/branch validation, and credential-safe output guard these operations.
- Add asset locking for binary/editor assets.
- Current remote/ref workflow: bounded local/remote branch and tag inventory, confirmed fetch/prune/tag refresh, clean-root fast-forward-only pull, local branch create/switch/safe-delete, lightweight or annotated local tag create/delete, and fully local credential-safe fetch/push authentication diagnostics are available in the Scene Inspector and shared MCP. Diagnostics classify transports, effective helper security/availability, AskPass/SSH-agent readiness, and actionable issues without contacting a remote or returning credential configuration values. Environment-authenticated GitHub, GitLab, Bitbucket Cloud, and Azure DevOps review workflows add provider configuration, bounded list/detail, create/draft, approve/comment/request-changes where supported, fingerprint-leased reviewer metadata, status/check or policy inspection, and exact-head-SHA leased merge/squash/rebase or rerun where supported without persisting credentials.
- Current integration workflow: read-only merge-base/divergence/file-impact preview, review-first no-auto-commit merge, non-interactive rebase, bounded unmerged-stage inspection, ours/theirs/delete/externally-edited conflict resolution, 256-KiB text/binary-aware Base/Ours/Theirs/current previews, SHA-256 stage fingerprints, rollback-safe custom UTF-8 resolution, bounded PNG/JPEG/WebP Base/Ours/Theirs previews, exact pairwise RGBA difference metrics and heatmaps, continue, and abort are available in the Scene Inspector and shared MCP with clean-root/admin/confirmation guards.
- Current remote publication workflow: authoritative remote heads/tags/default-branch inspection, non-force local branch/tag publication, and exact-hash force-with-lease deletion with default-branch protection are available in the Scene Inspector and shared MCP.
- Add optional hosted deployment automation.
- Add shared project settings and roles.

### 8.2 Package Ecosystem

- Add an Editor Package Manager for registry, Git, local, and enabled/disabled packages.
- Add dependency resolution, samples, compatibility checks, and version management.
- Define a public plugin API and SDK.
- Add marketplace metadata, verification, permissions, and updates.

### 8.3 Services

Use adapters rather than hardwiring one backend.

- Authentication.
- Cloud save.
- Leaderboards.
- Analytics.
- Remote config.
- Content delivery.
- In-app purchases and ads.
- Matchmaking, lobby, and relay.
- Cloud functions.

**Exit criteria:** Teams can collaborate safely, install capabilities predictably, and connect games to production services without bespoke glue code.

## Phase 9 — AI-Native Workflows

**Duration:** Ongoing after Phase 1 foundations.

The existing MCP work is a major advantage. Expand it rather than duplicating Unity AI.

- Add MCP tools for prefabs, terrain, splines, animator graphs, build profiles, tests, and profiling.
- Add agent-safe command execution and rollback.
- Add AI-assisted asset tagging, dependency cleanup, missing-reference repair, and performance audits.
- Add prompt-to-scene templates with reviewable command previews.
- Support optional image/material/mesh generation providers.
- Keep runtime inference as a separate plugin/package, not an editor-core dependency.

## Recommended Release Sequence

| Release               | Main delivery                                                           |
| --------------------- | ----------------------------------------------------------------------- |
| 6.0 Foundation        | Project migrations, asset IDs, command system, plugin/build-target APIs |
| 6.1 Production assets | Prefabs, variants, asset database, import pipeline, content groups      |
| 6.2 World building    | ProBuilder tools, Terrain v1, Splines, 2D v1                            |
| 6.3 Characters        | Animator, rigging/IK, virtual cameras, audio mixer                      |
| 6.4 Visual quality    | Lighting workflow, shader/VFX upgrades, render diagnostics              |
| 6.5 Shipping          | Build Profiles, mobile/desktop targets, test runner, profiler           |
| 6.6 Scale             | Multiplayer, collaboration, packages, cloud-service adapters            |
| 6.7 Advanced          | ECS/data-oriented experimentation, console programs, deeper XR          |

## Non-Negotiable Design Rules

- Do not rewrite the existing scene editor to add each feature.
- Reuse the existing scene, assets browser, inspector, timeline, Node Material Editor, Node Particle Editor, NavMesh editor, ragdoll editor, CLI, and MCP command model.
- Every new feature must support save/load, undo/redo, export/runtime loading, test coverage, MCP automation, plugin extensibility, and target-capability validation.
- Keep web as the primary runtime target. Native, console, and cloud features should be modular build/service packages.
- Do not claim console/mobile support until packaging, device testing, input, and signing workflows are complete.

## Staffing and First Milestone

A realistic staffing estimate is 10–15 engineers plus QA, design, and developer-relations support for 2–4 years.

The first commercially meaningful milestone is Phases 0–3: Prefabs, a proper asset workflow, world tools, and Animator/character tooling.
