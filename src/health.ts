export type Stage = "presend" | "postsend";

type StageHealth = { failures: number; failing: boolean; reason: string; notified: boolean };

/** Session-local failure counters. Never expose provider error messages or credentials. */
export class Health {
	private stages: Record<Stage, StageHealth> = {
		presend: { failures: 0, failing: false, reason: "", notified: false },
		postsend: { failures: 0, failing: false, reason: "", notified: false },
	};

	failure(stage: Stage, error: unknown): void {
		const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
		const reason = status === 401 || status === 403 ? "Check your TypeSafe API key."
			: status === 429 ? "TypeSafe rejected the request because of a usage limit."
			: "Check your connection and TypeSafe service availability.";
		Object.assign(this.stages[stage], { failures: this.stages[stage].failures + 1, failing: true, reason });
	}

	success(stage: Stage): void { this.stages[stage].failing = false; }

	get failing(): boolean { return Object.values(this.stages).some((s) => s.failing); }

	/** At most one warning per stage per session, including work completed without a UI context. */
	warnings(): string[] {
		return (Object.entries(this.stages) as [Stage, StageHealth][]).flatMap(([stage, state]) => {
			if (!state.failures || state.notified) return [];
			state.notified = true;
			const effect = stage === "presend" ? "Full output was kept." : "The affected result was not pruned.";
			return [`jev-lens: ${stage === "presend" ? "Pre-send compression" : "Post-send classification"} failed. ${effect} ${state.reason} See /jev-lens stats. Further failures appear there without repeated warnings.`];
		});
	}

	lines(): string[] {
		return (Object.entries(this.stages) as [Stage, StageHealth][]).map(([stage, state]) =>
			`${stage} failures: ${state.failures}${state.failures ? state.failing ? ` (last attempt failed). ${state.reason}` : " (a later attempt succeeded)" : ""}`);
	}
}
