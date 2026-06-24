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
	/** State group: backlog | unstarted | started | completed | cancelled. */
	group?: string;
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
	private rawStatesCache = new Map<string, PlaneState[]>();
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
		const match = findProject(projects, name);

		if (!match) {
			const available = projects
				.map((p) => p.name)
				.sort()
				.join(", ");
			const suggestion = closestProjectName(projects, name);
			const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
			throw new ResolverError(
				`Project not found: "${name}".${hint} Available projects: ${available || "(none)"}`,
			);
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

		const states = await this.getStates(projectId);
		for (const state of states) {
			this.stateCache.set(`${projectId}:${state.name.toLowerCase()}`, state.id);
		}

		if (!this.stateCache.has(key)) {
			this.stateCache.set(key, undefined);
		}
		return this.stateCache.get(key);
	}

	/**
	 * Return the id of the first project state belonging to one of the given
	 * groups (backlog | unstarted | started | completed | cancelled). Used to
	 * map acceptance-criteria checkboxes to a state when syncing sub-items.
	 */
	async firstStateIdInGroups(projectId: string, groups: string[]): Promise<string | undefined> {
		const wanted = new Set(groups);
		const states = await this.getStates(projectId);
		return states.find((s) => s.group !== undefined && wanted.has(s.group))?.id;
	}

	private async getStates(projectId: string): Promise<PlaneState[]> {
		const cached = this.rawStatesCache.get(projectId);
		if (cached) {
			return cached;
		}
		const states = await this.client.listStates<PlaneState>(projectId);
		this.rawStatesCache.set(projectId, states);
		return states;
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
 * Match a project by UUID, then exact name, then case-insensitive identifier
 * (e.g. "INFRASETUP"), then case-insensitive name. Returns undefined if none match.
 */
function findProject(projects: PlaneProject[], query: string): PlaneProject | undefined {
	if (isUuid(query)) {
		return projects.find((p) => p.id === query);
	}
	const exact = projects.find((p) => p.name === query);
	if (exact) {
		return exact;
	}
	const lower = query.toLowerCase();
	return (
		projects.find((p) => p.identifier?.toLowerCase() === lower) ??
		projects.find((p) => p.name.toLowerCase() === lower)
	);
}

/** Suggest the closest project name to an unmatched query, if one is reasonably close. */
function closestProjectName(projects: PlaneProject[], query: string): string | undefined {
	const q = query.toLowerCase();
	let best: { name: string; distance: number } | undefined;
	for (const project of projects) {
		const distance = Math.min(
			levenshtein(q, project.name.toLowerCase()),
			levenshtein(q, (project.identifier ?? "").toLowerCase()),
		);
		if (!best || distance < best.distance) {
			best = { name: project.name, distance };
		}
	}
	// Only suggest when the edit distance is within a sensible fraction of the query.
	if (best && best.distance <= Math.max(3, Math.floor(query.length / 2))) {
		return best.name;
	}
	return undefined;
}

function levenshtein(a: string, b: string): number {
	const rows = a.length + 1;
	const cols = b.length + 1;
	const dp: number[] = Array.from({ length: cols }, (_, i) => i);
	for (let i = 1; i < rows; i++) {
		let prev = dp[0] as number;
		dp[0] = i;
		for (let j = 1; j < cols; j++) {
			const temp = dp[j] as number;
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min((dp[j] as number) + 1, (dp[j - 1] as number) + 1, prev + cost);
			prev = temp;
		}
	}
	return dp[cols - 1] as number;
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
