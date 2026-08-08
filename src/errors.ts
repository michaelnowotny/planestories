export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export class ParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ParseError";
	}
}

export class PlaneApiError extends Error {
	/**
	 * HTTP status of the failed response, when one was received. Undefined for
	 * network-level failures (connection refused, timeout — the ambiguous cases
	 * where the request may or may not have reached the server). Callers use
	 * this to classify transient (429/5xx/undefined) vs permanent (4xx) errors.
	 */
	readonly status?: number;
	/** Server-directed retry delay (parsed Retry-After), when the response gave one. */
	readonly retryAfterMs?: number;

	constructor(message: string, status?: number, retryAfterMs?: number) {
		super(message);
		this.name = "PlaneApiError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export class ResolverError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResolverError";
	}
}
