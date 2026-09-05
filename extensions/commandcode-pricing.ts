// Command Code plan pricing for pi — /go-pricing /goat-pricing /pro-pricing /max-pricing
// Data is scraped live from each plan's page on commandcode.ai (no public pricing API exists).
// Intelligence scores and the Go-plan model list come from the GOAT page's embedded flight
// JSON, which covers the whole 62-model catalogue; prices/credits/limits come from each
// plan's own tables. Max's two tiers differ only in credit amounts, so both tiers share a row.
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { decodeKittyPrintable, matchesKey, sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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

const STANDARD_HEADERS = ["Model", "In/MTok", "Out/MTok", "Cache", "Intel", "Intel/mo", "5h", "Week", "Month", "Credits"];

interface Row {
	model: string;
	input: string;
	output: string;
	cacheRead: string;
	intel: string; // "58.6" or "—"
	intelPerMo: string;
	req5h: string;
	reqWeek: string;
	reqMonth: string;
	credits: { label: string; value: string }[]; // one per tier; max carries two
	blended: number; // 0.75·in + 0.25·out from this row's own prices; feeds Intel/mo and the value sort
}

interface PlanTable {
	headers: string[];
	rows: Row[];
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

// Printable-text input: on modern terminals (kitty/ghostty/WezTerm) letters arrive as CSI-u
// sequences like \x1b[113u, not raw chars — decode like pi's own editor does, with a raw-char
// fallback for legacy terminals. Returns null for non-printable input.
function printable(data: string): string | null {
	const decoded = decodeKittyPrintable(data);
	if (decoded) return decoded;
	return data.length === 1 && data.charCodeAt(0) >= 32 ? data : null;
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

function parseFlight(html: string, onError?: (msg: string) => void): { byName: Map<string, FlightModel>; models: FlightModel[]; goatIds: Set<string> } {
	const out = { byName: new Map<string, FlightModel>(), models: [] as FlightModel[], goatIds: new Set<string>() };
	try {
		const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,(".*?")\]\)/gs)].map((m) => m[1]);
		const flight = chunks.map((c) => JSON.parse(c) as string).join("");
		const modelsText = flightArrayAfter(flight, '"models":[');
		if (modelsText) {
			const parsed = JSON.parse(modelsText.replace(/"\$undefined"/g, "null")) as FlightModel[];
			// Shape check: a false marker match (the byte sequence can appear in embedded page
			// text) would parse to garbage — treat as absent rather than poisoning every row
			if (Array.isArray(parsed) && parsed.every((m) => typeof m?.name === "string" && typeof m?.id === "string")) {
				out.models = parsed;
				for (const m of parsed) out.byName.set(m.name.toLowerCase(), m);
			} else {
				onError?.("flight models payload failed shape check — intel columns show “—”");
			}
		}
		const idsText = flightArrayAfter(flight, '"modelIds":[');
		if (idsText) {
			const ids = JSON.parse(idsText) as unknown;
			if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") out.goatIds.add(id);
		}
	} catch (err) {
		onError?.(`flight data unavailable (${err instanceof Error ? err.message : String(err)}) — intel columns show “—”`);
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
		// Real credit tables start with a Model column; the plans-overview table starts with
		// "Plan" and would otherwise parse as models (its Credits/mo column mentions credits)
		if (!headCells[0]?.includes("Model")) continue;
		const creditIdx: number[] = [];
		headCells.forEach((h, i) => {
			if (h.toLowerCase().includes("credits") && i > 0) creditIdx.push(i);
		});
		if (creditIdx.length === 0) continue;
		for (const rowEl of table.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
			const cells = (rowEl.match(/<td[\s\S]*?<\/td>/g) ?? []).map(stripTags);
			if (cells.length < headCells.length - 1 || parsePrice(cells[1] ?? "") === null) continue;
			const name = modelName(cells[0]);
			// First table wins when the same model appears in multiple credit tables
			// (e.g. boosted vs 2× segments); current plan pages have disjoint model sets.
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

async function buildPlanTable(plan: Plan, onError?: (msg: string) => void): Promise<PlanTable> {
	// Intel always comes from the goat page's flight JSON (whole catalogue lives there);
	// the goat page doubles as the plan page in that case.
	const goatP = fetchPage(PLAN_URLS.goat);
	const pageP = plan === "go" ? goatP : fetchPage(PLAN_URLS[plan]);
	const [pageHtml, intel] = await Promise.all([pageP, goatP.then((h) => parseFlight(h, onError))]);
	return plan === "go" ? buildGoTable(intel) : buildModelTable(plan, pageHtml, intel);
}

// Intel/mo — the plan-holder's lens: intelligence × the plan's monthly credit allowance for
// that model ÷ blended cost, i.e. scored intelligence×MTok the plan buys per month. Credits
// differ per model, so this accounts for what Intel/$ can't see. "—" unscored/no allowance;
// "∞" for free models (blended 0).
function formatIntelPerMo(intelStr: string, blended: number, creditsValue: string): string {
	if (intelStr === "—") return "—";
	if (blended === 0) return "∞";
	const score = Number.parseFloat(intelStr);
	const credit = parsePrice(creditsValue);
	return Number.isFinite(score) && credit != null ? ((score * credit) / blended).toFixed(0) : "—";
}

// go is a plans-overview page — no model tables on it. Show the Go-eligible models instead
// (minPlanName "Go" in the catalogue flight data). The go page publishes no per-model credit
// allowances or request windows, so those columns stay "—".
function buildGoTable(intel: { models: FlightModel[] }): PlanTable {
	const rows: Row[] = intel.models
		.filter((m) => m.minPlanName === "Go")
		.map((m) => {
			const inP = formatPrice(m.inputCost);
			const outP = formatPrice(m.outputCost);
			const blended = blendedCost(inP, outP);
			const intelStr = m.intelligenceIndex != null ? m.intelligenceIndex.toFixed(1) : "—";
			return {
				model: m.name,
				input: inP,
				output: outP,
				cacheRead: formatPrice(m.cacheReadCost),
				intel: intelStr,
				intelPerMo: "—", // go publishes no per-model credit allowances
				req5h: "—",
				reqWeek: "—",
				reqMonth: "—",
				credits: [{ label: "Credits", value: "—" }],
				blended,
			};
		});
	if (rows.length === 0) throw new Error("No Go-eligible models found — catalogue data may have changed");
	return { headers: STANDARD_HEADERS, rows, url: PLAN_URLS.go };
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
		const intelStr = fm?.intelligenceIndex != null ? fm.intelligenceIndex.toFixed(1) : "—";
		const blended = blendedCost(cr.input, cr.output);
		const intelPerMo = cr.creditValues.map((c) => formatIntelPerMo(intelStr, blended, c.value)).join("/");
		bases.push({
			base: {
				model: cr.name,
				input: cr.input,
				output: cr.output,
				cacheRead: cr.cacheRead,
				intel: intelStr,
				intelPerMo,
				req5h: rq?.[0] ?? "—",
				reqWeek: rq?.[1] ?? "—",
				reqMonth: rq?.[2] ?? "—",
				blended,
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
			const intelStr = fm.intelligenceIndex != null ? fm.intelligenceIndex.toFixed(1) : "—";
			bases.push({
				base: {
					model: `${fm.name} (Free)`,
					input: formatPrice(fm.inputCost),
					output: formatPrice(fm.outputCost),
					cacheRead: formatPrice(fm.cacheReadCost),
					intel: intelStr,
					intelPerMo: formatIntelPerMo(intelStr, 0, "Free"),
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
	return {
		headers: STANDARD_HEADERS,
		rows: bases.map((b) => ({ ...b.base, credits: b.credits })),
		url: PLAN_URLS[plan],
	};
}

const SORT_MODES: { key: "credits" | "intel" | "value" | "plan"; label: string }[] = [
	{ key: "credits", label: "Credits" },
	{ key: "intel", label: "Intelligence" },
	{ key: "value", label: "Value (intel/$)" },
	{ key: "plan", label: "Plan (intel/mo)" },
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
	} else if (mode === "plan") {
		// Plan: free models on top (intel desc within), then by plan-adjusted intel/mo desc,
		// unscored paid last. The answer to "what should I run on this plan".
		const intel = (r: Row) => (r.intel === "—" ? -1 : Number.parseFloat(r.intel));
		const tier = (r: Row): 0 | 1 | 2 => (r.blended === 0 ? 0 : intel(r) < 0 ? 2 : 1);
		const rank = (r: Row) => (tier(r) === 0 ? intel(r) : tier(r) === 1 ? Number.parseFloat(r.intelPerMo) : 0);
		sorted.sort((a, b) => tier(a) - tier(b) || rank(b) - rank(a) || a.model.localeCompare(b.model));
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

// Column widths: fixed natural model name column (24 chars) + section gaps + content widths.
// 4 section dividers (" ┆ " = 12) + 1 leading space + 2 spaces in prices + 1 space in intel + 2 in limits = 18 formatting chars.
function layoutWidths(headers: string[], rows: Row[]) {
	const cells = (r: Row) => [r.input, r.output, r.cacheRead, r.intel, r.intelPerMo, r.req5h, r.reqWeek, r.reqMonth, creditText(r)];
	const widths = headers.slice(1).map((h, i) => Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(cells(r)[i] ?? ""))));
	const nameW = 24;
	const headerLen = nameW + 18 + widths.reduce((a, w) => a + w, 0);
	return { widths, nameW, headerLen };
}

function creditText(r: Row): string {
	return r.credits.map((c) => c.value).join("/");
}

class PricingOverlay implements Component {
	private table: PlanTable;
	private planLabel: string;
	private tui: TUI;
	private theme: Theme;
	private scroll = 0;
	private hScroll = 0;
	private maxHScroll = 0;
	private sortIdx = 0;
	private query = "";
	private searching = false;
	private done: () => void;

	constructor(table: PlanTable, planLabel: string, tui: TUI, theme: Theme, done: () => void) {
		this.table = table;
		this.planLabel = planLabel;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
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
			} else {
				const ch = printable(data); // CSI-u aware — kitty terminals send \x1b[113u for "q"
				if (ch) this.query += ch;
				else return;
			}
			this.clampScroll();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "return") || printable(data) === "q") {
			this.done();
		} else if (printable(data) === "/") {
			this.searching = true;
		} else if (matchesKey(data, "tab")) {
			this.sortIdx = (this.sortIdx + 1) % SORT_MODES.length;
		} else if (matchesKey(data, "up") || printable(data) === "k") {
			this.scroll--;
		} else if (matchesKey(data, "down") || printable(data) === "j") {
			this.scroll++;
		} else if (matchesKey(data, "left") || printable(data) === "h") {
			this.hScroll = Math.max(0, this.hScroll - 6);
		} else if (matchesKey(data, "right") || printable(data) === "l") {
			this.hScroll = Math.min(this.maxHScroll, this.hScroll + 6);
		} else if (matchesKey(data, "pageUp") || printable(data) === "u") {
			this.scroll -= page;
		} else if (matchesKey(data, "pageDown") || printable(data) === "d") {
			this.scroll += page;
		} else if (matchesKey(data, "home") || printable(data) === "g") {
			this.scroll = 0;
		} else if (matchesKey(data, "end") || printable(data) === "G") {
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
		return q ? this.table.rows.filter((r) => r.model.toLowerCase().includes(q)) : this.table.rows;
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

		const { widths, nameW, headerLen } = layoutWidths(this.table.headers, sorted);
		this.maxHScroll = Math.max(0, headerLen - innerW);
		this.hScroll = Math.max(0, Math.min(this.hScroll, this.maxHScroll));

		const tableRow = (s: string) => {
			const sliced = this.maxHScroll > 0 ? sliceByColumn(s, this.hScroll, innerW) : s;
			const pad = Math.max(0, innerW - visibleWidth(sliced));
			return border("│") + sliced + (pad > 0 ? " ".repeat(pad) : "") + border("│");
		};

		const sep = dim(" ┆ ");
		const formatSectioned = (
			model: string,
			prices: [string, string, string],
			intelCols: [string, string],
			limits: [string, string, string],
			credits: string,
		) => `${model} ${sep}${prices.join(" ")}${sep}${intelCols.join(" ")}${sep}${limits.join(" ")}${sep}${credits}`;

		const lines: string[] = [];

		const mode = SORT_MODES[this.sortIdx];
		const title = ` ${this.planLabel} · sort: ${mode.label} (Tab) `;
		const titlePad = Math.max(0, innerW - visibleWidth(title));
		lines.push(border("╭") + th.fg("accent", truncateToWidth(title, innerW)) + border("─".repeat(titlePad) + "╮"));
		lines.push(row(dim(` ${this.table.url}`)));
		const cursor = this.searching ? "\x1b[7m \x1b[27m" : "";
		const searchLine = this.query || this.searching ? th.fg("accent", `/ ${this.query}`) + cursor : dim(" / to search");
		lines.push(row(` ${searchLine}`));
		lines.push(row(""));

		// Header row with dimmed section borders
		const hdrCols = this.table.headers.slice(1).map((h, i) => h.padStart(widths[i]));
		const headerLine = formatSectioned(
			this.table.headers[0].padEnd(nameW).slice(0, nameW),
			[hdrCols[0], hdrCols[1], hdrCols[2]],
			[hdrCols[3], hdrCols[4]],
			[hdrCols[5], hdrCols[6], hdrCols[7]],
			hdrCols[8],
		);
		lines.push(tableRow(headerLine));

		const rulerPrices: [string, string, string] = ["─".repeat(widths[0]), "─".repeat(widths[1]), "─".repeat(widths[2])];
		const rulerIntel: [string, string] = ["─".repeat(widths[3]), "─".repeat(widths[4])];
		const rulerLimits: [string, string, string] = ["─".repeat(widths[5]), "─".repeat(widths[6]), "─".repeat(widths[7])];
		const rulerCredits = "─".repeat(widths[8]);
		const ruler = formatSectioned("─".repeat(nameW), rulerPrices, rulerIntel, rulerLimits, rulerCredits);
		lines.push(tableRow(dim(ruler)));

		for (const m of vis) {
			const isFree = m.credits.some((c) => c.value === "Free");

			// Color helpers
			const colorIntel = (s: string) => {
				const n = Number.parseFloat(s);
				if (!Number.isFinite(n)) return dim(s);
				if (n >= 55) return th.fg("accent", s);
				if (n >= 45) return th.fg("text", s);
				return dim(s);
			};

			const colorIntelPerMo = (s: string) => {
				if (s === "∞") return th.fg("success", s);
				const n = Number.parseFloat(s);
				if (!Number.isFinite(n)) return dim(s);
				// thresholds eyeballed against goat/pro/max intel/mo ranges
				if (n >= 800) return th.fg("success", s);
				if (n >= 250) return th.fg("accent", s);
				if (n >= 80) return th.fg("text", s);
				return dim(s);
			};

			const colorCredit = (s: string) => {
				if (isFree) return th.fg("success", s);
				if (s.includes("$")) return th.fg("warning", s);
				return dim(s);
			};

			const colorLimit = (s: string) => (s === "—" ? dim(s) : s);

			const p0 = m.input.padStart(widths[0]);
			const p1 = m.output.padStart(widths[1]);
			const p2 = m.cacheRead.padStart(widths[2]);
			const prices: [string, string, string] = [
				isFree || m.input === "$0.00" ? th.fg("success", p0) : p0,
				isFree || m.output === "$0.00" ? th.fg("success", p1) : p1,
				isFree || m.cacheRead === "$0.00" ? th.fg("success", p2) : dim(p2),
			];

			const intelCols: [string, string] = [
				colorIntel(m.intel.padStart(widths[3])),
				colorIntelPerMo(m.intelPerMo.padStart(widths[4])),
			];

			const limits: [string, string, string] = [
				colorLimit(m.req5h.padStart(widths[5])),
				colorLimit(m.reqWeek.padStart(widths[6])),
				colorLimit(m.reqMonth.padStart(widths[7])),
			];

			const mName = isFree ? th.fg("success", m.model.padEnd(nameW).slice(0, nameW)) : m.model.padEnd(nameW).slice(0, nameW);

			lines.push(
				tableRow(
					formatSectioned(
						mName,
						prices,
						intelCols,
						limits,
						colorCredit(creditText(m).padStart(widths[8])),
					),
				),
			);
		}

		const hHint = this.maxHScroll > 0 ? " · ←→/hl pan" : "";
		const hint = total === 0 ? "no match" : this.scroll + rows >= total ? `end · ${total} shown` : `${this.scroll + 1}–${this.scroll + rows} of ${total}`;
		lines.push(row(""));
		lines.push(row(dim(` Tab sort · / search · ↑↓/jk${hHint} · pgup/pgdn · g/G · Esc close · ${hint}`)));
		lines.push(border(`╰${"─".repeat(innerW)}╯`));
		return lines;
	}

	invalidate(): void {}
}

async function openPricing(plan: Plan, ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.setStatus("cc-pricing", `fetching ${plan} pricing…`);
	let table: PlanTable;
	try {
		table = await buildPlanTable(plan, (msg) => ctx.ui.notify(`${plan} pricing: ${msg}`, "warning"));
	} catch (err) {
		ctx.ui.notify(`${plan} pricing: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	} finally {
		ctx.ui.setStatus("cc-pricing", undefined);
	}
	if (ctx.mode === "print") {
		// print mode owns stdout; json/rpc modes stream a protocol there — notify instead
		for (const m of table.rows)
			console.log(`${m.model}\t${m.input}\t${m.output}\t${m.cacheRead}\t${m.intel}\t${m.intelPerMo}\t${m.req5h}\t${m.reqWeek}\t${m.reqMonth}\t${creditText(m)}`);
		return;
	}
	// Width fits all columns, capped to the terminal
	const natural = layoutWidths(table.headers, table.rows).headerLen + 2;
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
