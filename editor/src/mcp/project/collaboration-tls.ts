import { createPrivateKey, createPublicKey, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from "crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from "fs/promises";
import { isIP } from "net";
import { dirname, extname, join, normalize, resolve } from "path/posix";

import forge from "node-forge";
import { Scene } from "babylonjs";

import { IMCPActionOptions } from "../action";
import { resolveProjectCollaborationActor } from "./collaboration";

const maximumCertificateBytes = 128 * 1024;
const operationGuardStaleMilliseconds = 10000;

interface ICertificatePaths {
	certificatePath: string;
	privateKeyPath: string;
	absoluteCertificatePath: string;
	absolutePrivateKeyPath: string;
}

function projectDirectory(options: IMCPActionOptions): string {
	if (!options.editor.state.projectPath) {
		throw new Error("No project is currently open.");
	}
	return dirname(options.editor.state.projectPath);
}

function validateRelativePath(value: unknown, field: string, extensions: string[]): string {
	if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
		throw new Error(`${field} must be a non-empty project-relative path.`);
	}
	const path = normalize(value.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
	if (path === "." || path.startsWith("/") || path.split("/").includes("..") || path === ".babylon-editor" || path.startsWith(".babylon-editor/")) {
		throw new Error(`${field} must stay inside the project and outside editor metadata.`);
	}
	if (!extensions.includes(extname(path).toLowerCase())) {
		throw new Error(`${field} must use one of these extensions: ${extensions.join(", ")}.`);
	}
	return path;
}

async function resolveContainedDestination(root: string, path: string): Promise<string> {
	const absolute = resolve(root, path);
	await mkdir(dirname(absolute), { recursive: true });
	const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(absolute))]);
	if (realParent !== realRoot && !realParent.startsWith(`${realRoot}/`)) {
		throw new Error(`Certificate destination resolves outside the project: ${path}`);
	}
	return join(realParent, absolute.slice(dirname(absolute).length + 1));
}

async function resolvePaths(data: any, options: IMCPActionOptions): Promise<ICertificatePaths> {
	const root = projectDirectory(options);
	const certificatePath = validateRelativePath(data.certificatePath ?? "certs/collaboration.crt", "certificatePath", [".crt", ".cer", ".pem"]);
	const privateKeyPath = validateRelativePath(data.privateKeyPath ?? "certs/collaboration.key", "privateKeyPath", [".key", ".pem"]);
	if (certificatePath === privateKeyPath) {
		throw new Error("certificatePath and privateKeyPath must be different files.");
	}
	const [absoluteCertificatePath, absolutePrivateKeyPath] = await Promise.all([
		resolveContainedDestination(root, certificatePath),
		resolveContainedDestination(root, privateKeyPath),
	]);
	return { certificatePath, privateKeyPath, absoluteCertificatePath, absolutePrivateKeyPath };
}

function validateHosts(value: unknown): string[] {
	const hosts = value ?? ["localhost", "127.0.0.1", "::1"];
	if (!Array.isArray(hosts) || hosts.length < 1 || hosts.length > 32) {
		throw new Error("hosts must contain 1 through 32 DNS names or IP addresses.");
	}
	const normalized = hosts.map((host) => {
		if (typeof host !== "string" || !host || host.length > 253 || /[\r\n\0/]/.test(host)) {
			throw new Error("Each host must be a DNS name or IP address of at most 253 characters.");
		}
		const result = host.toLowerCase();
		if (!isIP(result) && !/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result)) {
			throw new Error(`Invalid certificate DNS name or IP address: ${host}`);
		}
		return result;
	});
	return [...new Set(normalized)];
}

async function exists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch((error: any) => {
			if (error?.code === "ENOENT") {
				return false;
			}
			throw error;
		});
}

async function withGuard<T>(root: string, action: () => Promise<T>): Promise<T> {
	const directory = join(root, ".babylon-editor");
	await mkdir(directory, { recursive: true });
	const guardPath = join(directory, ".collaboration-tls.operation");
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			handle = await open(guardPath, "wx");
			break;
		} catch (error: any) {
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
		throw new Error("Collaboration TLS certificate generation is busy. Retry the operation.");
	}
	try {
		return await action();
	} finally {
		await handle.close().catch(() => undefined);
		await unlink(guardPath).catch(() => undefined);
	}
}

