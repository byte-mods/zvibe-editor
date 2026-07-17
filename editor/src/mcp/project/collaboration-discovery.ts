import { randomUUID, X509Certificate } from "crypto";
import { createSocket, Socket } from "dgram";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "fs/promises";
import { isIPv4 } from "net";
import { basename, dirname, extname, join } from "path/posix";

import { Scene } from "babylonjs";

import type { Editor } from "../../editor/main";
import { IMCPActionOptions } from "../action";
import { resolveProjectCollaborationActor } from "./collaboration";

const discoveryProtocol = "babylon-editor-collaboration-discovery";
const discoveryVersion = 1;
const defaultDiscoveryAddress = "239.255.37.13";
const defaultDiscoveryPort = 3714;
const maximumDatagramBytes = 4096;
const maximumConfigBytes = 64 * 1024;

interface IRemoteCollaborationDiscoveryConfig {
	version: 1;
	enabled: boolean;
	discoveryId: string;
	displayName: string;
	address: string;
	port: number;
}

interface IDiscoveryQuery {
	protocol: typeof discoveryProtocol;
	version: 1;
	type: "query";
	nonce: string;
}

interface IDiscoveryAnnouncement {
	protocol: typeof discoveryProtocol;
	version: 1;
	type: "announcement";
	nonce: string;
	discoveryId: string;
	displayName: string;
	gatewayProtocol: "http" | "https";
	host: string;
	port: number;
	url: string;
	requiresAuthentication: true;
	tlsFingerprint256: string | null;
	expiresAt: string;
}

type GatewayStatus = {
	running: boolean;
	actualPort: number | null;
	protocol: "http" | "https";
	config: { bindAddress: string; port: number; tlsCertificatePath: string | null };
};

function projectDirectory(editor: Editor): string {
	if (!editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(editor.state.projectPath);
}

function configPath(editor: Editor): string {
	return join(projectDirectory(editor), ".babylon-editor", "remote-collaboration-discovery.json");
}

function defaultDisplayName(editor: Editor): string {
	const filename = basename(editor.state.projectPath ?? "Babylon Project");
	return filename.slice(0, Math.max(1, filename.length - extname(filename).length));
}

function isMulticastAddress(address: string): boolean {
	const first = Number(address.split(".")[0]);
	return first >= 224 && first <= 239;
}

function validateAddress(value: unknown): string {
	if (typeof value !== "string" || !isIPv4(value) || (!isMulticastAddress(value) && value !== "127.0.0.1")) {
		throw new Error("Discovery address must be an IPv4 multicast address or 127.0.0.1 for local-only discovery.");
	}
	return value;
}

function validateDisplayName(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.trim().length > 80 || /[\r\n\0]/.test(value)) {
		throw new Error("Discovery displayName must be 1–80 characters without line breaks or null bytes.");
	}
	return value.trim();
}

function validatePort(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
		throw new Error("Discovery port must be an integer from 1024 through 65535.");
	}
	return value as number;
}

function validateConfig(value: any): IRemoteCollaborationDiscoveryConfig {
	if (
		!value ||
		value.version !== discoveryVersion ||
		typeof value.enabled !== "boolean" ||
		typeof value.discoveryId !== "string" ||
		!/^[0-9a-f-]{36}$/i.test(value.discoveryId)
	) {
		throw new Error("Remote collaboration discovery configuration has an unsupported or malformed schema.");
	}
	return {
		version: discoveryVersion,
		enabled: value.enabled,
		discoveryId: value.discoveryId,
		displayName: validateDisplayName(value.displayName),
		address: validateAddress(value.address),
		port: validatePort(value.port),
	};
}

function defaultConfig(editor: Editor): IRemoteCollaborationDiscoveryConfig {
	return {
		version: discoveryVersion,
		enabled: false,
		discoveryId: randomUUID(),
		displayName: defaultDisplayName(editor),
		address: defaultDiscoveryAddress,
		port: defaultDiscoveryPort,
	};
}

