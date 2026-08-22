export type TutorialCodeLanguage = "typescript" | "bash" | "json";

export interface ITutorialCode {
	title: string;
	language: TutorialCodeLanguage;
	code: string;
}

export interface ITutorialFigure {
	src: string;
	alt: string;
	caption: string;
}

export interface ITutorialTable {
	headers: string[];
	rows: string[][];
}

export interface ITutorialSection {
	id: string;
	title: string;
	paragraphs?: string[];
	steps?: string[];
	bullets?: string[];
	note?: string;
	warning?: string;
	figure?: ITutorialFigure;
	code?: ITutorialCode;
	table?: ITutorialTable;
}

export interface ITutorial {
	slug: string;
	group: "Start here" | "Core workflows" | "Build complete games" | "AI and MCP";
	title: string;
	summary: string;
	level: "Beginner" | "Intermediate" | "Advanced";
	duration: string;
	prerequisites: string[];
	outcomes: string[];
	sections: ITutorialSection[];
}

const scriptLifecycleCode = `import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { IScript, visibleAsNumber } from "babylonjs-editor-tools";

export default class SpinComponent implements IScript {
	@visibleAsNumber("Speed", { min: 0, max: 0.1 })
	private _speed = 0.04;

	public constructor(public mesh: Mesh) {}

	public onStart(): void {
		// Called once after the scene and attached components are ready.
	}

	public onUpdate(): void {
		const frameScale = this.mesh.getScene().getAnimationRatio();
		this.mesh.rotate(Vector3.UpReadOnly, this._speed * frameScale);
	}

	public onStop(): void {
		// Dispose observers, timers, and other resources here.
	}
}`;

const playerControllerCode = `import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { IScript, visibleAsNumber } from "babylonjs-editor-tools";

export default class ArcadeCar implements IScript {
	@visibleAsNumber("Acceleration", { min: 1, max: 120 })
	private _acceleration = 42;

	@visibleAsNumber("Maximum speed", { min: 10, max: 220 })
	private _maximumSpeed = 105;

	@visibleAsNumber("Steering", { min: 0.1, max: 4 })
	private _steering = 1.8;

	private _speed = 0;
	private _keys = new Set<string>();

	public constructor(public mesh: Mesh) {}

	public onStart(): void {
		this.mesh.getScene().onKeyboardObservable.add((event) => {
			const key = event.event.key.toLowerCase();
			if (event.type === KeyboardEventTypes.KEYDOWN) this._keys.add(key);
			if (event.type === KeyboardEventTypes.KEYUP) this._keys.delete(key);
		});
	}

	public onUpdate(): void {
		const dt = this.mesh.getEngine().getDeltaTime() / 1000;
		const throttle = (this._keys.has("w") ? 1 : 0) - (this._keys.has("s") ? 1 : 0);
		const steer = (this._keys.has("d") ? 1 : 0) - (this._keys.has("a") ? 1 : 0);
		this._speed = Math.max(-25, Math.min(this._maximumSpeed, this._speed + throttle * this._acceleration * dt));
		this._speed *= Math.pow(0.985, dt * 60);
		this.mesh.rotation.y += steer * this._steering * dt * Math.min(1, Math.abs(this._speed) / 15);
		this.mesh.position.addInPlace(this.mesh.forward.scale(this._speed * dt));
	}
}`;

const thirdPersonCode = `import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { IScript, visibleAsNumber } from "babylonjs-editor-tools";

export default class ThirdPersonController implements IScript {
	@visibleAsNumber("Move speed", { min: 1, max: 20 })
	private _moveSpeed = 6;

	private _keys = new Set<string>();

	public constructor(public mesh: AbstractMesh) {}

	public onStart(): void {
		this.mesh.getScene().onKeyboardObservable.add((info) => {
			const key = info.event.key.toLowerCase();
			if (info.type === KeyboardEventTypes.KEYDOWN) this._keys.add(key);
			if (info.type === KeyboardEventTypes.KEYUP) this._keys.delete(key);
		});
	}

	public onUpdate(): void {
		const x = (this._keys.has("d") ? 1 : 0) - (this._keys.has("a") ? 1 : 0);
		const z = (this._keys.has("w") ? 1 : 0) - (this._keys.has("s") ? 1 : 0);
		const direction = new Vector3(x, 0, z);
		if (direction.lengthSquared() === 0) return;
		direction.normalize();
		const dt = this.mesh.getEngine().getDeltaTime() / 1000;
		this.mesh.moveWithCollisions(direction.scale(this._moveSpeed * dt));
		this.mesh.rotation.y = Math.atan2(direction.x, direction.z);
	}
}`;

const platformerCode = `import { KeyboardEventTypes } from "@babylonjs/core/Events/keyboardEvents";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { IScript, visibleAsNumber } from "babylonjs-editor-tools";

export default class PlatformerPlayer implements IScript {
	@visibleAsNumber("Run speed", { min: 1, max: 30 })
	private _runSpeed = 8;

	@visibleAsNumber("Jump impulse", { min: 1, max: 30 })
	private _jumpImpulse = 12;

	private _left = false;
	private _right = false;
	private _jumpQueued = false;

	public constructor(public mesh: Mesh) {}

	public onStart(): void {
		this.mesh.getScene().onKeyboardObservable.add((info) => {
			const pressed = info.type === KeyboardEventTypes.KEYDOWN;
			if (info.event.key === "ArrowLeft") this._left = pressed;
			if (info.event.key === "ArrowRight") this._right = pressed;
			if (pressed && info.event.code === "Space") this._jumpQueued = true;
		});
	}

	public onUpdate(): void {
		const body = this.mesh.physicsBody;
		if (!body) return;
		const velocity = body.getLinearVelocity() ?? Vector3.Zero();
		velocity.x = ((this._right ? 1 : 0) - (this._left ? 1 : 0)) * this._runSpeed;
		if (this._jumpQueued && Math.abs(velocity.y) < 0.15) velocity.y = this._jumpImpulse;
		body.setLinearVelocity(velocity);
		this._jumpQueued = false;
	}
}`;

const mcpConfigCode = `{
	"mcpServers": {
		"zvibe-editor": {
			"type": "stdio",
			"command": "node",
			"args": ["mcp/server/index.mjs"]
		}
	}
}`;

