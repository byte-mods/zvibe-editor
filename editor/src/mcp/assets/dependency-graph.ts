export type AssetDependencyGraphDirection = "dependencies" | "referencedBy";
export type AssetDependencyGraphExportFormat = "json" | "dot" | "mermaid";

export interface IAssetDependencyGraphNode {
	path: string;
	guid: string | null;
	type: string | null;
	missing: boolean;
	depth: number;
	virtual?: boolean;
	containerPath?: string;
}

export interface IAssetDependencyGraphEdge {
	sourcePath: string;
	targetPath: string;
	missing: boolean;
	cyclic: boolean;
	relationship?: "dependency" | "contains";
}

export interface IAssetDependencyGraph {
	rootPath: string;
	direction: AssetDependencyGraphDirection;
	depth: number;
	nodes: IAssetDependencyGraphNode[];
	edges: IAssetDependencyGraphEdge[];
	cycles: string[][];
	truncated: boolean;
	limit: number;
}

function escapeGraphLabel(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

/**
 * Formats a bounded asset dependency graph for external graph tooling.
 */
export function formatAssetDependencyGraph(graph: IAssetDependencyGraph, format: AssetDependencyGraphExportFormat): string {
	if (format === "json") {
		return JSON.stringify(graph, null, "\t");
	}

	const nodeIds = new Map(graph.nodes.map((node, index) => [node.path, `n${index}`]));
	if (format === "dot") {
		const lines = ["digraph AssetDependencies {", '  rankdir="LR";', '  node [shape="box", style="rounded,filled", fontname="Arial"];'];
		for (const node of graph.nodes) {
			const attributes = [
				`label="${escapeGraphLabel(node.path)}"`,
				`fillcolor="${node.missing ? "#7f1d1d" : node.path === graph.rootPath ? "#1d4ed8" : "#27272a"}"`,
				'fontcolor="#ffffff"',
			];
			lines.push(`  ${nodeIds.get(node.path)} [${attributes.join(", ")}];`);
		}
		for (const edge of graph.edges) {
			const attributes =
				edge.relationship === "contains"
					? 'color="#38bdf8", style="dotted"'
					: edge.missing
						? 'color="#ef4444", style="dashed"'
						: edge.cyclic
							? 'color="#f59e0b", penwidth="2"'
							: 'color="#94a3b8"';
			lines.push(`  ${nodeIds.get(edge.sourcePath)} -> ${nodeIds.get(edge.targetPath)} [${attributes}];`);
		}
		lines.push("}");
		return lines.join("\n");
	}

	const lines = ["flowchart LR"];
	for (const node of graph.nodes) {
		const id = nodeIds.get(node.path);
		lines.push(`  ${id}["${escapeGraphLabel(node.path)}"]`);
		if (node.missing) {
			lines.push(`  style ${id} fill:#7f1d1d,color:#fff,stroke:#ef4444`);
		} else if (node.path === graph.rootPath) {
			lines.push(`  style ${id} fill:#1d4ed8,color:#fff,stroke:#60a5fa`);
		}
	}
	for (const edge of graph.edges) {
		lines.push(`  ${nodeIds.get(edge.sourcePath)} ${edge.missing || edge.relationship === "contains" ? "-.->" : "-->"} ${nodeIds.get(edge.targetPath)}`);
	}
	return lines.join("\n");
}
