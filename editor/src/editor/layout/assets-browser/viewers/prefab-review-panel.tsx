import { basename } from "path/posix";

import { useEffect, useState } from "react";

import { Scene } from "babylonjs";

import { addPrefabReviewComment, inspectPrefabReview, listPrefabReviews, setPrefabReview, submitPrefabReviewDecision } from "../../../../mcp/prefabs/reviews";
import { showConfirm } from "../../../../ui/dialog";
import { Button } from "../../../../ui/shadcn/ui/button";
import { Input } from "../../../../ui/shadcn/ui/input";

import { Editor } from "../../../main";

interface IPrefabReviewPanelProps {
	editor: Editor;
	scene: Scene;
	path: string;
	currentRevision: string | null;
}

interface IReviewIdentity {
	id: string;
	name: string;
}

function reviewIdentities(value: string): IReviewIdentity[] {
	const reviewers = value
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const separator = line.indexOf("|");
			const id = (separator < 0 ? line : line.slice(0, separator)).trim();
			const name = (separator < 0 ? line : line.slice(separator + 1)).trim();
			if (!id || !name) {
				throw new Error(`Reviewer line ${index + 1} must use stable-id | Display Name.`);
			}
			return { id, name };
		});
	if (new Set(reviewers.map((reviewer) => reviewer.id)).size !== reviewers.length) {
		throw new Error("Reviewer stable ids must be unique.");
	}
	return reviewers;
}

