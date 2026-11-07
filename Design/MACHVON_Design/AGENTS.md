# Working directory policy

- The only active deliverable directory is `C:/PIS/Design/MACHVON_Design`.
- Edit and verify this directory in place. Do not create version-suffixed folders, duplicate deliverable trees, ZIP files, or mirrors unless the user explicitly requests them.
- Keep existing screen IDs and relative links stable. The interactive entry point is `02_Prototype/index.html`; the documentation entry point is `index.html`.
- Refresh asset cache keys when UI assets change and verify the prototype from this exact directory before reporting completion.
- The active color direction is Xanh dầu điều hành (petrol blue sidebar, teal primary, light content; CR-06-13), implemented in `02_Prototype/brand-theme.css` after the layout styles; the locked system is `design.md` at the repo root. Keep semantic success/warning colors distinct; synchronize `04_Design_Assets/design_tokens.json` when changing the palette.
- Historical copies outside this directory are not active working copies. Do not overwrite user changes or delete historical files without an explicit cleanup request.
- The business navigation is implemented in `02_Prototype/workspace-navigation.js` and `workspace-navigation.css`. Use the researched single-sidebar design, direct frequent destinations, contextual shortcuts, favorites and mobile bottom navigation. The six areas are metadata in the application library, not a permanent rail. Do not restore the horizontal `.modulelinks` catalogue under page headings.
- `03_Engineering/navigation_architecture.json` covers all 406 web screens of the catalogue with routes and the 72 native mobile screens, which keep their bottom navigation. It is exported from the running prototype (`node work/export_navigation.cjs`) and checked by `node work/tools/src/check-cli.mjs` (NAV_ROUTE_MISSING / NAV_ROUTE_UNKNOWN). `02_Prototype/screens.js` is generated from `screen_catalog.json` with `npm run prototype-sync` in `work/tools`.
- Historical one-off bootstrap scripts in `work/` are not the source of truth for current UI. Edit the current prototype in place; do not rerun bootstrap generators that overwrite the app shell. Verification/export scripts may refresh existing assets in place.

- Tenant theme settings (SAS-04) are implemented in tenant-theme.js/css. Only System Admin may mutate tenant branding. Tenant Admin is read-only. Preserve preview isolation and review-before-publish/rollback; prototype roles are simulations, server enforcement is specified separately.
