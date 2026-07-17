import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path/posix";

import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";

const storeVersion = 1;
const maximumMembers = 100;
const maximumSessions = 100;
const minimumSessionTtlSeconds = 30;
const maximumSessionTtlSeconds = 3600;
const defaultSessionTtlSeconds = 120;
const operationGuardStaleMilliseconds = 10000;

export type ProjectCollaborationRole = "admin" | "editor" | "viewer";

export interface IProjectCollaborationMember {
	id: string;
	name: string;
	role: ProjectCollaborationRole;
	enabled: boolean;
	accessKeyHash: string;
	createdAt: string;
	updatedAt: string;
}

export interface IProjectCollaborationSession {
	id: string;
	memberId: string;
	clientName: string;
	state: string;
	selectionNodeIds?: string[];
	cursor?: { x: number; y: number; viewport: string };
	color?: string;
	toolMode?: ProjectCollaborationToolMode;
	primarySelectionNodeId?: string;
	hoveredNodeId?: string;
	pointers?: IProjectCollaborationPointer[];
	camera?: IProjectCollaborationCamera;
	tokenHash: string;
	createdAt: string;
	lastSeenAt: string;
	expiresAt: string;
}

export type ProjectCollaborationToolMode = "select" | "move" | "rotate" | "scale" | "rect" | "paint" | "terrain" | "animate" | "play" | "navigate" | "custom";

export interface IProjectCollaborationPointer {
	id: string;
	viewport: string;
	x: number;
	y: number;
	pointerType: "mouse" | "pen" | "touch" | "xr";
	buttons: number;
	pressure: number;
	worldRay?: { origin: [number, number, number]; direction: [number, number, number]; length?: number };
	worldPosition?: [number, number, number];
	updatedAt: string;
}

export interface IProjectCollaborationCamera {
	viewport: string;
	position: [number, number, number];
	target: [number, number, number];
	up: [number, number, number];
	fovDegrees?: number;
	orthographicSize?: number;
	updatedAt: string;
}

interface IProjectCollaborationStore {
	version: 1;
	enforcementEnabled: boolean;
	members: IProjectCollaborationMember[];
	sessions: IProjectCollaborationSession[];
}

const collaborationEndpoints = new Set([
	"get_project_collaboration_status",
	"configure_project_collaboration",
	"list_project_collaboration_members",
	"create_project_collaboration_member",
	"set_project_collaboration_member",
	"delete_project_collaboration_member",
	"join_project_collaboration_session",
	"heartbeat_project_collaboration_session",
	"leave_project_collaboration_session",
	"list_project_collaboration_presence",
]);

const readOnlyEndpointPrefixes = ["get_", "list_", "compare_", "validate_", "find_", "evaluate_", "inspect_", "preview_"];
const additionalReadOnlyEndpoints = new Set(["resolve_localization_entry", "pseudo_localize_entry"]);

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function storeDirectory(root: string): string {
	return join(root, ".babylon-editor");
}

function storePath(root: string): string {
	return join(storeDirectory(root), "collaboration.json");
}

function emptyStore(): IProjectCollaborationStore {
	return { version: storeVersion, enforcementEnabled: false, members: [], sessions: [] };
}

function validateName(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim() || value.length > 128 || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new Error(`${field} must be a non-empty string of at most 128 characters without line breaks or null bytes.`);
	}
	return value.trim();
}

function validateState(value: unknown): string {
	if (value === undefined) {
		return "active";
	}
	if (typeof value !== "string" || value.length > 256 || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new Error("state must contain at most 256 characters without line breaks or null bytes.");
	}
	return value.trim() || "active";
}

function validateSelectionNodeIds(value: unknown): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > 64 || value.some((id) => typeof id !== "string" || !id || id.length > 128 || id.includes("\0") || /[\r\n]/.test(id))) {
		throw new Error("selectionNodeIds must contain at most 64 non-empty node ids of at most 128 characters each without line breaks or null bytes.");
	}
	return [...new Set(value)];
}

