import { isTransientPlaneError } from "../plane/client.ts";

// Re-exported so existing importers keep working; the policy itself lives beside
// the retry loop that applies it, in `plane/client.ts`.
export { isTransientPlaneError };

import { ReplicateError } from "../errors.ts";

export interface A10CreateClient {
	readonly maxRetries: number;
	createWorkItem<T>(
		projectId: string,
		body: Record<string, unknown>,
		opts?: { maxRetries?: number },
	): Promise<T>;
	listWorkItems<T>(
		projectId: string,
		query?: Record<string, string | number | boolean | undefined>,
	): Promise<T[]>;
}

export interface ExpectedIdentity {
	sequence: number;
	name: string;
	externalId?: string | null;
	externalSource?: string | null;
}

interface RawCreatedItem {
	id: string;
	sequence_id: number;
	name?: string;
	external_id?: string | null;
	external_source?: string | null;
}

/**
 * Find and fingerprint an expected sequence without making a write. The
 * fingerprint is STRICT: name must match AND external identity must match
 * including its ABSENCE — an expected-null external_id only matches an item
 * with no external_id, so a foreign item that happens to share a title but
 * carries its own external identity is never adopted. (A foreign board-native
 * item sharing both the exact title and no external identity at exactly the
 * expected number remains theoretically adoptable — no API-visible field can
 * discriminate it; the target project being run-created bounds that risk.)
 */
export async function reconcileExpectedItem(
	client: A10CreateClient,
	projectId: string,
	expected: ExpectedIdentity,
): Promise<{ id: string; sequenceId: number } | null> {
	const items = await client.listWorkItems<RawCreatedItem>(projectId);
	const found = items.find((item) => item.sequence_id === expected.sequence);
	if (!found) return null;
	const externalIdMatches = (found.external_id ?? null) === (expected.externalId ?? null);
	const externalSourceMatches =
		(found.external_source ?? null) === (expected.externalSource ?? null);
	if (found.name !== expected.name || !externalIdMatches || !externalSourceMatches) {
		throw new ReplicateError(
			`Foreign item occupies expected sequence ${expected.sequence}; expected fingerprint ` +
				`${JSON.stringify(expected.name)}/${String(expected.externalId ?? null)} but found ` +
				`${JSON.stringify(found.name ?? "")}/${String(found.external_id ?? null)}. ` +
				"Refusing to adopt it.",
		);
	}
	return { id: found.id, sequenceId: found.sequence_id };
}

/**
 * A10 create: disable blind client retries, then verify durable state before
 * deciding whether an ambiguous POST may safely be replayed.
 */
export async function createItemA10(
	client: A10CreateClient,
	projectId: string,
	body: Record<string, unknown>,
	expected: ExpectedIdentity,
	opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<{ id: string; sequenceId: number; adopted: boolean }> {
	const sleep =
		opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const attempts = Math.max(1, client.maxRetries + 1);
	for (let attempt = 1; ; attempt++) {
		try {
			const created = await client.createWorkItem<RawCreatedItem>(projectId, body, {
				maxRetries: 0,
			});
			return { id: created.id, sequenceId: created.sequence_id, adopted: false };
		} catch (error) {
			let found: { id: string; sequenceId: number } | null;
			try {
				found = await reconcileExpectedItem(client, projectId, expected);
			} catch (reconcileError) {
				if (reconcileError instanceof ReplicateError) throw reconcileError;
				throw error;
			}
			if (found) return { ...found, adopted: true };
			if (!isTransientPlaneError(error) || attempt >= attempts) throw error;
			await sleep(error.retryAfterMs ?? Math.min(500 * 2 ** (attempt - 1), 5000));
		}
	}
}
