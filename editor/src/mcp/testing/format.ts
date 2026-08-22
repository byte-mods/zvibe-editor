export function formatSceneTestAssertion(assertion: any): string {
	switch (assertion?.type) {
		case "node-exists":
			return `Node ${assertion.nodeId} exists = ${assertion.exists}`;
		case "node-enabled":
			return `Node ${assertion.nodeId} enabled = ${assertion.equals}`;
		case "node-position":
		case "node-rotation":
		case "node-scaling":
			return `Node ${assertion.nodeId} ${assertion.type.slice("node-".length)} = [${Array.isArray(assertion.equals) ? assertion.equals.join(", ") : "invalid"}]`;
		case "node-property":
			return `Node ${assertion.nodeId}.${assertion.path} ${assertion.operator} ${JSON.stringify(assertion.expected)}`;
		case "scene-count":
			return `${assertion.collection} ${assertion.operator} ${assertion.expected}`;
		default:
			return `Unsupported assertion: ${String(assertion?.type ?? "unknown")}`;
	}
}
