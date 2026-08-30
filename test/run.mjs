// Headless checks for the pricing extension. Loads the real extension code (transpiled),
// stubs the pi-tui imports, and runs it against saved HTML fixtures of the plan pages.
// Usage: node test/run.mjs          (uses test/fixtures/*.html; run fetch-fixtures.sh first)
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import ts from "typescript";

const dir = path.dirname(url.fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(dir, "..", "extensions", "commandcode-pricing.ts"), "utf8");
const js = ts.transpileModule(src, { compilerOptions: { target: "es2022" } }).outputText;

const grab = (name) => {
	const m = js.match(new RegExp(`function ${name}[\\s\\S]*?\\n}`));
	if (!m) throw new Error(`function ${name} not found in transpiled output`);
	return m[0];
};
const cls = js.slice(js.indexOf("class PricingOverlay"), js.indexOf("export default"));
const constPatterns = {
	PLAN_URLS: /const PLAN_URLS = \{[\s\S]*?\n\};/,
	PLAN_TITLES: /const PLAN_TITLES = \{[\s\S]*?\n\};/,
	STANDARD_HEADERS: /const STANDARD_HEADERS = \[[^\]]*\];/,
	GO_HEADERS: /const GO_HEADERS = \[[^\]]*\];/,
	SORT_MODES: /const SORT_MODES = \[[\s\S]*?\n\];/,
	CHROME_LINES: /const CHROME_LINES = \d+;/,
};
const consts = Object.entries(constPatterns).map(([k, re]) => {
	const m = js.match(re)?.[0];
	if (!m) throw new Error(`const extraction failed: ${k}`);
	return m;
}).join("\n");
const body = ["stripTags", "modelName", "parsePrice", "flightArrayAfter", "parseFlight", "parseCreditRows", "parseRequestMap", "blendedCost", "buildGoTable", "buildModelTable", "creditValue", "sortRows", "layoutWidths", "creditText"].map(grab).join("\n");

// pi-tui stubs, injected as parameters
const ESC = "\x1b";
const KEYS = {
	escape: ESC, return: "\r", tab: "\t", "ctrl+c": "\x03", backspace: "\x7f",
	up: `${ESC}[A`, down: `${ESC}[B`, pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, home: `${ESC}[H`, end: `${ESC}[F`,
};
const visibleWidth = (s) => s.replace(/\x1b\[[0-9;]*[mM]/g, "").replace(/\x1b\[7m/g, "").replace(/\x1b\[27m/g, "").length;
const truncateToWidth = (s, n) => (visibleWidth(s) > n ? s.slice(0, n - 1) + "…" : s);
const GOAT_URL = "https://commandcode.ai/docs/plans/goat";
const matchesKey = (data, key) => data === KEYS[key];

const mod = new Function(
	"visibleWidth", "truncateToWidth", "GOAT_URL", "matchesKey",
	`${consts}\n${body}\n${cls}\nreturn { parseFlight, parseCreditRows, parseRequestMap, buildGoTable, buildModelTable, sortRows, layoutWidths, creditText, PricingOverlay, PLAN_URLS };`,
)(visibleWidth, truncateToWidth, GOAT_URL, matchesKey);

let failures = 0;
const check = (cond, msg) => {
	console.log(`  ${cond ? "ok" : "FAIL"}  ${msg}`);
	if (!cond) failures++;
};

const fixture = (plan) => fs.readFileSync(path.join(dir, "fixtures", `${plan}.html`), "utf8");
const goatFlight = () => mod.parseFlight(fixture("goat"));

// ---- model plans ----
for (const plan of ["goat", "pro", "max"]) {
	console.log(`\n== ${plan}`);
	const table = mod.buildModelTable(plan, fixture(plan), goatFlight());
	check(table.rows.length >= 20, `${table.rows.length} rows parsed`);
	check(table.rows.every((r) => r.credits.length >= 1), "every row has a credits tier");
	check(table.rows.every((r) => r.intel !== undefined), "intel column present");

	const withReq = table.rows.filter((r) => r.req5h !== "—").length;
	check(withReq >= table.rows.length * 0.8, `${withReq} rows joined with request limits`);

	// layout self-consistency at natural width
	const natural = mod.layoutWidths(table.headers, table.rows, Number.MAX_SAFE_INTEGER).headerLen + 2;
	const fit = mod.layoutWidths(table.headers, table.rows, natural - 2).headerLen <= natural - 2;
	check(fit, `natural width ${natural} is self-consistent`);

	// all three sorts are permutations of the rows
	for (const mode of ["credits", "intel", "value"]) {
		const sorted = mod.sortRows(table.rows, mode);
		check(
			sorted.length === table.rows.length && [...sorted].sort((a, b) => a.model.localeCompare(b.model)).map((r) => r.model).join() === [...table.rows].sort((a, b) => a.model.localeCompare(b.model)).map((r) => r.model).join(),
			`sort ${mode} is a permutation`,
		);
	}

	// search: filter then sort stays consistent
	const ov = new mod.PricingOverlay(table, "test", { terminal: { rows: 40 }, requestRender() {} }, { fg: (_c, s) => s }, () => {});
	ov.handleInput("/");
	for (const c of (table.rows[0].model.split(" ")[0] || "x").toLowerCase().slice(0, 3)) ov.handleInput(c);
	const out = ov.render(natural).map((s) => s.replace(/\x1b\[[0-9;]*[mM]/g, ""));
	check(out.some((l) => l.includes("/ ") && !l.includes("/ to search")), "search prompt renders");
	check(!out.some((l) => l.includes("no match")), "non-empty query matches");
}

// ---- goat specifics ----
console.log("\n== goat specifics");
const goat = mod.buildModelTable("goat", fixture("goat"), goatFlight());
check(goat.rows.some((r) => r.model.endsWith("(Free)")), "free models merged with (Free) suffix");
const sol = goat.rows.find((r) => r.model === "GPT-5.6 Sol");
check(!!sol && sol.intel !== "—", "intel joined from flight data");
check(!!sol && sol.req5h === "414", "request limits joined");
const valueTop = mod.sortRows(goat.rows, "value")[0];
check(valueTop.blended === 0, "value sort puts free models on top");
check(sol.blended.toFixed(2) === "11.25", "blended cost 0.75·in + 0.25·out (GPT-5.6 Sol → 11.25)");

// ---- max specifics ----
console.log("\n== max specifics");
const max = mod.buildModelTable("max", fixture("max"), goatFlight());
check(max.rows.every((r) => r.credits.length === 2), `two credit tiers per row (Max 10×/20×)`);
check(max.rows.some((r) => r.credits.some((c) => c.value === "Free")), "free models present from credit table");
check(max.rows[0].credits[0].label.includes("10×") || max.rows[0].credits[1].label.includes("20×"), "tier labels carried through");

// ---- go specifics ----
console.log("\n== go specifics");
const go = mod.buildGoTable(fixture("go"));
check(go.rows.length === 1, `1 plan row on go overview page (got ${go.rows.length})`);
check(go.rows[0].model === "Go", "Go row present");
check(go.rows[0].input === "$1" && go.rows[0].output === "$10", "go price cells mapped");

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
