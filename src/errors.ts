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
	constructor(message: string) {
		super(message);
		this.name = "PlaneApiError";
	}
}

export class ResolverError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ResolverError";
	}
}
