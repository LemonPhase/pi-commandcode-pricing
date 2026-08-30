// Command Code plan pricing for pi — /go-pricing /goat-pricing /pro-pricing /max-pricing
// Data is scraped live from each plan's page on commandcode.ai (no public pricing API exists).
// Intelligence scores and the Go-plan model list come from the GOAT page's embedded flight
// JSON, which covers the whole 62-model catalogue; prices/credits/limits come from each
// plan's own tables. Plans with multiple tiers (max) or an overview (go) expose several
// views; h/l cycles between them inside the popup.
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PLAN_URLS = {
	go: "https://commandcode.ai/docs/plans/go",
	goat: "https://commandcode.ai/docs/plans/goat",
	pro: "https://commandcode.ai/docs/plans/pro",
	max: "https://commandcode.ai/docs/plans/max",
} as const;

type Plan = keyof typeof PLAN_URLS;

const PLAN_TITLES: Record<Plan, string> = {
	go: "Go plan — $1/mo → $10 credits",
	goat: "GOAT plan — $10/mo → $70 usage",
	pro: "Pro plan — $20/mo → $80 usage",
	max: "Max plans — $100/$200/mo → $150/$300 credits",
};

const STANDARD_HEADERS = ["Model", "In/MTok", "Out/MTok", "Cache", "Intel", "5h", "Week", "Month", "Credits"];
const GO_HEADERS = ["Plan", "Price/mo", "Credits/mo", "Usage", "", "", "", "", "Models"];

interface Row {
	model: string;
	input: string;
	output: string;
	cacheRead: string;
	intel: string; // "58.6" or "—"
	req5h: string;
	reqWeek: string;
	reqMonth: string;
	credits: { label: string; value: string }[]; // one per tier (single-tier views carry one)
	blended: number; // 0.75·in + 0.25·out from this row's own prices, for the value sort
}

interface PlanView {
	label: string;
	headers: string[];
	rows: Row[];
}

interface PlanTable {
	views: PlanView[];
	url: string;
}

interface FlightModel {
	name: string;
	id: string;
	inputCost: number | null;
	outputCost: number | null;
	cacheReadCost: number | null;
	intelligenceIndex: number | null;
	minPlanName: string | null;
	deal: { free?: boolean } | null;
}

function stripTags(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&#x27;|&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, " ")
		.trim();
}

// Table name cells can carry an "Off-peak shown…" annotation span after the model name
function modelName(s: string): string {
	return s.split("Off-peak shown")[0].trim();
}

// First $ amount in a cell ("$0.30 + 1" → 0.3); null when no price ("—", "Free")
function parsePrice(s: string): number | null {
	const m = /\$([0-9.]+)/.exec(s);
	return m ? Number.parseFloat(m[1]) : null;
}

function formatPrice(v: number | null): string {
	return v == null ? "—" : `$${v.toFixed(2)}`;
}

// Extract the text of a JSON array that follows `marker` (which includes its opening
// bracket, e.g. '"models":[') in the RSC flight string, respecting string literals.
function flightArrayAfter(flight: string, marker: string): string | null {
	const m = flight.indexOf(marker);
	if (m === -1) return null;
	let i = flight.indexOf("[", m);
	if (i === -1) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let k = i; k < flight.length; k++) {
		const c = flight[k];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "[") depth++;
		else if (c === "]") {
			depth--;
			if (depth === 0) return flight.slice(i, k + 1);
		}
	}
	return null;
}