export const tutorials: ITutorial[] = [
	{
		slug: "ide-tour",
		group: "Start here",
		title: "Complete IDE tour",
		summary: "Create a project, understand every main panel, compose a scene, save safely, and run the game.",
		level: "Beginner",
		duration: "35 minutes",
		prerequisites: ["Zvibe Editor installed", "Node.js 20 or newer", "A mouse with a middle button is helpful"],
		outcomes: ["Navigate the complete editor layout", "Create and organize a scene", "Inspect, save, play, and diagnose a project"],
		sections: [
			{
				id: "workspace",
				title: "Know the workspace",
				paragraphs: [
					"A project window combines the scene hierarchy, live 3D preview, Inspector, Assets Browser, development tools, and specialist workspaces. Selection is shared: choosing an object in the hierarchy or viewport opens the same object in the Inspector.",
					"Scene dimensions use centimeters. Imported glTF assets are normally scaled by 100 so a one-meter model appears as 100 editor units. Keep that convention consistent in scripts, physics, navigation, and effects.",
				],
				figure: {
					src: "/documentation/tutorials/ide-overview.png",
					alt: "Zvibe Editor showing the hierarchy, scene preview, assets, and Inspector",
					caption: "The packaged Zvibe Editor with a production game scene open.",
				},
			},
			{
				id: "first-scene",
				title: "Create your first scene",
				steps: [
					"Create or open a project from the dashboard. The project file stores workspace and build configuration; scene files store authored scene content.",
					"Create a scene, then add a camera, hemispheric or directional light, and a ground mesh from the Add menu or command palette.",
					"Rename objects immediately. Use functional names such as MainCamera, Sun, Environment, PlayerSpawn, and GameplayRoot.",
					"Parent related objects under transform nodes. Keep environment, gameplay, lighting, UI, and runtime-only helpers in separate roots.",
					"Select each object and edit Transform and component properties in the Inspector. Use the viewport gizmos for position, rotation, and scale.",
					"Save the scene, then save the project. Watch the Console for errors before continuing.",
				],
				figure: {
					src: "/documentation/tutorials/scene-hierarchy.png",
					alt: "Scene hierarchy in Zvibe Editor",
					caption: "A clear hierarchy makes scripting, prefabs, MCP automation, and debugging predictable.",
				},
			},
			{
				id: "panels",
				title: "What each editor area owns",
				table: {
					headers: ["Area", "Use it for", "Habit"],
					rows: [
						["Graph / Hierarchy", "Create, parent, rename, enable, and select scene entities", "Group by responsibility; avoid unnamed nodes"],
						["Preview", "Compose, navigate, frame, transform, and play the scene", "Use local/global handles deliberately"],
						["Inspector", "Edit components, materials, physics, scripts, and scene settings", "Change one subsystem at a time and test"],
						["Assets Browser", "Import, organize, inspect, instantiate, and reuse assets", "Keep source and generated assets separate"],
						["Console / Terminal", "Read runtime errors and run project commands", "Resolve the first error before later symptoms"],
						["Specialist tabs", "Animation, Animator, VFX, shaders, terrain, navigation, profiling, builds", "Open the workspace that owns the data"],
					],
				},
			},
			{
				id: "safe-loop",
				title: "Use the safe edit loop",
				steps: [
					"Save before structural changes.",
					"Make one coherent change.",
					"Check Console and scene diagnostics.",
					"Play in the editor for a fast check.",
					"Run the generated project for runtime truth.",
					"Capture a screenshot or profiler sample for visual/performance-sensitive work.",
				],
				note: "Undo and redo cover normal editor actions, but imported files and external source-control operations should still be protected by commits or backups.",
			},
		],
	},
	{
		slug: "assets-materials",
		group: "Core workflows",
		title: "Assets, textures, materials, and prefabs",
		summary: "Import production assets, configure texture intent, build PBR materials, and create reusable prefabs.",
		level: "Beginner",
		duration: "45 minutes",
		prerequisites: ["Complete IDE tour", "A glTF/GLB model and several PNG/JPG textures"],
		outcomes: ["Use the asset pipeline safely", "Configure 2D and 3D texture imports", "Create reusable materials and prefabs"],
		sections: [
			{
				id: "import",
				title: "Import and organize assets",
				steps: [
					"Create folders such as Models, Textures, Materials, Animations, Audio, Prefabs, Scripts, and UI under assets.",
					"Drag source files into the Assets Browser or use the import command. Wait for importer metadata and thumbnails to finish.",
					"Select the asset and inspect importer settings before instantiating it. Model settings control scaling, materials, animation clips, compression, and platform overrides.",
					"Use Move/Rename inside the editor so sidecar metadata and references remain synchronized.",
					"Instantiate models into the scene. Prefer instances for repeated static objects; use clones only when independent geometry or state is required.",
				],
				figure: {
					src: "/documentation/tutorials/assets-browser.png",
					alt: "Zvibe Editor Assets Browser with game assets",
					caption: "The Assets Browser is the source of truth for project-contained assets and their importer settings.",
				},
			},
			{
				id: "textures",
				title: "Configure textures by intent",
				table: {
					headers: ["Texture", "Color space", "Typical settings"],
					rows: [
						["Base color / UI / sprite", "sRGB", "Preserve alpha; mipmaps for 3D, usually off for pixel UI"],
						["Normal map", "Linear", "Normal-map type; correct handedness/channel convention"],
						["Metallic / roughness / AO / masks", "Linear", "No color correction; verify channel packing"],
						["HDR environment", "Linear HDR", "Use environment import path and sensible resolution"],
						["2D pixel art", "sRGB", "Point sampling, no mipmaps, pixels-per-unit and alpha outline as required"],
					],
				},
				paragraphs: [
					"PNG files do not need a destructive conversion to become game assets. Configure them as default textures, sprites, UI images, normal maps, or data maps. The importer records how the same source pixels should be decoded and packaged.",
				],
			},
			{
				id: "materials",
				title: "Build a PBR material",
				steps: [
					"Create a PBR material asset.",
					"Assign base color/albedo and normal textures.",
					"Set metallic and roughness values or connect the correct packed channels.",
					"Configure transparency only when needed; opaque materials sort and render more efficiently.",
					"Apply the material to a mesh, inspect it under neutral lighting, then verify it in the target rendering profile.",
					"Use material variants for paint colors or quality levels instead of duplicating entire graphs.",
				],
				warning: "Do not judge PBR material values under an unlit or nearly black scene. Add an environment texture or a calibrated key/fill setup first.",
			},
			{
				id: "prefabs",
				title: "Author reusable prefabs",
				steps: [
					"Build and test one complete object hierarchy in a scene.",
					"Attach scripts and configure exported fields.",
					"Create a prefab asset from the root.",
					"Instantiate the prefab in a test scene.",
					"Change a property on one instance and confirm the override is visible.",
					"Apply intentional overrides in bulk or revert them; update the prefab source when the change belongs to every instance.",
				],
				note: "Keep prefab roots self-contained. Scene-wide managers, global lights, and build configuration should not be hidden inside an ordinary gameplay prefab.",
			},
		],
	},
	{
		slug: "animation-animator",
		group: "Core workflows",
		title: "Animation and Animator controllers",
		summary: "Import clips, edit curves and events, assemble state machines, blend locomotion, and debug runtime transitions.",
		level: "Intermediate",
		duration: "60 minutes",
		prerequisites: ["A rigged model with idle, walk, run, and jump clips", "Basic scene composition"],
		outcomes: ["Edit clips and animation events", "Create Animator states and transitions", "Drive and debug animation from scripts"],
		sections: [
			{
				id: "timeline",
				title: "Prepare animation clips",
				steps: [
					"Import the model and inspect its skeleton and AnimationGroups.",
					"Split or rename source takes into stable gameplay clips.",
					"Set loop behavior for cyclic clips and keep one-shot actions non-looping.",
					"Use the Animation timeline to inspect tracks, keys, tangents, duration, and root-motion intent.",
					"Add named animation events for exact gameplay moments such as footstep, attackHit, reloadComplete, or land.",
				],
				figure: {
					src: "/documentation/tutorials/animation-timeline.png",
					alt: "Zvibe Editor animation timeline",
					caption: "Use the timeline for clip-level curves, keys, scrubbing, and events.",
				},
			},
			{
				id: "controller",
				title: "Build an Animator controller",
				steps: [
					"Create a controller and assign it to the character.",
					"Add float Speed, bool Grounded, trigger Jump, and trigger Attack parameters.",
					"Create Idle, Locomotion, Jump, Fall, Land, and Attack states.",
					"Use a 1D blend tree for idle/walk/run driven by Speed.",
					"Create transitions with explicit conditions and sensible exit-time behavior.",
					"Put upper-body actions on a masked layer when locomotion must continue underneath.",
					"Enable root motion only when the clips and controller are authored to own displacement.",
				],
				figure: {
					src: "/documentation/tutorials/animator.png",
					alt: "Zvibe Editor Animator graph",
					caption: "The Animator workspace owns parameters, states, transitions, blend trees, layers, masks, and runtime inspection.",
				},
			},
			{
				id: "script",
				title: "Drive parameters from gameplay",
				paragraphs: [
					"Scripts can update parameters and implement Animator callbacks such as state enter, update, exit, state-machine enter/exit, and IK. Keep movement truth in gameplay code and use the Animator to visualize that state.",
				],
				code: {
					title: "Animator callback pattern",
					language: "typescript",
					code: `import { IScript } from "babylonjs-editor-tools";

export default class CharacterAnimationEvents implements IScript {
	public onAnimatorStateEnter(_layer: number, state: { name?: string }): void {
		if (state.name === "Attack") console.log("Attack animation entered");
	}

	public onAnimatorStateExit(_layer: number, state: { name?: string }): void {
		if (state.name === "Land") console.log("Landing finished");
	}
}`,
				},
			},
			{
				id: "debug",
				title: "Verify the controller",
				steps: [
					"Play the scene and display live parameter values.",
					"Set transition breakpoints for unexpected state changes.",
					"Pause and fixed-step the controller through a transition.",
					"Inspect authored versus evaluated source, destination, interruption, and effective duration.",
					"Test both low and high frame rates and confirm gameplay never depends on animation frames being rendered.",
				],
			},
		],
	},
	{
		slug: "scripting-fundamentals",
		group: "Core workflows",
		title: "TypeScript gameplay scripting",
		summary: "Create components, expose Inspector properties, link scene assets, handle input, and debug runtime code.",
		level: "Beginner",
		duration: "55 minutes",
		prerequisites: ["Basic TypeScript", "A project with one mesh"],
		outcomes: ["Implement the script lifecycle", "Expose safe designer controls", "Attach, test, and debug components"],
		sections: [
			{
				id: "lifecycle",
				title: "Create an attachable component",
				paragraphs: [
					"A default-exported class that implements IScript becomes an attachable component. Its constructor receives the attached Babylon object. onStart initializes state, onUpdate performs frame work, and onStop releases resources.",
				],
				code: { title: "Complete component lifecycle", language: "typescript", code: scriptLifecycleCode },
			},
			{
				id: "attach",
				title: "Attach and configure the script",
				steps: [
					"Create the TypeScript file inside the project source/scripts directory.",
					"Wait for compilation; resolve the first diagnostic shown in Console.",
					"Select the target object and add the script component in the Inspector.",
					"Set exposed fields. The Speed decorator in the example becomes a bounded numeric control.",
					"Play the editor scene, then run the project to verify the generated runtime.",
				],
			},
			{
				id: "decorators",
				title: "Use editor decorators deliberately",
				bullets: [
					"visibleAsNumber, visibleAsBoolean, visibleAsString, visibleAsVector, and visibleAsColor expose designer-safe values.",
					"visibleAsEntity, nodeFromScene, and nodeFromDescendants link scene objects without fragile runtime name scans.",
					"visibleAsTexture and sceneAsset link project assets through persistent metadata.",
					"visibleAsKeyMap exposes input mappings.",
					"onPointerEvent and onKeyboardEvent bind input handlers declaratively.",
				],
				note: "Prefer a typed reference or asset GUID over looking up an object by a display name every frame.",
			},
			{
				id: "performance",
				title: "Write stable frame code",
				bullets: [
					"Use engine delta time or animation ratio; never assume 60 FPS.",
					"Cache references in onStart instead of searching the scene during every onUpdate.",
					"Remove observers and dispose resources in onStop.",
					"Use physics impulses/velocities through the physics body instead of fighting the solver with direct transforms.",
					"Keep allocations out of hot loops and confirm with the Profiler.",
				],
				figure: {
					src: "/documentation/tutorials/script-debugger.png",
					alt: "Zvibe Editor script debugger",
					caption: "The script debugger combines runtime diagnostics, breakpoints, and component inspection.",
				},
			},
		],
	},
	{
		slug: "feature-workflows",
		group: "Core workflows",
		title: "Complete feature workflow map",
		summary: "A practical map of the editor systems used to produce, profile, test, and ship games.",
		level: "Intermediate",
		duration: "Reference",
		prerequisites: ["Complete IDE tour"],
		outcomes: ["Know which workspace owns each task", "Understand the author-test-build loop for major systems", "Find the matching MCP family"],
		sections: [
			{
				id: "content",
				title: "Content authoring",
				table: {
					headers: ["System", "Workflow", "Verify"],
					rows: [
						["Meshes / ProBuilder", "Create primitives, edit geometry, UVs, subdivision, LOD and collisions", "Normals, bounds, draw calls, collision response"],
						["Terrain", "Create height terrain, paint layers, vegetation and streaming tiles", "Seams, materials, collision, streaming budget"],
						["Materials / Shader Graph", "Author PBR, node materials, subgraphs, variants and custom passes", "Lighting response, compilation, fallback profile"],
						["VFX / Particles", "Author CPU/GPU systems, node particle graphs, trails, collisions and vector fields", "Bounds, pooling, overdraw, device fallback"],
						["Sprites / 2D", "Import sprite sheets, slicing, sorting layers, palettes and tile colliders", "Pixel sampling, ordering, composite colliders"],
						["Audio / Video", "Create SoundNodes, mixer routing, spatial settings, ducking and video players", "User gesture, clipping, spatial falloff, packaging"],
					],
				},
			},
			{
				id: "gameplay",
				title: "Gameplay and simulation",
				table: {
					headers: ["System", "Workflow", "Verify"],
					rows: [
						["Animation / Animator", "Edit clips and events; build state machines, layers, masks and blend trees", "Runtime parameters, transitions, root motion, IK"],
						["Physics 3D", "Bodies, shapes, materials, constraints, contacts, vehicles, cloth and ragdolls", "Stable timestep, sleep, CCD, deterministic reset"],
						["Physics 2D", "Bodies, shapes, materials, joints and tile composite colliders", "Plane lock, contacts and sprite scale"],
						["Navigation", "Bake NavMesh areas, obstacles, links and agents", "Path reachability, radius/height, runtime obstacles"],
						["Rigging", "Humanoid avatar, IK targets, pole targets, constraints and rig layers", "Retarget pose, weight blending, foot placement"],
						["Visual scripting / Behavior trees", "Author typed graphs, subgraphs, variables, conditions and runtime debug", "Validation, breakpoints, serialization"],
						["Input / XR", "Action maps, keyboard, pointer, gamepad, touch, XR rigs and interactions", "Device simulator and target hardware"],
					],
				},
			},
			{
				id: "production",
				title: "Production and delivery",
				table: {
					headers: ["System", "Workflow", "Verify"],
					rows: [
						["GUI / UI Toolkit", "Screens, controls, bindings, localization, accessibility and interaction tests", "Responsive layouts, focus, screen reader labels"],
						["Rendering", "Profiles, post effects, volumes, probes, baked GI, occlusion and render graphs", "Frame debugger, screenshots, device quality tiers"],
						["Cinematics", "Timeline tracks, cameras, animation, audio, events and offline capture", "Timing, skip/replay behavior, muxed output"],
						["Addressables / Streaming", "Labels, catalogs, bundles, remote delivery and scene streaming", "Missing/offline behavior, hashes, memory release"],
						["Testing / Profiling", "Scene tests, device simulation, regression baselines and captures", "Repeatable pass criteria and performance budgets"],
						["Build / Platforms", "Web, PWA, Electron desktop, mobile scaffolds and server targets", "Clean build, packaged launch, logs, asset integrity"],
						["Source control / Collaboration", "Status, diffs, locks, semantic merge, reviews and presence", "No credentials in project data; conflict recovery"],
						[
							"Services / Networking / AI",
							"Service configuration, multiplayer transport, console servers and runtime models",
							"Offline/error paths, authority, latency and memory",
						],
					],
				},
			},
			{
				id: "definition-done",
				title: "Definition of done for any feature",
				steps: [
					"Author the feature in the editor and save it.",
					"Reload the scene to prove persistence.",
					"Run the project and exercise the actual gameplay path.",
					"Check Console and structured diagnostics for zero unexpected errors.",
					"Capture visual evidence or data readback.",
					"Profile the hot path on the target quality profile.",
					"Build the intended target and launch the artifact.",
					"When automated through MCP, reread exact state after every write and clean up temporary test content.",
				],
			},
		],
	},
	{
		slug: "worldbuilding-physics",
		group: "Core workflows",
		title: "Worldbuilding, terrain, physics, and navigation",
		summary: "Block out levels, sculpt terrain, configure collision and simulation, bake navigation, and validate playable spaces.",
		level: "Intermediate",
		duration: "75 minutes",
		prerequisites: ["Complete IDE tour", "A disposable scene", "Basic transforms and prefabs"],
		outcomes: ["Block out and optimize a level", "Configure rigid bodies, cloth, vehicles, and ragdolls", "Bake and debug a NavMesh"],
		sections: [
			{
				id: "blockout",
				title: "Block out with primitives and ProBuilder",
				steps: [
					"Write the level metrics first: character height, doorway width, jump distance, vehicle width, camera clearance, and intended travel time.",
					"Create primitives or ProBuilder geometry for floors, ramps, stairs, walls, and cover. Keep visual and collision intent obvious in names.",
					"Edit vertices, edges, faces, normals, pivots, and UVs only after the basic path is fun at gray-box quality.",
					"Use repeated instances or prefabs for modular architecture. Merge or batch only after iteration is stable.",
					"Walk or drive the entire blockout using final controller dimensions before replacing it with art.",
				],
				figure: {
					src: "/documentation/tutorials/scene-hierarchy.png",
					alt: "Organized world scene hierarchy",
					caption: "Separate environment, gameplay, physics, navigation, lighting, and runtime roots so each system remains testable.",
				},
			},
			{
				id: "terrain",
				title: "Create and stream terrain",
				steps: [
					"Create terrain from a height source or sculpt a new bounded surface.",
					"Set terrain size and resolution from gameplay scale—not texture resolution alone.",
					"Define material layers for rock, soil, grass, road, or snow and paint normalized layer weights.",
					"Add vegetation and detail with density, slope, height, distance, and randomization limits.",
					"Generate simplified collision and navigation sources.",
					"For large worlds, configure streaming tiles, preload distance, unload distance, and a memory budget; drive the streaming origin with the player or active camera.",
					"Traverse every tile boundary while profiling and inspect seams, collision continuity, asset release, and fallback behavior.",
				],
			},
			{
				id: "physics",
				title: "Configure 3D and 2D physics",
				table: {
					headers: ["Need", "Use", "Critical check"],
					rows: [
						[
							"Static world",
							"Static bodies with simple box, sphere, capsule, convex, or authored mesh shapes",
							"No moving concave bodies; collision mesh matches gameplay",
						],
						["Movable prop", "Dynamic body with mass, damping, material, sleep, and optional CCD", "Stable at target fixed timestep and scale"],
						["Door / mechanism", "Constraint with explicit frames, limits, drive, damping, and break threshold", "No initial overlap or frame mismatch"],
						["Vehicle", "Vehicle body, wheel/suspension configuration, friction and input", "Center of mass, suspension travel, recovery"],
						["Character death", "Ragdoll mapped to a valid skeleton", "Animator-to-ragdoll handoff and reset"],
						["Fabric", "Cloth constraints plus bounded colliders", "Pinned vertices, penetration, solver cost"],
						["2D gameplay", "2D bodies/shapes/joints and composite tile colliders", "Plane, pixels-per-unit, contact filters"],
					],
				},
				warning:
					"Never scale a physics hierarchy arbitrarily after authoring shapes. Rebuild or explicitly update shape dimensions and mass properties, then retest contacts and constraints.",
			},
			{
				id: "navmesh",
				title: "Bake navigation and move agents",
				steps: [
					"Mark only intended world geometry as navigation input. Exclude decorative micro-geometry and dynamic characters.",
					"Set agent radius, height, climb, and maximum slope from the actual controller capsule.",
					"Define area costs for road, grass, mud, danger, or preferred cover routes.",
					"Bake, then inspect disconnected islands and narrow portals in the NavMesh preview.",
					"Add links for authored jumps, doors, ladders, drops, or elevators and obstacles for runtime avoidance/carving.",
					"Spawn an agent, request paths between representative points, and test moving obstacles, unreachable destinations, repathing, stop distance, and recovery.",
				],
			},
			{
				id: "world-verify",
				title: "World verification checklist",
				bullets: [
					"Reload the scene and confirm terrain, ProBuilder geometry, physics, and navigation persist.",
					"Run scene tests for spawn safety, checkpoint reachability, trigger order, and forbidden penetrations.",
					"Use contact and navigation diagnostics instead of judging only by motion on screen.",
					"Profile the busiest physics frame and the largest streaming transition.",
					"Test low/high frame rate, pause/resume, scene restart, and build reload.",
				],
			},
		],
	},
	{
		slug: "rendering-vfx",
		group: "Core workflows",
		title: "Rendering, Shader Graph, VFX, and lighting",
		summary: "Create readable lighting, node-based materials, particles and trails, post-processing profiles, and measurable visual quality tiers.",
		level: "Intermediate",
		duration: "80 minutes",
		prerequisites: ["Assets and materials tutorial", "A representative gameplay scene"],
		outcomes: ["Author and debug a shader graph", "Build scalable particle/VFX systems", "Create lighting and rendering profiles"],
		sections: [
			{
				id: "lighting",
				title: "Establish readable lighting",
				steps: [
					"Set the environment texture and exposure using a neutral material test object.",
					"Add one primary directional, spot, or area-light source that communicates form and direction.",
					"Add fill/rim only where it improves gameplay readability. Use clustered containers for many compatible local lights.",
					"Configure shadow caster lists, maps, bias, filtering, cascades, and distance from the target performance budget.",
					"Use reflection probes, light probes, baked GI, and lighting scenarios where static or blended lighting is appropriate.",
					"Inspect a flat-gray scene, then final materials, to separate lighting defects from texture defects.",
				],
				figure: {
					src: "/documentation/tutorials/ide-overview.png",
					alt: "Lit gameplay scene in Zvibe Editor",
					caption: "A readable edit viewport should make the main subject, route, hazards, and interactive elements clear before post effects.",
				},
			},
			{
				id: "shader-graph",
				title: "Author a Shader Graph material",
				steps: [
					"Create a node material/shader graph and define exposed blackboard inputs for artist-controlled values.",
					"Build the smallest graph that outputs the intended surface, unlit, or post-process result.",
					"Group repeated logic into subgraphs and use keywords/switches only when a real variant is required.",
					"Preview textures, vectors, and intermediate outputs; resolve graph diagnostics before assigning it broadly.",
					"Create material variants for quality or appearance and verify fallback behavior on the WebGPU/WebGL profiles you ship.",
					"Strip unused blocks and inspect shader compilation time and variant count before release.",
				],
			},
			{
				id: "vfx",
				title: "Build VFX and particle systems",
				steps: [
					"Choose CPU particles for simple compatibility or GPU/node particles for high counts and graph-driven behavior.",
					"Author spawn shape, rate/bursts, lifetime, velocity, forces, size, color, rotation, spritesheet, and blend mode.",
					"Add collision, event, proximity, or vector-field behavior only when gameplay/visual evidence requires it.",
					"Use trails for tires, weapons, motion accents, or projectiles; control lifetime, width, color, texture, and pooling.",
					"Set conservative bounds so effects are neither culled too early nor always considered visible.",
					"Test start/stop/restart, object pooling, scene reload, low quality, and effect destruction without leaked emitters.",
				],
			},
			{
				id: "pipeline",
				title: "Create rendering profiles and volumes",
				bullets: [
					"Use a Development profile with diagnostics and a conservative Release profile for each platform tier.",
					"Configure antialiasing, HDR/exposure, bloom, tone mapping, SSAO, SSR, motion blur, depth of field, fog, and color grading as an intentional stack.",
					"Use volumes to blend local rendering changes and test overlapping priority/weight behavior.",
					"Use custom render passes or render graphs for requirements that cannot be represented by the standard pipeline.",
					"Capture render outputs and frame-debug intermediate targets when a final image is wrong.",
				],
			},
			{
				id: "profile",
				title: "Profile visual quality",
				steps: [
					"Capture a stable camera view with the busiest lights, transparencies, shadows, particles, and animated meshes.",
					"Record CPU/GPU frame time, draw calls, triangles, active particles, texture memory, render target memory, and shader compilation events.",
					"Disable subsystems one at a time to measure their actual cost.",
					"Create High, Medium, and Low profiles with explicit budgets rather than vague quality labels.",
					"Capture visual regression baselines for critical views and rerun them after pipeline or shader changes.",
				],
				figure: {
					src: "/documentation/tutorials/profiler.png",
					alt: "Zvibe Editor profiler",
					caption: "Use captures and target budgets to decide which visual effects belong in each quality tier.",
				},
			},
		],
	},
	{
		slug: "build-publish",
		group: "Core workflows",
		title: "Build, package, and publish",
		summary: "Configure project/editor settings and produce tested Web, PWA, and desktop builds.",
		level: "Intermediate",
		duration: "50 minutes",
		prerequisites: ["A scene that runs successfully", "A clean Console"],
		outcomes: ["Create development and release profiles", "Build Web and desktop targets", "Validate the packaged artifact"],
		sections: [
			{
				id: "settings",
				title: "Separate editor, project, and build settings",
				bullets: [
					"Editor preferences control local behavior such as theme, layout, external source editor, and machine-specific tools.",
					"Project settings control shared gameplay/runtime choices such as gravity, rendering, input, services, platform declarations, and package dependencies.",
					"Build profiles choose target, entry scene, quality/rendering profile, output rules, development diagnostics, compression, and platform-specific packaging.",
				],
				note: "Set the external editor to an executable or detected IDE. Opening a JavaScript/TypeScript source file should jump to that file without storing a teammate-specific absolute path in shared project data.",
			},
			{
				id: "profiles",
				title: "Create development and release profiles",
				steps: [
					"Create a Development Web profile with source maps and diagnostics enabled.",
					"Create a Release Web profile with optimized scripts, compressed assets, and an explicit start scene.",
					"Add a PWA profile if offline installation is required.",
					"Add an Electron desktop profile for macOS, Windows, or Linux packaging.",
					"Set platform overrides for texture sizes, codecs, rendering features, and quality.",
					"Validate the profile before building; treat warnings as explicit decisions.",
				],
				figure: {
					src: "/documentation/tutorials/build-profiles.png",
					alt: "Zvibe Editor Build Profiles workspace",
					caption: "Build Profiles keep target-specific choices reproducible instead of hiding them in local commands.",
				},
			},
			{
				id: "web",
				title: "Build and serve Web",
				code: {
					title: "Typical project commands",
					language: "bash",
					code: `yarn install
yarn dev
yarn build
yarn start`,
				},
				steps: [
					"Generate/export the project from the editor.",
					"Run the development server and test the exact gameplay loop.",
					"Create a production build and serve that output locally.",
					"Test asset URLs, refresh/deep links, audio unlock, pointer lock, loading screens, and browser Console errors.",
					"Deploy the generated static/server output appropriate to the selected template.",
				],
			},
			{
				id: "desktop",
				title: "Package desktop and verify",
				steps: [
					"Select the Electron target and operating-system architecture.",
					"Use unsigned local packaging for development; configure platform signing and notarization for distribution.",
					"Launch the installed/package artifact, not just the editor preview.",
					"Verify title, icon, version, save locations, full-screen behavior, input, audio, and clean shutdown.",
					"Repeat packaging on each target operating system because native dependencies and signing are platform-bound.",
				],
				warning: "A successful TypeScript or web build does not prove the desktop package launches. Always open the packaged artifact and inspect its logs.",
			},
		],
	},
	{
		slug: "racing-game",
		group: "Build complete games",
		title: "Build a neon arcade racing game",
		summary: "An end-to-end racing example with a visible car, track, chase camera, rivals, nitro, HUD, lighting, audio, and builds.",
		level: "Advanced",
		duration: "3–5 hours",
		prerequisites: ["A car model and track kit", "Scripting and materials tutorials", "Gamepad optional"],
		outcomes: ["Build a playable arcade handling loop", "Create race progression and HUD", "Light, profile, and package the game"],
		sections: [
			{
				id: "target",
				title: "Define the playable target",
				paragraphs: [
					"The minimum complete loop is: countdown, accelerate and steer, pass checkpoints in order, complete laps against rivals, use nitro, finish, restart. Visual spectacle is added only after this loop is reliable.",
				],
				figure: {
					src: "/documentation/tutorials/neon-apex-game.png",
					alt: "Playable Neon Apex racing game",
					caption: "A verified game build with a visible car, track, HUD, lighting, and speed feedback.",
				},
			},
			{
				id: "scene",
				title: "Assemble the race scene",
				steps: [
					"Create roots named Environment, Track, Checkpoints, Vehicles, Lighting, VFX, Audio, and UI.",
					"Import the track and car at the editor centimeter scale; verify wheelbase and collider dimensions.",
					"Use one road collision mesh and simplified barriers instead of complex visual meshes.",
					"Place ordered checkpoint triggers and a start/finish trigger. Add respawn transforms on safe road sections.",
					"Create a chase camera and a look-ahead target. Add a directional key light, environment lighting, emissive signage, and clustered local lights.",
					"Build a car prefab with visual mesh, collision body, wheel anchors, exhaust anchors, camera target, and script components.",
				],
			},
			{
				id: "controller",
				title: "Implement readable arcade handling",
				paragraphs: [
					"Start with a stable kinematic controller, then switch to the vehicle physics backend when suspension and tire behavior are needed. The example below is deliberately small and keeps all tuning visible in the Inspector.",
				],
				code: { title: "Arcade car controller", language: "typescript", code: playerControllerCode },
			},
			{
				id: "race",
				title: "Add race systems",
				steps: [
					"Write a RaceDirector state machine: Grid → Countdown → Racing → Finished.",
					"Accept checkpoints only in the expected order; compute lap when the start line follows the final checkpoint.",
					"Drive rivals along a spline or NavMesh corridor with speed targets, avoidance, and recovery.",
					"Add nitro energy, recharge rules, FOV change, exhaust/trail VFX, and a distinct audio layer.",
					"Bind HUD speed, lap, position, timer, countdown, minimap, nitro, and pause/restart controls.",
					"Save best lap and settings through a small service layer rather than directly from UI controls.",
				],
			},
			{
				id: "look",
				title: "Make the game readable at speed",
				bullets: [
					"Keep the car brighter than the road with rim/key lighting and controlled reflections.",
					"Use emissive track edges and checkpoint gates as navigation language.",
					"Apply bloom carefully; text, brake lights, and signs must not become unreadable blobs.",
					"Use speed lines, camera shake, motion blur, and FOV as feedback, not as substitutes for acceleration.",
					"Provide quality tiers for shadows, reflections, particles, resolution scale, and post effects.",
				],
				warning: "If the car disappears in darkness, fix exposure, environment lighting, material values, and camera composition before adding more effects.",
			},
			{
				id: "ship",
				title: "Test and ship",
				steps: [
					"Finish three consecutive races with keyboard and gamepad.",
					"Test leaving the track, reversing through checkpoints, pausing, restarting, and losing focus.",
					"Profile at the busiest section with rivals and VFX active.",
					"Reload the saved scene and repeat one lap.",
					"Build Web Release and Electron Development artifacts.",
					"Launch both artifacts, verify input/audio/HUD, and capture a final screenshot.",
				],
			},
		],
	},
	{
		slug: "third-person-game",
		group: "Build complete games",
		title: "Build a third-person action game",
		summary: "Create movement, camera, Animator locomotion, navigation enemies, combat, health, UI, and checkpoints.",
		level: "Advanced",
		duration: "4–6 hours",
		prerequisites: ["Rigged humanoid with locomotion and attack clips", "NavMesh and physics familiarity"],
		outcomes: ["Create a responsive character controller", "Connect Animator and gameplay", "Build an enemy and combat loop"],
		sections: [
			{
				id: "world",
				title: "Build the test arena",
				steps: [
					"Create a small arena with ramps, stairs, cover, one moving obstacle, and one drop hazard.",
					"Use simplified collision geometry and verify character capsule dimensions.",
					"Bake the NavMesh with agent radius, height, step, and slope values matching the character.",
					"Place player spawn, enemy spawns, patrol points, health pickups, checkpoint, and camera blockers.",
				],
			},
			{
				id: "movement",
				title: "Implement movement first",
				code: { title: "Minimal third-person movement", language: "typescript", code: thirdPersonCode },
				paragraphs: [
					"For production, rotate input by the camera heading, add acceleration/deceleration, grounded probing, jump and gravity, slope handling, coyote time, and a state-driven movement lock. Keep camera code separate from motor code.",
				],
			},
			{
				id: "animation",
				title: "Connect the Animator",
				steps: [
					"Create a locomotion blend tree driven by planar speed.",
					"Set Grounded and vertical velocity parameters every simulation step.",
					"Trigger jump, attack, hit reaction, and death from gameplay state.",
					"Use an upper-body layer and avatar mask if attacking while moving.",
					"Use animation events only to signal presentation-aligned moments; authoritative damage still validates range, direction, team, and attack state.",
				],
				figure: {
					src: "/documentation/tutorials/animator.png",
					alt: "Animator graph for a character",
					caption: "Use a locomotion base layer, masked action layers, explicit parameters, and runtime transition debugging.",
				},
			},
			{
				id: "enemy",
				title: "Add one complete enemy",
				steps: [
					"Create a behavior tree: Patrol → Investigate → Chase → Attack → Return.",
					"Use a Nav agent for path following and a separate facing controller for combat.",
					"Give the enemy perception distance, field of view, lost-target time, attack range, cooldown, health, and stagger controls.",
					"Publish damage and death events to VFX, audio, Animator, UI, and score systems.",
					"Test obstructed paths, moving obstacles, unreachable targets, and player death/restart.",
				],
			},
			{
				id: "completion",
				title: "Complete the game loop",
				bullets: [
					"Add lock-on or aim assistance, reticle, health/stamina UI, pause, settings, and controls screen.",
					"Add a checkpoint that restores player/enemy/world state predictably.",
					"Use ragdoll or authored death—not both simultaneously without an explicit handoff.",
					"Profile navigation, animation, skinning, shadows, VFX, and script update costs.",
					"Build and play the packaged target from start through checkpoint and victory/defeat.",
				],
			},
		],
	},
	{
		slug: "2d-platformer",
		group: "Build complete games",
		title: "Build a 2D platformer",
		summary: "Import sprites, configure pixel-perfect rendering, tile a level, add 2D physics, animation, cameras, UI, and a build.",
		level: "Intermediate",
		duration: "2–4 hours",
		prerequisites: ["Sprite sheet, tileset, and basic TypeScript"],
		outcomes: ["Configure PNG assets as sprites", "Build a tile-based physics level", "Create a complete platformer loop"],
		sections: [
			{
				id: "sprites",
				title: "Import PNG assets correctly",
				steps: [
					"Import the PNG and set Texture Type to Sprite or Sprite Sheet.",
					"Choose point sampling for pixel art, disable mipmaps where appropriate, and preserve source alpha.",
					"Set pixels-per-unit consistently across characters, tiles, props, and collision sizes.",
					"Slice the sheet using a fixed cell size or explicit rectangles; name frames by animation and order.",
					"Create sorting layers such as Background, World, Player, Effects, and Foreground.",
				],
				note: "The importer converts source PNG pixels into runtime texture/bitmap data during the asset pipeline. Keep the original PNG as the editable source of truth.",
				figure: {
					src: "/documentation/sprites/using-sprite-manager/spritesheet-detected.png",
					alt: "Detected sprite sheet frames",
					caption: "Verify detected cells, names, pivots, alpha, and pixels-per-unit before building animations or tile palettes.",
				},
			},
			{
				id: "level",
				title: "Build the level",
				steps: [
					"Create a tile palette from the tileset.",
					"Paint background and collision layers separately.",
					"Generate tile colliders and merge static neighbors with a composite collider.",
					"Place spawn, checkpoints, hazards, collectibles, enemies, and finish trigger.",
					"Use an orthographic camera and verify the pixel-perfect scale at target resolutions.",
				],
			},
			{
				id: "controller",
				title: "Add 2D movement",
				code: { title: "Minimal physics-based player", language: "typescript", code: platformerCode },
				paragraphs: [
					"A production controller should use a grounded contact or shape cast rather than vertical velocity alone, then add coyote time, buffered jump, variable jump height, slopes, moving platforms, and deterministic respawn.",
				],
			},
			{
				id: "loop",
				title: "Finish and verify",
				steps: [
					"Create Idle, Run, Jump, Fall, Land, Hurt, and Death sprite animations.",
					"Add coins, damage, health/lives, checkpoint, timer, pause, and finish UI.",
					"Test every platform edge, wall, slope, hazard, and moving platform at low and high frame rates.",
					"Check sorting and camera framing at every supported aspect ratio.",
					"Build Web/PWA, load it offline if promised, and complete the level in the production build.",
				],
			},
		],
	},
	{
		slug: "mcp-guide",
		group: "AI and MCP",
		title: "MCP architecture and setup",
		summary: "Connect Codex or Claude-compatible clients to the live editor and understand tools, leases, confirmations, and verification.",
		level: "Intermediate",
		duration: "40 minutes",
		prerequisites: ["Repository dependencies installed", "Zvibe Editor project window running", "Node.js 20 or newer"],
		outcomes: ["Connect an external AI client", "Understand the MCP execution path", "Use write tools safely and verify results"],
		sections: [
			{
				id: "architecture",
				title: "How MCP works",
				paragraphs: [
					"The AI client starts the project-local MCP server over standard input/output. The server validates the tool name and closed input schema, then sends a loopback request to the running Electron editor. The editor action changes the same in-memory scene/project state used by the UI and returns structured evidence.",
				],
				table: {
					headers: ["Layer", "Responsibility"],
					rows: [
						["Codex CLI / Claude-compatible client", "Plans work, calls tools, reads structured results and images"],
						["mcp/server/index.mjs", "Publishes 1,722 tools, validates schemas, annotations, bounds, and protocol"],
						["Loopback editor bridge", "Routes requests only to the local running project window"],
						["Editor MCP actions", "Use the editor's authoritative scene, asset, project, runtime, and UI owners"],
						["Readback and screenshots", "Prove the resulting state instead of assuming a write succeeded"],
					],
				},
			},
			{
				id: "configure",
				title: "Configure a client",
				paragraphs: ["Build or bundle the MCP workspace first. For a repository-local client configuration, point the stdio command at the bundled server."],
				code: { title: ".mcp.json", language: "json", code: mcpConfigCode },
			},
			{
				id: "codex",
				title: "Codex CLI configuration",
				code: {
					title: ".codex/config.toml equivalent",
					language: "bash",
					code: `[mcp_servers.zvibe-editor]
command = "node"
args = ["mcp/server/index.mjs"]
cwd = "."
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 120
default_tools_approval_mode = "writes"`,
				},
				steps: [
					"Open the project repository as the client working directory.",
					"Start Zvibe Editor and open the exact project window you intend to modify.",
					"Ask the client to call get_editor_status before any scene write.",
					"Confirm the returned project and scene paths.",
					"Begin with scene workspace and hierarchy reads; then make bounded writes and reread.",
				],
			},
			{
				id: "safety",
				title: "Leases, confirmation, and atomic work",
				bullets: [
					"Exact revision or fingerprint leases prevent an AI from overwriting state that changed after it was inspected.",
					"Destructive tools require literal confirmation and often the current lease.",
					"Closed schemas reject unknown fields before they reach the editor.",
					"execute_batch groups compatible operations and reports per-operation evidence.",
					"Project-contained paths, size limits, pagination, and regular-file checks constrain file operations.",
					"Instances are preferred over clones for repeated content; glTF scaling and centimeter conventions must be respected.",
				],
				warning: "Never bypass a stale lease by guessing a new revision. Reread the authoritative state, understand the intervening change, then form a new operation.",
			},
			{
				id: "verify",
				title: "The required MCP verification loop",
				steps: [
					"Read get_editor_status and confirm project identity.",
					"Read hierarchy/workspace and the target object's current state.",
					"Call one bounded write or a deliberate atomic batch.",
					"Reread the modified resource and compare exact identifiers and values.",
					"Run scene diagnostics and script diagnostics.",
					"Capture an editor or runtime screenshot for visual work.",
					"Save, reload when persistence matters, and reread again.",
					"Run the project, exercise gameplay, collect diagnostics/profiler evidence, then stop it.",
					"Build and launch the target artifact when the requested outcome includes delivery.",
				],
			},
		],
	},
	{
		slug: "mcp-game-workflow",
		group: "AI and MCP",
		title: "Build and verify a game through MCP",
		summary: "A prompt-and-tool workflow for creating a complete playable scene without editing the game directory directly.",
		level: "Advanced",
		duration: "90 minutes",
		prerequisites: ["MCP architecture and setup", "A disposable project", "Editor and MCP server running"],
		outcomes: ["Plan an MCP-only game change", "Compose scene and scripts through tools", "Prove persistence, gameplay, and build output"],
		sections: [
			{
				id: "contract",
				title: "Give the AI a verifiable contract",
				paragraphs: [
					"Describe the playable loop, visual target, controls, pass criteria, target platform, and the restriction that all game edits must flow through MCP. Ambiguous requests produce ambiguous games.",
				],
				code: {
					title: "Example task prompt",
					language: "bash",
					code: `Build a small neon checkpoint racer in the currently open disposable project.
Use only Zvibe Editor MCP tools for game-project changes.
Required: visible player car, three checkpoints, one lap, WASD controls,
chase camera, speed/lap HUD, lit track, restart, Web release profile.
After each write, reread the authoritative state. Then save, reload, run,
capture a runtime screenshot, inspect diagnostics, build Web, and report evidence.`,
				},
			},
			{
				id: "discover",
				title: "1. Discover before writing",
				steps: [
					"Call get_editor_status.",
					"Call get_scene_workspace and get_scene_hierarchy with bounded pages.",
					"List assets and inspect candidate model/material metadata.",
					"Read rendering, physics, input, build, and script state relevant to the game.",
					"Record exact stable IDs, revisions, scene path, units, and current diagnostics.",
				],
			},
			{
				id: "compose",
				title: "2. Compose in coherent batches",
				steps: [
					"Create named roots and gameplay primitives or instantiate imported assets.",
					"Create/assign materials, lights, environment, camera, and render profile.",
					"Create colliders, triggers, vehicle or movement configuration, checkpoints, and spawn points.",
					"Create UI controls and bindings.",
					"Write TypeScript through the script-authoring tool, inspect semantic diagnostics, attach the script, and set exported values.",
					"After every batch, reread the hierarchy and domain state; stop immediately on partial or ambiguous evidence.",
				],
				note: "Use small batches with one responsibility. A hundred unrelated operations are harder to diagnose and roll back than ten coherent batches.",
			},
			{
				id: "test",
				title: "3. Test the real loop",
				steps: [
					"Save the scene and project through MCP.",
					"Reload or reopen the scene and prove key nodes/components still exist.",
					"Run the project through MCP and wait for ready status.",
					"Capture a screenshot and inspect whether the player, track, lighting, camera, and HUD are readable.",
					"Use runtime diagnostics, scene tests, profiler captures, and input/device simulation where available.",
					"Stop the project cleanly; fix failures through MCP and repeat the complete loop.",
				],
				figure: {
					src: "/documentation/tutorials/profiler.png",
					alt: "Zvibe Editor profiler workspace",
					caption: "Performance evidence is part of completion, not an optional final polish step.",
				},
			},
			{
				id: "ship",
				title: "4. Build and hand off evidence",
				steps: [
					"Create or update the target build profile with an exact lease.",
					"Validate the profile and resolve blocking diagnostics.",
					"Invoke the build and poll structured status until success or actionable failure.",
					"Launch/serve the artifact and repeat the core playable loop.",
					"Report changed scene/assets/scripts/settings, exact tests, screenshots, diagnostics, build path, known limitations, and cleanup.",
				],
			},
			{
				id: "bad-signals",
				title: "Reject false completion",
				bullets: [
					"A tool returned success, but no readback was performed.",
					"The scene looks correct in edit mode, but the project was never run.",
					"The project ran, but the requested gameplay loop was not exercised.",
					"A screenshot exists, but the important subject is dark, off-camera, or hidden by UI.",
					"Unit tests passed, but the packaged target was not launched.",
					"The AI changed source files directly even though the task required MCP-only project edits.",
				],
			},
		],
	},
];

export function getTutorial(slug: string): ITutorial | undefined {
	return tutorials.find((tutorial) => tutorial.slug === slug);
}
