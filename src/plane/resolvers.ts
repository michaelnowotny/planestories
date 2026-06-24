import { ResolverError } from "../errors.ts";
import type { PlaneClient } from "./client.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

function isEmail(value: string): boolean {
	return value.includes("@");
}

export interface ResolvedProject {
	id: string;
	/** Short identifier used in human-readable work item ids, e.g. "BLOOM". */
	identifier: string;
}

interface PlaneProject {
	id: string;
	name: string;
	identifier: string;
}

interface PlaneState {
	id: string;
	name: string;
}

interface PlaneLabel {
	id: string;
	name: string;
}

/** Normalized member shape independent of Plane's nesting variations. */
interface NormalizedMember {
	id: string;
	email?: string;
	displayName?: string;
}

/**
 * Resolves human-readable names (project, label, state, assignee) into the
 * Plane UUIDs the API requires. All lookups are cached for the lifetime of the
 * instance, so a single import run hits each list endpoint at most once.
 *
 * Unlike Linear, Plane has no "team" tier — states and labels belong to a
 * PROJECT, so those resolvers are project-scoped.
 */
export class Resolver {
	private client: PlaneClient;
	private projectCache = new Map<string, ResolvedProject>();
	private labelCache = new Map<string, string>();
	private stateCache = new Map<string, string | undefined>();
	private memberCache = new Map<string, NormalizedMember[]>();
	private warnedMissingLabels = new Set<string>();

	/** Distinct label names created via createMissing, for run summaries. */
	readonly createdLabelNames = new Set<string>();
	/** Distinct label names skipped because they were not found. */
	readonly skippedLabelNames = new Set<string>();

	constructor(client: PlaneClient) {
		this.client = client;
	}

	/**
	 * Resolve a project name to its id + short identifier.
	 * Throws ResolverError if the project is not found.
	 */
	async resolveProject(name: string): Promise<ResolvedProject> {
		const cached = this.projectCache.get(name);
		if (cached) {
			return cached;
		}

		const projects = await this.client.listProjects<PlaneProject>();
		// Match by id first (UUID pass-through), then by exact name.
		const match = isUuid(name)
			? projects.find((p) => p.id === name)
			: projects.find((p) => p.name === name);

		if (!match) {
			throw new ResolverError(`Project not found: "${name}"`);
		}

		const resolved: ResolvedProject = { id: match.id, identifier: match.identifier };
		this.projectCache.set(name, resolved);
		this.projectCache.set(match.id, resolved);
		return resolved;
	}

	/**
	 * Resolve label names to UUIDs within a project.
	 * Labels not found are skipped with a warning, unless `createMissing` is set,
	 * in which case they are created in the project and then attached.
	 */
	async resolveLabelIds(
		projectId: string,
		names: string[],
		createMissing = false,
	): Promise<string[]> {
		if (names.length === 0) {
			return [];
		}

		const labels = await this.client.listLabels<PlaneLabel>(projectId);
		// Seed the cache (case-insensitive keys) from the project's labels.
		for (const label of labels) {
			this.labelCache.set(this.labelKey(projectId, label.name), label.id);
		}

		const ids: string[] = [];
		for (const name of names) {
			const key = this.labelKey(projectId, name);
			const cached = this.labelCache.get(key);
			if (cached) {
				ids.push(cached);
				continue;
			}

			if (!createMissing) {
				this.skippedLabelNames.add(name);
				// Warn once per distinct label, and name the remedy.
				if (!this.warnedMissingLabels.has(key)) {
					this.warnedMissingLabels.add(key);
					console.warn(`Label not found, skipping: "${name}" — pass --create-labels to create it`);
				}
				continue;
			}

			const created = await this.client.createLabel<PlaneLabel>(projectId, { name });
			this.labelCache.set(key, created.id);
			this.createdLabelNames.add(name);
			ids.push(created.id);
		}

		return ids;
	}

	/**
	 * Resolve a state name to its UUID within a project (case-insensitive).
	 * Returns undefined if the state is not found.
	 */
	async resolveStateId(projectId: string, name: string): Promise<string | undefined> {
		const key = `${projectId}:${name.toLowerCase()}`;
		if (this.stateCache.has(key)) {
			return this.stateCache.get(key);
		}

		const states = await this.client.listStates<PlaneState>(projectId);
		for (const state of states) {
			this.stateCache.set(`${projectId}:${state.name.toLowerCase()}`, state.id);
		}

		if (!this.stateCache.has(key)) {
			this.stateCache.set(key, undefined);
		}
		return this.stateCache.get(key);
	}

	/**
	 * Resolve an email or display name to a member UUID within a project.
	 * Returns undefined if no member matches.
	 */
	async resolveAssigneeId(projectId: string, emailOrName: string): Promise<string | undefined> {
		if (isUuid(emailOrName)) {
			return emailOrName;
		}

		const members = await this.getMembers(projectId);
		const wantEmail = isEmail(emailOrName);
		const needle = emailOrName.toLowerCase();

		const match = members.find((m) => {
			if (wantEmail) {
				return m.email?.toLowerCase() === needle;
			}
			return m.displayName?.toLowerCase() === needle;
		});

		return match?.id;
	}

	private async getMembers(projectId: string): Promise<NormalizedMember[]> {
		const cached = this.memberCache.get(projectId);
		if (cached) {
			return cached;
		}

		const raw = await this.client.listProjectMembers<Record<string, unknown>>(projectId);
		const normalized = raw.map(normalizeMember).filter((m): m is NormalizedMember => m !== null);
		this.memberCache.set(projectId, normalized);
		return normalized;
	}

	private labelKey(projectId: string, name: string): string {
		return `${projectId}:${name.toLowerCase()}`;
	}
}

/**
 * Plane's project-members endpoint nests the user differently across versions:
 * the member may be a flat object, or nested under a `member` key, or the entry
 * may carry the member UUID in `member` with email/display_name alongside.
 */
function normalizeMember(entry: Record<string, unknown>): NormalizedMember | null {
	const member = entry.member;
	if (member && typeof member === "object") {
		const m = member as Record<string, unknown>;
		const id = (m.id ?? entry.member_id) as string | undefined;
		if (!id) {
			return null;
		}
		return {
			id,
			email: (m.email as string) ?? (entry.email as string) ?? undefined,
			displayName: (m.display_name as string) ?? (entry.display_name as string) ?? undefined,
		};
	}

	// `member` is a UUID string (or absent) with details at the top level.
	const id = (typeof member === "string" ? member : (entry.id as string)) ?? undefined;
	if (!id) {
		return null;
	}
	return {
		id,
		email: (entry.email as string) ?? undefined,
		displayName: (entry.display_name as string) ?? undefined,
	};
}
