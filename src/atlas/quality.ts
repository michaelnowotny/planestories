// A light, local spec-quality heuristic for the Atlas overlay. This is NOT the
// full /rate-userstories rubric — just cheap, deterministic flags computable
// without an LLM, so the graph can show where a spec is thin at a glance.

export interface QualityAssessment {
	/** True when no flags fired. */
	ok: boolean;
	/** Human-readable flag labels, e.g. "no acceptance criteria". */
	flags: string[];
}

const VAGUE_PATTERNS: Array<{ label: string; re: RegExp }> = [
	{
		label: "subjective UI language",
		re: /\b(easy to use|intuitive|user[- ]friendly|nice looking|clean ui|looks good|modern design|sleek|beautiful|polished)\b/i,
	},
	{
		label: "unquantified performance",
		re: /\b(fast|responsive|snappy|smooth|quick|performant|scalable|lightweight)\b/i,
	},
	{
		label: "weasel words",
		re: /\b(properly|appropriately|reasonabl[ey]|adequate(ly)?|seamless(ly)?|robust(ly)?|gracefully|suitabl[ey])\b/i,
	},
	{
		label: "ambiguous scope",
		re: /(\betc\.?|\band more\b|\bas needed\b|\bwhere applicable\b|\bvarious\b|\ball relevant\b)/i,
	},
];

/** A performance word is only vague when there is no numeric threshold nearby. */
const HAS_NUMBER = /\d/;

export interface QualityInput {
	criteria: Array<{ text: string }>;
	description: string;
}

/**
 * Assess a single story's acceptance criteria and description with cheap local
 * heuristics. Flags: missing criteria, unquantified/subjective/weasel/ambiguous
 * language, and a thin description. Deterministic and offline.
 */
export function assessQuality(input: QualityInput): QualityAssessment {
	const flags: string[] = [];

	if (input.criteria.length === 0) {
		flags.push("no acceptance criteria");
	}

	const seen = new Set<string>();
	for (const criterion of input.criteria) {
		for (const { label, re } of VAGUE_PATTERNS) {
			if (!re.test(criterion.text)) {
				continue;
			}
			// A quantified performance criterion ("< 200ms", "within 2 seconds") is fine.
			if (label === "unquantified performance" && HAS_NUMBER.test(criterion.text)) {
				continue;
			}
			if (!seen.has(label)) {
				flags.push(label);
				seen.add(label);
			}
		}
	}

	if (input.criteria.length > 0 && input.description.trim().length < 40) {
		flags.push("thin description");
	}

	return { ok: flags.length === 0, flags };
}
