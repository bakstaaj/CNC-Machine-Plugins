# Spindle Tramming Plugin - PC Migration Guide

This document is the handoff for moving development and installation of the gSender Spindle Tramming plugin to another Windows PC. It describes the current project state and gives both a no-build installation path and a source-development path.

## Current project snapshot

- Plugin: **Spindle Tramming** (`community.spindle-tramming`)
- Current version: **0.4.2**
- Target host: **gSender 1.7.0-Edge-2**
- SDK dependency: `@sienci/gsender-plugin-sdk` **0.2.2**
- Build system: Vite 6; UI is React 19
- Current behavior: interactive, one-move-at-a-time tram readings with CW/CCW controls, a pinned workflow panel, saved-reading table, calculated corrections, and a fitted 3D plane visualization.
- The repository root is the parent `gsender_plugins` folder; this plugin folder does not contain its own `.git` directory. Keep all plugin folders in that shared repository.

The plugin is derived in purpose from [bhowiebkr/spindle-tramming-tool](https://github.com/bhowiebkr/spindle-tramming-tool). The original project is a reference; this plugin is a separate gSender SDK implementation.

## What to copy

For a full development migration, copy the entire `gsender_plugins` repository, including the `spindle-tramming` folder and `src`, `test`, `docs`, `ui`, `package.json`, `package-lock.json`, `vite.config.js`, `gsender-plugin.json`, and `README.md`. Also copy the latest release ZIP if you want a ready-to-install artifact without rebuilding.

The latest release artifact at the time of this handoff is:

```text
gsender-spindle-tramming-0.4.2.zip
```

The current workspace stages the install archive at `release-assets\spindle-tramming\v0.4.2\gsender-spindle-tramming-0.4.2.zip` from the `gsender_plugins` repository root. Release archives are ignored by Git and should be attached to a GitHub Release. If the archive is unavailable, recreate it with the build and packaging instructions below.

The old sibling folders `reference-gsender`, `reference-tramming`, and `plugin-packages` belonged to the prior workspace layout and are not required in this repository. The gSender reference checkout used during development was tag `v1.7.0-Edge-2`, commit `19bb36c666618b2b5332cbd7f94e106532a839d3`.

## Install the existing plugin build

If you only want to install the plugin, use the 0.4.2 ZIP and follow the plugin installation process supported by your gSender Edge build. The archive contains the plugin manifest, compiled UI and vendor bundles, README, and screenshots. It does not require Node.js or npm on the CNC PC.

The manifest (`gsender-plugin.json`) declares:

- ID: `community.spindle-tramming`
- Name: `Spindle Tramming`
- Version: `0.4.2`
- Required engine: `1.7.0-Edge-2`
- UI entry: `ui/index.html`
- Tool route: `spindle-tramming`

Do not assume the plugin is compatible with a different gSender release merely because it installs. Confirm SDK/host compatibility and test on the intended Edge build before using machine motion.

## Prepare a new development PC

Install these tools on the new Windows PC:

1. **Node.js**, using a version compatible with the project dependencies (Node 20 LTS is a sensible starting point).
2. **npm**, included with Node.js.
3. **gSender 1.7.0-Edge-2** for plugin host testing.
4. A code editor such as VS Code, if desired.

Copy the project folder to a writable location. Open a terminal in the folder containing `package.json` and run:

```powershell
npm ci
npm test
npm run build
```

`npm ci` restores the exact locked dependency tree from `package-lock.json`. `npm test` runs the Node test suite. `npm run build` writes the distributable UI into `ui`; Vite clears and recreates that output directory. The SDK package is bundled for host use as configured by the Vite SDK plugin, while the gSender SDK runtime is provided by the host.

Useful development commands:

```powershell
npm test
npm run build
```

After editing plugin source, rebuild before installing or testing it in gSender. The compiled `ui` directory is included in the source folder so an existing build can be inspected, but it should be regenerated after source changes.

## Project map

| Path | Purpose |
| --- | --- |
| `src/main.js` | Plugin UI, settings, pinned session panel, saved-reading workflow, calculations and visualization integration. |
| `src/geometry.js` | Measurement positions and arc movement geometry for 45-degree and 90-degree sampling. |
| `src/motion.js` | gSender SDK motion/session checks and controlled move sequencing. |
| `src/analysis.js` | Opposite-cardinal comparisons, correction calculations, plane fitting and visualization data. |
| `src/style.css` | Plugin styles, including sticky workflow and responsive layout. |
| `test/` | Node tests for analysis, geometry and motion behavior. |
| `gsender-plugin.json` | gSender plugin identity, host engine target and entry points. |
| `vite.config.js` | SDK-aware Vite build configuration; output is `ui/`. |
| `ui/` | Built plugin UI loaded by gSender. |
| `README.md` | User-facing overview, usage and installation documentation with screenshots. |
| `docs/images/` | README screenshots, including interactive workflow, readings, corrections and plane view. |
| `docs/capture-screenshots.cjs` | Optional simulated screenshot capture helper. |
| `docs/capture-45-screenshots.cjs` | Optional helper for the 45-degree screenshots. |
| `examples/default-full-run.nc` | Historical G-code example from the earlier generated-run workflow; not the current interactive workflow. |

## Current measurement workflow

1. Enter the probe radius, feed, spindle starting position, sampling angle (90 degrees by default; 45 degrees is also available), units, and initial preload reading. Verify the machine is safe to move and the spindle is off.
2. Start the measurement session. The initial preload is retained as the first saved reading.
3. Press **Move CW** or **Move CCW**. Each action issues the next controlled arc and adds a row for the new position/direction.
4. Enter the dial reading in the pinned panel and press **Save**. The next move remains unavailable until the latest reading is saved.
5. Repeat for the needed positions. Use **Done** to end the move session and release the pinned panel. Existing saved readings remain available for analysis; a pending value can still be saved after ending the motion sequence.
6. Calculate the recommended correction. Opposite cardinal pairs provide the named X/Y comparisons. The 3D plane needs at least three non-collinear, saved readings. Its exaggeration control changes the visual scale of the displayed plane.

The 45- and 90-degree modes use different angular sample positions; the circular indicator and 3D result follow the selected sampling layout.

## Motion and safety notes

This plugin sends motion commands through the gSender SDK. Treat it as machine-control software:

- Test installation, connection checks, and UI behavior without a cutter engaged before performing a real measurement.
- Keep the spindle off and provide safe clearance for the entire tramming arc. Verify the radius, feed, units, starting position and machine coordinate state before each session.
- The plugin checks host state and attempts to constrain the move sequence, but software checks cannot replace operator verification or a safe machine setup.
- The move session is incremental and interactive; it does not generate the old full-run G-code with a pause at every point. Save each dial reading before requesting the next move.
- **Done** ends the plugin's move sequence and releases its pinned panel. It does not undo physical movement already made.
- Real CNC hardware testing has not been established by a successful build or simulated UI capture. Validate cautiously on the specific controller, firmware, gSender build and machine.

The earlier full-run G-code example is retained under `examples/` for historical reference, but is not the current plugin flow. An earlier reported `Invalid Line` / error 9 occurred around a text comment in that older workflow. The current motion code uses ASCII-safe command strings; if a controller error occurs, stop safely and record the exact gSender/controller console output and machine state before continuing.

## Packaging a release ZIP

The committed/current project includes a build output in `ui/`; the latest 0.4.2 release ZIP was assembled from the manifest, built UI, README and screenshots. After building, create a clean package directory containing:

```text
gsender-plugin.json
README.md
ui/
docs/images/
```

Zip the contents of that directory so `gsender-plugin.json` is at the archive root. Do not include `node_modules`, tests, or the source tree in the install ZIP unless the gSender plugin installation format specifically calls for them. Keep the ZIP version aligned with `gsender-plugin.json` and `package.json`.

The versioned local release asset lives under `release-assets\spindle-tramming\v0.4.2\` at the `gsender_plugins` repository root. Preserve it separately from source history during migration, or recreate it from the plugin source.

## Optional screenshot capture

Screenshot scripts are not required for development, build, or installation. They were created for a specific local browser automation setup and may need path updates on the new PC. In particular, check the absolute Playwright/CUA runtime path in each `.cjs` helper and the Edge executable path, which was configured as:

```text
C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe
```

Use the existing `docs/images` assets for documentation unless you need to refresh them. The capture helpers simulate the plugin UI; they do not exercise a connected CNC machine.

## External references

- Original tramming tool: [github.com/bhowiebkr/spindle-tramming-tool](https://github.com/bhowiebkr/spindle-tramming-tool)
- gSender: [sienci.com/gsender](https://sienci.com/gsender/)
- gSender plugin SDK package: `@sienci/gsender-plugin-sdk` (version pinned in `package.json` and `package-lock.json`)

## Migration checklist

- [ ] Copy the full `gsender_plugins` repository, including this `spindle-tramming` folder.
- [ ] If needed, retrieve the install ZIP from the GitHub Release or rebuild it from this plugin folder.
- [ ] Install Node.js on the new development PC.
- [ ] Run `npm ci`, `npm test`, and `npm run build` from the project directory.
- [ ] Confirm the target gSender version is `1.7.0-Edge-2` before host testing.
- [ ] Test the plugin UI and safe-state checks before a real, spindle-off measurement.
- [ ] Refresh the README screenshots only if needed; update local paths in capture helpers first.
- [ ] Work from the `gsender_plugins` repository root for shared Git history; do not initialize a nested repository inside this plugin folder.