function parseFlight(html: string): { byName: Map<string, FlightModel>; models: FlightModel[]; goatIds: Set<string> } {
	const out = { byName: new Map<string, FlightModel>(), models: [] as FlightModel[], goatIds: new Set<string>() };
	try {
		const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,(".*?")\]\)/gs)].map((m) => m[1]);
		const flight = chunks.map((c) => JSON.parse(c) as string).join("");
		const modelsText = flightArrayAfter(flight, '"models":[');
		if (modelsText) {
			out.models = JSON.parse(modelsText.replace(/"\$undefined"/g, "null")) as FlightModel[];
			for (const m of out.models) out.byName.set(m.name.toLowerCase(), m);
		}
		const idsText = flightArrayAfter(flight, '"modelIds":[');
		if (idsText) {
			for (const id of JSON.parse(idsText) as string[]) out.goatIds.add(id);
		}
	} catch {
		// Flight data unavailable — intel column shows "—", value sort degrades gracefully
	}
	return out;
}

interface CreditRowRaw {
	name: string;
	input: string;
	output: string;
	cacheRead: string;
	creditValues: { label: string; value: string }[];
}

// Any table whose header mentions "credits" — covers "Monthly credits" (goat/pro, one value)
// and max's combined "Max 10× credits | Max 20× credits" two-tier table. Skips the plans-overview
// table (its "Price/mo" column gives it away; its "Credits/mo" would otherwise match).
function parseCreditRows(html: string): CreditRowRaw[] {
	const rows: CreditRowRaw[] = [];
	const seen = new Set<string>();
	for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
		const headCells = (table.match(/<th[\s\S]*?<\/th>/g) ?? []).map(stripTags);
		if (headCells.some((h) => h.includes("Price/mo"))) continue;
		const creditIdx: number[] = [];
		headCells.forEach((h, i) => {
			if (h.toLowerCase().includes("credits") && i > 0) creditIdx.push(i);
		});
		if (creditIdx.length === 0) continue;
		for (const rowEl of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
			const cells = (rowEl.match(/<td[\s\S]*?<\/td>/g) ?? []).map(stripTags);
			if (cells.length < headCells.length - 1 || parsePrice(cells[1] ?? "") === null) continue;
			const name = modelName(cells[0]);
			if (seen.has(name.toLowerCase())) continue;
			seen.add(name.toLowerCase());
			rows.push({
				name,
				input: cells[1],
				output: cells[2],
				cacheRead: cells[3],
				creditValues: creditIdx.map((i) => ({ label: headCells[i], value: cells[i] })),
			});
		}
	}
	return rows;
}

// Model | Requests / 5 hours | Requests / week | Requests / month
function parseRequestMap(html: string): Map<string, [string, string, string]> {
	const req = new Map<string, [string, string, string]>();
	for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
		const header = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
		if (!header.includes("Requests / 5 hours")) continue;
		for (const rowEl of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
			const cells = (rowEl.match(/<td[\s\S]*?<\/td>/g) ?? []).map(stripTags);
			if (cells.length < 4) continue;
			req.set(modelName(cells[0]).toLowerCase(), [cells[1], cells[2], cells[3]]);
		}
	}
	return req;
}

function blendedCost(input: string, output: string): number {
	const i = parsePrice(input);
	const o = parsePrice(output);
	return i != null && o != null ? 0.75 * i + 0.25 * o : Number.POSITIVE_INFINITY;
}

async function fetchPage(url: string): Promise<string> {
	const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
	return res.text();
}

async function buildPlanTable(plan: Plan): Promise<PlanTable> {
	const url = PLAN_URLS[plan];
	// Intel always comes from the goat page's flight JSON (whole catalogue lives there);
	// the goat page doubles as the plan page in that case.
	const [html, intel] = await Promise.all([
		fetchPage(url),
		plan === "go" ? Promise.resolve(null) : fetchPage(PLAN_URLS.goat).then(parseFlight),
	]);
	const flight = intel ?? { byName: new Map<string, FlightModel>(), models: [] as FlightModel[], goatIds: new Set<string>() };
	if (plan === "go") return buildGoTable(html, flight);
	return buildModelTable(plan, html, flight);
}