function validateCursor(value: unknown): { x: number; y: number; viewport: string } | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof (value as any).x !== "number" ||
		!Number.isFinite((value as any).x) ||
		(value as any).x < 0 ||
		(value as any).x > 1 ||
		typeof (value as any).y !== "number" ||
		!Number.isFinite((value as any).y) ||
		(value as any).y < 0 ||
		(value as any).y > 1
	) {
		throw new Error("cursor must contain normalized finite x and y values from 0 through 1.");
	}
	return { x: (value as any).x, y: (value as any).y, viewport: validateName((value as any).viewport ?? "scene", "cursor.viewport") };
}

function validateNodeId(value: unknown, field: string): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string" || value.length > 128 || value.includes("\0") || /[\r\n]/.test(value)) {
		throw new Error(`${field} must be a node id of at most 128 characters without line breaks or null bytes.`);
	}
	return value;
}

function validateColor(value: unknown, memberId: string): string {
	if (value === undefined) {
		return `#${createHash("sha256").update(memberId).digest("hex").slice(0, 6)}`;
	}
	if (typeof value !== "string" || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) {
		throw new Error("color must be a #RRGGBB or #RRGGBBAA hexadecimal color.");
	}
	return value.toUpperCase();
}

function validateToolMode(value: unknown): ProjectCollaborationToolMode {
	if (value === undefined) {
		return "select";
	}
	if (!["select", "move", "rotate", "scale", "rect", "paint", "terrain", "animate", "play", "navigate", "custom"].includes(value as string)) {
		throw new Error("toolMode must be select, move, rotate, scale, rect, paint, terrain, animate, play, navigate, or custom.");
	}
	return value as ProjectCollaborationToolMode;
}

function validateVector3(value: unknown, field: string): [number, number, number] {
	if (
		!Array.isArray(value) ||
		value.length !== 3 ||
		value.some((component) => typeof component !== "number" || !Number.isFinite(component) || Math.abs(component) > 1_000_000_000)
	) {
		throw new Error(`${field} must contain exactly three finite numbers with magnitude at most 1,000,000,000.`);
	}
	return [value[0], value[1], value[2]];
}

function validatePointers(value: unknown, timestamp: string): IProjectCollaborationPointer[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > 8) {
		throw new Error("pointers must contain at most 8 viewport pointers.");
	}
	const pointers = value.map((pointer: any, index) => {
		if (!pointer || typeof pointer !== "object" || Array.isArray(pointer)) {
			throw new Error(`pointers[${index}] must be an object.`);
		}
		const id = validateName(pointer.id ?? `pointer-${index + 1}`, `pointers[${index}].id`);
		const viewport = validateName(pointer.viewport ?? "scene", `pointers[${index}].viewport`);
		if (
			typeof pointer.x !== "number" ||
			!Number.isFinite(pointer.x) ||
			pointer.x < 0 ||
			pointer.x > 1 ||
			typeof pointer.y !== "number" ||
			!Number.isFinite(pointer.y) ||
			pointer.y < 0 ||
			pointer.y > 1
		) {
			throw new Error(`pointers[${index}] x and y must be normalized finite values from 0 through 1.`);
		}
		const pointerType = pointer.pointerType ?? "mouse";
		if (!["mouse", "pen", "touch", "xr"].includes(pointerType)) {
			throw new Error(`pointers[${index}].pointerType must be mouse, pen, touch, or xr.`);
		}
		const buttons = pointer.buttons ?? 0;
		const pressure = pointer.pressure ?? 0;
		if (!Number.isInteger(buttons) || buttons < 0 || buttons > 31) {
			throw new Error(`pointers[${index}].buttons must be an integer from 0 through 31.`);
		}
		if (typeof pressure !== "number" || !Number.isFinite(pressure) || pressure < 0 || pressure > 1) {
			throw new Error(`pointers[${index}].pressure must be from 0 through 1.`);
		}
		let worldRay: IProjectCollaborationPointer["worldRay"];
		if (pointer.worldRay !== undefined) {
			if (!pointer.worldRay || typeof pointer.worldRay !== "object" || Array.isArray(pointer.worldRay)) {
				throw new Error(`pointers[${index}].worldRay must be an object.`);
			}
			const origin = validateVector3(pointer.worldRay.origin, `pointers[${index}].worldRay.origin`);
			const direction = validateVector3(pointer.worldRay.direction, `pointers[${index}].worldRay.direction`);
			if (Math.hypot(...direction) < 1e-9) {
				throw new Error(`pointers[${index}].worldRay.direction must be non-zero.`);
			}
			const length = pointer.worldRay.length;
			if (length !== undefined && (typeof length !== "number" || !Number.isFinite(length) || length <= 0 || length > 1_000_000_000)) {
				throw new Error(`pointers[${index}].worldRay.length must be positive and at most 1,000,000,000.`);
			}
			worldRay = { origin, direction, ...(length === undefined ? {} : { length }) };
		}
		return {
			id,
			viewport,
			x: pointer.x,
			y: pointer.y,
			pointerType,
			buttons,
			pressure,
			...(worldRay ? { worldRay } : {}),
			...(pointer.worldPosition === undefined ? {} : { worldPosition: validateVector3(pointer.worldPosition, `pointers[${index}].worldPosition`) }),
			updatedAt: timestamp,
		} as IProjectCollaborationPointer;
	});
	const keys = pointers.map((pointer) => `${pointer.viewport}\0${pointer.id}`);
	if (new Set(keys).size !== keys.length) {
		throw new Error("Each pointer id must be unique within its viewport.");
	}
	return pointers;
}

