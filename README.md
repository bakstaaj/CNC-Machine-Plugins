# gSender Plugins

Source repository for gSender plugins maintained by Bakstaaj. Each plugin has its own folder and version history within this repository.

## Plugins

- [Spindle Tramming](spindle-tramming/README.md) — interactive spindle tramming for gSender 1.7.0-Edge-2.

## Development

Work from the selected plugin folder. For Spindle Tramming:

```powershell
cd spindle-tramming
npm ci
npm test
npm run build
```

The plugin source and generated `ui/` output live together in its folder. Do not commit `node_modules/` or release ZIPs into the source folder.

## Releases

Publish a separate GitHub Release for each plugin version. Use a plugin-prefixed tag such as `spindle-tramming-v0.4.2` and attach that version's install ZIP, for example `gsender-spindle-tramming-0.4.2.zip`. The ZIP contains the gSender plugin manifest, built UI, README, and required screenshots. Do not combine multiple plugins into one install ZIP.

Local release assets are staged under `release-assets/<plugin>/v<version>/`; this directory is ignored by Git because those ZIPs are attached to GitHub Releases rather than committed to source history.