// go is a plans-overview page — no model tables on it. Two views: the overview table, and
// the Go-eligible models (minPlanName "Go" in the goat page's catalogue flight data).
function buildGoTable(html: string, intel: { byName: Map<string, FlightModel>; models: FlightModel[] }): PlanTable {
	const rows: Row[] = [];
	for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
		const header = table.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
		if (!header.includes("Price/mo")) continue;
		for (const rowEl of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
			const cells = (rowEl.match(/<td[\s\S]*?<\/td>/g) ?? []).map(stripTags);
			if (cells.length < 5 || cells[1].startsWith("Price")) continue;
			rows.push({
				model: cells[0],
				input: cells[1],
				output: cells[2],
				cacheRead: cells[3],
				intel: "—",
				req5h: "—",
				reqWeek: "—",
				reqMonth: "—",
				credits: [{ label: "Models", value: cells[4] }],
				blended: Number.POSITIVE_INFINITY,
			});
		}
	}
	if (rows.length === 0) throw new Error("No plan table found — page format may have changed");

	// Models view: everything the catalogue gates at Go or above. The go page publishes no
	// per-model credit allowances or request windows, so those columns stay "—".
	const modelRows: Row[] = intel.models
		.filter((m) => m.minPlanName === "Go")
		.map((m) => ({
			model: m.name,
			input: formatPrice(m.inputCost),
			output: formatPrice(m.outputCost),
			cacheRead: formatPrice(m.cacheReadCost),
			intel: m.intelligenceIndex != null ? m.intelligenceIndex.toFixed(1) : "—",
			req5h: "—",
			reqWeek: "—",
			reqMonth: "—",
			credits: [{ label: "Credits", value: "—" }],
			blended: blendedCost(formatPrice(m.inputCost), formatPrice(m.outputCost)),
		}));

	return {
		views: [
			{ label: "Overview", headers: GO_HEADERS, rows },
			{ label: `Models (${modelRows.length})`, headers: STANDARD_HEADERS, rows: modelRows },
		],
		url: PLAN_URLS.go,
	};
}

function buildModelTable(
	plan: Plan,
	html: string,
	intel: { byName: Map<string, FlightModel>; models: FlightModel[]; goatIds: Set<string> },
): PlanTable {
	const req = parseRequestMap(html);
	interface Base extends Omit<Row, "credits"> {}
	const bases: { base: Base; credits: { label: string; value: string }[] }[] = [];
	for (const cr of parseCreditRows(html)) {
		const fm = intel.byName.get(cr.name.toLowerCase());
		const rq = req.get(cr.name.toLowerCase());
		bases.push({
			base: {
				model: cr.name,
				input: cr.input,
				output: cr.output,
				cacheRead: cr.cacheRead,
				intel: fm?.intelligenceIndex != null ? fm.intelligenceIndex.toFixed(1) : "—",
				req5h: rq?.[0] ?? "—",
				reqWeek: rq?.[1] ?? "—",
				reqMonth: rq?.[2] ?? "—",
				blended: blendedCost(cr.input, cr.output),
			},
			credits: cr.creditValues,
		});
	}

	// Goat only: free models on the plan (planScope-gated) have no credit-table row — add
	// them from flight data. Max's credit table already includes its free rows.
	if (plan === "goat") {
		const usedIds = new Set(bases.map((b) => intel.byName.get(b.base.model.toLowerCase())?.id ?? ""));
		for (const fm of intel.models) {
			if (!fm.deal?.free || !intel.goatIds.has(fm.id) || usedIds.has(fm.id)) continue;
			usedIds.add(fm.id);
			bases.push({
				base: {
					model: `${fm.name} (Free)`,
					input: formatPrice(fm.inputCost),
					output: formatPrice(fm.outputCost),
					cacheRead: formatPrice(fm.cacheReadCost),
					intel: fm.intelligenceIndex != null ? fm.intelligenceIndex.toFixed(1) : "—",
					req5h: "—",
					reqWeek: "—",
					reqMonth: "—",
					blended: 0,
				},
				credits: [{ label: "Credits", value: "Free" }],
			});
		}
	}

	if (bases.length === 0) throw new Error("No pricing tables found — page format may have changed");

	// Multi-tier tables (max) become one view per credit column, in table order; single-tier
	// plans get one view. Tier count is the max entries per row — goat's merged free rows use a
	// different label ("Credits" vs "Monthly credits") but are still single-entry.
	const tierCount = Math.max(...bases.map((b) => b.credits.length));
	const labels: string[] = [];
	if (tierCount > 1) {
		for (const b of bases) {
			if (b.credits.length !== tierCount) continue;
			for (const c of b.credits) {
				if (!labels.includes(c.label)) labels.push(c.label);
			}
		}
	}
	const views: PlanView[] =
		tierCount <= 1
			? [{ label: "", headers: STANDARD_HEADERS, rows: bases.map((b) => ({ ...b.base, credits: b.credits })) }]
			: labels.map((label) => ({
					label,
					headers: STANDARD_HEADERS,
					rows: bases.map((b) => ({
						...b.base,
						credits: b.credits.filter((c) => c.label === label).length > 0
							? b.credits.filter((c) => c.label === label)
							: [{ label, value: "—" }],
					})),
				}));
	return { views, url: PLAN_URLS[plan] };
}

