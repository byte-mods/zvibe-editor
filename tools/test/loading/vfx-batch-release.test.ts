import { describe, expect, test, vi } from "vitest";

import {
	disposeVfxBatchReleaseController,
	getVfxBatchReleaseEvidence,
	handleVfxBatchHostEnabledChanged,
	registerVfxBatchReleaseController,
	setVfxBatchReleasePolicy,
} from "../../src/loading/vfx-batch-release";

interface IFakeBatch {
	id: number;
}

function createFixture(initialBatch: IFakeBatch | null = { id: 1 }) {
	const host = {};
	let enabled = true;
	let disposed = false;
	let batch = initialBatch;
	let nextId = 2;
	const disposeBatch = vi.fn();
	const publishBatch = vi.fn((candidate: IFakeBatch) => {
		batch = candidate;
	});
	registerVfxBatchReleaseController(
		host,
		{
			isHostEnabled: () => enabled,
			isHostDisposed: () => disposed,
			hasRebuildSource: () => true,
			getBatch: () => batch,
			detachBatch: () => {
				const current = batch;
				batch = null;
				return current;
			},
			buildBatch: async () => ({ id: nextId++ }),
			publishBatch,
			disposeBatch,
		},
		false
	);
	return {
		host,
		disposeBatch,
		publishBatch,
		setEnabled: (value: boolean) => {
			enabled = value;
		},
		setDisposed: (value: boolean) => {
			disposed = value;
		},
		getBatch: () => batch,
	};
}

describe("VFX batch release lifecycle", () => {
	test("retains a disabled batch while the policy is off", async () => {
		const fixture = createFixture();
		fixture.setEnabled(false);
		await handleVfxBatchHostEnabledChanged(fixture.host);
		expect(getVfxBatchReleaseEvidence(fixture.host)).toMatchObject({ policyEnabled: false, state: "retained-disabled", batchPresent: true, releaseCount: 0 });
		expect(fixture.disposeBatch).not.toHaveBeenCalled();
	});

	test("releases once on disable and rebuilds once on re-enable", async () => {
		const fixture = createFixture();
		await setVfxBatchReleasePolicy(fixture.host, true);
		fixture.setEnabled(false);
		await handleVfxBatchHostEnabledChanged(fixture.host);
		expect(getVfxBatchReleaseEvidence(fixture.host)).toMatchObject({ state: "released", batchPresent: false, releaseCount: 1, rebuildCount: 0 });
		expect(fixture.disposeBatch).toHaveBeenCalledWith({ id: 1 });

		fixture.setEnabled(true);
		await handleVfxBatchHostEnabledChanged(fixture.host);
		expect(fixture.getBatch()).toEqual({ id: 2 });
		expect(getVfxBatchReleaseEvidence(fixture.host)).toMatchObject({ state: "active", batchPresent: true, releaseCount: 1, rebuildCount: 1, lastError: null });
	});

	test("turning the policy off while disabled restores a retained batch", async () => {
		const fixture = createFixture();
		await setVfxBatchReleasePolicy(fixture.host, true);
		fixture.setEnabled(false);
		await handleVfxBatchHostEnabledChanged(fixture.host);
		await setVfxBatchReleasePolicy(fixture.host, false);
		expect(getVfxBatchReleaseEvidence(fixture.host)).toMatchObject({ policyEnabled: false, state: "retained-disabled", batchPresent: true, rebuildCount: 1 });
	});

	test("disposes an in-flight candidate when the host is destroyed", async () => {
		const host = {};
		let resolveBuild!: (batch: IFakeBatch) => void;
		const build = new Promise<IFakeBatch>((resolve) => (resolveBuild = resolve));
		const disposeBatch = vi.fn();
		registerVfxBatchReleaseController(
			host,
			{
				isHostEnabled: () => true,
				isHostDisposed: () => true,
				hasRebuildSource: () => true,
				getBatch: () => null,
				detachBatch: () => null,
				buildBatch: () => build,
				publishBatch: vi.fn(),
				disposeBatch,
			},
			true
		);
		const pending = handleVfxBatchHostEnabledChanged(host);
		resolveBuild({ id: 9 });
		await pending;
		expect(disposeBatch).toHaveBeenCalledWith({ id: 9 });
		expect(getVfxBatchReleaseEvidence(host).state).toBe("disposed");
		disposeVfxBatchReleaseController(host);
	});

	test("publishes an exact error and recovers on the next rebuild", async () => {
		const host = {};
		let batch: IFakeBatch | null = null;
		const buildBatch = vi.fn().mockRejectedValueOnce(new Error("shader compile failed")).mockResolvedValueOnce({ id: 2 });
		registerVfxBatchReleaseController(
			host,
			{
				isHostEnabled: () => true,
				isHostDisposed: () => false,
				hasRebuildSource: () => true,
				getBatch: () => batch,
				detachBatch: () => {
					const current = batch;
					batch = null;
					return current;
				},
				buildBatch,
				publishBatch: (candidate) => (batch = candidate),
				disposeBatch: vi.fn(),
			},
			true
		);

		await handleVfxBatchHostEnabledChanged(host);
		expect(getVfxBatchReleaseEvidence(host)).toMatchObject({ state: "error", batchPresent: false, lastError: "shader compile failed", rebuildCount: 0 });
		await handleVfxBatchHostEnabledChanged(host);
		expect(getVfxBatchReleaseEvidence(host)).toMatchObject({ state: "active", batchPresent: true, lastError: null, rebuildCount: 1 });
	});

	test("discards an in-flight rebuild when the host becomes disabled", async () => {
		const host = {};
		let enabled = true;
		let resolveBuild!: (batch: IFakeBatch) => void;
		const candidate = new Promise<IFakeBatch>((resolve) => (resolveBuild = resolve));
		const disposeBatch = vi.fn();
		registerVfxBatchReleaseController(
			host,
			{
				isHostEnabled: () => enabled,
				isHostDisposed: () => false,
				hasRebuildSource: () => true,
				getBatch: () => null,
				detachBatch: () => null,
				buildBatch: () => candidate,
				publishBatch: vi.fn(),
				disposeBatch,
			},
			true
		);

		const pending = handleVfxBatchHostEnabledChanged(host);
		enabled = false;
		await handleVfxBatchHostEnabledChanged(host);
		resolveBuild({ id: 3 });
		await pending;
		expect(disposeBatch).toHaveBeenCalledWith({ id: 3 });
		expect(getVfxBatchReleaseEvidence(host)).toMatchObject({ state: "released", batchPresent: false, rebuildCount: 0 });
	});
});
