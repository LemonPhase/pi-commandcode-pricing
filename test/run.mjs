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
	SORT_MODES: /const SORT_MODES = \[[\s\S]*?\n\];/,
	CHROME_LINES: /const CHROME_LINES = \d+;/,
};
const consts = Object.entries(constPatterns).map(([k, re]) => {
	const m = js.match(re)?.[0];
	if (!m) throw new Error(`const extraction failed: ${k}`);
	return m;
}).join("\n");
const body = ["printable", "stripTags", "modelName", "parsePrice", "formatPrice", "flightArrayAfter", "parseFlight", "parseCreditRows", "parseRequestMap", "blendedCost", "formatIntelPerMo", "buildGoTable", "buildModelTable", "creditValue", "sortRows", "layoutWidths", "creditText"].map(grab).join("\n");

// pi-tui stubs, injected as parameters
const ESC = "\x1b";
const KEYS = {
	escape: ESC, return: "\r", tab: "\t", "ctrl+c": "\x03", backspace: "\x7f",
	up: `${ESC}[A`, down: `${ESC}[B`, left: `${ESC}[D`, right: `${ESC}[C`,
	pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, home: `${ESC}[H`, end: `${ESC}[F`,
};
const visibleWidth = (s) => s.replace(/\x1b\[[0-9;]*[mM]/g, "").replace(/\x1b\[7m/g, "").replace(/\x1b\[27m/g, "").length;
const truncateToWidth = (s, n) => (visibleWidth(s) > n ? s.slice(0, n - 1) + "…" : s);
const sliceByColumn = (s, start, length) => s.slice(start, start + length);
const GOAT_URL = "https://commandcode.ai/docs/plans/goat";
const matchesKey = (data, key) => data === KEYS[key];
const decodeKittyPrintable = (data) => {
	const m = /^\x1b\[(\d+)u$/.exec(data);
	if (!m) return undefined;
	const cp = Number.parseInt(m[1], 10);
	return Number.isFinite(cp) && cp >= 32 ? String.fromCodePoint(cp) : undefined;
};

const mod = new Function(
	"visibleWidth", "truncateToWidth", "sliceByColumn", "GOAT_URL", "matchesKey", "decodeKittyPrintable",
	`${consts}\n${body}\n${cls}\nreturn { parseFlight, parseCreditRows, parseRequestMap, parsePrice, blendedCost, formatIntelPerMo, buildGoTable, buildModelTable, sortRows, layoutWidths, creditText, PricingOverlay, PLAN_URLS };`,
)(visibleWidth, truncateToWidth, sliceByColumn, GOAT_URL, matchesKey, decodeKittyPrintable);

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
	const ov = new mod.PricingOverlay(table, "test", { terminal: { rows: 40 }, requestRender() {} }, { fg: (_c, s) => s }, () => {});
	const strip = (s) => s.replace(/\x1b\[[0-9;]*[mM]/g, "");
	ov.handleInput("/");
	const term = (table.rows[0]?.model.split(" ")[0] || "zz").toLowerCase().slice(0, 3);
	for (const c of term) ov.handleInput(`\x1b[${c.codePointAt(0)}u`); // kitty CSI-u form
	let out = ov.render(natural).map(strip);
	check(out.some((l) => l.includes("/ ") && !l.includes("/ to search")), "search prompt renders");
	check(!out.some((l) => l.includes("no match")), "non-empty query matches");
	for (let i = 0; i < 4; i++) ov.handleInput("\x7f");
	const rawAfter = ov.render(natural).join("\n");
	check(!rawAfter.includes("\x1b[7m") && rawAfter.replace(/\x1b\[[0-9;]*[mM]/g, "").split("\n").some((l) => l.includes("/ to search")), "backspace-on-empty cancels search");

	// Horizontal panning check when width is narrow
	const narrowOut = ov.render(60).map(strip);
	check(narrowOut.some((l) => l.includes("←→/hl pan")), "pan hint appears when narrow");
	ov.handleInput("l");
	const pannedOut = ov.render(60).map(strip);
	check(pannedOut.length === narrowOut.length, "render works cleanly while panned");
};

// ---- model plans ----
for (const plan of ["goat", "pro", "max"]) {
	console.log(`\n== ${plan}`);
	const table = mod.buildModelTable(plan, fixture(plan), goatFlight());
	check(table.rows.length >= 20, `${table.rows.length} rows parsed`);
	check(table.rows.every((r) => r.credits.length >= 1), "every row has a credits tier");
	check(table.rows.every((r) => r.intel !== undefined), "intel column present");
	check(table.rows.every((r) => r.intelPerMo !== undefined), "intel/mo column present");
	const scoredPaid = table.rows.filter((r) => r.intel !== "—" && r.blended !== 0);
	check(scoredPaid.every((r) => {
		const expected = r.credits.map((c) => {
			const credit = mod.parsePrice(c.value) ?? 0;
			return credit === 0 || r.intel === "—" || r.blended === 0 ? (r.blended === 0 && r.intel !== "—" ? "∞" : "—") : ((Number.parseFloat(r.intel) * credit) / r.blended).toFixed(0);
		});
		return r.intelPerMo === expected.join("/");
	}), "intel/mo = intel × credits ÷ blended per tier");
	check(table.rows.every((r) => (r.intel === "—" ? r.intelPerMo.split("/").every((t) => t === "—") : true)), "unscored rows have — intel/mo per tier");
	const withReq = table.rows.filter((r) => r.req5h !== "—").length;
	check(withReq >= table.rows.length * 0.8, `${withReq} rows joined with request limits`);

	const natural = mod.layoutWidths(table.headers, table.rows).headerLen + 2;
	check(mod.layoutWidths(table.headers, table.rows).headerLen <= natural - 2, `natural width ${natural} is self-consistent`);

	for (const mode of ["credits", "intel", "value", "plan"]) permutationCheck(table.rows, mod.sortRows(table.rows, mode), `sort ${mode}`);
	interactionCheck(table, natural);
}

// ---- goat specifics ----
console.log("\n== goat specifics");
const goat = mod.buildModelTable("goat", fixture("goat"), goatFlight());
const goatRows = goat.rows;
check(goatRows.some((r) => r.model.endsWith("(Free)")), "free models merged with (Free) suffix");
const sol = goatRows.find((r) => r.model === "GPT-5.6 Sol");
check(!!sol && sol.intel !== "—", "intel joined from flight data");
check(!!sol && sol.intelPerMo === (Number.parseFloat(sol.intel) * 70 / sol.blended).toFixed(0), "intel/mo = intel × credits ÷ blended (Sol)");
check(goatRows.find((r) => r.blended === 0 && r.intel !== "—")?.intelPerMo === "∞", "scored free models have ∞ intel/mo");
check(mod.sortRows(goatRows, "plan")[0].blended === 0, "plan sort puts free models on top");
const planSorted = mod.sortRows(goatRows.filter((r) => r.blended !== 0 && r.intel !== "—"), "plan");
check(planSorted.every((r, i) => i === 0 || Number.parseFloat(planSorted[i - 1].intelPerMo) >= Number.parseFloat(r.intelPerMo)), "plan sort descends by intel/mo");
check(!!sol && sol.req5h === "414", "request limits joined");
check(mod.sortRows(goatRows, "value")[0].blended === 0, "value sort puts free models on top");
check(sol.blended.toFixed(2) === "11.25", "blended cost 0.75·in + 0.25·out (GPT-5.6 Sol → 11.25)");

// ---- max specifics ----
console.log("\n== max specifics");
const max = mod.buildModelTable("max", fixture("max"), goatFlight());
check(max.rows.every((r) => r.credits.length === 2), "both tiers on one row (Max 10× / Max 20×)");
check(max.rows[0].credits[0].label.includes("10×") && max.rows[0].credits[1].label.includes("20×"), "tier labels carried through");
check(max.rows.some((r) => r.credits.some((c) => c.value === "Free")), "free models present from credit table");
check(max.rows.some((r) => r.credits[0].value === "$150") && max.rows.some((r) => r.credits[1].value === "$300"), "both tier values parsed");

// ---- go specifics ----
console.log("\n== go specifics");
const go = mod.buildGoTable(goatFlight());
check(go.rows.length >= 30, `${go.rows.length} Go-eligible models`);
check(go.rows.filter((r) => r.intel !== "—").length >= 30, "intel coverage (33/40 scored in catalogue)");
check(go.rows.some((r) => r.input === "$0.00"), "includes free models");
check(go.rows.every((r) => r.req5h === "—"), 'request windows honestly "—"');

console.log(failures === 0 ? "\nALL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
