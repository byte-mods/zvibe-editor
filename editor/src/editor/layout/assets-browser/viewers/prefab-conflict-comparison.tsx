export interface IPrefabConflictComparisonValue {
	exists: boolean;
	value: unknown;
	ambiguous?: boolean;
}

export interface IPrefabConflictComparison {
	base: IPrefabConflictComparisonValue;
	variant: IPrefabConflictComparisonValue;
	resolved: IPrefabConflictComparisonValue;
	live: IPrefabConflictComparisonValue | null;
}

function formatConflictValue(value: IPrefabConflictComparisonValue): string {
	if (!value?.exists) {
		return value?.ambiguous ? "Ambiguous matches" : "Does not exist";
	}
	const serialized = JSON.stringify(value.value, null, 2) ?? "null";
	return serialized.length > 800 ? `${serialized.slice(0, 800)}\n…` : serialized;
}

/** Pure presentation shared by Prefab Stage and focused render-contract tests. */
export function PrefabConflictComparisonPresentation(props: { conflict: IPrefabConflictComparison }) {
	return (
		<div className="grid grid-cols-3 gap-1">
			{[
				["Current Base", props.conflict.base],
				["Variant Override", props.conflict.variant],
				[props.conflict.live ? "Live Instance" : "Resolved Preview", props.conflict.live ?? props.conflict.resolved],
			].map(([label, value]) => (
				<div key={label as string} className="min-w-0 rounded bg-background/70 p-1.5">
					<div className="mb-1 font-medium">{label as string}</div>
					<pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-[9px] text-muted-foreground">
						{formatConflictValue(value as IPrefabConflictComparisonValue)}
					</pre>
				</div>
			))}
		</div>
	);
}
