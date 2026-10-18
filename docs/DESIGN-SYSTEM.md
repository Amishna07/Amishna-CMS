# Amishna Music design system

## Architecture audit

The existing application uses plain JavaScript, HTML templates, native form controls, and inline SVG icons. There is no React runtime or component library. `frontend/public/dashboard.js` contains the shared shell, hash-based routes, view modules, catalog/editor workflows, and persistence integration. The workspace opens directly without a login. `export-dialog.js` provides the existing export dialog. SheetJS and JSZip are served locally.

The shared shell contains the sidebar, header, search, account controls, and page outlet. Navigation reuses that shell and renders the selected view. Overview, projects, cues/workfiles, songs, artists, exports, reports, settings, and import/database workflows retain their existing routes. Episode controls remain inside the project cue workspace. Report aggregates use the existing revision-based cache, and the cue workspace preserves episode-strip scroll position. Workspace Search caches its relationship indexes, search text and category counts by workspace identity and revision, and renders 40 results per page. Changes to the query or filters reset the page; all result categories and full record details remain available.

The Node frontend server serves the public assets and proxies the API. Backend validation and local SQLite persistence remain separate from the presentation layer. Both servers bind to loopback, with local host and origin checks on API access.

## Files and cascade

- `dashboard.css`: established layouts, data views, type sizes, and responsive behavior.
- `sections.css`, `export-dialog.css`: specialized views.
- `premium.css`: shared palette and previous presentation adapters.
- `liquid-glass.css`: final material tokens, reusable utilities, existing-view adapters, and accessibility fallbacks.
- `liquid-glass.js`: optional pointer highlights and modal presentation motion.

Load `liquid-glass.css` last. Existing styles contain high-specificity `!important` rules; the adapters deliberately match them. Check both the normal and accessibility media-query cascade before adding another override. Preserve the existing font sizes and teal accent family.

Theme selection remains Light, Dark, or System. `theme-init.js` applies the initial `html[data-theme]` value; the application maintains the saved preference and responds to system changes. Dark surfaces use graphite tones with muted teal accents.

## Materials

| Material | Use | Treatment |
| --- | --- | --- |
| Floating glass | Sidebar, header, search/filter toolbars, settings controls and dialogs | Controlled transparency, restrained backdrop blur, subtle border, inner highlight and soft shadow |
| Quiet panel | Dashboard/summary cards, catalog summary, project context and small statistics | Translucent fill and shallow shadow; no separate backdrop blur |
| Working surface | Cue/song/artist/episode data, report tables, rights details and import review | Opaque fill, clear separators, readable selection and hover states; no backdrop blur |

Default large data panels to the working surface. Apply stronger glass only to selected surrounding controls. Avoid nested blurred containers, blur on table rows, continuously moving backgrounds, and blanket `will-change` declarations.

## Utilities and tokens

Use existing view adapters where possible. New elements can use:

- `.lg-surface`, `.lg-navigation`, `.lg-toolbar`, `.lg-modal` for floating materials.
- `.lg-panel` for quiet summary surfaces.
- `.lg-solid` for dense working surfaces.
- `.lg-button`, `.lg-input` for shared control styling and focus treatment.

The `--ui-*` tokens define text, semantic colors, opaque surfaces and accents. The `--glass-*` tokens define fills, borders, highlights, shadows, radius, blur, focus, motion timing and background environment. Change tokens by theme rather than introducing unrelated per-page colors.

Use the supplied `assets/amishna-logo.png` unchanged. Its alpha channel is intentional: logo wrappers stay transparent, without a dark plaque, filter or shadow. Preserve its aspect ratio.

## Pointer response and motion

`data-glass-light` explicitly opts a bounded surface into the faint pointer highlight. Current opt-ins are the sidebar and header search control. Do not add it to the page outlet, data tables, every card, or an entire scrolling workspace.

Pointer handling requires a fine mouse pointer and hover support. It uses one pending animation frame, rejects oversized surfaces, and clears state when the pointer leaves an opted-in surface, the document becomes hidden, or the workspace closes. Touch input and reduced-motion preferences disable it; mobile CSS also hides the highlight.

`AmishnaGlass.enterModal()` adds a short entrance animation. Closing the live dialog remains synchronous; `exitModal()` briefly animates an inert, hidden-from-assistive-technology snapshot with identifiers and interactive metadata removed. Snapshots are removed after animation, when another modal opens, or when motion is cancelled. Closing the workspace cancels animations and removes snapshots. `reset()` clears pointer state; `destroy()` removes listeners and presentation state.

Keep rendering, data mutation and network access out of this module. Presentation effects must never delay saving, closing a dialog, restoring focus or changing routes.

## Responsive behavior and accessibility

At narrow widths, navigation becomes the existing drawer, spacing and blur decrease, and most toolbar/settings surfaces become opaque. Preserve the established cue-workspace stacking, song-detail stacking, internal table scrolling and sticky table headers. Long titles must wrap or truncate without widening the viewport.

Unsupported backdrop filtering falls back through solid material tokens. Reduced-transparency preferences remove blur and use solid fills; reduced-motion preferences suppress nonessential transitions and animations. The pointer overlay never receives input. Forced-colors users retain native color adjustment and explicit control borders.

Keep semantic controls, accessible names, active navigation state, dialog labels, visible keyboard focus and existing focus restoration. Check contrast on the composited surface in both themes, including small status text and filled buttons. Test preference media queries against the final cascade rather than assuming a later generic rule wins.

## Functional boundaries and verification

This design layer must preserve local host and origin checks, workspace persistence, imports, editing, search/filter behavior, project and episode handling, export templates, society membership filtering, percentages, and automatic filenames. Saved Movie/Serial details and existing direct-download actions remain authoritative.

Before shipping changes, run the existing frontend/backend tests and check direct startup, route changes, search, editing, episodes, imports and Movie/Serial exports in an isolated test workspace. Verify IPRS/PRS/ASCAP outputs, file naming, light/dark themes, keyboard use, reduced motion/transparency and narrow layouts. Inspect console errors and measure navigation responsiveness with representative data before making performance claims. Do not clear or replace the user's saved workspace for visual testing.


## Upgrade verification

The local regression suite passed 97 tests (84 frontend and 13 backend). Isolated browser checks used 1,000 songs and 50 episodes and covered editing, imports, backups, project deletion, episode scroll retention, society exports and names, authentication, all navigation views, Search pagination, and light/dark/system themes. Responsive checks covered 390–1440px, including the navigation breakpoint boundaries. Keyboard dialog closing and focus restoration, pointer cleanup, and reduced-motion/transparency were checked in the browser. The company PNG remains byte-for-byte identical to the supplied transparent asset.

Headless Chrome navigation checks retained the same shell and made zero navigation data requests. After pagination, the measured Search switch reached the second animation frame in 24ms, compared with 299ms before pagination in the same test library. These are local test measurements, not a guarantee for every device. Actual GPU/compositor smoothness should also be assessed on the target device.
