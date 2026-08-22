import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { afterEach, describe, expect, test } from "vitest";

import { discoverInstalledEditorExtensions, inspectInstalledEditorExtension } from "../../src/extensions/discovery";
import { editorExtensionFingerprint, normalizeEditorExtensionManifest } from "../../src/extensions/manifest";
import { getEditorExtensionTrustRecord, readEditorExtensionTrustRecords, revokeEditorExtensionTrust, trustEditorExtension } from "../../src/extensions/trust";
import { IEditorExtensionTrustStorage } from "../../src/extensions/types";

const roots: string[] = [];
const packageManagerFingerprint = "a".repeat(64);

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		apiVersion: 1,
		id: "com.example.tools",
		displayName: "Example Tools",
		description: "Test extension",
		capabilities: ["inspectors", "windows", "menus", "tests", "buildProfiles"],
		contributes: {
			inspectors: [{ id: "com.example.tools.inspector", title: "Example", priority: 10 }],
			windows: [{ id: "com.example.tools.window", title: "Example Window", neighborId: "inspector" }],
			menus: [{ id: "com.example.tools.open", path: "Example/Open Window" }],
			tests: [{ id: "com.example.tools.test", title: "Smoke" }],
			buildProfileFooterActions: [
				{ id: "com.example.tools.build", title: "Audit Build", description: "Audit the selected profile", order: 20, targets: ["web", "ios"], activeProfileOnly: true },
			],
		},
		...overrides,
	};
}

async function projectWithExtension(packageName = "example-extension", packageOverrides: Record<string, unknown> = {}): Promise<{ projectRoot: string; packageRoot: string }> {
	const projectRoot = await mkdtemp(join(tmpdir(), "zvibe-extension-"));
	roots.push(projectRoot);
	const packageRoot = join(projectRoot, "node_modules", ...packageName.split("/"));
	await mkdir(packageRoot, { recursive: true });
	await writeFile(join(packageRoot, "index.js"), "exports.activate = () => undefined;\n");
	await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version: "1.2.3", main: "index.js", zvibeEditor: manifest(), ...packageOverrides }));
	return { projectRoot, packageRoot };
}

function storage(initial?: string): IEditorExtensionTrustStorage & { value: string | null } {
	return {
		value: initial ?? null,
		getItem(): string | null {
			return this.value;
		},
		setItem(_key: string, value: string): void {
			this.value = value;
		},
	};
}

