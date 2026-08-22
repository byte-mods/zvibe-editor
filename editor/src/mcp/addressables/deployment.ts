import { createHash } from "crypto";
import { dirname, extname, isAbsolute, join, normalize } from "path/posix";
import { ensureDir, move, pathExists, readFile, readJSON, readdir, writeFile, writeJSON } from "fs-extra";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { getAddressableCatalogHashPayload, IAddressableCatalog, IAddressableDeploymentTarget } from "babylonjs-editor-tools";

import { IAddressableBuildArtifact, IAddressableBuildReport } from "./content";

export interface IAddressableDeploymentReceipt {
	version: 1;
	deploymentId: string;
	targetId: string;
	targetName: string;
	provider: IAddressableDeploymentTarget["provider"];
	buildId: string;
	catalogHash: string;
	startedAt: string;
	completedAt: string;
	fileCount: number;
	uploadedBytes: number;
	pointerPath: string;
	pointerPublishedLast: true;
	verified: boolean;
}

interface IDeploymentStorage {
	put(path: string, bytes: Buffer, hash: string, pointer: boolean): Promise<void>;
	get(path: string): Promise<Buffer>;
}

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function safeRelativePath(value: string): string {
	const result = normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
	if (!result || result === "." || result.startsWith("/") || /^[A-Za-z]:\//.test(result) || result.split("/").includes("..")) {
		throw new Error(`Addressables deployment path is unsafe: ${value}`);
	}
	return result;
}

function projectPath(projectDirectory: string, value: string): string {
	const result = normalize(isAbsolute(value) ? value : join(projectDirectory, value));
	if (result !== projectDirectory && !result.startsWith(`${projectDirectory}/`)) {
		throw new Error(`Addressables build report must stay inside the open project: ${value}`);
	}
	return result;
}

