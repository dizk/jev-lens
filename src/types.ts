export type Bucket = "keep" | "trim" | "forget";

export interface Probabilities {
	needed: number;
	outcomeOnly: number;
}

export interface Decision {
	/** toolCallId of the tool result this decision is about. */
	id: string;
	toolName: string;
	bucket: Bucket;
	p: Probabilities;
	/** One-line description used in the stub, fixed at decision time so the stub never changes. */
	summary: string;
	tokensBefore: number;
	decidedAt: number;
	/** "pending" until first applied in a context call; then frozen forever. */
	status: "pending" | "applied";
	appliedAtCall?: number;
	/** Why the decision was applied (rolling, cold-cache, compaction, forced). */
	appliedReason?: string;
}

export interface CallStats {
	call: number;
	at: number;
	messages: number;
	tokensOriginal: number;
	tokensSent: number;
	tokensPruned: number;
	appliedNow: number;
	frozen: number;
	pendingHeld: number;
	coldCache: boolean;
}