async function readConfig(editor: Editor): Promise<IRemoteCollaborationDiscoveryConfig> {
	const path = configPath(editor);
	try {
		const details = await stat(path);
		if (!details.isFile() || details.size > maximumConfigBytes) {
			throw new Error(`Remote collaboration discovery configuration must be a file of at most ${maximumConfigBytes} bytes.`);
		}
		return validateConfig(JSON.parse(await readFile(path, "utf-8")));
	} catch (error: any) {
		if (error?.code === "ENOENT") {
			return defaultConfig(editor);
		}
		if (error instanceof SyntaxError) {
			throw new Error("Remote collaboration discovery configuration contains invalid JSON.");
		}
		throw error;
	}
}

async function writeConfig(editor: Editor, config: IRemoteCollaborationDiscoveryConfig): Promise<void> {
	const path = configPath(editor);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, "\t")}\n`, "utf-8");
	try {
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function encodeMessage(value: IDiscoveryQuery | IDiscoveryAnnouncement): Buffer {
	const payload = Buffer.from(JSON.stringify(value), "utf-8");
	if (payload.length > maximumDatagramBytes) {
		throw new Error(`Remote collaboration discovery messages are limited to ${maximumDatagramBytes} bytes.`);
	}
	return payload;
}

function parseQuery(message: Buffer): IDiscoveryQuery | null {
	if (message.length < 1 || message.length > maximumDatagramBytes) {
		return null;
	}
	try {
		const value = JSON.parse(message.toString("utf-8"));
		if (
			value?.protocol !== discoveryProtocol ||
			value.version !== discoveryVersion ||
			value.type !== "query" ||
			typeof value.nonce !== "string" ||
			!/^[0-9a-f-]{36}$/i.test(value.nonce)
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function parseAnnouncement(message: Buffer, nonce: string): IDiscoveryAnnouncement | null {
	if (message.length < 1 || message.length > maximumDatagramBytes) {
		return null;
	}
	try {
		const value = JSON.parse(message.toString("utf-8"));
		if (
			value?.protocol !== discoveryProtocol ||
			value.version !== discoveryVersion ||
			value.type !== "announcement" ||
			value.nonce !== nonce ||
			typeof value.discoveryId !== "string" ||
			!/^[0-9a-f-]{36}$/i.test(value.discoveryId) ||
			typeof value.displayName !== "string" ||
			!value.displayName ||
			value.displayName.length > 80 ||
			!["http", "https"].includes(value.gatewayProtocol) ||
			typeof value.host !== "string" ||
			!isIPv4(value.host) ||
			!Number.isInteger(value.port) ||
			value.port < 1024 ||
			value.port > 65535 ||
			typeof value.url !== "string" ||
			value.url !== `${value.gatewayProtocol}://${value.host}:${value.port}` ||
			value.requiresAuthentication !== true ||
			(value.tlsFingerprint256 !== null && (typeof value.tlsFingerprint256 !== "string" || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(value.tlsFingerprint256))) ||
			typeof value.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(value.expiresAt))
		) {
			return null;
		}
		return value;
	} catch {
		return null;
	}
}

function bindSocket(socket: Socket, port: number, address: string): Promise<void> {
	return new Promise((resolveBind, rejectBind) => {
		const onError = (error: Error): void => rejectBind(error);
		socket.once("error", onError);
		socket.bind(port, address, () => {
			socket.off("error", onError);
			resolveBind();
		});
	});
}

function sendMessage(socket: Socket, message: Buffer, port: number, address: string): Promise<void> {
	return new Promise((resolveSend, rejectSend) => socket.send(message, port, address, (error) => (error ? rejectSend(error) : resolveSend())));
}

function closeSocket(socket: Socket): Promise<void> {
	return new Promise((resolveClose) => {
		try {
			socket.close(() => resolveClose());
		} catch {
			resolveClose();
		}
	});
}

class RemoteCollaborationDiscoveryRuntime {
	private _editor: Editor | null = null;
	private _gatewayStatus: (() => GatewayStatus) | null = null;
	private _config: IRemoteCollaborationDiscoveryConfig | null = null;
	private _socket: Socket | null = null;
	private _lastError: string | null = null;
	private _responseCount = 0;