const SORT_MODES: { key: "credits" | "intel" | "value"; label: string }[] = [
	{ key: "credits", label: "Credits" },
	{ key: "intel", label: "Intelligence" },
	{ key: "value", label: "Value (intel/$)" },
];

function creditValue(credits: Row["credits"]): number {
	return Number.parseInt((credits[0]?.value ?? "").replace(/[$,]/g, ""), 10) || 0; // "Free" → 0
}

function sortRows(rows: Row[], mode: (typeof SORT_MODES)[number]["key"]): Row[] {
	const sorted = [...rows];
	if (mode === "credits") {
		sorted.sort((a, b) => creditValue(b.credits) - creditValue(a.credits) || a.model.localeCompare(b.model));
	} else if (mode === "intel") {
		const score = (r: Row) => (r.intel === "—" ? -1 : Number.parseFloat(r.intel));
		sorted.sort((a, b) => score(b) - score(a) || a.model.localeCompare(b.model));
	} else {
		// Value: tiered — free models on top (intel desc within), then paid by intel per
		// blended $/MTok, unscored paid last
		const intel = (r: Row) => (r.intel === "—" ? -1 : Number.parseFloat(r.intel));
		const tier = (r: Row): 0 | 1 | 2 => (r.blended === 0 ? 0 : intel(r) < 0 ? 2 : 1);
		const rank = (r: Row) => (tier(r) === 0 ? intel(r) : tier(r) === 1 ? intel(r) / r.blended : 0);
		sorted.sort((a, b) => tier(a) - tier(b) || rank(b) - rank(a) || a.model.localeCompare(b.model));
	}
	return sorted;
}

const CHROME_LINES = 8; // top border, url, search, blank, header, divider, footer, bottom border

// Column widths from data so the 9 columns can't overflow; the name column absorbs the remainder.
// ponytail: below ~95 terminal cols the name column bottoms out at 12 and right columns clip —
// compact headers would be the upgrade if that ever matters.
function layoutWidths(headers: string[], rows: Row[], innerW: number) {
	const cells = (r: Row) => [r.input, r.output, r.cacheRead, r.intel, r.req5h, r.reqWeek, r.reqMonth, creditText(r)];
	const widths = headers.slice(1).map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(cells(r)[i] ?? ""))));
	const fixed = widths.reduce((a, w) => a + w + 2, 0);
	const nameW = Math.max(12, Math.min(30, innerW - fixed));
	return { widths, nameW, headerLen: fixed + nameW };
}

function creditText(r: Row): string {
	return r.credits.map((c) => c.value).join("/");
}

