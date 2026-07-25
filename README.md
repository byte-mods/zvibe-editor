# Babylon.js Editor 5

**Focus more on creating and less on coding.**

## Introduction

The Babylon.js Editor is a desktop application used to create and edit 3D scenes using the Babylon.js 3D engine.
The Editor is available on Windows, macOS and Linux.

It includes built-in templates, including a Next.js template, allowing you to bypass the tedious setup process and dive straight into building your project.

The model-import pipeline supports exact artist-authored LOD groups as well as generated deformation-safe LODs. Both workflows are available from the Model Inspector and the local MCP server, and produce the same runtime links in editor and CLI builds.

Projects can load multiple authored scenes together under independent Hierarchy roots. Active and lighting scenes, per-scene dirty/save/revert/unload state, transform-preserving dependency moves, and exact runtime additive load/unload handles share one ownership model. The local MCP server exposes the same leased workspace lifecycle and cross-scene move workflows to Codex CLI and Claude CLI.

Prefab instances include searchable single- and multi-instance Overrides windows for exact outer or nested boundaries. They group transform, serialized-component, and hierarchy differences with source values, conflict evidence, and leased Apply/Revert controls. Multi-instance changes support rollback-safe atomic mode for compatible independent sources and explicit per-target best-effort results. Prefab Stage opens assets in isolation or a locked live-scene context with persisted environment, appearance, override-display, and Auto Save settings. Core and specialized string, number, boolean, vector, color, list, slider, dimensions, asset, and entity controls show exact source status; whole custom-metadata, script, and runtime-physics component sections expose the same Apply/Revert actions. Runtime physics values are serialized from the live aggregate and reconstructed transactionally on Revert and prefab instantiation. Conflicted variants open a visual three-way merge that compares current base, authored override, resolved preview, and an optional exact live instance; every row requires an explicit safe Use Base, Keep Variant, or exact retarget choice before one rollback-aware write. A separate project-local review store gives Prefabs stable ownership, requested reviewers, bounded comments, exact-revision request rounds, approval/change-request evidence, collaboration identities, and automatic stale approval after content or recursive-base changes without modifying exported assets. The local MCP server exposes the same override, bulk, Stage, conflict-resolution, ownership, review-queue, comment, decision, and atomic source-edit workflows.

The asset browser and project exporter treat corrupt or mislabeled image files as recoverable assets: previews fall back to a generic image card, while builds skip invalid image data and report the affected path in the editor console. Export work always settles and closes its progress UI, and Play mode restores its controls if export, script compilation, or scene loading fails. Development reloads are scoped to application windows so Electron DevTools and internal renderers are not traversed by the legacy reloader. Unpackaged builds keep DevTools opt-in to avoid Electron protocol diagnostics for every new window: use `Cmd/Ctrl+Alt+I` for the focused window, or launch with `AUTO_OPEN_DEVTOOLS=true` when automatic opening is specifically needed.

✌️ The website is available here: https://editor.babylonjs.com

🏛️ The documentation is available here: https://editor.babylonjs.com/documentation

## Download

**v5.4.2**

- Windows x64: https://babylonjs-editor.fra1.cdn.digitaloceanspaces.com/updates/BabylonJS%20Editor%20Setup%205.4.2.exe
- macOS Apple Chip: https://babylonjs-editor.fra1.cdn.digitaloceanspaces.com/updates/BabylonJS%20Editor-5.4.2-arm64.dmg
- macOS Intel Chip: https://babylonjs-editor.fra1.cdn.digitaloceanspaces.com/updates/x64/BabylonJS%20Editor-5.4.2.dmg
- Linux x64: https://babylonjs-editor.fra1.cdn.digitaloceanspaces.com/updates/BabylonJS%20Editor-5.4.2.AppImage
- Linux arm64: https://babylonjs-editor.fra1.cdn.digitaloceanspaces.com/updates/BabylonJS%20Editor-5.4.2-arm64.AppImage

## Prerequisites

### Prerequisites for Windows

On **Windows**, you need some tools to be present in the system like Python and C++ compiler. Windows users can easily install them by running the following command in PowerShell as administrator:

```bash
# For more information see https://github.com/felixrieseberg/windows-build-tools
npm install --global --production windows-build-tools
```

The following are also needed:

- [Windows SDK](https://developer.microsoft.com/en-us/windows/downloads/windows-10-sdk) - only the "Desktop C++ Apps" components are needed to be installed
- Spectre-mitigated libraries - In order to avoid the build error "MSB8040: Spectre-mitigated libraries are required for this project", open the Visual Studio Installer, press the Modify button, navigate to the "Individual components" tab, search "Spectre", and install an option like "MSVC v143 - VS 2022 C++ x64/x86 Spectre-mitigated libs (Latest)" (the exact option to install will depend on your version of Visual Studio as well as your operating system architecture)

### Prerequisites for macOS

On **macOS**, you need to install XCode in order to compile native modules used by the Editor.
You can get XCode from the [AppStore](https://apps.apple.com/fr/app/xcode/id497799835?mt=12)

### Prerequisites for Linux (apt)

```bash
sudo apt install -y make python build-essential
```

## Installing and building

First, install the dependencies. This repository uses yarn classic.

```bash
yarn install
```

To build the editor and its associated tools, use the "build" command:

```bash
yarn build
```

## Running

Using the command line at the root of the repository, just type:

```bash
yarn start
```

The devtools will open automatically.

## Developing

To watch the Editor and its dependencies, use the following command:

```bash
yarn watch-editor-all
```

Using Visual Studio Code, you can also use a specific task to watch the Editor and other packages.
Just type `Ctrl+Shift+B` (or `Cmd+Shift+B` on macOS) and select the task `watch-all-editor`.

Before contributing, please ensure that all code is formatted correctly and respects the project's coding rules.
You can lint files using the following command:

```bash
yarn lint
```

And you can fix all fixable issues using:

```bash
yarn lint-fix
```

## Packaging

Due to the native dependencies, builds on macOS must be performed on a macOS machine and builds on Windows must be performed on a Windows machine with all the requirements installed (XCode, C++ compilers etc.).

To package the Editor, just use the "**package**" command.

```bash
# For the current platform and architecture
yarn package --noSign

# By providing the target architecture
yarn package --noSign --x64

# For both architectures
yarn package --noSign --arm64 --x64
```

This will re-install the depdendencies to ensure they are up-to-date, build the Editor and its tools to finally package the Electron application for the desired target.

In order to sign the application on **macOS**, you need to add a **.env** file at the root of the repository and set the following environment variables:

```env
APPLE_ID=
APPLE_APP_SPECIFIC_PASSWORD=
APPLE_TEAM_ID=
```

Then use the package command by omitting the **--noSign** flag:

```bash
# For the current platform and architecture
yarn package

# By providing the target architecture
yarn package --x64

# For both architectures
yarn package --arm64 --x64
```
