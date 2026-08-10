/**
 * Strict instant equality for verification paths. `Date.parse` truncates to
 * milliseconds while Plane emits microsecond precision — `.123456Z` and
 * `.123999Z` are DIFFERENT instants that would otherwise compare equal,
 * a narrow false-fresh / false-authorship-pass route. The fractional-second
 * digits are timezone-independent, so comparing them (zero-padded) alongside
 * the parsed millisecond closes the gap without a datetime library.
 */
export function sameNullableInstant(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return a === b;
	if (Date.parse(a) !== Date.parse(b)) return false;
	return fractionDigits(a) === fractionDigits(b);
}

function fractionDigits(value: string): string {
	const match = /\.(\d+)/.exec(value);
	return (match?.[1] ?? "").padEnd(9, "0");
}
