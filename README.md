# pi-commandcode-pricing

[Command Code](https://commandcode.ai) plan pricing inside [pi](https://pi.dev) — scrollable popup with sort, search, and request limits, scraped live from the official docs pages (no public pricing API exists).

## Install

```bash
pi install git:github.com/LemonPhase/pi-commandcode-pricing
```

Or try without installing:

```bash
pi -e git:github.com/LemonPhase/pi-commandcode-pricing
```

## Commands

| Command | Shows |
|---------|-------|
| `/go-pricing` | Go plan — 40 Go-eligible models with per-token prices (windows aren't published per-model on the Go page) |
| `/goat-pricing` | GOAT plan — per-model pricing, intel, request limits (free models included) |
| `/pro-pricing` | Pro plan — 46 models across three credit tables |
| `/max-pricing` | Max 10× / Max 20× — both credit tiers side by side (they differ only in credit amounts) |

Keys inside a popup: **Tab** cycles sort (Credits → Intelligence → Value intel/$), **`/`** filters by model name (Backspace on empty cancels), `↑↓`/`jk` scroll, `PgUp/PgDn`/`u d` page, `g`/`G` top/end, `Esc` clears search then closes.

## Where the data comes from

- Each command reads its own plan page (`commandcode.ai/docs/plans/<plan>`) for prices, credits, and request windows.
- Intelligence scores always come from the GOAT page's embedded flight JSON, which covers the whole model catalogue — the same scores on every plan.
- Value sort ranks by intel per blended $/MTok (0.75·input + 0.25·output, matching the site's own calculator); free models pin to the top.
- No caching — every command fetches fresh. Pages are ~300–650KB; expect a short delay.

## Development

```bash
npm install
./test/fetch-fixtures.sh   # refresh saved plan-page fixtures
node test/run.mjs          # headless checks against fixtures
```

To load a local checkout into pi without installing:

```bash
pi install /path/to/pi-commandcode-pricing   # local-path package, loads live from disk
```

## License

MIT
