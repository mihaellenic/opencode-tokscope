# Tokscope documentation previews

- `tokscope-overview.png`: model/provider comparison, daily trend, filters, and
  coverage. An **illustrative HTML mockup**, not a live capture: synthetic
  rates and provider assignments, real model names supplied by the owner.
  Regenerate with `bun scripts/screenshots/generate.ts`, then render
  `tokscope-overview.html` at 1406 × 688 and save a viewport PNG.
- `tokscope-sidebar.png`: a real capture of OpenCode 2.1.4 with the Tokscope
  widget in the session sidebar (a 24h-era summary, captured before the sidebar switched to Today, + one highlighted widget, as the
  owner chose). It contains the owner's own session metadata, model names, and
  usage figures, reviewed before publishing.

## Regeneration

Only `tokscope-overview.png` is generated. `tokscope-sidebar.png` is the owner's
manual capture and should not be overwritten by the generator.

From the repository root, with Bun available:

```sh
bun scripts/screenshots/generate.ts
```

If Bun is managed by mise without a selected version:

```sh
mise exec bun@1.4.1 -- bun scripts/screenshots/generate.ts
```

Open the generated HTML file in Chrome, set the viewport to 1406 × 688,
and save a viewport PNG to `tokscope-overview.png`. No external resources or
server are required. Review both PNGs after regenerating.

The root README embeds `docs/images/` via absolute `raw.githubusercontent.com/main` URLs so both GitHub and
npm render them; the npm artifact still does not include `docs/images/`. Local development lives in `CONTRIBUTING.md`.