async function writePair(paths: ICertificatePaths, certificatePem: string, privateKeyPem: string, overwrite: boolean): Promise<boolean> {
	const certificateExists = await exists(paths.absoluteCertificatePath);
	const privateKeyExists = await exists(paths.absolutePrivateKeyPath);
	if ((certificateExists || privateKeyExists) && !overwrite) {
		throw new Error("Certificate or private-key destination already exists. Set confirmOverwrite=true to rotate the pair.");
	}
	const certificateTemporary = `${paths.absoluteCertificatePath}.${randomUUID()}.tmp`;
	const privateKeyTemporary = `${paths.absolutePrivateKeyPath}.${randomUUID()}.tmp`;
	const certificateBackup = `${paths.absoluteCertificatePath}.${randomUUID()}.bak`;
	const privateKeyBackup = `${paths.absolutePrivateKeyPath}.${randomUUID()}.bak`;
	await writeFile(certificateTemporary, certificatePem, { encoding: "utf-8", mode: 0o644 });
	await writeFile(privateKeyTemporary, privateKeyPem, { encoding: "utf-8", mode: 0o600 });
	let certificateBackedUp = false;
	let privateKeyBackedUp = false;
	try {
		if (certificateExists) {
			await rename(paths.absoluteCertificatePath, certificateBackup);
			certificateBackedUp = true;
		}
		if (privateKeyExists) {
			await rename(paths.absolutePrivateKeyPath, privateKeyBackup);
			privateKeyBackedUp = true;
		}
		await rename(certificateTemporary, paths.absoluteCertificatePath);
		await rename(privateKeyTemporary, paths.absolutePrivateKeyPath);
		await Promise.all([chmod(paths.absoluteCertificatePath, 0o644), chmod(paths.absolutePrivateKeyPath, 0o600)]);
		await Promise.all([unlink(certificateBackup).catch(() => undefined), unlink(privateKeyBackup).catch(() => undefined)]);
		return certificateExists || privateKeyExists;
	} catch (error) {
		await Promise.all([unlink(certificateTemporary).catch(() => undefined), unlink(privateKeyTemporary).catch(() => undefined)]);
		await Promise.all([unlink(paths.absoluteCertificatePath).catch(() => undefined), unlink(paths.absolutePrivateKeyPath).catch(() => undefined)]);
		if (certificateBackedUp) {
			await rename(certificateBackup, paths.absoluteCertificatePath).catch(() => undefined);
		}
		if (privateKeyBackedUp) {
			await rename(privateKeyBackup, paths.absolutePrivateKeyPath).catch(() => undefined);
		}
		throw error;
	}
}

async function readBounded(path: string, field: string): Promise<Buffer> {
	const details = await lstat(path);
	if (details.isSymbolicLink()) {
		throw new Error(`${field} must not be a symbolic link.`);
	}
	if (!details.isFile() || details.size < 1 || details.size > maximumCertificateBytes) {
		throw new Error(`${field} must be a non-empty file of at most ${maximumCertificateBytes} bytes.`);
	}
	return readFile(path);
}

function keyMatchesCertificate(certificate: X509Certificate, privateKeyPem: Buffer): boolean {
	try {
		const certificatePublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
		const privatePublicKey = createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" });
		return certificatePublicKey.length === privatePublicKey.length && timingSafeEqual(certificatePublicKey, privatePublicKey);
	} catch {
		return false;
	}
}

function trustGuidance(certificatePath: string): Record<string, string> {
	return {
		macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certificatePath}"`,
		Windows: `certutil -addstore -f Root "${certificatePath}"`,
		Linux: `Copy ${certificatePath} to your distribution's local CA directory, then run its CA update command (for example update-ca-certificates).`,
		warning: "Review the certificate fingerprint before trusting it. The editor never changes the operating-system trust store automatically.",
	};
}