function validateCamera(value: unknown, timestamp: string): IProjectCollaborationCamera | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("camera must be an object.");
	}
	const camera = value as any;
	const fovDegrees = camera.fovDegrees;
	const orthographicSize = camera.orthographicSize;
	if (fovDegrees !== undefined && (typeof fovDegrees !== "number" || !Number.isFinite(fovDegrees) || fovDegrees < 1 || fovDegrees > 179)) {
		throw new Error("camera.fovDegrees must be from 1 through 179.");
	}
	if (
		orthographicSize !== undefined &&
		(typeof orthographicSize !== "number" || !Number.isFinite(orthographicSize) || orthographicSize <= 0 || orthographicSize > 1_000_000_000)
	) {
		throw new Error("camera.orthographicSize must be positive and at most 1,000,000,000.");
	}
	const position = validateVector3(camera.position, "camera.position");
	const target = validateVector3(camera.target, "camera.target");
	const up = validateVector3(camera.up ?? [0, 1, 0], "camera.up");
	if (Math.hypot(target[0] - position[0], target[1] - position[1], target[2] - position[2]) < 1e-9) {
		throw new Error("camera.target must differ from camera.position.");
	}
	if (Math.hypot(...up) < 1e-9) {
		throw new Error("camera.up must be non-zero.");
	}
	return {
		viewport: validateName(camera.viewport ?? "scene", "camera.viewport"),
		position,
		target,
		up,
		...(fovDegrees === undefined ? {} : { fovDegrees }),
		...(orthographicSize === undefined ? {} : { orthographicSize }),
		updatedAt: timestamp,
	};
}

function validateRole(value: unknown): ProjectCollaborationRole {
	if (!(["admin", "editor", "viewer"] as unknown[]).includes(value)) {
		throw new Error("role must be admin, editor, or viewer.");
	}
	return value as ProjectCollaborationRole;
}

function validateTtl(value: unknown): number {
	const ttl = value ?? defaultSessionTtlSeconds;
	if (!Number.isInteger(ttl) || (ttl as number) < minimumSessionTtlSeconds || (ttl as number) > maximumSessionTtlSeconds) {
		throw new Error(`ttlSeconds must be an integer from ${minimumSessionTtlSeconds} through ${maximumSessionTtlSeconds}.`);
	}
	return ttl as number;
}

function hashAccessKey(value: string): string {
	const salt = randomBytes(16).toString("hex");
	return `${salt}:${scryptSync(value, salt, 32).toString("hex")}`;
}

