import { PlaneApiError } from "../errors.ts";
import type { PlaneDialectSource } from "../types.ts";
import type { AllowedMethods, PlaneEndpointDialect, RelationMethodProbe } from "./client.ts";

export type { AllowedMethods, RelationMethodProbe } from "./client.ts";

export type CapabilityStatus = "supported" | "not-supported" | "could-not-determine";

export interface DeploymentCapabilities {
	host: string;
	workspace: string;
	edition: string | null;
	version: string | null;
	dialect: PlaneEndpointDialect;
	dialectSource: PlaneDialectSource;
	capabilities: {
		relationCreate: CapabilityStatus;
		relationList: CapabilityStatus;
		relationRemove: CapabilityStatus;
		pql: CapabilityStatus;
		countEndpoint: CapabilityStatus;
	};
}

export interface CapabilityProbeClient {
	readonly baseUrl: string;
	readonly workspaceSlug: string;
	readonly dialect: PlaneEndpointDialect;
	getInstance<T>(): Promise<T>;
	listProjects<T>(): Promise<T[]>;
	sampleWorkItem<T>(projectId: string): Promise<T | null>;
	probeRelationMethods(projectId: string, workItemId: string): Promise<RelationMethodProbe>;
	probePql(projectId: string): Promise<void>;
	probeWorkspaceCount(): Promise<void>;
}

export interface CapabilityProbeOptions {
	dialectSource: PlaneDialectSource;
	preferredProject?: string | null;
}

interface ProbeProject {
	id: string;
	name?: string;
	identifier?: string;
}

interface InstancePayload {
	instance?: {
		edition?: unknown;
		current_version?: unknown;
	};
}

/** Probe each independent surface without letting one failed read erase the others. */
export async function probeDeploymentCapabilities(
	client: CapabilityProbeClient,
	options: CapabilityProbeOptions,
): Promise<DeploymentCapabilities> {
	const [instance, target, countEndpoint] = await Promise.all([
		probeInstance(client),
		findProbeTarget(client, options.preferredProject),
		probeCountEndpoint(client),
	]);

	const pql = target.project ? await probePql(client, target.project.id) : indeterminate();
	const relations = target.item
		? await probeRelations(client, target.project!.id, target.item.id)
		: {
				relationCreate: indeterminate(),
				relationList: indeterminate(),
				relationRemove: indeterminate(),
			};

	return {
		host: hostOf(client.baseUrl),
		workspace: client.workspaceSlug,
		edition: instance.edition,
		version: instance.version,
		dialect: client.dialect,
		dialectSource: options.dialectSource,
		capabilities: {
			...relations,
			pql,
			countEndpoint,
		},
	};
}

async function probeInstance(
	client: CapabilityProbeClient,
): Promise<{ edition: string | null; version: string | null }> {
	try {
		const payload = await client.getInstance<InstancePayload>();
		return {
			edition: stringOrNull(payload?.instance?.edition),
			version: stringOrNull(payload?.instance?.current_version),
		};
	} catch {
		return { edition: null, version: null };
	}
}

async function findProbeTarget(
	client: CapabilityProbeClient,
	preferredProject?: string | null,
): Promise<{ project: ProbeProject | null; item: { id: string } | null }> {
	try {
		const projects = await client.listProjects<ProbeProject>();
		const wanted = preferredProject?.toLocaleLowerCase();
		const project =
			(wanted
				? projects.find(
						(candidate) =>
							candidate.name?.toLocaleLowerCase() === wanted ||
							candidate.identifier?.toLocaleLowerCase() === wanted,
					)
				: undefined) ??
			projects[0] ??
			null;
		if (!project) return { project: null, item: null };
		try {
			return {
				project,
				item: await client.sampleWorkItem<{ id: string }>(project.id),
			};
		} catch {
			return { project, item: null };
		}
	} catch {
		return { project: null, item: null };
	}
}

async function probeRelations(
	client: CapabilityProbeClient,
	projectId: string,
	itemId: string,
): Promise<{
	relationCreate: CapabilityStatus;
	relationList: CapabilityStatus;
	relationRemove: CapabilityStatus;
}> {
	let probe: RelationMethodProbe;
	try {
		probe = await client.probeRelationMethods(projectId, itemId);
	} catch {
		return {
			relationCreate: indeterminate(),
			relationList: indeterminate(),
			relationRemove: indeterminate(),
		};
	}

	// An empty Allow set is not "no methods" — it is "this endpoint did not say".
	// The one command whose job is to avoid confident claims from indirect
	// evidence must not turn silence into a negative.
	const allow = new Set(probe.collection.allow.map((method) => method.toUpperCase()));
	const fromAllow = (method: string): CapabilityStatus =>
		allow.size === 0 ? indeterminate() : allow.has(method) ? "supported" : "not-supported";

	return {
		relationCreate: fromAllow("POST"),
		relationList: fromAllow("GET"),
		relationRemove: removalStatus(probe.removal),
	};
}

/**
 * Removal is established from the ROUTES, not from the dialect.
 *
 * The previous version read `client.dialect === "work-items"` and printed a
 * confident NOT SUPPORTED — so a Cloud deployment with an explicitly configured
 * work-items dialect would have been told, in the command that exists to
 * measure things, something nobody measured.
 */
function removalStatus(routes: readonly AllowedMethods[]): CapabilityStatus {
	if (routes.length === 0) return indeterminate();
	if (routes.every((route) => route.status === 404)) return "not-supported";
	const reachable = routes.filter((route) => route.status !== 404);
	return reachable.some((route) => route.allow.length > 0) ? "supported" : indeterminate();
}

async function probePql(
	client: CapabilityProbeClient,
	projectId: string,
): Promise<CapabilityStatus> {
	try {
		await client.probePql(projectId);
		return "supported";
	} catch (error) {
		if (
			error instanceof PlaneApiError &&
			error.status === 400 &&
			/unsupported_parameters|PQL[^\n]*not supported|PQL and structured filters are not supported/i.test(
				error.message,
			)
		) {
			return "not-supported";
		}
		return indeterminate();
	}
}

async function probeCountEndpoint(client: CapabilityProbeClient): Promise<CapabilityStatus> {
	try {
		await client.probeWorkspaceCount();
		return "supported";
	} catch (error) {
		return error instanceof PlaneApiError && error.status === 404
			? "not-supported"
			: indeterminate();
	}
}

function indeterminate(): CapabilityStatus {
	return "could-not-determine";
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

export function formatCapabilitiesTable(result: DeploymentCapabilities): string {
	return [
		`host: ${result.host}`,
		`workspace: ${result.workspace}`,
		`edition: ${result.edition ?? "could not determine"}`,
		`version: ${result.version ?? "could not determine"}`,
		`dialect: ${result.dialect} (${result.dialectSource})`,
		`relation create: ${formatStatus(result.capabilities.relationCreate)}`,
		`relation list: ${formatStatus(result.capabilities.relationList)}`,
		`relation removal: ${formatStatus(result.capabilities.relationRemove)}`,
		`PQL: ${formatStatus(result.capabilities.pql)}`,
		`count endpoint: ${formatStatus(result.capabilities.countEndpoint)}`,
	].join("\n");
}

function formatStatus(status: CapabilityStatus): string {
	if (status === "supported") return "SUPPORTED";
	if (status === "not-supported") return "NOT SUPPORTED on this deployment";
	return "could not determine";
}
