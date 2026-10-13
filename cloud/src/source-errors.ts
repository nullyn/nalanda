type GithubOperation = "stars" | "readme";
type GithubFailure =
	| "http"
	| "rate-limit"
	| "timeout"
	| "network"
	| "invalid-response";

// Only these structured values may leave a failed provider request.
export class GithubRequestError extends Error {
	constructor(
		readonly operation: GithubOperation,
		readonly reason: GithubFailure,
		readonly status?: number,
		readonly retryAt?: string,
	) {
		super(`GitHub ${operation} request failed`);
	}
	static fromResponse(operation: GithubOperation, response: Response) {
		const limited =
			response.status === 429 ||
			(response.status === 403 &&
				response.headers.get("x-ratelimit-remaining") === "0");
		const reset = response.headers.get("x-ratelimit-reset");
		const retry = response.headers.get("retry-after");
		const resetSeconds =
			reset && /^\d{1,10}$/.test(reset) ? Number(reset) : null;
		const retrySeconds =
			retry && /^\d{1,6}$/.test(retry) ? Number(retry) : null;
		const retryTime = limited
			? retrySeconds !== null
				? Date.now() + retrySeconds * 1000
				: resetSeconds !== null
					? resetSeconds * 1000
					: null
			: null;
		return new GithubRequestError(
			operation,
			limited ? "rate-limit" : "http",
			response.status,
			retryTime !== null ? new Date(retryTime).toISOString() : undefined,
		);
	}
	diagnostic() {
		return {
			provider: "github",
			operation: this.operation,
			reason: this.reason,
			status: this.status,
			retryAt: this.retryAt,
		};
	}
}

export type InstagramStage =
	| "open-saved"
	| "verify-account"
	| "open-collection"
	| "discover-posts"
	| "read-post";
export type InstagramFailure =
	| "session-required"
	| "challenge"
	| "account-mismatch"
	| "ui-timeout"
	| "collection-unavailable"
	| "browser-step-failed";
export class InstagramCaptureError extends Error {
	constructor(
		readonly stage: InstagramStage,
		readonly reason: InstagramFailure,
		readonly signals?: {
			profileImages: number;
			loginLinks: number;
			passwordFields: number;
			links: number;
		},
	) {
		super(`Instagram ${stage}: ${reason}`);
	}
	diagnostic() {
		return {
			provider: "instagram",
			stage: this.stage,
			reason: this.reason,
			signals: this.signals,
			sessionRenewalRequired: [
				"session-required",
				"challenge",
				"account-mismatch",
			].includes(this.reason),
		};
	}
}