function verifyAccessKey(value: string, encoded: string): boolean {
	const [salt, expectedHex] = encoded.split(":");
	if (!salt || !/^[a-f0-9]{64}$/.test(expectedHex ?? "")) {
		return false;
	}
	const actual = scryptSync(value, salt, 32);
	const expected = Buffer.from(expectedHex, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function hashSessionToken(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function createCredential(): string {
	return randomBytes(32).toString("base64url");
}

function isMember(value: any): value is IProjectCollaborationMember {
	return (
		typeof value?.id === "string" &&
		/^[0-9a-f-]{36}$/i.test(value.id) &&
		typeof value.name === "string" &&
		["admin", "editor", "viewer"].includes(value.role) &&
		typeof value.enabled === "boolean" &&
		typeof value.accessKeyHash === "string" &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		Number.isFinite(Date.parse(value.updatedAt))
	);
}

function isSession(value: any): value is IProjectCollaborationSession {
	const structurallyValid =
		typeof value?.id === "string" &&
		/^[0-9a-f-]{36}$/i.test(value.id) &&
		typeof value.memberId === "string" &&
		typeof value.clientName === "string" &&
		typeof value.state === "string" &&
		(value.selectionNodeIds === undefined ||
			(Array.isArray(value.selectionNodeIds) && value.selectionNodeIds.length <= 64 && value.selectionNodeIds.every((id: unknown) => typeof id === "string"))) &&
		(value.cursor === undefined || (typeof value.cursor?.x === "number" && typeof value.cursor?.y === "number" && typeof value.cursor?.viewport === "string")) &&
		(value.color === undefined || (typeof value.color === "string" && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value.color))) &&
		(value.toolMode === undefined || ["select", "move", "rotate", "scale", "rect", "paint", "terrain", "animate", "play", "navigate", "custom"].includes(value.toolMode)) &&
		(value.primarySelectionNodeId === undefined || typeof value.primarySelectionNodeId === "string") &&
		(value.hoveredNodeId === undefined || typeof value.hoveredNodeId === "string") &&
		(value.pointers === undefined ||
			(Array.isArray(value.pointers) && value.pointers.length <= 8 && value.pointers.every((pointer: any) => Number.isFinite(Date.parse(pointer?.updatedAt))))) &&
		(value.camera === undefined || Number.isFinite(Date.parse(value.camera?.updatedAt))) &&
		/^[a-f0-9]{64}$/.test(value.tokenHash) &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		Number.isFinite(Date.parse(value.lastSeenAt)) &&
		Number.isFinite(Date.parse(value.expiresAt));
	if (!structurallyValid) {
		return false;
	}
	try {
		validateSelectionNodeIds(value.selectionNodeIds);
		validateCursor(value.cursor);
		if (value.color !== undefined) {
			validateColor(value.color, value.memberId);
		}
		if (value.toolMode !== undefined) {
			validateToolMode(value.toolMode);
		}
		validateNodeId(value.primarySelectionNodeId, "primarySelectionNodeId");
		validateNodeId(value.hoveredNodeId, "hoveredNodeId");
		if (value.pointers !== undefined) {
			validatePointers(value.pointers, value.lastSeenAt);
		}
		if (value.camera !== undefined) {
			validateCamera(value.camera, value.lastSeenAt);
		}
		return true;
	} catch {
		return false;
	}
}

async function readStore(root: string): Promise<IProjectCollaborationStore> {
	try {
		const value = JSON.parse(await readFile(storePath(root), "utf-8"));
		if (
			value?.version !== storeVersion ||
			typeof value.enforcementEnabled !== "boolean" ||
			!Array.isArray(value.members) ||
			value.members.length > maximumMembers ||
			!value.members.every(isMember) ||
			!Array.isArray(value.sessions) ||
			value.sessions.length > maximumSessions ||
			!value.sessions.every(isSession)
		) {
			throw new Error("The project collaboration store has an unsupported or malformed schema.");
		}
		return value;
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return emptyStore();
		}
		if (error instanceof SyntaxError) {
			throw new Error("The project collaboration store contains invalid JSON. Repair .babylon-editor/collaboration.json before continuing.");
		}
		throw error;
	}
}

async function writeStore(root: string, store: IProjectCollaborationStore): Promise<void> {
	const path = storePath(root);
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(store, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function withStoreGuard<T>(root: string, action: (store: IProjectCollaborationStore) => Promise<T>): Promise<T> {
	const directory = storeDirectory(root);
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".collaboration.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const candidate = await open(guardPath, "wx");
			try {
				await candidate.writeFile(`${Date.now()}\n`, "utf-8");
				handle = candidate;
			} catch (error) {
				await candidate.close().catch(() => undefined);
				await unlink(guardPath).catch(() => undefined);
				throw error;
			}
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") {
				throw error;
			}
			const guardStat = await stat(guardPath).catch(() => null);
			if (guardStat && Date.now() - guardStat.mtimeMs > operationGuardStaleMilliseconds) {
				await unlink(guardPath).catch(() => undefined);
			} else {
				await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		}
	}
	if (!handle) {
		throw new Error("The project collaboration store is busy. Retry the operation.");
	}
	try {
		return await action(await readStore(root));
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

function activeSession(store: IProjectCollaborationStore, token: unknown): { session: IProjectCollaborationSession; member: IProjectCollaborationMember } {
	if (typeof token !== "string" || !token || token.length > 128) {
		throw new Error("A valid collaboration session is required. Join with join_project_collaboration_session first.");
	}
	const tokenHash = hashSessionToken(token);
	const session = store.sessions.find((candidate) => candidate.tokenHash === tokenHash);
	if (!session || Date.parse(session.expiresAt) <= Date.now()) {
		throw new Error("The collaboration session is missing or expired. Join the project collaboration session again.");
	}
	const member = store.members.find((candidate) => candidate.id === session.memberId);
	if (!member || !member.enabled) {
		throw new Error("The collaboration member is missing or disabled. Ask a project administrator for access.");
	}
	return { session, member };
}

function requireAdmin(store: IProjectCollaborationStore, token: unknown): { session: IProjectCollaborationSession; member: IProjectCollaborationMember } {
	const actor = activeSession(store, token);
	if (actor.member.role !== "admin") {
		throw new Error("Project collaboration administration requires the admin role.");
	}
	return actor;
}

function publicMember(member: IProjectCollaborationMember): Omit<IProjectCollaborationMember, "accessKeyHash"> {
	const { accessKeyHash: _accessKeyHash, ...result } = member;
	return result;
}

function publicPresence(store: IProjectCollaborationStore): any[] {
	const now = Date.now();
	return store.sessions
		.filter((session) => Date.parse(session.expiresAt) > now)
		.map((session) => {
			const member = store.members.find((candidate) => candidate.id === session.memberId);
			const pointers =
				session.pointers ??
				(session.cursor
					? [
							{
								id: "legacy",
								viewport: session.cursor.viewport,
								x: session.cursor.x,
								y: session.cursor.y,
								pointerType: "mouse",
								buttons: 0,
								pressure: 0,
								updatedAt: session.lastSeenAt,
							},
						]
					: []);
			return {
				sessionId: session.id,
				memberId: session.memberId,
				memberName: member?.name ?? "Unknown member",
				role: member?.role ?? null,
				clientName: session.clientName,
				state: session.state,
				selectionNodeIds: session.selectionNodeIds ?? [],
				cursor: session.cursor ?? null,
				color: session.color ?? validateColor(undefined, session.memberId),
				toolMode: session.toolMode ?? "select",
				primarySelectionNodeId: session.primarySelectionNodeId ?? session.selectionNodeIds?.[0] ?? null,
				hoveredNodeId: session.hoveredNodeId ?? null,
				pointers,
				camera: session.camera ?? null,
				createdAt: session.createdAt,
				lastSeenAt: session.lastSeenAt,
				expiresAt: session.expiresAt,
			};
		});
}

export function isReadOnlyMcpEndpoint(endpoint: string): boolean {
	return readOnlyEndpointPrefixes.some((prefix) => endpoint.startsWith(prefix)) || additionalReadOnlyEndpoints.has(endpoint);
}

/** Enforces opt-in project collaboration roles for one central editor HTTP request. */
export async function authorizeProjectCollaborationRequest(endpoint: string, data: any, options: IMCPActionOptions): Promise<void> {
	if (collaborationEndpoints.has(endpoint)) {
		return;
	}
	const store = await readStore(projectDirectory(options));
	if (!store.enforcementEnabled) {
		return;
	}
	const actor = activeSession(store, data.collaborationToken);
	if (actor.member.role === "viewer" && !isReadOnlyMcpEndpoint(endpoint)) {
		throw new Error(`Collaboration role viewer cannot call mutating endpoint ${endpoint}. Ask an admin to grant editor access.`);
	}
}

export async function resolveProjectCollaborationActor(token: unknown, options: IMCPActionOptions): Promise<any> {
	const store = await readStore(projectDirectory(options));
	const actor = activeSession(store, token);
	return {
		sessionId: actor.session.id,
		memberId: actor.member.id,
		memberName: actor.member.name,
		role: actor.member.role,
		clientName: actor.session.clientName,
		expiresAt: actor.session.expiresAt,
	};
}

export async function getProjectCollaborationStatus(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const store = await readStore(projectDirectory(options));
	let actor: any = null;
	if (data.collaborationToken) {
		try {
			const resolved = activeSession(store, data.collaborationToken);
			actor = { sessionId: resolved.session.id, member: publicMember(resolved.member), expiresAt: resolved.session.expiresAt };
		} catch {
			actor = null;
		}
	}
	return { enforcementEnabled: store.enforcementEnabled, memberCount: store.members.length, activeSessionCount: publicPresence(store).length, actor };
}

export async function configureProjectCollaboration(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		if (typeof data.enabled !== "boolean") {
			throw new Error("enabled must be a boolean.");
		}
		if (store.enforcementEnabled) {
			requireAdmin(store, data.collaborationToken);
		}
		if (data.enabled === store.enforcementEnabled) {
			return { enforcementEnabled: store.enforcementEnabled, bootstrap: null };
		}
		if (!data.enabled) {
			store.enforcementEnabled = false;
			store.members = [];
			store.sessions = [];
			await writeStore(root, store);
			return { enforcementEnabled: false, bootstrap: null };
		}
		const accessKey = createCredential();
		const timestamp = new Date().toISOString();
		const member: IProjectCollaborationMember = {
			id: randomUUID(),
			name: validateName(data.bootstrapAdminName ?? "Project Administrator", "bootstrapAdminName"),
			role: "admin",
			enabled: true,
			accessKeyHash: hashAccessKey(accessKey),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.enforcementEnabled = true;
		store.members = [member];
		store.sessions = [];
		await writeStore(root, store);
		return { enforcementEnabled: true, bootstrap: { member: publicMember(member), accessKey } };
	});
}

export async function listProjectCollaborationMembers(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const store = await readStore(projectDirectory(options));
	if (store.enforcementEnabled) {
		activeSession(store, data.collaborationToken);
	}
	return { members: store.members.map(publicMember), total: store.members.length };
}

export async function createProjectCollaborationMember(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		requireAdmin(store, data.collaborationToken);
		if (store.members.length >= maximumMembers) {
			throw new Error(`A project can contain at most ${maximumMembers} collaboration members.`);
		}
		const name = validateName(data.name, "name");
		if (store.members.some((member) => member.name.toLowerCase() === name.toLowerCase())) {
			throw new Error(`A collaboration member named "${name}" already exists.`);
		}
		const accessKey = createCredential();
		const timestamp = new Date().toISOString();
		const member: IProjectCollaborationMember = {
			id: randomUUID(),
			name,
			role: validateRole(data.role),
			enabled: data.enabled ?? true,
			accessKeyHash: hashAccessKey(accessKey),
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		store.members.push(member);
		await writeStore(root, store);
		return { member: publicMember(member), accessKey };
	});
}

export async function setProjectCollaborationMember(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const actor = requireAdmin(store, data.collaborationToken);
		const member = store.members.find((candidate) => candidate.id === data.id);
		if (!member) {
			throw new Error(`Collaboration member was not found: ${data.id}`);
		}
		const name = data.name === undefined ? member.name : validateName(data.name, "name");
		if (store.members.some((candidate) => candidate.id !== member.id && candidate.name.toLowerCase() === name.toLowerCase())) {
			throw new Error(`A collaboration member named "${name}" already exists.`);
		}
		const role = data.role === undefined ? member.role : validateRole(data.role);
		const enabled = data.enabled ?? member.enabled;
		const remainingAdmins = store.members.filter((candidate) => candidate.id !== member.id && candidate.enabled && candidate.role === "admin").length;
		if (member.role === "admin" && member.enabled && (role !== "admin" || !enabled) && remainingAdmins === 0) {
			throw new Error("The last enabled collaboration admin cannot be demoted or disabled.");
		}
		if (actor.member.id === member.id && !enabled) {
			throw new Error("An administrator cannot disable their own active member account.");
		}
		let accessKey: string | null = null;
		Object.assign(member, { name, role, enabled, updatedAt: new Date().toISOString() });
		if (data.rotateAccessKey === true) {
			accessKey = createCredential();
			member.accessKeyHash = hashAccessKey(accessKey);
			store.sessions = store.sessions.filter((session) => session.memberId !== member.id);
		}
		if (!enabled) {
			store.sessions = store.sessions.filter((session) => session.memberId !== member.id);
		}
		await writeStore(root, store);
		return { member: publicMember(member), accessKey };
	});
}