describe("editor extension manifest, discovery, and trust", () => {
	test("normalizes a complete bounded manifest deterministically", () => {
		const normalized = normalizeEditorExtensionManifest(manifest());
		expect(normalized).toMatchObject({ apiVersion: 1, id: "com.example.tools", capabilities: ["inspectors", "windows", "menus", "tests", "buildProfiles"] });
		expect(normalized.contributes.windows[0]).toMatchObject({ id: "com.example.tools.window", neighborId: "inspector" });
		expect(normalized.contributes.buildProfileFooterActions[0]).toMatchObject({ id: "com.example.tools.build", targets: ["web", "ios"], activeProfileOnly: true });
		expect(editorExtensionFingerprint({ b: 2, a: 1 })).toBe(editorExtensionFingerprint({ a: 1, b: 2 }));
	});

	test("rejects unknown fields, duplicate ids, undeclared capabilities, and unsafe menu paths", () => {
		expect(() => normalizeEditorExtensionManifest({ ...manifest(), unknown: true })).toThrow("unsupported field");
		expect(() => normalizeEditorExtensionManifest(manifest({ capabilities: ["windows", "menus", "tests", "buildProfiles"] }))).toThrow('Capability "inspectors"');
		const duplicate = manifest() as any;
		duplicate.contributes.menus[0].id = "com.example.tools.window";
		expect(() => normalizeEditorExtensionManifest(duplicate)).toThrow("unique");
		const unsafePath = manifest() as any;
		unsafePath.contributes.menus[0].path = "One/Two/Three/Four/Five";
		expect(() => normalizeEditorExtensionManifest(unsafePath)).toThrow("1–4");
		unsafePath.contributes.menus[0].path = "One/Two\u0001";
		expect(() => normalizeEditorExtensionManifest(unsafePath)).toThrow("1–4");
		const unsupportedTarget = manifest() as any;
		unsupportedTarget.contributes.buildProfileFooterActions[0].targets = ["console"];
		expect(() => normalizeEditorExtensionManifest(unsupportedTarget)).toThrow("unsupported");
	});

	test("discovers installed and hoisted scoped packages with exact file fingerprints", async () => {
		const { projectRoot } = await projectWithExtension("@example/editor-tools");
		const nestedProject = join(projectRoot, "packages", "game");
		await mkdir(nestedProject, { recursive: true });
		const extension = await inspectInstalledEditorExtension(nestedProject, "@example/editor-tools", packageManagerFingerprint);
		expect(extension).toMatchObject({ packageName: "@example/editor-tools", packageVersion: "1.2.3", contentFileCount: 2, manifest: { id: "com.example.tools" } });
		expect(extension?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
		await writeFile(extension!.entryPath, "exports.activate = () => 2;\n");
		const changed = await inspectInstalledEditorExtension(nestedProject, "@example/editor-tools", packageManagerFingerprint);
		expect(changed?.fingerprint).not.toBe(extension?.fingerprint);
		await writeFile(join(extension!.packageRoot, "helper.js"), "module.exports = 1;\n");
		const helperChanged = await inspectInstalledEditorExtension(nestedProject, "@example/editor-tools", packageManagerFingerprint);
		expect(helperChanged?.fingerprint).not.toBe(changed?.fingerprint);
	});

	test("isolates malformed packages as discovery issues and rejects entry traversal", async () => {
		const { projectRoot } = await projectWithExtension();
		await projectWithExtension("unused");
		const outside = join(projectRoot, "outside.js");
		await writeFile(outside, "module.exports = {};\n");
		await writeFile(
			join(projectRoot, "node_modules", "example-extension", "package.json"),
			JSON.stringify({ name: "example-extension", version: "1.2.3", main: "../../outside.js", zvibeEditor: manifest() })
		);
		const result = await discoverInstalledEditorExtensions(projectRoot, ["missing", "example-extension"], packageManagerFingerprint);
		expect(result.extensions).toEqual([]);
		expect(result.issues).toHaveLength(2);
		expect(result.issues.find((issue) => issue.packageName === "example-extension")?.message).toContain("escapes");
	});

	test("supports package-manager workspace symlinks but refuses entry symlink escape", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "zvibe-extension-link-"));
		roots.push(projectRoot);
		const workspacePackage = join(projectRoot, "packages", "extension");
		await mkdir(workspacePackage, { recursive: true });
		await mkdir(join(projectRoot, "node_modules"), { recursive: true });
		await writeFile(join(workspacePackage, "index.js"), "exports.activate = () => undefined;\n");
		await writeFile(join(workspacePackage, "package.json"), JSON.stringify({ name: "linked-extension", version: "1.0.0", main: "index.js", zvibeEditor: manifest() }));
		await symlink(workspacePackage, join(projectRoot, "node_modules", "linked-extension"), "dir");
		expect((await inspectInstalledEditorExtension(projectRoot, "linked-extension", packageManagerFingerprint))?.manifest.id).toBe("com.example.tools");
		await rm(join(workspacePackage, "index.js"));
		await writeFile(join(projectRoot, "outside.js"), "module.exports = {};\n");
		await symlink(join(projectRoot, "outside.js"), join(workspacePackage, "index.js"));
		await expect(inspectInstalledEditorExtension(projectRoot, "linked-extension", packageManagerFingerprint)).rejects.toThrow("outside");
	});

	test("grants exact local trust and invalidates it after code or capability changes", async () => {
		const { projectRoot } = await projectWithExtension();
		const extension = (await inspectInstalledEditorExtension(projectRoot, "example-extension", packageManagerFingerprint))!;
		const values = storage();
		expect(getEditorExtensionTrustRecord(values, extension)).toBeNull();
		expect(() => trustEditorExtension(values, extension, ["windows"])).toThrow("exactly match");
		const trusted = trustEditorExtension(values, extension, extension.manifest.capabilities);
		expect(getEditorExtensionTrustRecord(values, extension)).toEqual(trusted);
		const dependencyGraphChanged = (await inspectInstalledEditorExtension(projectRoot, "example-extension", "b".repeat(64)))!;
		expect(getEditorExtensionTrustRecord(values, dependencyGraphChanged)).toBeNull();
		await writeFile(extension.entryPath, "exports.activate = () => 3;\n");
		const changed = (await inspectInstalledEditorExtension(projectRoot, "example-extension", packageManagerFingerprint))!;
		expect(getEditorExtensionTrustRecord(values, changed)).toBeNull();
		expect(revokeEditorExtensionTrust(values, "example-extension")).toBe(true);
		expect(revokeEditorExtensionTrust(values, "example-extension")).toBe(false);
	});

	test("bounds package traversal depth and produces deterministic concurrent results", async () => {
		const { projectRoot, packageRoot } = await projectWithExtension();
		let directory = packageRoot;
		for (let index = 0; index < 33; index++) {
			directory = join(directory, `level-${index}`);
			await mkdir(directory);
		}
		await expect(inspectInstalledEditorExtension(projectRoot, "example-extension", packageManagerFingerprint)).rejects.toThrow("32-level");
		await rm(join(packageRoot, "level-0"), { recursive: true });
		const fingerprints = await Promise.all(
			Array.from({ length: 24 }, async () => (await inspectInstalledEditorExtension(projectRoot, "example-extension", packageManagerFingerprint))?.fingerprint)
		);
		expect(new Set(fingerprints)).toHaveLength(1);
	});

	test("fails closed on malformed or oversized trust stores", () => {
		expect(readEditorExtensionTrustRecords(storage("not-json"))).toEqual([]);
		expect(readEditorExtensionTrustRecords(storage(JSON.stringify({ version: 1, records: Array.from({ length: 257 }, () => ({})) })))).toEqual([]);
		expect(readEditorExtensionTrustRecords(storage(" ".repeat(1024 * 1024 + 1)))).toEqual([]);
		expect(
			readEditorExtensionTrustRecords(
				storage(
					JSON.stringify({
						version: 1,
						records: [{ packageName: "../escape", extensionId: "invalid", fingerprint: "a".repeat(64), capabilities: [], trustedAt: new Date().toISOString() }],
					})
				)
			)
		).toEqual([]);
	});

	test("rejects malformed discovery inputs and non-canonical package versions", async () => {
		const { projectRoot } = await projectWithExtension("versioned-extension", { version: "v1.2.3" });
		await expect(inspectInstalledEditorExtension(projectRoot, "versioned-extension", packageManagerFingerprint)).rejects.toThrow("exact semantic version");
		await expect(discoverInstalledEditorExtensions(projectRoot, [12 as unknown as string], packageManagerFingerprint)).rejects.toThrow("Invalid package name");
		await expect(discoverInstalledEditorExtensions(projectRoot, [], "stale")).rejects.toThrow("packageManagerFingerprint");
		expect(() => editorExtensionFingerprint(undefined)).toThrow("JSON-serializable");
	});
});
