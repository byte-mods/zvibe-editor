#!/usr/bin/env node
/**
 * End-to-end play-test of the production Orb Rush build in headless Chromium with real keyboard input.
 * Usage: node playtest.mjs <dist-directory> <screenshot-directory>
 */
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const [distDirectory, shotDirectory] = process.argv.slice(2);
await mkdir(shotDirectory, { recursive: true });

const mime = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".wasm": "application/wasm",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".wav": "audio/wav",
	".env": "application/octet-stream",
};
const server = createServer(async (request, response) => {
	const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
	const file = normalize(join(distDirectory, path.endsWith("/") ? `${path}index.html` : path));
	try {
		const body = await readFile(file);
		response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
		response.end(body);
	} catch {
		response.writeHead(404);
		response.end();
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
// Serve under a sub-path to prove the build works when hosted in a folder (itch.io, GitHub Pages).
const url = `http://127.0.0.1:${server.address().port}/`;

const results = [];
const check = (name, ok, detail = "") => {
	results.push({ name, ok: !!ok, detail });
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM_PATH,
	args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
const failedRequests = [];
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
	if (message.type() === "error") errors.push(`console: ${message.text()} @ ${message.location()?.url ?? "?"}`);
});
page.on("requestfailed", (request) => failedRequests.push(`${request.url()} ${request.failure()?.errorText}`));
page.on("response", (response) => {
	if (response.status() >= 400) failedRequests.push(`${response.url()} HTTP ${response.status()}`);
});

const state = () =>
	page.evaluate(() => {
		const scene = window.__orbRushScene;
		const player = scene.getMeshByName("Player");
		const texts = scene.textures
			.filter((texture) => texture.getClassName?.() === "AdvancedDynamicTexture")
			.flatMap((hud) => hud.getDescendants(false).filter((control) => control.getClassName() === "TextBlock" && control.isVisible && (control.parent?.isVisible ?? true)))
			.map((control) => control.text);
		const panel = scene.textures.find((texture) => texture.getClassName?.() === "AdvancedDynamicTexture")?.getControlByName("panel");
		const gems = scene.meshes.filter((mesh) => mesh.name.startsWith("Gem"));
		const crates = scene.meshes.filter((mesh) => mesh.name.startsWith("Crate"));
		const sounds = scene.transformNodes.filter((node) => node.isSoundNode);
		const arm = scene.getMeshByName("Sweeper Arm");
		const velocity = player.physicsBody?.getLinearVelocity();
		return {
			fps: scene.getEngine().getFps(),
			physics: !!scene.getPhysicsEngine(),
			player: player.absolutePosition.asArray().map((value) => Math.round(value)),
			speed: velocity ? Math.round(velocity.length()) : null,
			gemsEnabled: gems.filter((gem) => gem.isEnabled()).length,
			gemsTotal: gems.length,
			crates: crates.map((crate) => crate.absolutePosition.asArray().map((value) => Math.round(value))),
			crateBodies: crates.filter((crate) => crate.physicsBody).length,
			armRotation: arm?.rotationQuaternion ? arm.rotationQuaternion.toEulerAngles().y : null,
			panelVisible: panel?.isVisible ?? null,
			texts,
			sounds: sounds.map((node) => ({ name: node.name, loaded: !!node.sound, playing: node.isPlaying?.() ?? false })),
			audioState: scene.getEngine().constructor.audioEngine?.audioContext?.state ?? null,
			camera: scene.activeCamera?.position.asArray().map((value) => Math.round(value)),
		};
	});

const teleport = (position) =>
	page.evaluate((target) => {
		const scene = window.__orbRushScene;
		const player = scene.getMeshByName("Player");
		const body = player.physicsBody;
		body.disablePreStep = false;
		player.position.set(target[0], target[1], target[2]);
		body.setLinearVelocity(player.position.scale(0));
		scene.onAfterPhysicsObservable.addOnce(() => scene.onAfterPhysicsObservable.addOnce(() => (body.disablePreStep = true)));
	}, position);

const wait = (ms) => page.waitForTimeout(ms);
// Waits for rendered frames rather than wall time, so slow software rendering doesn't change the outcome.
const frames = (count) =>
	page.evaluate(
		(n) =>
			new Promise((resolve) => {
				const scene = window.__orbRushScene;
				let seen = 0;
				const observer = scene.onAfterRenderObservable.add(() => {
					if (++seen >= n) {
						observer.remove();
						resolve(seen);
					}
				});
			}),
		count
	);

try {
	const started = Date.now();
	await page.goto(`${url}?debug`, { waitUntil: "load" });
	await page.waitForFunction(() => window.__orbRushScene?.isReady?.() && window.__orbRushScene.getMeshByName("Player"), null, { timeout: 120_000 });
	await wait(3000);
	check("Production build loads and the scene becomes ready", true, `${((Date.now() - started) / 1000).toFixed(1)}s`);

	let s = await state();
	check("Havok physics is running with all crate bodies", s.physics && s.crateBodies === 20, `${s.crateBodies} crate bodies`);
	check("All 12 gems are present", s.gemsTotal === 12 && s.gemsEnabled === 12);
	check("Title screen is shown", s.panelVisible && s.texts.some((text) => text.includes("ORB RUSH")), s.texts.join(" | "));
	check("All 10 sound nodes loaded their audio", s.sounds.length === 10 && s.sounds.every((sound) => sound.loaded), JSON.stringify(s.sounds.filter((sound) => !sound.loaded)));
	await page.screenshot({ path: join(shotDirectory, "1-title.png") });

	// Start the run with a real key press (also the user gesture that unlocks audio).
	await page.locator("canvas").click({ position: { x: 320, y: 200 } });
	await page.keyboard.press("Enter");
	await wait(1500);
	s = await state();
	check("Enter starts the run and hides the title panel", !s.panelVisible, s.texts.join(" | "));
	check("Music is playing after the start gesture", s.sounds.find((sound) => sound.name === "Music")?.playing, `audio=${s.audioState}`);
	const armBefore = s.armRotation;

	const startPosition = s.player;
	await page.keyboard.down("KeyW");
	await frames(60);
	s = await state();
	await page.keyboard.up("KeyW");
	check("Holding W rolls the orb forward with physics forces", s.player[2] - startPosition[2] > 300, `z ${startPosition[2]} → ${s.player[2]}, speed ${s.speed} cm/s`);
	check("The follow camera tracks the orb inside the arena", Math.abs(s.camera[2]) <= 2120 && s.camera[2] < s.player[2], `camera ${s.camera} player ${s.player}`);
	check("The sweeper hazard spins", s.armRotation !== null && Math.abs(s.armRotation - armBefore) > 0.1, `${armBefore?.toFixed(2)} → ${s.armRotation?.toFixed(2)}`);
	await page.screenshot({ path: join(shotDirectory, "2-rolling.png") });

	// Jump: sample the height while in the air.
	await frames(40);
	const groundY = (await state()).player[1];
	await page.keyboard.press("Space");
	let peak = groundY;
	for (let i = 0; i < 12; i++) {
		await frames(2);
		peak = Math.max(peak, (await state()).player[1]);
	}
	check("Space makes the orb jump", peak - groundY > 80, `y ${groundY} → peak ${peak}`);

	// Physics interaction: launch the orb into the east crate pyramid.
	const cratesBefore = (await state()).crates;
	await teleport([1300, 55, -1500]);
	await frames(10);
	await page.evaluate(() =>
		window.__orbRushScene.getMeshByName("Player").physicsBody.setLinearVelocity(new (window.__orbRushScene.getMeshByName("Player").position.constructor)(0, 0, 1400))
	);
	await frames(60);
	const cratesAfter = (await state()).crates;
	const moved = cratesAfter.filter((position, index) => Math.hypot(...position.map((value, axis) => value - cratesBefore[index][axis])) > 40).length;
	check("Crates are knocked over by the orb (dynamic physics)", moved >= 3, `${moved} crates moved`);
	await page.screenshot({ path: join(shotDirectory, "3-crates.png") });

	// Collection: visit every gem.
	const gemPositions = await page.evaluate(() =>
		window.__orbRushScene.meshes.filter((mesh) => mesh.name.startsWith("Gem") && mesh.isEnabled()).map((mesh) => mesh.absolutePosition.asArray())
	);
	for (const [index, position] of gemPositions.entries()) {
		// Gems in the sweeper's path can be knocked out of reach, so retry like a player would.
		for (let attempt = 0; attempt < 4; attempt++) {
			const before = (await state()).gemsEnabled;
			await teleport([position[0], position[1] + 10, position[2]]);
			await frames(6);
			if ((await state()).gemsEnabled < before) break;
		}
		if (index === 5) {
			s = await state();
			check(
				"HUD gem counter updates while collecting",
				s.texts.some((text) => /◆ \d+ \/ 12/.test(text) && !text.startsWith("◆ 0 ")),
				s.texts.join(" | ")
			);
		}
	}
	await frames(10);
	s = await state();
	check("Collecting all 12 gems wins the game", s.gemsEnabled === 0 && s.texts.some((text) => text.includes("YOU WIN")), s.texts.join(" | "));
	await page.screenshot({ path: join(shotDirectory, "4-win.png") });

	// Restart resets gems and crates.
	await page.keyboard.press("Enter");
	await frames(20);
	s = await state();
	const deviations = s.crates.map((position, index) => Math.round(Math.hypot(...position.map((value, axis) => value - cratesBefore[index][axis]))));
	const cratesReset = deviations.every((deviation) => deviation < 30);
	check("Enter restarts: gems and crates are reset", s.gemsEnabled === 12 && cratesReset && !s.panelVisible, `gems ${s.gemsEnabled}, crate deviations ${deviations.join(",")}`);
	await page.screenshot({ path: join(shotDirectory, "5-restart.png") });

	s = await state();
	check("Frame rate is measurable (software renderer)", s.fps > 1, `${s.fps.toFixed(1)} fps on SwiftShader`);
	check("No runtime errors", errors.length === 0, errors.slice(0, 5).join(" || "));
	check("No failed network requests", failedRequests.length === 0, failedRequests.slice(0, 5).join(" || "));
} catch (error) {
	check("Play-test completed without exceptions", false, error instanceof Error ? error.message : String(error));
	await page.screenshot({ path: join(shotDirectory, "error.png") }).catch(() => undefined);
	console.log(errors.slice(0, 10).join("\n"));
} finally {
	await browser.close();
	server.close();
	const failed = results.filter((result) => !result.ok);
	console.log(JSON.stringify({ verdict: failed.length ? "FAIL" : "PASS", passed: results.length - failed.length, total: results.length }));
	process.exitCode = failed.length ? 1 : 0;
}
