import { describe, expect, test } from "bun:test";
import { parseEffortDays } from "../../../src/markdown/directives.ts";
import { parseMarkdownFile } from "../../../src/markdown/parser.ts";
import type { FetchedWorkItem } from "../../../src/plane/issues.ts";
import { boardItemToStory } from "../../../src/sync/board-story.ts";
import { hashStoryPayload } from "../../../src/sync/story-hash.ts";
import { makeFakeClient } from "../../helpers/fake-plane-client.ts";

const FILE_BODYLINE = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
status: Backlog
\`\`\`

The narrative.

**Effort:** 2.5 dev-days

### Acceptance Criteria
- [ ] a concrete thing
`;

const FILE_YAML = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
status: Backlog
effort_days: 2.5
\`\`\`

The narrative.

### Acceptance Criteria
- [ ] a concrete thing
`;

describe("effort parsing from a file", () => {
	test("the body line sets effortDays and stays in the body", () => {
		const story = parseMarkdownFile(FILE_BODYLINE, "x.md").stories[0]!;
		expect(story.effortDays).toBe(2.5);
		expect(story.body).toContain("**Effort:** 2.5 dev-days");
	});

	test("a YAML effort_days is materialized into the body line (equivalent input)", () => {
		const story = parseMarkdownFile(FILE_YAML, "x.md").stories[0]!;
		expect(story.effortDays).toBe(2.5);
		expect(story.body).toContain("**Effort:** 2.5 dev-days");
		// The materialized line sits in the narrative, before the criteria.
		expect(story.body.indexOf("**Effort:**")).toBeLessThan(
			story.body.indexOf("Acceptance Criteria"),
		);
	});

	test("YAML and body-line inputs yield the same story body (so they hash the same)", () => {
		const a = parseMarkdownFile(FILE_BODYLINE, "x.md").stories[0]!;
		const b = parseMarkdownFile(FILE_YAML, "x.md").stories[0]!;
		expect(a.body).toBe(b.body);
		expect(hashStoryPayload(a, { syncCriteria: false, labels: [] })).toBe(
			hashStoryPayload(b, { syncCriteria: false, labels: [] }),
		);
	});
});

function fileWithYamlEffort(value: string): string {
	return `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
status: Backlog
effort_days: ${value}
\`\`\`

The narrative.

### Acceptance Criteria
- [ ] a concrete thing
`;
}