export async function inspectRemoteCollaborationTlsCertificate(_scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	await resolveProjectCollaborationActor(data.collaborationToken, options);
	const paths = await resolvePaths(data, options);
	const certificatePem = await readBounded(paths.absoluteCertificatePath, "certificatePath");
	let certificate: X509Certificate;
	try {
		certificate = new X509Certificate(certificatePem);
	} catch {
		throw new Error("certificatePath does not contain a valid PEM or DER X.509 certificate.");
	}
	const validFrom = new Date(certificate.validFrom);
	const validTo = new Date(certificate.validTo);
	const now = Date.now();
	const privateKeyExists = await exists(paths.absolutePrivateKeyPath);
	const keyMatches = privateKeyExists ? keyMatchesCertificate(certificate, await readBounded(paths.absolutePrivateKeyPath, "privateKeyPath")) : null;
	return {
		certificatePath: paths.certificatePath,
		privateKeyPath: paths.privateKeyPath,
		subject: certificate.subject,
		issuer: certificate.issuer,
		serialNumber: certificate.serialNumber,
		fingerprint256: certificate.fingerprint256,
		subjectAltName: certificate.subjectAltName,
		validFrom: validFrom.toISOString(),
		validTo: validTo.toISOString(),
		daysRemaining: Math.floor((validTo.getTime() - now) / 86_400_000),
		validNow: validFrom.getTime() <= now && validTo.getTime() > now,
		expiresSoon: validTo.getTime() - now <= 30 * 86_400_000,
		ca: certificate.ca,
		keyType: certificate.publicKey.asymmetricKeyType,
		keyBits: certificate.publicKey.asymmetricKeyDetails?.modulusLength ?? null,
		privateKeyExists,
		keyMatches,
		trust: trustGuidance(paths.certificatePath),
	};
}

export async function generateRemoteCollaborationTlsCertificate(scene: Scene, data: any, options: IMCPActionOptions): Promise<any> {
	const actor = await resolveProjectCollaborationActor(data.collaborationToken, options);
	if (actor.role !== "admin") {
		throw new Error("Remote collaboration TLS certificate generation requires the admin role.");
	}
	const root = projectDirectory(options);
	const paths = await resolvePaths(data, options);
	const hosts = validateHosts(data.hosts);
	const commonName = data.commonName === undefined ? hosts[0] : validateHosts([data.commonName])[0];
	const validityDays = data.validityDays ?? 397;
	const rsaBits = data.rsaBits ?? 2048;
	if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > 825) {
		throw new Error("validityDays must be an integer from 1 through 825.");
	}
	if (![2048, 3072, 4096].includes(rsaBits)) {
		throw new Error("rsaBits must be 2048, 3072, or 4096.");
	}
	const rotated = await withGuard(root, async () => {
		const keys = forge.pki.rsa.generateKeyPair({ bits: rsaBits, e: 0x10001 });
		const certificate = forge.pki.createCertificate();
		certificate.publicKey = keys.publicKey;
		certificate.serialNumber = `01${randomBytes(15).toString("hex")}`;
		certificate.validity.notBefore = new Date(Date.now() - 5 * 60 * 1000);
		certificate.validity.notAfter = new Date(Date.now() + validityDays * 86_400_000);
		const attributes = [
			{ name: "commonName", value: commonName },
			{ name: "organizationName", value: "Babylon.js Editor Development" },
			{ shortName: "OU", value: "Remote Collaboration" },
		];
		certificate.setSubject(attributes);
		certificate.setIssuer(attributes);
		certificate.setExtensions([
			{ name: "basicConstraints", cA: false, critical: true },
			{ name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
			{ name: "extKeyUsage", serverAuth: true },
			{ name: "subjectAltName", altNames: hosts.map((host) => (isIP(host) ? { type: 7, ip: host } : { type: 2, value: host })) },
			{ name: "subjectKeyIdentifier" },
		]);
		certificate.sign(keys.privateKey, forge.md.sha256.create());
		return writePair(paths, forge.pki.certificateToPem(certificate), forge.pki.privateKeyToPem(keys.privateKey), data.confirmOverwrite === true);
	});
	return {
		generated: true,
		rotated,
		hosts,
		...(await inspectRemoteCollaborationTlsCertificate(scene, { ...data, ...paths, collaborationToken: data.collaborationToken }, options)),
	};
}