class PricingOverlay implements Component {
	private views: PlanView[];
	private planLabel: string;
	private url: string;
	private tui: TUI;
	private theme: Theme;
	private viewIdx = 0;
	private scroll = 0;
	private sortIdx = 0;
	private query = "";
	private searching = false;
	private done: () => void;

	constructor(table: PlanTable, planLabel: string, tui: TUI, theme: Theme, done: () => void) {
		this.views = table.views;
		this.planLabel = planLabel;
		this.url = table.url;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
	}

	private get view(): PlanView {
		return this.views[this.viewIdx];
	}

	handleInput(data: string): void {
		const page = this.visibleRows();
		if (this.searching) {
			if (matchesKey(data, "escape")) {
				this.searching = false;
				this.query = "";
			} else if (matchesKey(data, "return")) {
				this.searching = false; // keep the filter, leave input mode
			} else if (matchesKey(data, "backspace")) {
				if (this.query === "") {
					this.searching = false; // vim-style: backspace on empty search cancels it
				} else {
					this.query = this.query.slice(0, -1);
				}
			} else if (matchesKey(data, "tab")) {
				this.sortIdx = (this.sortIdx + 1) % SORT_MODES.length;
			} else if (matchesKey(data, "up")) {
				this.scroll--;
			} else if (matchesKey(data, "down")) {
				this.scroll++;
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				this.query += data;
			} else {
				return;
			}
			this.clampScroll();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return") || data === "q") {
			this.done();
		} else if (data === "/") {
			this.searching = true;
		} else if (matchesKey(data, "tab")) {
			this.sortIdx = (this.sortIdx + 1) % SORT_MODES.length;
		} else if (this.views.length > 1 && (data === "h" || matchesKey(data, "left"))) {
			this.viewIdx = (this.viewIdx - 1 + this.views.length) % this.views.length;
			this.scroll = 0;
		} else if (this.views.length > 1 && (data === "l" || matchesKey(data, "right"))) {
			this.viewIdx = (this.viewIdx + 1) % this.views.length;
			this.scroll = 0;
		} else if (matchesKey(data, "up") || data === "k") {
			this.scroll--;
		} else if (matchesKey(data, "down") || data === "j") {
			this.scroll++;
		} else if (matchesKey(data, "pageUp") || data === "u") {
			this.scroll -= page;
		} else if (matchesKey(data, "pageDown") || data === "d") {
			this.scroll += page;
		} else if (matchesKey(data, "home") || data === "g") {
			this.scroll = 0;
		} else if (matchesKey(data, "end") || data === "G") {
			this.scroll = Number.POSITIVE_INFINITY;
		} else {
			return;
		}
		this.clampScroll();
		this.tui.requestRender();
	}

	private clampScroll(): void {
		this.scroll = Math.max(0, Math.min(this.scroll, this.filtered().length - this.visibleRows()));
	}

	private filtered(): Row[] {
		const q = this.query.trim().toLowerCase();
		return q ? this.view.rows.filter((r) => r.model.toLowerCase().includes(q)) : this.view.rows;
	}

