import { extname } from "path/posix";
import { randomUUID } from "crypto";
import { move, pathExists, readJSON, remove, stat, writeJSON } from "fs-extra";

import { forkCinematicDocument, getCinematicFingerprint, ICinematicDocument, normalizeCinematicDocument } from "babylonjs-editor-tools";

/** Requires both monotonic revision and exact normalized content for a safe replacement. */
export interface ICinematicDocumentLease {
	expectedRevision: number;
	expectedFingerprint: string;
}

/** Returns canonical content plus the lease and whether an old file needs migration on save. */
export interface ILoadedCinematicDocument {
	document: ICinematicDocument;
	fingerprint: string;
	migrated: boolean;
}

/** Supplies stable project-relative identity for legacy assets without persisted IDs. */
export interface ICinematicDocumentLoadOptions {
	identitySeed?: string;
}

let cinematicDocumentMutationQueue: Promise<void> = Promise.resolve();

/** Serializes editor and MCP writes so two in-process leases cannot both commit. */
async function withCinematicDocumentMutationLock<T>(action: () => Promise<T>): Promise<T> {
	const previous = cinematicDocumentMutationQueue;
	let release!: () => void;
	cinematicDocumentMutationQueue = new Promise<void>((resolve) => (release = resolve));
	await previous;
	try {
		return await action();
	} finally {
		release();
	}
}

/** Keeps persistence restricted to the asset format this service validates. */
function assertCinematicPath(absolutePath: string): void {
	if (extname(absolutePath).toLowerCase() !== ".cinematic") {
		throw new Error("Cinematic document paths must end in .cinematic.");
	}
}

/** Performs the bounded read/normalization shared by public loads and locked saves. */
async function loadCinematicDocumentUnlocked(absolutePath: string, options: ICinematicDocumentLoadOptions): Promise<ILoadedCinematicDocument> {
	assertCinematicPath(absolutePath);
	if ((await stat(absolutePath)).size > 16 * 1024 * 1024) {
		throw new Error("Cinematic documents cannot exceed 16 MiB.");
	}
	const raw = await readJSON(absolutePath, { encoding: "utf-8" });
	const document = normalizeCinematicDocument(raw, { identitySeed: options.identitySeed ?? absolutePath });
	return { document, fingerprint: getCinematicFingerprint(document), migrated: raw?.version !== document.version };
}

/** Replaces a document through a same-directory temporary path and always cleans leftovers. */
async function writeCinematicDocumentAtomic(absolutePath: string, document: ICinematicDocument): Promise<void> {
	const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
	try {
		await writeJSON(temporaryPath, document, { spaces: "\t", encoding: "utf-8" });
		await move(temporaryPath, absolutePath, { overwrite: true });
	} finally {
		await remove(temporaryPath).catch(() => undefined);
	}
}

/** Loads either cinematic format into a validated version-2 document and exact content lease. */
export async function loadCinematicDocument(absolutePath: string, options: ICinematicDocumentLoadOptions = {}): Promise<ILoadedCinematicDocument> {
	return loadCinematicDocumentUnlocked(absolutePath, options);
}

/** Creates a fresh version-2 asset atomically and refuses to replace an existing path. */
export async function createCinematicDocumentFile(
	absolutePath: string,
	documentValue: ICinematicDocument,
	options: ICinematicDocumentLoadOptions = {}
): Promise<ILoadedCinematicDocument> {
	return withCinematicDocumentMutationLock(async () => {
		assertCinematicPath(absolutePath);
		if (await pathExists(absolutePath)) {
			throw new Error(`A cinematic document already exists at ${absolutePath}.`);
		}
		const document = normalizeCinematicDocument({ ...documentValue, revision: 0 }, { identitySeed: options.identitySeed ?? absolutePath });
		await writeCinematicDocumentAtomic(absolutePath, document);
		return { document, fingerprint: getCinematicFingerprint(document), migrated: false };
	});
}

/** Commits one exact-revision replacement atomically and rejects stale or cross-asset writes. */
export async function saveCinematicDocument(
	absolutePath: string,
	documentValue: ICinematicDocument,
	lease: ICinematicDocumentLease,
	options: ICinematicDocumentLoadOptions = {}
): Promise<ILoadedCinematicDocument> {
	return withCinematicDocumentMutationLock(async () => {
		const current = await loadCinematicDocumentUnlocked(absolutePath, options);
		if (current.document.revision !== lease.expectedRevision || current.fingerprint !== lease.expectedFingerprint) {
			throw new Error(`Cinematic document changed after it was opened. Reload revision ${current.document.revision} with fingerprint ${current.fingerprint}.`);
		}
		if (current.document.id !== documentValue.id) {
			throw new Error("Cinematic document identity cannot change during an in-place save.");
		}
		const document = normalizeCinematicDocument({ ...documentValue, revision: current.document.revision + 1 }, { identitySeed: options.identitySeed ?? absolutePath });
		await writeCinematicDocumentAtomic(absolutePath, document);
		return { document, fingerprint: getCinematicFingerprint(document), migrated: false };
	});
}

/** Forks an exact source lease into a new path with independent stable asset identity. */
export async function forkCinematicDocumentFile(
	sourceAbsolutePath: string,
	destinationAbsolutePath: string,
	lease: ICinematicDocumentLease,
	options: ICinematicDocumentLoadOptions = {}
): Promise<ILoadedCinematicDocument> {
	return withCinematicDocumentMutationLock(async () => {
		assertCinematicPath(destinationAbsolutePath);
		const source = await loadCinematicDocumentUnlocked(sourceAbsolutePath, options);
		if (source.document.revision !== lease.expectedRevision || source.fingerprint !== lease.expectedFingerprint) {
			throw new Error(`Cinematic document changed after it was inspected. Reload revision ${source.document.revision} with fingerprint ${source.fingerprint}.`);
		}
		if (await pathExists(destinationAbsolutePath)) {
			throw new Error(`A cinematic document already exists at ${destinationAbsolutePath}.`);
		}
		const document = forkCinematicDocument(source.document, options.identitySeed ?? destinationAbsolutePath);
		await writeCinematicDocumentAtomic(destinationAbsolutePath, document);
		return { document, fingerprint: getCinematicFingerprint(document), migrated: false };
	});
}

/** Deletes one exact document lease so stale clients cannot remove a newer asset. */
export async function deleteCinematicDocumentFile(
	absolutePath: string,
	lease: ICinematicDocumentLease,
	options: ICinematicDocumentLoadOptions = {}
): Promise<{ id: string; revision: number; fingerprint: string }> {
	return withCinematicDocumentMutationLock(async () => {
		const current = await loadCinematicDocumentUnlocked(absolutePath, options);
		if (current.document.revision !== lease.expectedRevision || current.fingerprint !== lease.expectedFingerprint) {
			throw new Error(`Cinematic document changed after it was inspected. Reload revision ${current.document.revision} with fingerprint ${current.fingerprint}.`);
		}
		await remove(absolutePath);
		return { id: current.document.id, revision: current.document.revision, fingerprint: current.fingerprint };
	});
}
