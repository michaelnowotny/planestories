import { PlaneApiError, ReplicateError } from "../errors.ts";

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
}

interface RawCreatedItem {
	id: string;
	sequence_id: number;
	name?: string;
	external_id?: string | null;
}

export function isTransientPlaneError(error: unknown): error is PlaneApiError {
	return (
		error instanceof PlaneApiError &&
		(error.status === undefined || error.status === 429 || error.status >= 500)
	);
}

/** Find and fingerprint an expected sequence without making a write. */
export async function reconcileExpectedItem(
	client: A10CreateClient,
	projectId: string,
	expected: ExpectedIdentity,
): Promise<{ id: string; sequenceId: number } | null> {
	const items = await client.listWorkItems<RawCreatedItem>(projectId);
	const found = items.find((item) => item.sequence_id === expected.sequence);
	if (!found) return null;
	const externalMatches =
		expected.externalId === undefined ||
		expected.externalId === null ||
		found.external_id === expected.externalId;
	if (found.name !== expected.name || !externalMatches) {
		throw new ReplicateError(
			`Foreign item occupies expected sequence ${expected.sequence}; expected fingerprint ` +
				`${JSON.stringify(expected.name)} but found ${JSON.stringify(found.name ?? "")}. ` +
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