export function PrefabReviewPanel(props: IPrefabReviewPanelProps) {
	const [inspection, setInspection] = useState<any>(null);
	const [queue, setQueue] = useState<any>(null);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [title, setTitle] = useState(`Review ${basename(props.path)}`);
	const [ownerId, setOwnerId] = useState("");
	const [reviewerLines, setReviewerLines] = useState("");
	const [actorId, setActorId] = useState("local-editor");
	const [actorName, setActorName] = useState("Local Editor");
	const [collaborationToken, setCollaborationToken] = useState("");
	const [comment, setComment] = useState("");
	const [decisionBody, setDecisionBody] = useState("");

	const review = inspection?.exists ? inspection.review : null;
	const fingerprint = review?.fingerprint ?? inspection?.fingerprint ?? null;
	const currentRevision = review?.currentRevision ?? inspection?.currentRevision ?? props.currentRevision;
	const actor = collaborationToken
		? { collaborationToken }
		: {
				actorId,
				actorName,
			};

	function syncForm(next: any): void {
		const nextReview = next?.exists ? next.review : next?.review;
		if (!nextReview) {
			return;
		}
		setTitle(nextReview.title);
		setOwnerId(nextReview.owner.id);
		setReviewerLines(nextReview.reviewers.map((reviewer: any) => `${reviewer.id} | ${reviewer.name}`).join("\n"));
	}

	async function refresh(): Promise<void> {
		setLoading(true);
		setError(null);
		try {
			const [result, reviewQueue] = await Promise.all([
				inspectPrefabReview(props.scene, { path: props.path, limit: 100 }, { editor: props.editor }),
				listPrefabReviews(props.scene, { offset: 0, limit: 10 }, { editor: props.editor }),
			]);
			setInspection(result);
			setQueue(reviewQueue);
			syncForm(result);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, [props.path, props.currentRevision]);

	async function update(action: "saveDraft" | "requestReview" | "close"): Promise<void> {
		if (!fingerprint || !currentRevision) {
			return;
		}
		let reviewers: IReviewIdentity[];
		try {
			reviewers = reviewIdentities(reviewerLines);
		} catch (caught: any) {
			setError(caught.message);
			return;
		}
		const confirmed = await showConfirm(
			action === "requestReview" ? "Request Prefab review?" : action === "close" ? "Close Prefab review?" : "Save Prefab review draft?",
			action === "requestReview"
				? `Open a new review round bound to exact Prefab revision ${currentRevision.slice(0, 12)}?`
				: "Only separate project review metadata will change; the Prefab asset will not be written."
		);
		if (!confirmed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await setPrefabReview(
				props.scene,
				{
					path: props.path,
					expectedReviewFingerprint: fingerprint,
					...(action === "requestReview" ? { expectedPrefabRevision: currentRevision } : {}),
					title,
					...(ownerId ? { ownerId } : {}),
					reviewers,
					action,
					...actor,
					confirm: true,
				},
				{ editor: props.editor }
			);
			const next = { exists: true, review: result.review };
			setInspection(next);
			syncForm(next);
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	}

	async function addComment(): Promise<void> {
		if (!review || !fingerprint || !currentRevision || !comment.trim()) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await addPrefabReviewComment(
				props.scene,
				{
					path: props.path,
					expectedReviewFingerprint: fingerprint,
					expectedPrefabRevision: currentRevision,
					body: comment,
					...actor,
					confirm: true,
				},
				{ editor: props.editor }
			);
			setInspection({ exists: true, review: result.review });
			setComment("");
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	}

	async function decide(decision: "approve" | "requestChanges" | "dismiss"): Promise<void> {
		if (!review || !fingerprint || !currentRevision) {
			return;
		}
		const confirmed = await showConfirm(
			decision === "approve" ? "Approve Prefab revision?" : decision === "requestChanges" ? "Request Prefab changes?" : "Dismiss your decision?",
			`Record ${decision} for exact review round ${review.round}, revision ${currentRevision.slice(0, 12)}?`
		);
		if (!confirmed) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const result = await submitPrefabReviewDecision(
				props.scene,
				{
					path: props.path,
					expectedReviewFingerprint: fingerprint,
					expectedPrefabRevision: currentRevision,
					decision,
					body: decisionBody,
					...actor,
					confirm: true,
				},
				{ editor: props.editor }
			);
			setInspection({ exists: true, review: result.review });
			setDecisionBody("");
		} catch (caught: any) {
			setError(caught.message);
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mb-3 space-y-2 rounded border border-border bg-muted/20 p-2 text-xs">
			<div className="flex items-center justify-between gap-2">
				<div>
					<div className="font-medium">Ownership & Review</div>
					<div className="text-[10px] text-muted-foreground">Separate metadata · exact resolved-revision approvals</div>
				</div>
				<Button size="sm" variant="ghost" disabled={loading || busy} onClick={() => void refresh()}>
					Refresh
				</Button>
			</div>
			{loading && <div className="text-muted-foreground">Loading review…</div>}
			{queue && (
				<div className="rounded border border-border bg-background p-2">
					<div className="font-medium">Project Queue · {queue.total}</div>
					{queue.reviews.length === 0 && <div className="mt-1 text-[10px] text-muted-foreground">No Prefab reviews yet.</div>}
					{queue.reviews.map((entry: any) => (
						<div key={entry.id} className="mt-1 flex items-center justify-between gap-2 text-[10px]">
							<span className="truncate" title={entry.path}>
								{entry.path}
							</span>
							<span className={entry.stale ? "text-amber-300" : "text-muted-foreground"}>
								{entry.state} · {entry.approval.status}
							</span>
						</div>
					))}
					{queue.hasMore && <div className="mt-1 text-[10px] text-muted-foreground">Showing 10 of {queue.total}; use shared MCP pagination for the full queue.</div>}
				</div>
			)}
			{review && (
				<div className={`rounded border p-2 ${review.stale ? "border-amber-500/40 bg-amber-500/10" : "border-border"}`}>
					<div className="flex items-center justify-between gap-2">
						<span>
							{review.state} · round {review.round} · {review.approval.status}
						</span>
						<span className="font-mono text-[9px]">{review.currentRevision.slice(0, 12)}</span>
					</div>
					<div className="mt-1 text-[10px] text-muted-foreground">
						Owner: {review.owner.name} ({review.owner.id})
					</div>
					{review.stale && <div className="mt-1 font-medium text-amber-300">Approval is stale because Prefab content changed. Request a new review round.</div>}
					{review.approval.decisions.map((entry: any) => (
						<div key={entry.reviewer.id} className="mt-1 text-[10px]">
							{entry.reviewer.name}: {entry.decision}
						</div>
					))}
				</div>
			)}
			<Input value={title} disabled={busy} placeholder="Review title" onChange={(event) => setTitle(event.target.value)} />
			<Input value={ownerId} disabled={busy} placeholder="Owner stable id (defaults to actor)" onChange={(event) => setOwnerId(event.target.value)} />
			<textarea
				className="min-h-16 w-full rounded border border-input bg-background p-2 text-[11px]"
				value={reviewerLines}
				disabled={busy}
				placeholder={"reviewer-id | Reviewer Name\none-id-per-line"}
				onChange={(event) => setReviewerLines(event.target.value)}
			/>
			<div className="grid grid-cols-2 gap-1">
				<Input value={actorId} disabled={busy || !!collaborationToken} placeholder="Local actor id" onChange={(event) => setActorId(event.target.value)} />
				<Input value={actorName} disabled={busy || !!collaborationToken} placeholder="Local actor name" onChange={(event) => setActorName(event.target.value)} />
			</div>
			<Input
				type="password"
				value={collaborationToken}
				disabled={busy}
				placeholder="Collaboration token (when enforcement is enabled)"
				onChange={(event) => setCollaborationToken(event.target.value)}
			/>
			<div className="grid grid-cols-3 gap-1">
				<Button size="sm" variant="outline" disabled={busy || !fingerprint} onClick={() => void update("saveDraft")}>
					Save Draft
				</Button>
				<Button size="sm" disabled={busy || !fingerprint || !currentRevision} onClick={() => void update("requestReview")}>
					Request
				</Button>
				<Button size="sm" variant="ghost" disabled={busy || !review} onClick={() => void update("close")}>
					Close
				</Button>
			</div>
			{review && (
				<>
					<textarea
						className="min-h-14 w-full rounded border border-input bg-background p-2 text-[11px]"
						value={comment}
						disabled={busy}
						placeholder="Revision-bound review comment"
						onChange={(event) => setComment(event.target.value)}
					/>
					<Button className="w-full" size="sm" variant="outline" disabled={busy || !comment.trim()} onClick={() => void addComment()}>
						Add Comment
					</Button>
					{review.comments.map((entry: any) => (
						<div key={entry.id} className="rounded bg-background p-2 text-[10px]">
							<div className="font-medium">
								{entry.author.name} · round {entry.round} · {entry.prefabRevision.slice(0, 8)}
							</div>
							<div className="whitespace-pre-wrap">{entry.body}</div>
						</div>
					))}
					<textarea
						className="min-h-12 w-full rounded border border-input bg-background p-2 text-[11px]"
						value={decisionBody}
						disabled={busy}
						placeholder="Optional decision note"
						onChange={(event) => setDecisionBody(event.target.value)}
					/>
					<div className="grid grid-cols-3 gap-1">
						<Button size="sm" disabled={busy || review.state !== "inReview" || review.stale} onClick={() => void decide("approve")}>
							Approve
						</Button>
						<Button size="sm" variant="destructive" disabled={busy || review.state !== "inReview" || review.stale} onClick={() => void decide("requestChanges")}>
							Changes
						</Button>
						<Button size="sm" variant="outline" disabled={busy || review.state !== "inReview" || review.stale} onClick={() => void decide("dismiss")}>
							Dismiss
						</Button>
					</div>
				</>
			)}
			{error && <div className="rounded bg-destructive/15 p-2 text-destructive">{error}</div>}
		</div>
	);
}