describe("invalid / edge effort inputs", () => {
	test("a negative effort_days is rejected, not injected (would break re-parse)", () => {
		const story = parseMarkdownFile(fileWithYamlEffort("-1"), "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
		expect(story.body).not.toContain("**Effort:**");
	});

	test("a non-finite effort_days (.inf) is rejected, not injected", () => {
		const story = parseMarkdownFile(fileWithYamlEffort(".inf"), "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
		expect(story.body).not.toContain("**Effort:**");
	});

	test("a boolean or blank effort_days is rejected, not fabricated to 0", () => {
		for (const bad of ["false", '" "', "true"]) {
			const story = parseMarkdownFile(fileWithYamlEffort(bad), "x.md").stories[0]!;
			expect(story.effortDays).toBeNull();
			expect(story.body).not.toContain("**Effort:**");
		}
	});

	test("a small decimal effort_days round-trips through a file (no exponent)", () => {
		const story = parseMarkdownFile(fileWithYamlEffort("0.0000001"), "x.md").stories[0]!;
		expect(story.effortDays).toBe(0.0000001);
		expect(story.body).toContain("**Effort:** 0.0000001 dev-days");
		expect(story.body).not.toContain("e-");
	});

	test("YAML effort is NOT injected when the body already mentions effort (no duplicate)", () => {
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2
\`\`\`

The narrative.

### Acceptance Criteria
- [ ] a thing

**Effort:** 3 dev-days
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		// After-AC line is unrecognized; YAML is suppressed by the mention-guard.
		expect(story.effortDays).toBeNull();
		expect(story.body.match(/\*\*Effort:\*\*/g)?.length).toBe(1);
	});

	test("YAML effort is not applied when injection can't round-trip (unclosed fence)", () => {
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2.5
\`\`\`

Narrative.

\`\`\`text
unclosed code
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		// The self-verify guard rejects an injection that would land inside the open fence.
		expect(story.effortDays).toBeNull();
		expect(story.body).not.toContain("**Effort:**");
	});

	test("YAML effort is rejected when a longer unclosed fence would swallow the line", () => {
		// ````md opens a 4-backtick fence; the inner ``` (3) is content, so the fence
		// stays open and an appended effort line would render as code -> reject.
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2.5
\`\`\`

Narrative.

\`\`\`\`md
code
\`\`\`
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
		expect(story.body).not.toContain("**Effort:**");
	});

	test("YAML effort is rejected when a 4-space-indented fence leaves the block open", () => {
		// CommonMark: a fence indented 4+ spaces is NOT a closer, so the ```md block
		// stays open and the renderer keeps an appended effort line as code.
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2.5
\`\`\`

Narrative.

\`\`\`md
code
    \`\`\`
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
		expect(story.body).not.toContain("**Effort:**");
	});

	test("a precision-losing YAML effort_days string is rejected, not silently altered", () => {
		const story = parseMarkdownFile(fileWithYamlEffort('"9007199254740993"'), "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
		expect(story.body).not.toContain("**Effort:**");
	});

	test("YAML effort not fabricated when an inline mention + unclosed <pre> would swallow it", () => {
		// An inline **Effort:** mention renders <strong>Effort:</strong> elsewhere, while
		// the injected line is swallowed by the open <pre>. Canonical re-parse -> null -> reject.
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2
\`\`\`

Earlier **Effort:** mention.

<pre>
unclosed
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
	});

	test("YAML effort is suppressed by an underscore-bold __Effort:__ mention (no duplicate)", () => {
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2
\`\`\`

Narrative.

### Acceptance Criteria
- [ ] x

__Effort:__ 3 dev-days
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
		// No injected **Effort:** line; the only effort mention is the authored one.
		expect(story.body).not.toContain("**Effort:**");
	});

	test("YAML effort is suppressed by effort text inside a raw <pre> block (no duplicate)", () => {
		// Turndown escapes the ** inside <pre>, so the canonical pass misses it; the raw
		// pass of hasAnyEffortMention catches it and refuses to inject a second line.
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2
\`\`\`

Narrative.

<pre>
**Effort:** 3 dev-days
</pre>
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		// Exactly one **Effort:** line (the authored one); none injected.
		expect(story.body.match(/\*\*Effort:\*\*/g)?.length).toBe(1);
	});

	test("Setext AC heading is recognized: YAML effort is injected BEFORE it (round-trip consistent)", () => {
		// splitBody recognizes the Setext heading (`Acceptance Criteria` + `===`), so the
		// effort line lands in the narrative before it — not orphaned after the criteria.
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2.5
\`\`\`

Narrative.

Acceptance Criteria
===================

- [ ] works
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBe(2.5);
		expect(story.body.indexOf("**Effort:**")).toBeLessThan(
			story.body.indexOf("Acceptance Criteria"),
		);
	});

	test("authored effort AFTER a Setext AC heading is null on BOTH raw and board form (round 10)", () => {
		// The round-10 breaker: without Setext recognition, raw splitBody kept the effort
		// line in the narrative (2.5) while the board's ATX form excluded it (null). Now
		// both agree it is after the criteria -> null, so effortDays no longer desyncs.
		const authoredAfter =
			"Narrative.\n\nAcceptance Criteria\n===\n\n- [ ] x\n\n**Effort:** 2.5 dev-days";
		expect(parseEffortDays(authoredAfter)).toBeNull();
	});

	test("YAML effort is suppressed by a SAME-LINE <pre>**Effort:**...</pre> mention (no duplicate)", () => {
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 2
\`\`\`

Narrative.

<pre>**Effort:** 3 dev-days</pre>
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		// The mention guard catches the mid-line marker; exactly one **Effort:** remains.
		expect(story.body.match(/\*\*Effort:\*\*/g)?.length).toBe(1);
	});

	test("an effort line after the AC heading is not recognized (avoids sync-criteria hash loss)", () => {
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
status: Backlog
\`\`\`

The narrative.

### Acceptance Criteria
- [ ] a concrete thing

**Effort:** 2.5 dev-days
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBeNull();
	});

	test("effort_days: 0 is a real zero and round-trips (parse -> parse stable)", () => {
		const story = parseMarkdownFile(fileWithYamlEffort("0"), "x.md").stories[0]!;
		expect(story.effortDays).toBe(0);
		expect(story.body).toContain("**Effort:** 0 dev-days");
		// Re-parsing the materialized body is a fixed point (no duplicate line).
		const reparsed = parseMarkdownFile(
			`---\nproject: "Q1"\n---\n\n## As a user, I want X, so that Y\n\n${story.body}\n`,
			"x.md",
		).stories[0]!;
		expect(reparsed.effortDays).toBe(0);
		expect(reparsed.body.match(/\*\*Effort:\*\*/g)?.length).toBe(1);
	});

	test("the body line wins when it disagrees with YAML effort_days", () => {
		const file = `---
project: "Q1"
---

## As a user, I want X, so that Y

\`\`\`yaml
effort_days: 8
\`\`\`

The narrative.

**Effort:** 2.5 dev-days
`;
		const story = parseMarkdownFile(file, "x.md").stories[0]!;
		expect(story.effortDays).toBe(2.5);
		expect(story.body.match(/\*\*Effort:\*\*/g)?.length).toBe(1);
	});
});

describe("effort survives the board round-trip warm", () => {
	test("import hash == export-reconstructed hash, effortDays preserved", () => {
		const { client } = makeFakeClient({ projects: [{ id: "p1", name: "Q1", identifier: "ENG" }] });
		const story = parseMarkdownFile(FILE_BODYLINE, "x.md").stories[0]!;
		const importHash = hashStoryPayload(story, { syncCriteria: false, labels: [] });

		// Non-sync-criteria import stores the FULL body (effort line + criteria) as the
		// description. Model the board item that comes back on export.
		const item: FetchedWorkItem = {
			id: "w1",
			sequenceId: 7,
			name: story.title,
			description: story.body,
			priority: undefined,
			estimate: undefined,
			stateName: "Backlog",
			assigneeEmail: undefined,
			assigneeDisplayName: undefined,
			labels: [],
			externalSource: "planestories",
			externalId: "as-a-user-i-want-x-so-that-y",
			parent: undefined,
			stateGroup: "backlog",
		};

		const reconstructed = boardItemToStory(client, item, "p1", "ENG", "Q1", false);
		expect(reconstructed.effortDays).toBe(2.5);
		// Warm round-trip: the export-written hash matches what the import computed.
		expect(reconstructed.planeHash).toBe(importHash);
	});
});
