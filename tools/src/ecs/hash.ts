function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([key, entry]) => [key, stableValue(entry)])
		);
	}
	return value;
}

/** Stable FNV-1a hash keeps browser, worker, and Node ECS state aligned. */
export function getECSStableHash(value: unknown): string {
	const text = JSON.stringify(stableValue(value));
	if (text === undefined) {
		throw new Error("ECS stable hashing requires a JSON-serializable value.");
	}
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < text.length; index++) {
		hash ^= BigInt(text.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}
