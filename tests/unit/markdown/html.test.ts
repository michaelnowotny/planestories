import { describe, expect, test } from "bun:test";
import { htmlToMarkdown, markdownToHtml } from "../../../src/markdown/html.ts";

describe("markdownToHtml", () => {
	test("renders task lists as a TipTap task-list (not GFM inputs)", () => {
		// Plane's editor only renders an interactive checklist from the TipTap
		// schema; GFM <input> checkboxes are inert. See tasklist.test.ts for the
		// full writer contract.
		const html = markdownToHtml("- [ ] todo\n- [x] done");
		expect(html).toContain('data-type="taskList"');
		expect(html).toContain('data-checked="false"');
		expect(html).toContain('data-checked="true"');
		expect(html).not.toContain("<input");
	});

	test("returns empty string for blank input", () => {
		expect(markdownToHtml("   ")).toBe("");
	});
});

describe("htmlToMarkdown", () => {
	test("reconstructs headings and task-list checkboxes", () => {
		const html =
			"<div><p>Body.</p>\n<h3>Acceptance Criteria</h3>\n<ul>\n" +
			'<li><input type="checkbox"> one</li>\n' +
			'<li><input type="checkbox" checked> two</li>\n</ul></div>';
		const md = htmlToMarkdown(html);
		expect(md).toContain("### Acceptance Criteria");
		expect(md).toContain("- [ ] one");
		expect(md).toContain("- [x] two");
	});

	test("returns empty string for empty input", () => {
		expect(htmlToMarkdown(undefined)).toBe("");
		expect(htmlToMarkdown("")).toBe("");
	});
});

describe("markdown round-trips through HTML", () => {
	test("acceptance-criteria checklist survives md -> html -> md", () => {
		const original = [
			"User should be able to log in.",
			"",
			"### Acceptance Criteria",
			"",
			"- [ ] User can enter email and password",
			"- [x] Invalid credentials show an error",
		].join("\n");

		const roundTripped = htmlToMarkdown(markdownToHtml(original));

		expect(roundTripped).toContain("### Acceptance Criteria");
		expect(roundTripped).toContain("- [ ] User can enter email and password");
		expect(roundTripped).toContain("- [x] Invalid credentials show an error");
	});
});