export async function deleteProjectCollaborationMember(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const actor = requireAdmin(store, data.collaborationToken);
		const index = store.members.findIndex((member) => member.id === data.id);
		if (index === -1) {
			throw new Error(`Collaboration member was not found: ${data.id}`);
		}
		const member = store.members[index];
		if (actor.member.id === member.id) {
			throw new Error("An administrator cannot delete their own active member account.");
		}
		if (member.role === "admin" && member.enabled && store.members.filter((candidate) => candidate.enabled && candidate.role === "admin").length === 1) {
			throw new Error("The last enabled collaboration admin cannot be deleted.");
		}
		store.members.splice(index, 1);
		store.sessions = store.sessions.filter((session) => session.memberId !== member.id);
		await writeStore(root, store);
		return { deleted: true, member: publicMember(member) };
	});
}

export async function joinProjectCollaborationSession(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		if (!store.enforcementEnabled) {
			throw new Error("Project collaboration enforcement is not enabled.");
		}
		const member = store.members.find((candidate) => candidate.id === data.memberId);
		if (!member || !member.enabled || typeof data.accessKey !== "string" || !verifyAccessKey(data.accessKey, member.accessKeyHash)) {
			throw new Error("Collaboration member id or access key is invalid, or the member is disabled.");
		}
		const ttlSeconds = validateTtl(data.ttlSeconds);
		const now = new Date();
		store.sessions = store.sessions.filter((session) => Date.parse(session.expiresAt) > now.getTime());
		if (store.sessions.length >= maximumSessions) {
			throw new Error(`A project can contain at most ${maximumSessions} active collaboration sessions.`);
		}
		const token = createCredential();
		const timestamp = now.toISOString();
		const selectionNodeIds = validateSelectionNodeIds(data.selectionNodeIds);
		const pointers = validatePointers(data.pointers, timestamp);
		const legacyCursor = validateCursor(data.cursor);
		const cursor = legacyCursor ?? (pointers?.[0] ? { x: pointers[0].x, y: pointers[0].y, viewport: pointers[0].viewport } : undefined);
		const primarySelectionNodeId = validateNodeId(data.primarySelectionNodeId, "primarySelectionNodeId");
		const hoveredNodeId = validateNodeId(data.hoveredNodeId, "hoveredNodeId");
		const camera = validateCamera(data.camera, timestamp);
		if (primarySelectionNodeId && selectionNodeIds && !selectionNodeIds.includes(primarySelectionNodeId)) {
			throw new Error("primarySelectionNodeId must be included in selectionNodeIds when both are provided.");
		}
		const session: IProjectCollaborationSession = {
			id: randomUUID(),
			memberId: member.id,
			clientName: validateName(data.clientName, "clientName"),
			state: validateState(data.state),
			...(selectionNodeIds === undefined ? {} : { selectionNodeIds }),
			...(cursor ? { cursor } : {}),
			color: validateColor(data.color, member.id),
			toolMode: validateToolMode(data.toolMode),
			...(primarySelectionNodeId ? { primarySelectionNodeId } : {}),
			...(hoveredNodeId ? { hoveredNodeId } : {}),
			...(pointers === undefined ? {} : { pointers }),
			...(camera ? { camera } : {}),
			tokenHash: hashSessionToken(token),
			createdAt: timestamp,
			lastSeenAt: timestamp,
			expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
		};
		store.sessions.push(session);
		await writeStore(root, store);
		return { session: { ...publicPresence(store).find((entry) => entry.sessionId === session.id), token }, member: publicMember(member), ttlSeconds };
	});
}

