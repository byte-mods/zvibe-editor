/** Converts a client pointer position to clamped normalized touch coordinates for a preview surface. */
export function toNormalizedTouchPosition(bounds: Pick<DOMRect, "left" | "top" | "width" | "height">, clientX: number, clientY: number): [number, number] {
	if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) {
		return [0.5, 0.5];
	}
	const x = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
	const y = Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height));
	return [x, y];
}
