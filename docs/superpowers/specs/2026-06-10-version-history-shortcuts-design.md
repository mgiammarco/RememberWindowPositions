# Window Layout Version History + Recall Shortcuts — Design

Date: 2026-06-10
Status: approved by user

## Goal

Add two features to the RememberWindowPositions KWin script:

1. Keep an automatic history of the saved window positions/sizes (versions).
2. Provide two global shortcuts that navigate this history backward/forward and immediately reapply the selected version's geometry to the currently open windows.

## Requirements (user decisions)

- **Version semantics:** automatic history of saves. Every time the script persists its saved-window data, the previous state is retained as a version. No manual snapshot action.
- **Granularity:** global. One history of the entire saved state (all applications). Recall reapplies the full layout to all open windows.
- **Shortcut behavior:** back/forward navigation. Shortcut A steps to older versions (repeatable: -1, -2, ...), shortcut B steps back toward the newest. An OSD shows which version is active.
- **Retention:** 5 versions, fixed. No configuration UI.

## Current architecture (relevant facts)

- Implementation lives in `src/contents/ui/main.qml` (~1984 lines). `src/contents/code/main.js` is an intentionally empty placeholder.
- Saved state persists through the QML `Settings` element (main.qml:1840) into `~/.config/kde.org/kwin.conf`, key `rememberwindowpositions_windows`, as a compact JSON string (single-letter field names).
- `saveWindowsToSettings(shutdown)` (main.qml:1601) serializes `config.windows` into that compact string. Called from 5 sites: window close paths, clear paths, and shutdown.
- `loadWindowsFromSettings()` (main.qml:1527) parses the compact string back into the expanded runtime structure.
- Restore machinery: `isValidWindow()`, `getHighestCaptionScore()` (caption matching), `restoreWindowPlacement()` (applies geometry/desktop/activity/tile to a client).
- Shortcut pattern: two `ShortcutHandler` elements already exist (main.qml:1938+): "Show Config" (Meta+Ctrl+W) and "Block Restore" (Meta+X).
- OSD pattern: `DBusCall` to `org.kde.plasmashell /org/kde/osdService showText` via the `onScreenDisplay.show(message, icon)` helper.

## Design

### 1. Data model

New property in the existing `Settings` block:

```qml
property string rememberwindowpositions_windowsHistory: "[]"
```

JSON array, newest first, max 5 entries:

```json
[{ "t": 1760000000000, "d": "<compact windows blob>" }, ...]
```

`d` is byte-identical to the string written to `rememberwindowpositions_windows` — no new serialization format.

### 2. Version capture

At the end of `saveWindowsToSettings()`, after the compact blob is produced:

- If the blob differs from `history[0].d` (or history is empty): unshift `{t: Date.now(), d: blob}`, trim the array to 5, write `settings.rememberwindowpositions_windowsHistory`.
- If identical: do nothing (deduplication — the 5 existing call sites never produce noise versions).
- A new capture resets `historyIndex` to 0.

### 3. Navigation state

Runtime-only property `property int historyIndex: 0`, where 0 = live state.

- **Previous:** if `historyIndex < history.length`, increment, then apply `history[historyIndex - 1].d`.
- **Next:** if `historyIndex > 0`, decrement; at 0 apply the current blob (`settings.rememberwindowpositions_windows`), otherwise apply `history[historyIndex - 1].d`.
- Past either end: OSD "No older version" / "No newer version", index unchanged, nothing applied.

The index is not persisted; it resets on script reload and on every new capture.

### 4. Reapply engine

Small refactor: extract the parse loop of `loadWindowsFromSettings()` into a helper
`parseWindowsBlob(jsonString)` returning the expanded structure; `loadWindowsFromSettings()` becomes a thin wrapper around it.

New function `applyVersion(blob)`:

1. `parseWindowsBlob(blob)` → version data.
2. For each open window in `Workspace.windows`: skip if `!isValidWindow(client)`; look up `client.resourceClass` in the version data; find the best caption match via `getHighestCaptionScore()`; on a match call `restoreWindowPlacement()` with the client's current config flags (`getCurrentConfig(client)`).
3. Windows with no match in the version are left untouched.
4. `applyVersion` never writes `config.windows` or `rememberwindowpositions_windows` — it only moves/resizes open windows. The saved state continues to update through the normal save triggers.

### 5. Shortcuts + OSD

Two new `ShortcutHandler` elements next to the existing ones:

| Name | Default sequence | Action |
|---|---|---|
| Remember Window Positions: Apply Previous Version | Meta+Ctrl+PgDown | step back in history, apply |
| Remember Window Positions: Apply Next Version | Meta+Ctrl+PgUp | step forward, apply |

OSD messages via the existing `onScreenDisplay` helper:
- "Window layout: version -N/<history count> (HH:MM)" when applying a version (count is the number of stored versions, ≤ 5)
- "Current layout restored" when returning to index 0
- "No older version" / "No newer version" at the ends
- "No saved versions yet" when history is empty

Both shortcuts are rebindable in System Settings > Shortcuts > Window Management, like the existing ones.

### 6. Error handling

- `JSON.parse` of the history wrapped in try/catch: on corruption, log the error, OSD "Version history corrupted, resetting", reset key to `[]`.
- Empty history on Previous: OSD "No saved versions yet".
- No new configuration UI (retention is fixed at 5).

### 7. Testing

No automated test infrastructure exists in this repo (pure QML KWin script). Verification:

- `qmllint` (project config in `.qmllint.ini`).
- Manual checklist on Plasma 6 using `make load` / `make logs` (journalctl):
  1. Close a window → new version captured (log line, history length grows to max 5).
  2. Re-trigger save with unchanged state → no duplicate version.
  3. Meta+Ctrl+PgDown repeatedly → layouts of -1, -2, ... applied, OSD correct.
  4. Meta+Ctrl+PgUp → forward navigation, index 0 restores current layout.
  5. Navigation past either end → OSD only, no movement.
  6. Empty history → OSD "No saved versions yet".
  7. Corrupt `rememberwindowpositions_windowsHistory` by hand → reset + OSD, no crash.
  8. Restart KWin → history persists, index resets to 0.

## Out of scope

- Manual snapshot shortcut (user chose automatic history only).
- Per-application or per-window history.
- Configurable retention depth.
- History browser UI in the config dialog (MainMenu.qml untouched).
