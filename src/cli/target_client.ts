import chalk from "chalk";
import { createPlaneClient, type PlaneClient } from "../plane/client.ts";
import {
	DialectResolver,
	detectReadDialect,
	dialectCacheKey,
	isDialectConfigured,
} from "../plane/dialect.ts";
import type { ResolvedConfig } from "../types.ts";

interface ProjectRef {
	id: string;
	name?: string;
	identifier?: string;
}

export interface TargetClientOptions {
	/** Prefer this project as the source of the one-item relation probe. */
	project?: string | null;
	/** Injectable resolver for tests; production shares one process-wide cache. */
	resolver?: DialectResolver;
	/** Emit the mandatory loud fallback warning. Defaults to console.error. */
	warn?: (message: string) => void;
}

export interface ConnectedTarget {
	client: PlaneClient;
	config: ResolvedConfig;
}

const sharedResolver = new DialectResolver();
const warnedFallbacks = new Set<string>();

/** Build one live client after resolving (or explicitly honoring) its dialect. */
export async function connectTarget(
	config: ResolvedConfig,
	options: TargetClientOptions = {},
): Promise<ConnectedTarget> {
	const base = createPlaneClient({
		apiKey: config.apiKey,
		workspaceSlug: config.workspaceSlug,
		baseUrl: config.baseUrl,
		maxRetries: config.maxRetries,
		dialect: config.dialect,
		dialectConfigured: isDialectConfigured(config),
		requestsPerMinute: config.apiRateLimit,
		rateHeadroom: config.rateHeadroom,
		maxConcurrency: config.maxConcurrency,
	});
	const resolver = options.resolver ?? sharedResolver;
	const resolution = await resolver.resolve(config, async () => {
		const projects = await base.listProjects<ProjectRef>();
		if (projects.length === 0) {
			return {
				dialect: "issues" as const,
				source: "fallback" as const,
				reason: "the workspace has no project whose relations can be sampled",
			};
		}
		const preferred = (options.project ?? config.defaultProject)?.toLocaleLowerCase();
		const project =
			(preferred
				? projects.find(
						(candidate) =>
							candidate.name?.toLocaleLowerCase() === preferred ||
							candidate.identifier?.toLocaleLowerCase() === preferred,
					)
				: undefined) ?? projects[0]!;
		return detectReadDialect((dialect) => base.withDialect(dialect), project.id, {
			includeArchived: false,
		});
	});

	const resolvedConfig: ResolvedConfig = {
		...config,
		dialect: resolution.dialect,
		dialectSource: resolution.source,
	};
	if (resolution.source === "fallback") {
		const key = dialectCacheKey(config);
		if (!warnedFallbacks.has(key)) {
			warnedFallbacks.add(key);
			const warning =
				`Could not determine Plane endpoint dialect (${resolution.reason ?? "probe was inconclusive"}). ` +
				'Falling back to "issues" for this run.';
			(options.warn ?? ((message) => console.error(chalk.yellow(`⚠ ${message}`))))(warning);
		}
	}

	return {
		client: base.dialect === resolution.dialect ? base : base.withDialect(resolution.dialect),
		config: resolvedConfig,
	};
}
