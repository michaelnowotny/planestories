import { describe, expect, test } from "bun:test";
import {
	type AcceptanceCriterion,
	spliceAcceptanceCriteria,
	splitBody,
} from "../../../src/markdown/criteria.ts";
import { htmlToMarkdown, markdownToHtml } from "../../../src/markdown/html.ts";

// --- Writer: markdown -> TipTap task-list (§4.1) -----------------------------

describe("markdownToHtml → TipTap task-list", () => {
	test("emits taskList/taskItem with data-checked for a criteria block", () => {
		const html = markdownToHtml("### Acceptance Criteria\n- [ ] first\n- [x] second");
		expect(html).toContain('data-type="taskList"');
		expect(html).toContain('data-type="taskItem"');
		// first unchecked, second checked
		expect(html).toMatch(/data-checked="false"[\s\S]*first/);
		expect(html).toMatch(/data-checked="true"[\s\S]*second/);
		// no GFM <input> checkboxes leak through
		expect(html).not.toContain("<input");
	});

	test("splits a mixed checkbox + plain-bullet list so checkboxes stay native", () => {
		const html = markdownToHtml("- [ ] a task\n- a plain bullet\n- [x] another task");
		// the checkbox items must be in a taskList, the plain bullet in a normal <ul>
		expect(html).toContain('data-type="taskList"');
		expect(html).toContain('data-type="taskItem"');
		// the plain bullet is NOT a task item
		expect(html).toMatch(/<li>[^<]*a plain bullet/);
		expect(html).not.toContain("<input");
	});

	test("preserves inline markup (code + link) inside a criterion", () => {
		const html = markdownToHtml("- [x] use `code` and [a link](https://x.test)");
		expect(html).toContain('data-type="taskItem"');
		expect(html).toContain("<code>code</code>");
		expect(html).toContain('href="https://x.test"');
	});

	test("leaves ordered and non-task lists untouched", () => {
		const html = markdownToHtml("1. one\n2. two");
		expect(html).toContain("<ol>");
		expect(html).not.toContain("data-type=");
	});

	test("empty input stays empty", () => {
		expect(markdownToHtml("   ")).toBe("");
	});
});

// --- Reader: TipTap task-list -> markdown (§4.2) -----------------------------

const TIPTAP = `<h3>Acceptance Criteria</h3><ul class="todo-list" data-type="taskList"><li class="todo-list-item" data-type="taskItem" data-checked="false"><p>first</p></li><li class="todo-list-item" data-type="taskItem" data-checked="true"><p>second</p></li></ul>`;

describe("htmlToMarkdown ← TipTap task-list", () => {
	test("recovers - [ ] / - [x] from real TipTap output (no <input>)", () => {
		const md = htmlToMarkdown(TIPTAP);
		expect(md).toContain("### Acceptance Criteria");
		expect(md).toContain("- [ ] first");
		expect(md).toContain("- [x] second");
	});

	test("still recovers checkboxes from legacy GFM <input> HTML", () => {
		const gfm =
			'<h3>Acceptance Criteria</h3><ul>\n<li><input disabled type="checkbox"> one</li>\n<li><input checked disabled type="checkbox"> two</li>\n</ul>';
		const md = htmlToMarkdown(gfm);
		expect(md).toContain("- [ ] one");
		expect(md).toContain("- [x] two");
	});

	test("does NOT double-mark a hybrid taskItem that also holds an <input>", () => {
		const hybrid =
			'<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p><input checked type="checkbox"> hybrid</p></li></ul>';
		const md = htmlToMarkdown(hybrid);
		expect(md).toContain("- [x] hybrid");
		expect(md).not.toContain("[x] [x]");
		expect(md).not.toContain("[ ] [");
	});

	test("preserves inline markup on the way back", () => {
		const html =
			'<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>use <code>code</code> and <a href="https://x.test">a link</a></p></li></ul>';
		const md = htmlToMarkdown(html);
		expect(md).toContain("- [x]");
		expect(md).toContain("`code`");
		expect(md).toContain("[a link](https://x.test)");
	});

	test("treats only data-checked=\"true\" as checked (not other truthy forms)", () => {
		const html =
			'<ul data-type="taskList"><li data-type="taskItem" data-checked="checked"><p>weird</p></li></ul>';
		const md = htmlToMarkdown(html);
		expect(md).toContain("- [ ] weird");
	});
});

describe("markdown → TipTap HTML → markdown round-trip identity", () => {
	test("preserves mixed checked state and inline markup", () => {
		const md = "### Acceptance Criteria\n\n- [ ] plain one\n- [x] with `code` and [l](https://x.test)";
		const round = htmlToMarkdown(markdownToHtml(md));
		expect(round).toContain("### Acceptance Criteria");
		expect(round).toContain("- [ ] plain one");
		expect(round).toContain("- [x] with `code` and [l](https://x.test)");
	});
});

// --- Splice: prefix + AC + SUFFIX preservation (§4.3) ------------------------

describe("spliceAcceptanceCriteria preserves prefix and suffix", () => {
	const crit = (text: string, checked: boolean): AcceptanceCriterion => ({ text, checked });

	test("keeps trailing sections after the AC block (the data-loss bug)", () => {
		const body = [
			"Some narrative.",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] old one",
			"",
			"### Testing Notes",
			"",
			"Run the suite.",
			"",
			"**Effort:** 2.5 dev-days",
			"**Depends on:** DATA-1",
		].join("\n");
		const out = spliceAcceptanceCriteria(body, [crit("new one", true), crit("new two", false)]);
		expect(out).toContain("Some narrative.");
		expect(out).toContain("- [x] new one");
		expect(out).toContain("- [ ] new two");
		// suffix survives
		expect(out).toContain("### Testing Notes");
		expect(out).toContain("Run the suite.");
		expect(out).toContain("**Effort:** 2.5 dev-days");
		expect(out).toContain("**Depends on:** DATA-1");
		expect(out).not.toContain("- [ ] old one");
	});

	test("splitBody exposes the suffix region", () => {
		const body = "Intro\n\n### Acceptance Criteria\n\n- [x] c1\n\n### Notes\n\nafter";
		const split = splitBody(body);
		expect(split.narrative).toBe("Intro");
		expect(split.criteria).toEqual([{ text: "c1", checked: true }]);
		expect(split.suffix.trim()).toBe("### Notes\n\nafter");
	});

	test("appends an AC block when the body has none", () => {
		const out = spliceAcceptanceCriteria("Just narrative.", [crit("only", false)]);
		expect(out).toContain("Just narrative.");
		expect(out).toContain("### Acceptance Criteria");
		expect(out).toContain("- [ ] only");
	});

	test("empty criteria drops the AC block but keeps prefix + suffix", () => {
		const body = "Pre\n\n### Acceptance Criteria\n\n- [ ] gone\n\n### Post\n\nkeep";
		const out = spliceAcceptanceCriteria(body, []);
		expect(out).toContain("Pre");
		expect(out).toContain("### Post");
		expect(out).toContain("keep");
		expect(out).not.toContain("- [ ] gone");
		expect(out).not.toContain("Acceptance Criteria");
	});
});