export async function heartbeatProjectCollaborationSession(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const actor = activeSession(store, data.collaborationToken);
		const ttlSeconds = validateTtl(data.ttlSeconds);
		const now = new Date();
		const timestamp = now.toISOString();
		actor.session.state = data.state === undefined ? actor.session.state : validateState(data.state);
		if (data.selectionNodeIds !== undefined) {
			actor.session.selectionNodeIds = validateSelectionNodeIds(data.selectionNodeIds);
		}
		if (data.cursor !== undefined) {
			actor.session.cursor = validateCursor(data.cursor);
			actor.session.pointers = undefined;
		}
		if (data.color !== undefined) {
			actor.session.color = validateColor(data.color, actor.member.id);
		}
		if (data.toolMode !== undefined) {
			actor.session.toolMode = validateToolMode(data.toolMode);
		}
		if (data.primarySelectionNodeId !== undefined) {
			actor.session.primarySelectionNodeId = validateNodeId(data.primarySelectionNodeId, "primarySelectionNodeId");
		}
		if (data.hoveredNodeId !== undefined) {
			actor.session.hoveredNodeId = validateNodeId(data.hoveredNodeId, "hoveredNodeId");
		}
		if (data.pointers !== undefined) {
			const pointers = validatePointers(data.pointers, timestamp) ?? [];
			actor.session.pointers = pointers;
			actor.session.cursor = pointers[0] ? { x: pointers[0].x, y: pointers[0].y, viewport: pointers[0].viewport } : undefined;
		}
		if (data.camera !== undefined) {
			actor.session.camera = validateCamera(data.camera, timestamp);
		}
		if (actor.session.primarySelectionNodeId && actor.session.selectionNodeIds && !actor.session.selectionNodeIds.includes(actor.session.primarySelectionNodeId)) {
			throw new Error("primarySelectionNodeId must be included in selectionNodeIds.");
		}
		actor.session.lastSeenAt = timestamp;
		actor.session.expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
		await writeStore(root, store);
		return { session: publicPresence(store).find((entry) => entry.sessionId === actor.session.id), member: publicMember(actor.member), ttlSeconds };
	});
}

export async function leaveProjectCollaborationSession(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const root = projectDirectory(options);
	return withStoreGuard(root, async (store) => {
		const actor = activeSession(store, data.collaborationToken);
		store.sessions = store.sessions.filter((session) => session.id !== actor.session.id);
		await writeStore(root, store);
		return { left: true, sessionId: actor.session.id };
	});
}

export async function listProjectCollaborationPresence(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const store = await readStore(projectDirectory(options));
	if (store.enforcementEnabled) {
		activeSession(store, data.collaborationToken);
	}
	const presence = publicPresence(store);
	return { presence, total: presence.length };
}