	public async initialize(editor: Editor, gatewayStatus: () => GatewayStatus): Promise<void> {
		await this.shutdown();
		this._editor = editor;
		this._gatewayStatus = gatewayStatus;
		try {
			this._config = await readConfig(editor);
			this._lastError = null;
		} catch (error) {
			this._config = defaultConfig(editor);
			this._lastError = `Discovery configuration was ignored: ${error instanceof Error ? error.message : String(error)}`;
		}
		await this.synchronize(false);
	}

	public status(): any {
		const gateway = this._gatewayStatus?.() ?? null;
		return {
			config: this._config,
			advertising: Boolean(this._socket),
			gatewayRunning: Boolean(gateway?.running),
			responseCount: this._responseCount,
			lastError: this._lastError,
			protocol: discoveryProtocol,
			version: discoveryVersion,
			privacy: {
				publishes: ["discoveryId", "displayName", "gatewayProtocol", "host", "port", "requiresAuthentication", "tlsFingerprint256", "expiresAt"],
				excludes: ["projectPath", "allowedHosts", "allowedOrigins", "members", "sessions", "tokens", "certificateContents", "privateKey"],
			},
			reason: this._config?.enabled
				? gateway?.running
					? this._socket
						? null
						: "Discovery listener failed to start."
					: "Start the remote collaboration gateway to advertise it."
				: "Discovery is disabled.",
		};
	}

	public async configure(data: any): Promise<any> {
		if (!this._editor || !this._config) {
			throw new Error("Remote collaboration discovery is not initialized.");
		}
		const previous = this._config;
		const next = validateConfig({
			...previous,
			...data,
			version: discoveryVersion,
			discoveryId: previous.discoveryId,
		});
		await this._stop();
		this._config = next;
		try {
			await this.synchronize(true);
			await writeConfig(this._editor, next);
		} catch (error) {
			await this._stop();
			this._config = previous;
			await this.synchronize(false);
			throw error;
		}
		return this.status();
	}

	public async synchronize(strict: boolean): Promise<void> {
		await this._stop();
		if (!this._config?.enabled || !this._gatewayStatus?.().running) {
			return;
		}
		try {
			await this._start();
			this._lastError = null;
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
			if (strict) {
				throw error;
			}
		}
	}

	public async shutdown(): Promise<void> {
		await this._stop();
		this._editor = null;
		this._gatewayStatus = null;
		this._config = null;
	}

	private async _start(): Promise<void> {
		const config = this._config!;
		const gatewayAddress = this._gatewayStatus!().config.bindAddress;
		if (!isIPv4(gatewayAddress) || gatewayAddress === "0.0.0.0") {
			throw new Error("LAN discovery requires the collaboration gateway to bind an explicit IPv4 interface address, not an IPv6 or wildcard address.");
		}
		const socket = createSocket({ type: "udp4", reuseAddr: true });
		this._socket = socket;
		socket.on("error", (error) => {
			this._lastError = error.message;
		});
		socket.on("message", (message, remote) => void this._handleQuery(message, remote.address, remote.port));
		try {
			await bindSocket(socket, config.port, isMulticastAddress(config.address) ? "0.0.0.0" : config.address);
			if (isMulticastAddress(config.address)) {
				socket.addMembership(config.address);
				socket.setMulticastTTL(1);
				socket.setMulticastLoopback(true);
			}
		} catch (error) {
			this._socket = null;
			await closeSocket(socket);
			throw error;
		}
	}

	private async _handleQuery(message: Buffer, address: string, port: number): Promise<void> {
		const query = parseQuery(message);
		if (!query || !this._socket) {
			return;
		}
		try {
			const announcement = await this._announcement(query.nonce);
			if (announcement) {
				await sendMessage(this._socket, encodeMessage(announcement), port, address);
				this._responseCount++;
			}
		} catch (error) {
			this._lastError = error instanceof Error ? error.message : String(error);
		}
	}

