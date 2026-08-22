import { editorExtensionCapabilities, EditorExtensionCapability, IEditorExtensionTrustRecord, IEditorExtensionTrustStorage, IInstalledEditorExtension } from "./types";

/** Trust is intentionally machine-local and is never serialized into a shared project file. */
export const editorExtensionTrustStorageKey = "zvibe-editor-extension-trust-v1";

interface IEditorExtensionTrustStore {
	version: 1;
	records: IEditorExtensionTrustRecord[];
}

const capabilitySet = new Set<string>(editorExtensionCapabilities);
const maximumTrustStorageBytes = 1024 * 1024;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/;
const extensionIdPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const trustRecordKeys = ["packageName", "extensionId", "fingerprint", "capabilities", "trustedAt"];

function normalizeRecord(value: unknown): IEditorExtensionTrustRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const record = value as Partial<IEditorExtensionTrustRecord>;
	if (
		Object.keys(record).some((key) => !trustRecordKeys.includes(key)) ||
		typeof record.packageName !== "string" ||
		!packageNamePattern.test(record.packageName) ||
		record.packageName.length > 214 ||
		typeof record.extensionId !== "string" ||
		!extensionIdPattern.test(record.extensionId) ||
		record.extensionId.length > 128 ||
		typeof record.fingerprint !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.fingerprint) ||
		!Array.isArray(record.capabilities) ||
		record.capabilities.some((capability) => typeof capability !== "string" || !capabilitySet.has(capability)) ||
		new Set(record.capabilities).size !== record.capabilities.length ||
		typeof record.trustedAt !== "string" ||
		record.trustedAt.length > 32 ||
		!Number.isFinite(Date.parse(record.trustedAt)) ||
		new Date(record.trustedAt).toISOString() !== record.trustedAt
	) {
		return null;
	}
	return { ...record, capabilities: [...record.capabilities] as EditorExtensionCapability[] } as IEditorExtensionTrustRecord;
}

/** Reads only bounded, structurally valid grants; corrupt storage fails closed to no trust. */
export function readEditorExtensionTrustRecords(storage: IEditorExtensionTrustStorage): IEditorExtensionTrustRecord[] {
	try {
		const value = storage.getItem(editorExtensionTrustStorageKey);
		if (!value) {
			return [];
		}
		if (Buffer.byteLength(value, "utf8") > maximumTrustStorageBytes) {
			return [];
		}
		const parsed = JSON.parse(value) as Partial<IEditorExtensionTrustStore>;
		if (parsed.version !== 1 || !Array.isArray(parsed.records) || parsed.records.length > 256) {
			return [];
		}
		return parsed.records.map(normalizeRecord).filter((record): record is IEditorExtensionTrustRecord => Boolean(record));
	} catch {
		return [];
	}
}

function writeTrustRecords(storage: IEditorExtensionTrustStorage, records: readonly IEditorExtensionTrustRecord[]): void {
	const store: IEditorExtensionTrustStore = { version: 1, records: [...records].sort((left, right) => left.packageName.localeCompare(right.packageName)) };
	storage.setItem(editorExtensionTrustStorageKey, JSON.stringify(store));
}

/** Resolves trust only when identity, content fingerprint, and requested privileges still match. */
export function getEditorExtensionTrustRecord(storage: IEditorExtensionTrustStorage, extension: IInstalledEditorExtension): IEditorExtensionTrustRecord | null {
	const record = readEditorExtensionTrustRecords(storage).find((candidate) => candidate.packageName === extension.packageName);
	if (!record || record.extensionId !== extension.manifest.id || record.fingerprint !== extension.fingerprint) {
		return null;
	}
	return extension.manifest.capabilities.every((capability) => record.capabilities.includes(capability)) ? record : null;
}

/** Grants all and only the capabilities in the currently inspected manifest. */
export function trustEditorExtension(
	storage: IEditorExtensionTrustStorage,
	extension: IInstalledEditorExtension,
	capabilities: readonly EditorExtensionCapability[]
): IEditorExtensionTrustRecord {
	const uniqueCapabilities = [...new Set(capabilities)];
	if (
		uniqueCapabilities.length !== capabilities.length ||
		uniqueCapabilities.some((capability) => !extension.manifest.capabilities.includes(capability)) ||
		extension.manifest.capabilities.some((capability) => !uniqueCapabilities.includes(capability))
	) {
		throw new Error("Trusted capabilities must exactly match the extension manifest's requested capabilities.");
	}
	const record: IEditorExtensionTrustRecord = {
		packageName: extension.packageName,
		extensionId: extension.manifest.id,
		fingerprint: extension.fingerprint,
		capabilities: uniqueCapabilities,
		trustedAt: new Date().toISOString(),
	};
	const records = readEditorExtensionTrustRecords(storage).filter((candidate) => candidate.packageName !== extension.packageName);
	if (records.length >= 256) {
		throw new Error("Extension trust store already contains the maximum 256 records.");
	}
	writeTrustRecords(storage, [...records, record]);
	return record;
}

/** Removes the local grant for a package without changing project dependencies or settings. */
export function revokeEditorExtensionTrust(storage: IEditorExtensionTrustStorage, packageName: string): boolean {
	const records = readEditorExtensionTrustRecords(storage);
	const remaining = records.filter((candidate) => candidate.packageName !== packageName);
	if (remaining.length === records.length) {
		return false;
	}
	writeTrustRecords(storage, remaining);
	return true;
}
