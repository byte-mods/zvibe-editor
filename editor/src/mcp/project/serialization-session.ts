import { Scene } from "babylonjs";

import { getSerializationSessionDiagnostics } from "../../project/serialization-session";

/** Exposes one bounded read-only page of renderer-session serialization evidence. */
export function getProjectSerializationSession(_scene: Scene, data: any): object {
	return getSerializationSessionDiagnostics({ offset: data.offset ?? 0, limit: data.limit ?? 100 });
}
