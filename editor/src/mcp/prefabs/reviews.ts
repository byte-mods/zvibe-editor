import { createHash, randomUUID } from "crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { getProjectCollaborationStatus, listProjectCollaborationMembers, resolveProjectCollaborationActor } from "../project/collaboration";
import { inspectPrefabVariantRebase } from "./prefabs";

const storeVersion = 1;
const maximumStoreBytes = 4 * 1024 * 1024;
const maximumReviews = 500;
const maximumReviewers = 50;
const maximumComments = 1000;
const maximumDecisions = 1000;
const operationGuardStaleMilliseconds = 10_000;

export type PrefabReviewState = "draft" | "inReview" | "closed";
export type PrefabReviewDecision = "approve" | "requestChanges" | "dismiss";

export interface IPrefabReviewIdentity {
	id: string;
	name: string;
}

export interface IPrefabReviewComment {
	id: string;
	author: IPrefabReviewIdentity;
	body: string;
	round: number;
	prefabRevision: string;
	createdAt: string;
}

export interface IPrefabReviewDecisionRecord {
	id: string;
	reviewer: IPrefabReviewIdentity;
	decision: PrefabReviewDecision;
	body: string;
	round: number;
	prefabRevision: string;
	createdAt: string;
}

export interface IPrefabReview {
	version: 1;
	id: string;
	path: string;
	title: string;
	owner: IPrefabReviewIdentity;
	reviewers: IPrefabReviewIdentity[];
	state: PrefabReviewState;
	round: number;
	reviewedRevision: string | null;
	comments: IPrefabReviewComment[];
	decisions: IPrefabReviewDecisionRecord[];
	createdAt: string;
	updatedAt: string;
}

interface IPrefabReviewStore {
	version: 1;
	reviews: IPrefabReview[];
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function metadataDirectory(root: string): string {
	return join(root, ".babylon-editor");
}

function storePath(root: string): string {
	return join(metadataDirectory(root), "prefab-reviews.json");
}

function emptyStore(): IPrefabReviewStore {
	return { version: storeVersion, reviews: [] };
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function reviewFingerprint(path: string, review: IPrefabReview | null): string {
	return sha256(review ? JSON.stringify(review) : `missing\0${path}`);
}

function validateIdentifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(value)) {
		throw new Error(`${field} must contain 1 through 128 stable identifier characters.`);
	}
	return value;
}

function validateText(value: unknown, field: string, maximum: number, allowEmpty = false): string {
	if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!allowEmpty && !value.trim())) {
		throw new Error(`${field} must ${allowEmpty ? "contain at most" : "contain 1 through"} ${maximum} characters without null bytes.`);
	}
	return allowEmpty ? value : value.trim();
}

function validateRevision(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error(`${field} must be an exact lowercase SHA-256 prefab revision.`);
	}
	return value;
}

