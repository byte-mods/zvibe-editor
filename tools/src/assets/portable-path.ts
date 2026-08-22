/** Small POSIX-path helpers that are safe in browser and Node runtimes. */
export function normalizePortablePath(value: string): string {
	const source = value.replace(/\\/g, "/");
	const absolute = source.startsWith("/");
	const segments: string[] = [];
	for (const segment of source.split("/")) {
		if (!segment || segment === ".") {
			continue;
		}
		if (segment === "..") {
			if (segments.length && segments.at(-1) !== "..") {
				segments.pop();
			} else if (!absolute) {
				segments.push(segment);
			}
		} else {
			segments.push(segment);
		}
	}
	const normalized = `${absolute ? "/" : ""}${segments.join("/")}`;
	return normalized || (absolute ? "/" : ".");
}

export function isAbsolutePortablePath(value: string): boolean {
	return value.replace(/\\/g, "/").startsWith("/");
}

export function joinPortablePath(...values: string[]): string {
	return normalizePortablePath(values.filter(Boolean).join("/"));
}

export function dirnamePortablePath(value: string): string {
	const normalized = normalizePortablePath(value);
	if (normalized === "/" || normalized === ".") {
		return normalized;
	}
	const index = normalized.lastIndexOf("/");
	if (index < 0) {
		return ".";
	}
	return index === 0 ? "/" : normalized.slice(0, index);
}

export function basenamePortablePath(value: string, suffix?: string): string {
	const normalized = normalizePortablePath(value);
	if (normalized === "/" || normalized === ".") {
		return normalized === "/" ? "" : ".";
	}
	const result = normalized.slice(normalized.lastIndexOf("/") + 1);
	return suffix && result.endsWith(suffix) ? result.slice(0, -suffix.length) : result;
}

export function extnamePortablePath(value: string): string {
	const basename = basenamePortablePath(value);
	const index = basename.lastIndexOf(".");
	return index <= 0 ? "" : basename.slice(index);
}
