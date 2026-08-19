/**
 * Generates a SYNTHETIC demo board for the README screenshots.
 *
 * Everything here is fabricated — a fictional spacecraft-telemetry product. The
 * README previously showed the operator's real board, with real story titles.
 * Deterministic (a seeded LCG, no Math.random) so a re-shoot reproduces the same
 * arrangement rather than a different-looking galaxy every time.
 */

let seed = 20260819;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;

const EPICS = [
	["Ground station uplink", "Reliable command and telemetry over the dish network."],
	["Telemetry ingestion", "Land every downlinked frame, in order, exactly once."],
	["Frame decoding", "Turn raw CCSDS packets into typed measurements."],
	["Anomaly detection", "Catch a failing subsystem before the operator does."],
	["Orbit determination", "Fit state vectors from ranging and doppler."],
	["Mission planner", "Turn objectives into a validated command schedule."],
	["Command authorization", "No command reaches a spacecraft unreviewed."],
	["Payload scheduling", "Fair, deconflicted instrument time."],
	["Thermal model", "Predict panel temperatures across an orbit."],
	["Power budget", "Battery depth-of-discharge stays inside limits."],
	["Attitude control", "Point the bus where the plan says."],
	["Archive and replay", "Any pass can be replayed bit-for-bit."],
	["Operator console", "One screen an operator can run a pass from."],
	["Alerting and paging", "The right person, the first time."],
	["Simulation harness", "Fly the whole stack against a synthetic vehicle."],
	["Flight software updates", "Uplink a patch without bricking the bus."],
	["Ranging calibration", "Remove station bias from range measurements."],
	["Data distribution", "Science teams pull products without asking us."],
	["Access control", "Least privilege across missions and teams."],
	["Observability", "The ground segment observes itself."],
];

const ROLES = [
	"an operator",
	"a flight engineer",
	"a mission planner",
	"a science user",
	"an on-call engineer",
	"a subsystem owner",
	"an analyst",
	"a station operator",
	"a security officer",
	"a developer",
	"a payload scientist",
	"a ground controller",
];

const ACTIONS = [
	"see live subsystem health",
	"replay a downlink frame by frame",
	"validate a schedule offline",
	"download calibrated products",
	"be paged with the failing subsystem named",
	"set alert thresholds per instrument",
	"compare two passes side by side",
	"see the dish booking calendar",
	"audit every command that was sent",
	"run the stack against a simulator",
	"reconstruct the state vector after a gap",
	"export a pass as CCSDS",
	"annotate an anomaly on the timeline",
	"filter telemetry by subsystem",
	"see which frames were dropped",
	"approve a command batch",
	"roll back a flight software patch",
	"watch battery depth-of-discharge",
	"see predicted panel temperatures",
	"trace a product back to its raw frames",
	"pin a baseline for regression",
	"request an unscheduled pass",
	"see the ranging residuals",
	"mask a known-noisy channel",
	"schedule instrument time",
	"resolve two conflicting bookings",
	"see the uplink queue depth",
	"replay with the clock correction applied",
	"tag a pass as anomalous",
	"stream telemetry to a notebook",
	"diff two schedule versions",
	"see who acknowledged an alert",
];

const OUTCOMES = [
	"I can act during the pass",
	"an anomaly can be reconstructed",
	"a bad plan never reaches the dish",
	"I do not have to ask an operator",
	"triage does not start with five tools",
	"the alerts match the hardware",
	"drift is visible early",
	"maintenance does not collide with a pass",
	"we can prove what was commanded",
	"we can test without a spacecraft",
	"the gap does not become a guess",
	"the archive stays reproducible",
	"the next shift has the context",
	"the science is defensible",
];

const DETAIL = [
	"Frames arrive out of order during a pass and must be reassembled by sequence count.",
	"The station clock drifts; timestamps are corrected against the ranging solution.",
	"Downlink gaps are normal — the gap itself is data and must be recorded, not filled.",
	"Two ground stations can see the vehicle at once; duplicate frames must collapse.",
	"A command is rejected unless its authorization chain is intact.",
	"Calibration coefficients change per instrument and per epoch.",
	"The model runs per orbit and is compared against measured telemetry.",
	"Products are immutable once published; corrections publish a new version.",
];

const STATUSES = [
	"Done",
	"Done",
	"Done",
	"In Progress",
	"In Progress",
	"Todo",
	"Todo",
	"Backlog",
	"Backlog",
	"Backlog",
	"Cancelled",
];
const PRIORITIES = ["urgent", "high", "medium", "medium", "low", "none"];

const lines: string[] = ["---", 'project: "Helios Ground Segment"', "---", ""];
let n = 0;
const idOf = () => `HGS-${++n}`;

interface Story {
	id: string;
	epic: string;
}
const stories: Story[] = [];
const seen = new Set<string>();
const epicIds: string[] = [];

for (const [title, why] of EPICS) {
	const epicId = idOf();
	epicIds.push(epicId);
	lines.push(
		`## ${title}`,
		"",
		"```yaml",
		"kind: epic",
		`plane_identifier: ${epicId}`,
		"```",
		"",
		"### Why is this needed?",
		"",
		why as string,
		"",
	);
	const count = 8 + Math.floor(rnd() * 12);
	for (let i = 0; i < count; i++) {
		const id = idOf();
		let title = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			const candidate = `As ${pick(ROLES)}, I want to ${pick(ACTIONS)}, so that ${pick(OUTCOMES)}`;
			if (!seen.has(candidate)) {
				title = candidate;
				seen.add(candidate);
				break;
			}
		}
		if (!title) continue;
		lines.push(
			`## ${title}`,
			"",
			"```yaml",
			`plane_identifier: ${id}`,
			`parent: ${epicId}`,
			`status: ${pick(STATUSES)}`,
			`priority: ${pick(PRIORITIES)}`,
			"```",
			"",
			`**Effort:** ${[0.5, 1, 1.5, 2, 3, 5, 8][Math.floor(rnd() * 7)]} dev-days`,
			"",
			pick(DETAIL),
			"",
			"### Acceptance Criteria",
			`- [${rnd() > 0.5 ? "x" : " "}] The behaviour is observable in the console`,
			`- [${rnd() > 0.6 ? "x" : " "}] A regression test covers the failure mode`,
			`- [${rnd() > 0.7 ? "x" : " "}] The runbook documents the alert`,
			"",
		);
		stories.push({ id, epic: epicId });
	}
}

// Cross-epic dependency edges — the "supply lines" the README describes. Only
// between DIFFERENT epics, so the picture shows the graph crossing boundaries.
const edges: string[] = [];
for (let i = 0; i < 46; i++) {
	const a = pick(stories);
	const b = pick(stories);
	if (a.epic === b.epic || a.id === b.id) continue;
	edges.push(`${a.id}|${b.id}`);
}
const text = lines.join("\n");
const withDeps = text.replace(/plane_identifier: (HGS-\d+)\nparent: (HGS-\d+)\n/g, (m, id) => {
	const mine = edges.filter((e) => e.startsWith(`${id}|`)).map((e) => e.split("|")[1]);
	return mine.length > 0 ? `${m}blocked_by: [${mine.join(", ")}]\n` : m;
});

await Bun.write(process.argv[2] as string, withDeps);
console.log(`epics=${epicIds.length} stories=${stories.length} edges=${edges.length}`);