function validateIdentity(value: unknown, field: string): IPrefabReviewIdentity {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${field} must contain stable id and display name fields.`);
	}
	return {
		id: validateIdentifier((value as any).id, `${field}.id`),
		name: validateText((value as any).name, `${field}.name`, 128),
	};
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateStoredReview(value: any): IPrefabReview {
	if (
		!value ||
		value.version !== 1 ||
		typeof value.path !== "string" ||
		!value.path.endsWith(".prefab") ||
		value.path.length > 1024 ||
		!Array.isArray(value.reviewers) ||
		value.reviewers.length > maximumReviewers ||
		!Array.isArray(value.comments) ||
		value.comments.length > maximumComments ||
		!Array.isArray(value.decisions) ||
		value.decisions.length > maximumDecisions ||
		!["draft", "inReview", "closed"].includes(value.state) ||
		!Number.isInteger(value.round) ||
		value.round < 0 ||
		value.round > 1_000_000 ||
		(value.reviewedRevision !== null && !/^[a-f0-9]{64}$/.test(value.reviewedRevision)) ||
		!isTimestamp(value.createdAt) ||
		!isTimestamp(value.updatedAt)
	) {
		throw new Error("The project Prefab review store has an unsupported or malformed review record.");
	}
	const review: IPrefabReview = {
		version: 1,
		id: validateIdentifier(value.id, "review.id"),
		path: value.path,
		title: validateText(value.title, "review.title", 256),
		owner: validateIdentity(value.owner, "review.owner"),
		reviewers: value.reviewers.map((entry: unknown, index: number) => validateIdentity(entry, `review.reviewers[${index}]`)),
		state: value.state,
		round: value.round,
		reviewedRevision: value.reviewedRevision,
		comments: value.comments.map((entry: any, index: number) => {
			if (!entry || !Number.isInteger(entry.round) || entry.round < 0 || !isTimestamp(entry.createdAt)) {
				throw new Error(`review.comments[${index}] is malformed.`);
			}
			return {
				id: validateIdentifier(entry.id, `review.comments[${index}].id`),
				author: validateIdentity(entry.author, `review.comments[${index}].author`),
				body: validateText(entry.body, `review.comments[${index}].body`, 10_000),
				round: entry.round,
				prefabRevision: validateRevision(entry.prefabRevision, `review.comments[${index}].prefabRevision`),
				createdAt: entry.createdAt,
			};
		}),
		decisions: value.decisions.map((entry: any, index: number) => {
			if (
				!entry ||
				!["approve", "requestChanges", "dismiss"].includes(entry.decision) ||
				!Number.isInteger(entry.round) ||
				entry.round < 1 ||
				!isTimestamp(entry.createdAt)
			) {
				throw new Error(`review.decisions[${index}] is malformed.`);
			}
			return {
				id: validateIdentifier(entry.id, `review.decisions[${index}].id`),
				reviewer: validateIdentity(entry.reviewer, `review.decisions[${index}].reviewer`),
				decision: entry.decision,
				body: validateText(entry.body, `review.decisions[${index}].body`, 10_000, true),
				round: entry.round,
				prefabRevision: validateRevision(entry.prefabRevision, `review.decisions[${index}].prefabRevision`),
				createdAt: entry.createdAt,
			};
		}),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
	if (new Set(review.reviewers.map((entry) => entry.id)).size !== review.reviewers.length) {
		throw new Error("The project Prefab review store contains duplicate reviewer identities.");
	}
	if (new Set(review.comments.map((entry) => entry.id)).size !== review.comments.length || new Set(review.decisions.map((entry) => entry.id)).size !== review.decisions.length) {
		throw new Error("The project Prefab review store contains duplicate comment or decision identities.");
	}
	if ((review.state === "inReview" && (review.round < 1 || review.reviewedRevision === null)) || (review.round === 0 && review.reviewedRevision !== null)) {
		throw new Error("The project Prefab review store contains inconsistent request-round revision evidence.");
	}
	return review;
}

async function requireMetadataDirectory(root: string): Promise<string> {
	const directory = metadataDirectory(root);
	await mkdir(directory, { recursive: true });
	const [realRoot, realDirectory] = await Promise.all([realpath(root), realpath(directory)]);
	if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}/`)) {
		throw new Error("Prefab review metadata must stay inside the active project.");
	}
	return realDirectory;
}

