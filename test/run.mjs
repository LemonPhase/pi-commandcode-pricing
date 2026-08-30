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
const body = ["stripTags", "modelName", "parsePrice", "formatPrice", "flightArrayAfter", "parseFlight", "parseCreditRows", "parseRequestMap", "blendedCost", "buildGoTable", "buildModelTable", "creditValue", "sortRows", "layoutWidths", "creditText"].map(grab).join("\n");

// pi-tui stubs, injected as parameters
const ESC = "\x1b";
const KEYS = {
	escape: ESC, return: "\r", tab: "\t", "ctrl+c": "\x03", backspace: "\x7f",
	up: `${ESC}[A`, down: `${ESC}[B`, pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, home: `${ESC}[H`, end: `${ESC}[F`,
	left: `${ESC}[D`, right: `${ESC}[C`,
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

const permutationCheck = (rows, sorted, label) => {
	const key = (list) => [...list].sort((a, b) => a.model.localeCompare(b.model)).map((r) => r.model).join();
	check(sorted.length === rows.length && key(sorted) === key(rows), `${label} is a permutation`);
};

const interactionCheck = (table, natural) => {
	// every view: search renders, backspace-on-empty cancels, h/l cycles views
	for (let v = 0; v < table.views.length; v++) {
		const ov = new mod.PricingOverlay(table, "test", { terminal: { rows: 40 }, requestRender() {} }, { fg: (_c, s) => s }, () => {});
		for (let i = 0; i < v; i++) { ov.handleInput("l"); }
		ov.handleInput("/");
		for (const c of (table.views[v].rows[0]?.model.split(" ")[0] || "zz").toLowerCase().slice(0, 3)) ov.handleInput(c);
		let out = ov.render(natural).map((s) => s.replace(/\x1b\[[0-9;]*[mM]/g, ""));
		check(out.some((l) => l.includes("/ ") && !l.includes("/ to search")), `view ${v}: search prompt renders`);
		check(!out.some((l) => l.includes("no match")), `view ${v}: non-empty query matches`);
		// backspace to empty, then once more -> cancels input mode (prompt line back to hint)
		for (let i = 0; i < 4; i++) ov.handleInput("\x7f");
		const rawAfter = ov.render(natural).join("\n");
		const strippedAfter = rawAfter.replace(/\x1b\[[0-9;]*[mM]/g, "").split("\n");
		check(!rawAfter.includes("\x1b[7m") && strippedAfter.some((l) => l.includes("/ to search")), `view ${v}: backspace-on-empty cancels search`);
		// h/l wraps around views
		if (table.views.length > 1) {
			ov.handleInput("h");
			check(ov.viewIdx === (v - 1 + table.views.length) % table.views.length, `view ${v}: h cycles to previous view`);
			ov.handleInput("l"); ov.handleInput("l");
			check(ov.viewIdx === (v + 1) % table.views.length, `view ${v}: l cycles to next view`);
		}
	}
};

// ---- model plans ----
for (const plan of ["goat", "pro", "max"]) {
	console.log(`\n== ${plan}`);
	const table = mod.buildModelTable(plan, fixture(plan), goatFlight());
	check(table.views.length >= 1, `${table.views.length} view(s)`);
	for (const view of table.views) {
		check(view.rows.length >= 20, `view "${view.label || "default"}": ${view.rows.length} rows`);
		check(view.rows.every((r) => r.credits.length >= 1), `view "${view.label || "default"}": every row has a credits tier`);
	}
	const withReq = table.views[0].rows.filter((r) => r.req5h !== "—").length;
	check(withReq >= table.views[0].rows.length * 0.8, `${withReq} rows joined with request limits`);

	const widest = Math.max(...table.views.map((v) => mod.layoutWidths(v.headers, v.rows, Number.MAX_SAFE_INTEGER).headerLen)) + 2;
	const fit = table.views.every((v) => mod.layoutWidths(v.headers, v.rows, widest - 2).headerLen <= widest - 2);
	check(fit, `natural width ${widest} is self-consistent`);

	for (const view of table.views) {
		for (const mode of ["credits", "intel", "value"]) permutationCheck(view.rows, mod.sortRows(view.rows, mode), `sort ${mode} (${view.label || "default"})`);
	}
	interactionCheck(table, widest);
}

// ---- goat specifics ----
console.log("\n== goat specifics");
const goat = mod.buildModelTable("goat", fixture("goat"), goatFlight());
check(goat.views.length === 1, "single view");
const goatRows = goat.views[0].rows;
check(goatRows.some((r) => r.model.endsWith("(Free)")), "free models merged with (Free) suffix");
const sol = goatRows.find((r) => r.model === "GPT-5.6 Sol");
check(!!sol && sol.intel !== "—", "intel joined from flight data");
check(!!sol && sol.req5h === "414", "request limits joined");
check(mod.sortRows(goatRows, "value")[0].blended === 0, "value sort puts free models on top");
check(sol.blended.toFixed(2) === "11.25", "blended cost 0.75·in + 0.25·out (GPT-5.6 Sol → 11.25)");

// ---- max specifics ----
console.log("\n== max specifics");
const max = mod.buildModelTable("max", fixture("max"), goatFlight());
check(max.views.length === 2, `2 views (Max 10× / Max 20×), got ${max.views.length}`);
check(max.views[0].label.includes("10×") && max.views[1].label.includes("20×"), "view labels from credit column headers");
check(max.views.every((v) => v.rows.every((r) => r.credits.length === 1)), "each view shows one tier per row");
check(max.views.some((v) => v.rows.some((r) => r.credits[0].value === "Free")), "free models present from credit table");
// credits sort differs per tier (allowances differ between 10× and 20×)
check(max.views[0].rows.some((r) => r.credits[0].value === "$150") && max.views[1].rows.some((r) => r.credits[0].value === "$300"), "each view carries its own tier's values");

// ---- go specifics ----
console.log("\n== go specifics");
const go = mod.buildGoTable(fixture("go"), goatFlight());
check(go.views.length === 2, "overview + models views");
const [goOverview, goModels] = go.views;
check(goOverview.rows.length === 1 && goOverview.rows[0].model === "Go", "overview has the Go row");
check(goOverview.rows[0].input === "$1" && goOverview.rows[0].output === "$10", "go price cells mapped");
check(goModels.rows.length >= 30, `models view: ${goModels.rows.length} Go-eligible models`);
check(goModels.rows.filter((r) => r.intel !== "—").length >= 30, "models view: intel coverage (33/40 scored in catalogue)");
check(goModels.rows.some((r) => r.input === "$0.00"), "models view includes free models");
check(goModels.rows.every((r) => r.req5h === '—'), 'models view: request windows honestly "—"');

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