	private async _announcement(nonce: string): Promise<IDiscoveryAnnouncement | null> {
		if (!this._editor || !this._config || !this._gatewayStatus) {
			return null;
		}
		const gateway = this._gatewayStatus();
		if (!gateway.running) {
			return null;
		}
		let tlsFingerprint256: string | null = null;
		if (gateway.config.tlsCertificatePath) {
			const certificate = new X509Certificate(await readFile(join(projectDirectory(this._editor), gateway.config.tlsCertificatePath)));
			tlsFingerprint256 = certificate.fingerprint256;
		}
		const port = gateway.actualPort ?? gateway.config.port;
		const host = gateway.config.bindAddress;
		return {
			protocol: discoveryProtocol,
			version: discoveryVersion,
			type: "announcement",
			nonce,
			discoveryId: this._config.discoveryId,
			displayName: this._config.displayName,
			gatewayProtocol: gateway.protocol,
			host,
			port,
			url: `${gateway.protocol}://${host}:${port}`,
			requiresAuthentication: true,
			tlsFingerprint256,
			expiresAt: new Date(Date.now() + 15_000).toISOString(),
		};
	}

	private async _stop(): Promise<void> {
		if (this._socket) {
			const socket = this._socket;
			this._socket = null;
			await closeSocket(socket);
		}
	}
}

const discoveryRuntime = new RemoteCollaborationDiscoveryRuntime();

export async function initializeRemoteCollaborationDiscovery(editor: Editor, gatewayStatus: () => GatewayStatus): Promise<void> {
	await discoveryRuntime.initialize(editor, gatewayStatus);
}

export async function synchronizeRemoteCollaborationDiscovery(): Promise<void> {
	await discoveryRuntime.synchronize(false);
}

export async function shutdownRemoteCollaborationDiscovery(): Promise<void> {
	await discoveryRuntime.shutdown();
}

export async function getRemoteCollaborationDiscovery(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await resolveProjectCollaborationActor(data.collaborationToken, options);
	return discoveryRuntime.status();
}

export async function setRemoteCollaborationDiscovery(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Remote collaboration discovery configuration requires the admin role.");
	}
	return discoveryRuntime.configure(data);
}

export async function discoverRemoteCollaborationProjects(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await resolveProjectCollaborationActor(data.collaborationToken, options);
	const status = discoveryRuntime.status();
	const address = validateAddress(data.address ?? status.config?.address ?? defaultDiscoveryAddress);
	const port = validatePort(data.port ?? status.config?.port ?? defaultDiscoveryPort);
	const timeoutMs = data.timeoutMs ?? 750;
	if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 5000) {
		throw new Error("timeoutMs must be an integer from 100 through 5000.");
	}
	const nonce = randomUUID();
	const socket = createSocket("udp4");
	const projects = new Map<string, IDiscoveryAnnouncement>();
	socket.on("message", (message) => {
		const announcement = parseAnnouncement(message, nonce);
		if (announcement && Date.parse(announcement.expiresAt) > Date.now()) {
			projects.set(announcement.discoveryId, announcement);
		}
	});
	try {
		await bindSocket(socket, 0, "0.0.0.0");
		if (isMulticastAddress(address)) {
			socket.setMulticastTTL(1);
			socket.setMulticastLoopback(true);
		}
		await sendMessage(socket, encodeMessage({ protocol: discoveryProtocol, version: discoveryVersion, type: "query", nonce }), port, address);
		await new Promise<void>((resolveWait) => setTimeout(resolveWait, timeoutMs));
	} finally {
		await closeSocket(socket);
	}
	const items = [...projects.values()].sort((left, right) => left.displayName.localeCompare(right.displayName) || left.discoveryId.localeCompare(right.discoveryId));
	return {
		projects: items,
		count: items.length,
		target: { address, port },
		timeoutMs,
		untrustedDiscoveryMetadata: true,
		verification: "Authenticate with a separately obtained collaboration member credential and verify the TLS fingerprint before connecting.",
	};
}
