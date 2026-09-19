export type Stage = "presend" | "postsend";

type StageHealth = { failures: number; failing: boolean; reason: string; notified: boolean };

/** Report only validated status codes and fixed advice, never raw provider data. */
function failureReason(error: unknown): string {
	const e = error && typeof error === "object" ? error as { status?: unknown; name?: unknown } : {};
	const status = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : undefined;
	if (status !== undefined) {
		const advice = status === 402 ? "Payment required. Check your TypeSafe credits and billing at https://console.typesafe.ai."
			: status === 401 ? "Authentication failed. Check your TypeSafe API key."
			: status === 403 ? "Access denied. Check your TypeSafe API key and account permissions."
			: status === 429 ? "TypeSafe rejected the request because of a usage limit. Check your rate limits and quota at https://console.typesafe.ai."
			: status === 400 || status === 422 ? "TypeSafe rejected the request format. Check SDK compatibility and the model configuration."
			: status === 404 ? "TypeSafe could not find the requested resource. Check the model and API endpoint."
			: status === 408 || status === 504 ? "The API request timed out. Retry later."
			: status >= 500 ? "TypeSafe reported a server error. Retry later and check service availability."
			: "TypeSafe returned an unexpected HTTP response. Check service availability and account settings.";
		return `HTTP ${status}: ${advice}`;
	}
	if (e.name === "APITimeoutError" || e.name === "TimeoutError") return "Request timed out (no HTTP status). Check your connection and TypeSafe service availability.";
	if (e.name === "APIConnectionError") return "Connection failed (no HTTP status). Check your network, proxy, and TypeSafe service availability.";
	if (e.name === "TypeSafeError") return "TypeSafe SDK error (no HTTP status). Check SDK compatibility and configuration.";
	if (e.name === "TypeError" || e.name === "RangeError" || e.name === "SyntaxError") return `${e.name} during compression (no HTTP status). The cause is unknown. Report this as a jev-lens bug if it persists.`;
	return "Unclassified error (no HTTP status). The cause is unknown. Report this as a jev-lens bug if it persists.";
}

/** Session-local failure counters. Never expose provider error messages or credentials. */
export class Health {
	private stages: Record<Stage, StageHealth> = {
		presend: { failures: 0, failing: false, reason: "", notified: false },
		postsend: { failures: 0, failing: false, reason: "", notified: false },
	};

	failure(stage: Stage, error: unknown): void {
		const reason = failureReason(error);
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