	private visibleRows(): number {
		// Fit within ~80% of terminal height, minus the fixed chrome lines
		return Math.max(3, Math.min(this.filtered().length, Math.floor(this.tui.terminal.rows * 0.8) - CHROME_LINES));
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(1, width - 2);
		const border = (c: string) => th.fg("border", c);
		const dim = (s: string) => th.fg("dim", s);
		const row = (s: string) => border("│") + truncateToWidth(s, innerW, "…", true) + border("│");

		const sorted = sortRows(this.filtered(), SORT_MODES[this.sortIdx].key);
		const rows = this.visibleRows();
		const total = sorted.length;
		this.clampScroll();
		const vis = sorted.slice(this.scroll, this.scroll + rows);

		const { widths, nameW } = layoutWidths(this.view.headers, sorted, innerW);
		const format = (model: string, rest: string[], colorLast?: (s: string) => string) => {
			const parts = rest.map((c, i) => c.padStart(widths[i]));
			const last = colorLast && parts.length > 0 ? colorLast(parts[parts.length - 1]) : parts[parts.length - 1];
			return `${model.padEnd(nameW).slice(0, nameW)}  ${parts.slice(0, -1).join("  ")}  ${last}`;
		};
		const lines: string[] = [];

		const mode = SORT_MODES[this.sortIdx];
		const viewTag = this.view.label ? ` · ${this.view.label}` : "";
		const title = ` ${this.planLabel}${viewTag} · sort: ${mode.label} (Tab) `;
		const titlePad = Math.max(0, innerW - visibleWidth(title));
		lines.push(border("╭") + th.fg("accent", truncateToWidth(title, innerW)) + border("─".repeat(titlePad) + "╮"));
		lines.push(row(dim(` ${this.url}`)));
		const cursor = this.searching ? "\x1b[7m \x1b[27m" : "";
		const searchLine = this.query || this.searching ? th.fg("accent", `/ ${this.query}`) + cursor : dim(" / to search");
		lines.push(row(` ${searchLine}`));
		lines.push(row(""));
		lines.push(row(format(this.view.headers[0], this.view.headers.slice(1))));
		const ruler = format("x".repeat(nameW), widths.map((w) => "─".repeat(w)));
		lines.push(row(dim("─".repeat(Math.max(1, visibleWidth(ruler))))));

		for (const m of vis) {
			const isFree = m.credits.some((c) => c.value === "Free");
			lines.push(
				row(
					format(
						m.model,
						[m.input, m.output, m.cacheRead, m.intel, m.req5h, m.reqWeek, m.reqMonth, creditText(m)],
						isFree ? (s) => th.fg("success", s) : undefined,
					),
				),
			);
		}

		const hint = total === 0 ? "no match" : this.scroll + rows >= total ? `end · ${total} shown` : `${this.scroll + 1}–${this.scroll + rows} of ${total}`;
		const viewHint = this.views.length > 1 ? "h/l view · " : "";
		lines.push(row(""));
		lines.push(row(dim(` Tab sort · / search · ${viewHint}↑↓/jk · pgup/pgdn · g/G · Esc close · ${hint}`)));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
}

async function openPricing(plan: Plan, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.setStatus("cc-pricing", `fetching ${plan} pricing…`);
	let table: PlanTable;
	try {
		table = await buildPlanTable(plan);
	} catch (err) {
		ctx.ui.notify(`${plan} pricing: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	} finally {
		ctx.ui.setStatus("cc-pricing", undefined);
	}
	if (ctx.mode !== "tui") {
		for (const view of table.views)
			for (const m of view.rows)
				console.log(`${m.model}\t${m.input}\t${m.output}\t${m.cacheRead}\t${m.intel}\t${m.req5h}\t${m.reqWeek}\t${m.reqMonth}\t${creditText(m)}`);
		return;
	}
	// Width fits the widest view's columns (name up to 30 chars), capped to the terminal
	const natural = Math.max(...table.views.map((v) => layoutWidths(v.headers, v.rows, Number.MAX_SAFE_INTEGER).headerLen)) + 2;
	const width = Math.min(natural, Math.max(70, (process.stdout.columns ?? 110) - 2));
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => new PricingOverlay(table, PLAN_TITLES[plan], tui, theme, done),
		{ overlay: true, overlayOptions: { anchor: "center", width } },
	);
}

export default function (pi: ExtensionAPI) {
	for (const plan of Object.keys(PLAN_URLS) as Plan[]) {
		pi.registerCommand(`${plan}-pricing`, {
			description: `${PLAN_TITLES[plan]} from commandcode.ai (popup: Tab sort, / search)`,
			handler: async (_args, ctx) => {
				await openPricing(plan, ctx);
			},
		});
	}
}