async function readStore(root: string): Promise<IPrefabReviewStore> {
	const path = storePath(root);
	try {
		const details = await lstat(path);
		if (!details.isFile() || details.isSymbolicLink() || details.size > maximumStoreBytes) {
			throw new Error(`Prefab review metadata must be a regular non-symlink file of at most ${maximumStoreBytes} bytes.`);
		}
		await requireMetadataDirectory(root);
		const value = JSON.parse(await readFile(path, "utf-8"));
		if (value?.version !== storeVersion || !Array.isArray(value.reviews) || value.reviews.length > maximumReviews) {
			throw new Error("The project Prefab review store has an unsupported or malformed schema.");
		}
		const reviews = value.reviews.map(validateStoredReview);
		if (new Set(reviews.map((review) => review.path)).size !== reviews.length || new Set(reviews.map((review) => review.id)).size !== reviews.length) {
			throw new Error("The project Prefab review store contains duplicate paths or review identities.");
		}
		return { version: 1, reviews };
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return emptyStore();
		}
		if (error instanceof SyntaxError) {
			throw new Error("The project Prefab review store contains invalid JSON. Repair .babylon-editor/prefab-reviews.json before continuing.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: IPrefabReviewStore): Promise<void> {
	await requireMetadataDirectory(root);
	const path = storePath(root);
	const existing = await lstat(path).catch((error: any) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
	if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
		throw new Error("Prefab review metadata must not be a symlink or non-file entry.");
	}
	const serialized = `${JSON.stringify(store, null, "\t")}\n`;
	if (Buffer.byteLength(serialized, "utf-8") > maximumStoreBytes) {
		throw new Error(`Prefab review metadata would exceed ${maximumStoreBytes} bytes.`);
	}
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, serialized, { encoding: "utf-8", flag: "wx", mode: 0o600 });
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function withStoreGuard<T>(root: string, action: (store: IPrefabReviewStore) => Promise<T>): Promise<T> {
	const directory = await requireMetadataDirectory(root);
	const guardPath = join(directory, ".prefab-reviews.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			handle = await open(guardPath, "wx", 0o600);
			await handle.writeFile(`${Date.now()}\n`, "utf-8");
			break;
		} catch (error: any) {
			await handle?.close().catch(() => undefined);
			handle = null;
			if (error?.code !== "EEXIST") {
				throw error;
			}
			const details = await stat(guardPath).catch(() => null);
			if (details && Date.now() - details.mtimeMs > operationGuardStaleMilliseconds) {
				await unlink(guardPath).catch(() => undefined);
			} else {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
	}
	if (!handle) {
		throw new Error("The project Prefab review store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

async function resolveActor(scene: Scene, data: any, options: IMCPActionOptions): Promise<IPrefabReviewIdentity & { role: string }> {
	const status = await getProjectCollaborationStatus(scene, { collaborationToken: data.collaborationToken }, options);
	if (status.enforcementEnabled) {
		const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
		return { id: actor.memberId, name: actor.memberName, role: actor.role };
	}
	return {
		id: validateIdentifier(data.actorId ?? "local-editor", "actorId"),
		name: validateText(data.actorName ?? "Local Editor", "actorName", 128),
		role: "admin",
	};
}

async function resolveReviewers(scene: Scene, data: any, options: IMCPActionOptions): Promise<IPrefabReviewIdentity[]> {
	if (!Array.isArray(data.reviewers) || data.reviewers.length > maximumReviewers) {
		throw new Error(`reviewers must contain at most ${maximumReviewers} stable identities.`);
	}
	const requested = data.reviewers.map((entry: unknown, index: number) => validateIdentity(entry, `reviewers[${index}]`));
	if (new Set(requested.map((entry) => entry.id)).size !== requested.length) {
		throw new Error("reviewers must not contain duplicate identities.");
	}
	const status = await getProjectCollaborationStatus(scene, { collaborationToken: data.collaborationToken }, options);
	if (!status.enforcementEnabled) {
		return requested;
	}
	const listed = await listProjectCollaborationMembers(scene, { collaborationToken: data.collaborationToken }, options);
	const members = new Map(listed.members.filter((member: any) => member.enabled).map((member: any) => [member.id, member]));
	return requested.map((entry) => {
		const member = members.get(entry.id) as any;
		if (!member) {
			throw new Error(`Reviewer ${entry.id} is not an enabled project collaboration member.`);
		}
		return { id: member.id, name: member.name };
	});
}

function requireConfirmation(data: any, action: string): void {
	if (data.confirm !== true) {
		throw new Error(`confirm must be true to ${action}.`);
	}
}

function requireLease(data: any, path: string, review: IPrefabReview | null): void {
	const expected = validateRevision(data.expectedReviewFingerprint, "expectedReviewFingerprint");
	if (expected !== reviewFingerprint(path, review)) {
		throw new Error("Prefab review metadata changed since inspection. Refresh the review and retry with its exact current fingerprint.");
	}
}

function decisionSummary(review: IPrefabReview, stale: boolean): any {
	const latest = new Map<string, IPrefabReviewDecisionRecord>();
	for (const decision of review.decisions.filter((entry) => entry.round === review.round && entry.prefabRevision === review.reviewedRevision)) {
		latest.set(decision.reviewer.id, decision);
	}
	const decisions = review.reviewers.map((reviewer) => ({ reviewer, decision: latest.get(reviewer.id)?.decision ?? "pending", body: latest.get(reviewer.id)?.body ?? "" }));
	let status = "pending";
	if (stale && review.reviewedRevision) {
		status = "stale";
	} else if (decisions.some((entry) => entry.decision === "requestChanges")) {
		status = "changesRequested";
	} else if (decisions.length > 0 && decisions.every((entry) => entry.decision === "approve")) {
		status = "approved";
	}
	return { status, decisions };
}

async function publicReview(scene: Scene, review: IPrefabReview, offset = 0, limit = 50): Promise<any> {
	const inspection = await inspectPrefabVariantRebase(scene, { path: review.path });
	const currentRevision = inspection.resolvedRevision as string;
	const stale = review.reviewedRevision !== null && review.reviewedRevision !== currentRevision;
	const comments = review.comments.slice(offset, offset + limit);
	return {
		...review,
		comments,
		commentPage: {
			total: review.comments.length,
			count: comments.length,
			offset,
			hasMore: offset + comments.length < review.comments.length,
			nextOffset: offset + comments.length < review.comments.length ? offset + comments.length : null,
		},
		currentRevision,
		stale,
		approval: decisionSummary(review, stale),
		fingerprint: reviewFingerprint(review.path, review),
	};
}

function validatePagination(data: any): { offset: number; limit: number } {
	const offset = data.offset ?? 0;
	const limit = data.limit ?? 50;
	if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
		throw new Error("offset must be a non-negative integer and limit must be an integer from 1 through 100.");
	}
	return { offset, limit };
}

/** Lists project-local Prefab review requests without reading or changing runtime asset content. */
export async function listPrefabReviews(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = validatePagination(data);
	if (data.state !== undefined && !["draft", "inReview", "closed"].includes(data.state)) {
		throw new Error("state must be draft, inReview, or closed.");
	}
	const store = await readStore(projectDirectory(options));
	const filtered = store.reviews.filter((review) => !data.state || review.state === data.state).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt));
	const page = filtered.slice(offset, offset + limit);
	const reviews = await Promise.all(
		page.map(async (review) => {
			const inspected = await publicReview(scene, review, 0, 1);
			return { ...inspected, comments: undefined, decisions: undefined };
		})
	);
	return {
		storage: ".babylon-editor/prefab-reviews.json",
		total: filtered.length,
		count: reviews.length,
		offset,
		hasMore: offset + reviews.length < filtered.length,
		nextOffset: offset + reviews.length < filtered.length ? offset + reviews.length : null,
		reviews,
	};
}

/** Reads one Prefab review and its revision-bound approval state. */
export async function inspectPrefabReview(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const { offset, limit } = validatePagination(data);
	const prefab = await inspectPrefabVariantRebase(scene, { path: data.path });
	const store = await readStore(projectDirectory(options));
	const review = store.reviews.find((entry) => entry.path === prefab.path) ?? null;
	return review
		? { storage: ".babylon-editor/prefab-reviews.json", exists: true, review: await publicReview(scene, review, offset, limit) }
		: {
				storage: ".babylon-editor/prefab-reviews.json",
				exists: false,
				path: prefab.path,
				currentRevision: prefab.resolvedRevision,
				fingerprint: reviewFingerprint(prefab.path, null),
			};
}

/** Creates or updates ownership/reviewers and optionally opens a new exact-revision review round. */
export async function setPrefabReview(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	requireConfirmation(data, "set Prefab review ownership and request state");
	const root = projectDirectory(options);
	const actor = await resolveActor(scene, data, options);
	const reviewers = await resolveReviewers(scene, data, options);
	const title = validateText(data.title, "title", 256);
	const action = data.action;
	if (!["saveDraft", "requestReview", "close"].includes(action)) {
		throw new Error("action must be saveDraft, requestReview, or close.");
	}
	return withStoreGuard(root, async (store) => {
		const prefab = await inspectPrefabVariantRebase(scene, { path: data.path });
		let review = store.reviews.find((entry) => entry.path === prefab.path) ?? null;
		requireLease(data, prefab.path, review);
		if (review && actor.role !== "admin" && actor.id !== review.owner.id) {
			throw new Error("Only the Prefab review owner or a collaboration admin can change ownership, reviewers, or review-request state.");
		}
		if (!review && store.reviews.length >= maximumReviews) {
			throw new Error(`A project can contain at most ${maximumReviews} Prefab reviews.`);
		}
		const requestedOwnerId = data.ownerId === undefined ? (review?.owner.id ?? actor.id) : validateIdentifier(data.ownerId, "ownerId");
		let owner: IPrefabReviewIdentity;
		if (requestedOwnerId === actor.id) {
			owner = { id: actor.id, name: actor.name };
		} else if (review?.owner.id === requestedOwnerId) {
			owner = review.owner;
		} else {
			if (actor.role !== "admin") {
				throw new Error("Only a collaboration admin can assign a different Prefab review owner.");
			}
			const candidate = reviewers.find((entry) => entry.id === requestedOwnerId);
			if (!candidate) {
				throw new Error("ownerId must identify the actor or one of the supplied stable reviewer identities.");
			}
			owner = candidate;
		}
		const now = new Date().toISOString();
		if (!review) {
			review = {
				version: 1,
				id: randomUUID(),
				path: prefab.path,
				title,
				owner,
				reviewers,
				state: "draft",
				round: 0,
				reviewedRevision: null,
				comments: [],
				decisions: [],
				createdAt: now,
				updatedAt: now,
			};
			store.reviews.push(review);
		}
		review.title = title;
		review.owner = owner;
		review.reviewers = reviewers;
		review.updatedAt = now;
		if (action === "requestReview") {
			if (!reviewers.length) {
				throw new Error("At least one reviewer is required to request Prefab review.");
			}
			const expectedRevision = validateRevision(data.expectedPrefabRevision, "expectedPrefabRevision");
			if (expectedRevision !== prefab.resolvedRevision) {
				throw new Error("Prefab content changed since inspection. Refresh and request review for the exact current revision.");
			}
			review.state = "inReview";
			review.round++;
			review.reviewedRevision = prefab.resolvedRevision;
		} else if (action === "close") {
			review.state = "closed";
		} else if (review.state === "closed") {
			review.state = "draft";
		}
		await writeStore(root, store);
		return { updated: true, action, review: await publicReview(scene, review) };
	});
}

/** Adds one stable comment tied to the exact current Prefab revision and review round. */
export async function addPrefabReviewComment(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	requireConfirmation(data, "add a Prefab review comment");
	const body = validateText(data.body, "body", 10_000);
	const actor = await resolveActor(scene, data, options);
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const prefab = await inspectPrefabVariantRebase(scene, { path: data.path });
		const review = store.reviews.find((entry) => entry.path === prefab.path) ?? null;
		if (!review) {
			throw new Error("No Prefab review exists for this asset. Create a draft or review request first.");
		}
		requireLease(data, prefab.path, review);
		const expectedRevision = validateRevision(data.expectedPrefabRevision, "expectedPrefabRevision");
		if (expectedRevision !== prefab.resolvedRevision) {
			throw new Error("Prefab content changed since inspection. Refresh before commenting on the exact current revision.");
		}
		if (review.comments.length >= maximumComments) {
			throw new Error(`A Prefab review can contain at most ${maximumComments} comments.`);
		}
		const comment: IPrefabReviewComment = {
			id: randomUUID(),
			author: { id: actor.id, name: actor.name },
			body,
			round: review.round,
			prefabRevision: prefab.resolvedRevision,
			createdAt: new Date().toISOString(),
		};
		review.comments.push(comment);
		review.updatedAt = comment.createdAt;
		await writeStore(root, store);
		return { added: true, comment, review: await publicReview(scene, review) };
	});
}

/** Submits one assigned reviewer's exact-revision decision without changing Prefab content. */
export async function submitPrefabReviewDecision(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	requireConfirmation(data, "submit a Prefab review decision");
	const decision = data.decision as PrefabReviewDecision;
	if (!["approve", "requestChanges", "dismiss"].includes(decision)) {
		throw new Error("decision must be approve, requestChanges, or dismiss.");
	}
	const body = validateText(data.body ?? "", "body", 10_000, true);
	const actor = await resolveActor(scene, data, options);
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const prefab = await inspectPrefabVariantRebase(scene, { path: data.path });
		const review = store.reviews.find((entry) => entry.path === prefab.path) ?? null;
		if (!review) {
			throw new Error("No Prefab review exists for this asset.");
		}
		requireLease(data, prefab.path, review);
		if (review.state !== "inReview" || review.reviewedRevision === null) {
			throw new Error("Prefab decisions require an active review request.");
		}
		const reviewer = review.reviewers.find((entry) => entry.id === actor.id);
		if (!reviewer) {
			throw new Error("Only an assigned reviewer can submit a Prefab review decision.");
		}
		const expectedRevision = validateRevision(data.expectedPrefabRevision, "expectedPrefabRevision");
		if (expectedRevision !== prefab.resolvedRevision || expectedRevision !== review.reviewedRevision) {
			throw new Error("The requested Prefab review revision is stale. The owner must open a new review round for the exact current revision.");
		}
		if (review.decisions.length >= maximumDecisions) {
			throw new Error(`A Prefab review can contain at most ${maximumDecisions} decision records.`);
		}
		const record: IPrefabReviewDecisionRecord = {
			id: randomUUID(),
			reviewer,
			decision,
			body,
			round: review.round,
			prefabRevision: expectedRevision,
			createdAt: new Date().toISOString(),
		};
		review.decisions.push(record);
		review.updatedAt = record.createdAt;
		await writeStore(root, store);
		return { submitted: true, decision: record, review: await publicReview(scene, review) };
	});
}