function joinUrl(base: string, value: string): string {
	return new URL(value.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`).toString();
}

function normalizedPublicUrl(value: string): string {
	return new URL(value).toString().replace(/\/$/, "");
}

function contentType(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".json") {
		return "application/json";
	}
	if (extension === ".hash" || extension === ".txt") {
		return "text/plain; charset=utf-8";
	}
	return "application/octet-stream";
}

function createFilesystemStorage(projectDirectory: string, target: Extract<IAddressableDeploymentTarget, { provider: "filesystem" }>): IDeploymentStorage {
	const root = normalize(isAbsolute(target.destinationPath) ? target.destinationPath : join(projectDirectory, target.destinationPath));
	const resolve = (value: string): string => {
		const result = join(root, safeRelativePath(value));
		if (result !== root && !result.startsWith(`${root}/`)) {
			throw new Error(`Addressables deployment escaped its filesystem root: ${value}`);
		}
		return result;
	};
	return {
		async put(path, bytes, _hash, pointer): Promise<void> {
			const destination = resolve(path);
			await ensureDir(dirname(destination));
			if (pointer) {
				const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
				await writeFile(temporary, bytes);
				await move(temporary, destination, { overwrite: true });
			} else {
				const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
				await writeFile(temporary, bytes);
				await move(temporary, destination, { overwrite: true });
			}
		},
		async get(path): Promise<Buffer> {
			return readFile(resolve(path));
		},
	};
}

function createHttpStorage(target: Extract<IAddressableDeploymentTarget, { provider: "http" }>): IDeploymentStorage {
	const authorization = target.authorizationEnvironment ? process.env[target.authorizationEnvironment] : undefined;
	if (target.authorizationEnvironment && !authorization) {
		throw new Error(`Addressables HTTP authorization environment variable is not defined: ${target.authorizationEnvironment}`);
	}
	const request = async (method: "GET" | "PUT", path: string, bytes?: Buffer, hash?: string): Promise<Response> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 120_000);
		try {
			return await fetch(joinUrl(target.baseUrl, safeRelativePath(path)), {
				method,
				headers: {
					...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
					...(bytes ? { "Content-Type": contentType(path), "X-Content-SHA256": hash ?? sha256(bytes) } : {}),
				},
				body: bytes ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) : undefined,
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeout);
		}
	};
	return {
		async put(path, bytes, hash): Promise<void> {
			const response = await request("PUT", path, bytes, hash);
			if (!response.ok) {
				throw new Error(`Addressables HTTP upload failed for ${path}: ${response.status} ${response.statusText}`);
			}
		},
		async get(path): Promise<Buffer> {
			const response = await request("GET", path);
			if (!response.ok) {
				throw new Error(`Addressables HTTP verification failed for ${path}: ${response.status} ${response.statusText}`);
			}
			return Buffer.from(await response.arrayBuffer());
		},
	};
}

function createS3Storage(target: Extract<IAddressableDeploymentTarget, { provider: "s3" }>): IDeploymentStorage {
	const accessKeyId = process.env[target.accessKeyIdEnvironment];
	const secretAccessKey = process.env[target.secretAccessKeyEnvironment];
	const sessionToken = target.sessionTokenEnvironment ? process.env[target.sessionTokenEnvironment] : undefined;
	if (!accessKeyId || !secretAccessKey) {
		throw new Error(`Addressables S3 credentials are missing from ${target.accessKeyIdEnvironment} / ${target.secretAccessKeyEnvironment}.`);
	}
	const client = new S3Client({
		region: target.region,
		endpoint: target.endpoint,
		credentials: { accessKeyId, secretAccessKey, sessionToken },
	});
	const key = (path: string): string => [target.keyPrefix.replace(/^\/+|\/+$/g, ""), safeRelativePath(path)].filter(Boolean).join("/");
	return {
		async put(path, bytes, hash): Promise<void> {
			await client.send(
				new PutObjectCommand({
					Bucket: target.bucket,
					Key: key(path),
					Body: bytes,
					ContentType: contentType(path),
					Metadata: { sha256: hash },
				})
			);
		},
		async get(path): Promise<Buffer> {
			const result = await client.send(new GetObjectCommand({ Bucket: target.bucket, Key: key(path) }));
			if (!result.Body) {
				throw new Error(`Addressables S3 verification returned no body for ${path}.`);
			}
			return Buffer.from(await result.Body.transformToByteArray());
		},
	};
}

function createStorage(projectDirectory: string, target: IAddressableDeploymentTarget): IDeploymentStorage {
	switch (target.provider) {
		case "filesystem":
			return createFilesystemStorage(projectDirectory, target);
		case "http":
			return createHttpStorage(target);
		case "s3":
			return createS3Storage(target);
	}
}

async function loadReport(projectDirectory: string, reportValue: string): Promise<{ report: IAddressableBuildReport; buildRoot: string }> {
	const reportPath = projectPath(projectDirectory, reportValue);
	if (!(await pathExists(reportPath))) {
		throw new Error(`Addressables build report was not found: ${reportValue}`);
	}
	const report = (await readJSON(reportPath)) as IAddressableBuildReport;
	if (report.version !== 1 || !report.buildId || !report.catalogHash || !Array.isArray(report.artifacts)) {
		throw new Error("Addressables build report is invalid.");
	}
	return { report, buildRoot: join(dirname(reportPath), "..") };
}

async function readArtifact(buildRoot: string, artifact: IAddressableBuildArtifact): Promise<Buffer> {
	const relativePath = safeRelativePath(artifact.relativePath);
	const absolutePath = join(buildRoot, relativePath);
	if (absolutePath !== buildRoot && !absolutePath.startsWith(`${buildRoot}/`)) {
		throw new Error(`Addressables build artifact escaped its build root: ${relativePath}`);
	}
	const bytes = await readFile(absolutePath);
	if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.hash) {
		throw new Error(`Addressables build artifact no longer matches its report: ${relativePath}`);
	}
	return bytes;
}

async function validateDeploymentRouting(
	buildRoot: string,
	report: IAddressableBuildReport,
	target: IAddressableDeploymentTarget,
	pointer: IAddressableBuildArtifact
): Promise<void> {
	const catalogArtifact = report.artifacts.find((artifact) => artifact.kind === "catalog");
	if (!catalogArtifact) {
		throw new Error("Addressables build report does not contain a catalog artifact.");
	}
	const catalog = JSON.parse((await readArtifact(buildRoot, catalogArtifact)).toString("utf8")) as IAddressableCatalog;
	const publicBaseUrl = normalizedPublicUrl(target.publicBaseUrl);
	for (const group of catalog.groups.filter((candidate) => candidate.delivery === "remote" && candidate.assets.length)) {
		if (normalizedPublicUrl(group.loadPath) !== publicBaseUrl) {
			throw new Error(`Addressables deployment target publicBaseUrl does not match remote group "${group.name}" loadPath: ${group.loadPath}`);
		}
	}
	if (catalog.remoteCatalog?.pointerUrl && normalizedPublicUrl(catalog.remoteCatalog.pointerUrl) !== normalizedPublicUrl(joinUrl(target.publicBaseUrl, pointer.deployPath!))) {
		throw new Error(`Addressables deployment target publicBaseUrl does not match the catalog publication pointer: ${catalog.remoteCatalog.pointerUrl}`);
	}
}

async function verifyPublication(storage: IDeploymentStorage, pointerPath: string, expectedBuildId: string, expectedCatalogHash: string): Promise<void> {
	const pointer = JSON.parse((await storage.get(pointerPath)).toString("utf8")) as {
		version?: number;
		buildId?: string;
		catalogHash?: string;
		catalogUrl?: string;
		hashUrl?: string;
	};
	if (pointer.version !== 1 || pointer.buildId !== expectedBuildId || pointer.catalogHash !== expectedCatalogHash || !pointer.catalogUrl || !pointer.hashUrl) {
		throw new Error("Published Addressables pointer does not match the requested release.");
	}
	const [catalogBytes, hashBytes] = await Promise.all([storage.get(pointer.catalogUrl), storage.get(pointer.hashUrl)]);
	const catalog = JSON.parse(catalogBytes.toString("utf8")) as IAddressableCatalog;
	const semanticHash = sha256(getAddressableCatalogHashPayload(catalog));
	if (
		catalog.buildId !== expectedBuildId ||
		catalog.catalogHash !== expectedCatalogHash ||
		semanticHash !== expectedCatalogHash ||
		hashBytes.toString("utf8").trim() !== expectedCatalogHash
	) {
		throw new Error("Published Addressables catalog or hash file failed verification.");
	}
	const remotePortableAddresses = new Set(
		catalog.groups.filter((group) => group.delivery === "remote").flatMap((group) => group.assets.filter((asset) => asset.portableBundleId).map((asset) => asset.address))
	);
	if (remotePortableAddresses.size) {
		const registry = catalog.typeTreeRegistry;
		if (!registry) {
			throw new Error("Published portable Addressables do not reference a TypeTree registry.");
		}
		const registryBytes = await storage.get(registry.internalId);
		if (registryBytes.byteLength !== registry.sizeBytes || sha256(registryBytes) !== registry.hash) {
			throw new Error("Published Addressables TypeTree registry failed verification.");
		}
		for (const bundle of catalog.portableBundles ?? []) {
			if (!bundle.addresses.some((address) => remotePortableAddresses.has(address))) {
				continue;
			}
			const bundleBytes = await storage.get(bundle.internalId);
			if (bundleBytes.byteLength !== bundle.sizeBytes || sha256(bundleBytes) !== bundle.hash) {
				throw new Error(`Published Addressables portable bundle failed verification: ${bundle.id}`);
			}
		}
	}
}

/** Uploads immutable artifacts first and makes the new release visible by publishing its pointer last. */
export async function deployAddressableBuild(
	projectDirectory: string,
	reportPath: string,
	target: IAddressableDeploymentTarget,
	expectedCatalogHash: string,
	confirmPublish: boolean
): Promise<IAddressableDeploymentReceipt> {
	if (!confirmPublish) {
		throw new Error("Addressables deployment requires confirmPublish=true.");
	}
	const { report, buildRoot } = await loadReport(projectDirectory, reportPath);
	if (report.catalogHash !== expectedCatalogHash) {
		throw new Error(`Addressables build report hash is ${report.catalogHash}; expected ${expectedCatalogHash}.`);
	}
	const storage = createStorage(projectDirectory, target);
	const deployable = report.artifacts.filter((artifact) => artifact.deployPath);
	const pointer = deployable.find((artifact) => artifact.kind === "pointer-preview");
	if (!pointer?.deployPath) {
		throw new Error("Addressables build report does not contain a publication pointer.");
	}
	await validateDeploymentRouting(buildRoot, report, target, pointer);
	const immutable = deployable.filter((artifact) => artifact !== pointer).sort((left, right) => String(left.deployPath).localeCompare(String(right.deployPath)));
	const startedAt = new Date().toISOString();
	let uploadedBytes = 0;
	for (const artifact of immutable) {
		const bytes = await readArtifact(buildRoot, artifact);
		await storage.put(artifact.deployPath!, bytes, artifact.hash, false);
		const verified = await storage.get(artifact.deployPath!);
		if (sha256(verified) !== artifact.hash) {
			throw new Error(`Addressables deployment verification failed before publication: ${artifact.deployPath}`);
		}
		uploadedBytes += bytes.byteLength;
	}
	const pointerBytes = await readArtifact(buildRoot, pointer);
	await storage.put(pointer.deployPath, pointerBytes, pointer.hash, true);
	uploadedBytes += pointerBytes.byteLength;
	await verifyPublication(storage, pointer.deployPath, report.buildId, report.catalogHash);
	const completedAt = new Date().toISOString();
	const receipt: IAddressableDeploymentReceipt = {
		version: 1,
		deploymentId: `${report.buildId}-${target.id}-${Date.now()}`,
		targetId: target.id,
		targetName: target.name,
		provider: target.provider,
		buildId: report.buildId,
		catalogHash: report.catalogHash,
		startedAt,
		completedAt,
		fileCount: immutable.length + 1,
		uploadedBytes,
		pointerPath: pointer.deployPath,
		pointerPublishedLast: true,
		verified: true,
	};
	const receiptPath = join(projectDirectory, ".bjseditor/addressables/deployments", `${receipt.deploymentId}.json`);
	await ensureDir(dirname(receiptPath));
	await writeJSON(receiptPath, receipt, { spaces: "\t" });
	return receipt;
}

export async function verifyAddressableDeployment(
	projectDirectory: string,
	target: IAddressableDeploymentTarget,
	pointerPath: string,
	expectedBuildId: string,
	expectedCatalogHash: string
): Promise<{ verified: true; buildId: string; catalogHash: string; pointerUrl: string }> {
	const storage = createStorage(projectDirectory, target);
	const safePointerPath = safeRelativePath(pointerPath);
	await verifyPublication(storage, safePointerPath, expectedBuildId, expectedCatalogHash);
	return { verified: true, buildId: expectedBuildId, catalogHash: expectedCatalogHash, pointerUrl: joinUrl(target.publicBaseUrl, safePointerPath) };
}

export async function listAddressableDeploymentReceipts(projectDirectory: string): Promise<IAddressableDeploymentReceipt[]> {
	const directory = join(projectDirectory, ".bjseditor/addressables/deployments");
	if (!(await pathExists(directory))) {
		return [];
	}
	const paths = (await readdir(directory)).filter((path) => path.endsWith(".json")).map((path) => join(directory, path));
	const receipts = await Promise.all(paths.map(async (path) => readJSON(path) as Promise<IAddressableDeploymentReceipt>));
	return receipts.sort((left, right) => right.completedAt.localeCompare(left.completedAt)).slice(0, 256);
}
