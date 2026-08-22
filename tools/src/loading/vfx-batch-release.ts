export type VfxBatchReleaseState = "unbuilt" | "active" | "retained-disabled" | "released" | "rebuilding" | "error" | "disposed";

export interface IVfxBatchReleaseEvidence {
	policyEnabled: boolean;
	hostEnabled: boolean;
	state: VfxBatchReleaseState;
	batchPresent: boolean;
	releaseCount: number;
	rebuildCount: number;
	revision: number;
	lastError: string | null;
}

export interface IVfxBatchReleaseAdapter<TBatch extends object> {
	isHostEnabled: () => boolean;
	isHostDisposed: () => boolean;
	hasRebuildSource: () => boolean;
	getBatch: () => TBatch | null;
	detachBatch: () => TBatch | null;
	buildBatch: () => Promise<TBatch>;
	publishBatch: (batch: TBatch) => void;
	disposeBatch: (batch: TBatch) => void;
}

class VfxBatchReleaseController<TBatch extends object> {
	private _policyEnabled: boolean;
	private _state: VfxBatchReleaseState;
	private _releaseCount = 0;
	private _rebuildCount = 0;
	private _revision = 1;
	private _lastError: string | null = null;
	private _rebuildPromise: Promise<void> | null = null;
	private _disposed = false;

	public constructor(
		private readonly _adapter: IVfxBatchReleaseAdapter<TBatch>,
		policyEnabled: boolean
	) {
		this._policyEnabled = policyEnabled;
		this._state = this._deriveStableState();
	}

	public getEvidence(): IVfxBatchReleaseEvidence {
		return {
			policyEnabled: this._policyEnabled,
			hostEnabled: this._adapter.isHostEnabled(),
			state: this._state,
			batchPresent: this._adapter.getBatch() !== null,
			releaseCount: this._releaseCount,
			rebuildCount: this._rebuildCount,
			revision: this._revision,
			lastError: this._lastError,
		};
	}

	public async setPolicy(enabled: boolean): Promise<IVfxBatchReleaseEvidence> {
		if (this._disposed) {
			throw new Error("The VFX batch-release controller is disposed.");
		}
		if (this._policyEnabled !== enabled) {
			this._policyEnabled = enabled;
			this._revision++;
			this._lastError = null;
		}
		if (enabled) {
			await this.handleHostEnabledChanged();
		} else if (!this._adapter.getBatch() && this._adapter.hasRebuildSource()) {
			await this._rebuild(true);
		} else {
			this.refresh();
		}
		return this.getEvidence();
	}

	public async handleHostEnabledChanged(): Promise<IVfxBatchReleaseEvidence> {
		if (this._disposed) {
			return this.getEvidence();
		}
		if (!this._adapter.isHostEnabled()) {
			if (this._policyEnabled) {
				this._release();
			} else {
				this.refresh();
			}
		} else if (this._policyEnabled && !this._adapter.getBatch() && this._adapter.hasRebuildSource()) {
			await this._rebuild(false);
		} else {
			this.refresh();
		}
		return this.getEvidence();
	}

	public refresh(): IVfxBatchReleaseEvidence {
		if (!this._disposed && this._state !== "rebuilding") {
			this._state = this._deriveStableState();
			this._lastError = null;
			this._revision++;
		}
		return this.getEvidence();
	}

	public dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		this._state = "disposed";
		this._revision++;
	}

	private _deriveStableState(): VfxBatchReleaseState {
		if (this._disposed || this._adapter.isHostDisposed()) {
			return "disposed";
		}
		if (this._adapter.getBatch()) {
			return this._adapter.isHostEnabled() ? "active" : "retained-disabled";
		}
		if (this._policyEnabled && !this._adapter.isHostEnabled()) {
			return "released";
		}
		return "unbuilt";
	}

	private _release(): void {
		const batch = this._adapter.detachBatch();
		if (batch) {
			this._adapter.disposeBatch(batch);
			this._releaseCount++;
		}
		this._state = "released";
		this._lastError = null;
		this._revision++;
	}

	private async _rebuild(allowDisabled: boolean): Promise<void> {
		if (this._rebuildPromise) {
			await this._rebuildPromise;
			return;
		}
		if (!this._adapter.hasRebuildSource()) {
			this.refresh();
			return;
		}
		this._state = "rebuilding";
		this._lastError = null;
		this._revision++;
		this._rebuildPromise = (async () => {
			let candidate: TBatch | null = null;
			try {
				candidate = await this._adapter.buildBatch();
				if (this._disposed || this._adapter.isHostDisposed() || (!allowDisabled && this._policyEnabled && !this._adapter.isHostEnabled())) {
					this._adapter.disposeBatch(candidate);
					candidate = null;
					this._state = this._disposed || this._adapter.isHostDisposed() ? "disposed" : "released";
				} else {
					const previous = this._adapter.detachBatch();
					try {
						this._adapter.publishBatch(candidate);
						candidate = null;
						if (previous) {
							this._adapter.disposeBatch(previous);
						}
						this._rebuildCount++;
						this._state = this._deriveStableState();
					} catch (error) {
						if (previous) {
							this._adapter.publishBatch(previous);
						}
						throw error;
					}
				}
				this._lastError = null;
			} catch (error) {
				if (candidate) {
					this._adapter.disposeBatch(candidate);
				}
				this._state = "error";
				this._lastError = error instanceof Error ? error.message : String(error);
			} finally {
				this._revision++;
				this._rebuildPromise = null;
			}
		})();
		await this._rebuildPromise;
	}
}

const controllers = new WeakMap<object, VfxBatchReleaseController<any>>();

export function registerVfxBatchReleaseController<TBatch extends object>(host: object, adapter: IVfxBatchReleaseAdapter<TBatch>, policyEnabled = false): IVfxBatchReleaseEvidence {
	controllers.get(host)?.dispose();
	const controller = new VfxBatchReleaseController(adapter, policyEnabled);
	controllers.set(host, controller);
	return controller.getEvidence();
}

function resolveController(host: object): VfxBatchReleaseController<any> {
	const controller = controllers.get(host);
	if (!controller) {
		throw new Error("The object has no registered VFX batch-release lifecycle.");
	}
	return controller;
}

export function getVfxBatchReleaseEvidence(host: object): IVfxBatchReleaseEvidence {
	return resolveController(host).getEvidence();
}

export function refreshVfxBatchReleaseEvidence(host: object): IVfxBatchReleaseEvidence {
	return resolveController(host).refresh();
}

export function setVfxBatchReleasePolicy(host: object, enabled: boolean): Promise<IVfxBatchReleaseEvidence> {
	return resolveController(host).setPolicy(enabled);
}

export function handleVfxBatchHostEnabledChanged(host: object): Promise<IVfxBatchReleaseEvidence> {
	return resolveController(host).handleHostEnabledChanged();
}

export function disposeVfxBatchReleaseController(host: object): void {
	const controller = controllers.get(host);
	controller?.dispose();
	controllers.delete(host);
}
