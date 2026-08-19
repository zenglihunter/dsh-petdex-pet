📖 中文文档：README.md

# dsh-petdex-pet

Bring [Petdex](https://petdex.dev/) desktop pets into the **DeepSeek Harness Web UI**:
a floating, draggable pet in the bottom-right corner that switches sprite animations in real time
following DSH agent activity (idle / running / jumping / waving / failed / waiting-for-approval…),
with a full settings page and interactions.

Pure browser-side rendering — **no Petdex desktop app required**; pet data is read from `~/.petdex/pets/`,
shared and compatible with the desktop version.

![dsh-petdex-pet main UI — pet menu previewing the 4 default Hunter protagonists](img/screenshot.png)

More screenshots:

| Pet menu | One-click install & fetch pets online |
| --- | --- |
| ![Pet menu](img/menu.png) | ![One-click install & fetch pets online](img/install.png) |

## Bundled pets (out of the box)

The plugin ships **4 Hunter × Hunter protagonist pet packs**
(Gon / Killua / Kurapika / Leorio, with spritesheets and `pet.json`).
After installation and a DSH restart, the plugin **seeds** them into `~/.petdex/pets/` on first activation —
so a fresh machine gets pets immediately, no need to add them one by one from the gallery.

- Seeding is **once per pet** (recorded by the marker file `~/.petdex/.dsh-petdex-bundled.json`);
- If a pet with the same name already exists on the target machine, it is **not overwritten** (existing files are kept);
- After you manually delete a bundled pet, it **will not respawn** (deletion is respected).

> ⚠️ Open-source redistribution note: the bundled sprites come from the Petdex community gallery.
> Before publishing, please confirm the asset license terms permit redistribution, and credit the source
> (see "Acknowledgements").

## Feature overview

- 🐾 Bottom-right floating pet: draggable, click to expand the menu; the status bar syncs with DSH activity
  (tool calls, task completion, waiting for approval, failure, etc.), and auto-hides after 5 seconds of the same state.
- ✨ Interaction animations: waves hello on mouse hover; auto-cycles left/right running directions while running.
- ⚙️ Settings → Pets (standalone settings page):
  - Adjust pet size (40%–150%) and enable/disable
  - My Pets: thumbnail list, one-click switch, 🗑 delete
  - Gallery: search (name/type), spritesheet preview, total count, load more
  - **One-click install by install code**: paste `npx petdex@latest install doraemon`, a pet link, or a slug to install
  - State preview: all 9 actions shown as row-by-row animations
- 🔌 Deep DSH integration: task start (jump), executing (run), complete (wave), failed, waiting for approval (wait)…

## Sprite states (9-row spritesheet)

| State | Sprite row | Triggered when |
| --- | --- | --- |
| idle | 0 | No activity |
| running-right | 1 | Cycles while running |
| running-left | 2 | Cycles while running |
| waving | 3 | Task complete / hover interaction |
| jumping | 4 | Task execution starts |
| failed | 5 | Task failed |
| waiting | 6 | Waiting for approval / blocked |
| running | 7 | Tool call, workflow, step execution |
| review | 8 | Preview only (no DSH event mapping yet) |

## Installing on another machine's DSH

The plugin must be installed into DSH's **web profile** (default `C:\Users\<you>\.dsh\profiles\web\`).

### Method 1: Local tgz (simplest)

1. Get `dsh-external-dsh-petdex-pet-<version>.tgz` and copy it into the target machine's profile directory;
2. Edit that profile's `package.json`:
   - Add to `dependencies`:
     ```json
     "@dsh-external/dsh-petdex-pet": "file:./dsh-external-dsh-petdex-pet-0.1.0.tgz"
     ```
   - Append `"@dsh-external/dsh-petdex-pet"` to the `dsh.profile.bundles` array;
3. Run `pnpm install` (or `npm install`) in the profile directory;
4. Restart DSH. A "Pets" item appears in settings and the pet shows up in the bottom-right.

> DSH auto-combines the plugin's `cordis.patch.yml` via `dsh.bundle.patch` — **no manual edit** to the profile's `cordis.patch.yml` is needed.

### Method 2: GitHub / self-hosted source (recommended for open-source distribution)

1. Push this repo to GitHub (e.g. `<user>/dsh-petdex-pet`);
2. Add to the target machine's profile `dependencies`:
   ```json
   "@dsh-external/dsh-petdex-pet": "github:<user>/dsh-petdex-pet"
   ```
3. Also add `"@dsh-external/dsh-petdex-pet"` to `dsh.profile.bundles`, then `pnpm install` and restart DSH.

### Method 3: npm publish

Change `package.json`'s `name` to your own scope (e.g. `@<your-username>/dsh-petdex-pet`) or a non-scoped name, then `npm publish`.
The target machine can then depend on `"dsh-petdex-pet": "^0.1.0"` directly.

## Packaging the plugin

In the plugin directory run:

```bash
npm pack
```

This generates `dsh-external-dsh-petdex-pet-<version>.tgz` (includes `lib/`, `cordis.patch.yml`, `README.md`, `LICENSE`).

## Data & compatibility

- Pet files live in `~/.petdex/pets/<slug>/` (`pet.json` + `spritesheet.webp|png`), shared with the Petdex desktop app;
- The gallery manifest comes from `https://petdex.dev/api/manifest` (5-minute cache); preview images go through an in-plugin proxy (`/petdex-pet/preview/<slug>`) to avoid blocked external links;
- Installing pets uses the plugin's built-in downloader — **no need to run `npx petdex`**.

## Development

- `lib/index.js` — DSH server-side half: routes (status / pets / gallery / install / delete / preview proxy / SSE), session events → pet state machine, settings persistence (owner-side settings scope);
- `lib/client.js` — browser-side bundle (`__ModuleLoader__` format): floating pet rendering / animation / drag / hover, settings → pets page (registers `settings.section` slot).

> Note: client changes use DSH's client HMR (stat-poll + SSE) — save `lib/client.js` for hot reload; `lib/index.js` changes require a DSH restart.

## Acknowledgements

- [Petdex](https://petdex.dev/) — pet sprites, state definitions, and gallery; the bundled Hunter pets are high-quality Codex assets submitted by Petdex community authors (Gon / Killua / Kurapika / Leorio)
- DeepSeek Harness plugin system (client bundle / settings / slots)

## License

MIT
