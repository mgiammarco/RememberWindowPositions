# Window Layout Version History + Recall Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep an automatic 5-deep history of the script's saved window layouts and add two global shortcuts (Meta+Ctrl+PgDown / Meta+Ctrl+PgUp) that step backward/forward through that history and immediately reapply the selected layout to open windows.

**Architecture:** All changes live in `src/contents/ui/main.qml` (the whole KWin script is this one QML file; `main.js` is an intentionally empty placeholder). History is stored as a JSON array in a new key of the existing `Settings` element (persists to `~/.config/kde.org/kwin.conf`). Each entry's `d` field is byte-identical to the compact blob already written to `rememberwindowpositions_windows`, so the existing parser and restore machinery are reused unchanged.

**Tech Stack:** KWin scripting API (Plasma 6), QML (`org.kde.kwin` — `ShortcutHandler`, `Workspace`, `DBusCall`; `QtCore` — `Settings`). No test framework exists in this repo; verification is `qmllint` + `make build` + a manual checklist.

**Spec:** `docs/superpowers/specs/2026-06-10-version-history-shortcuts-design.md`

**Branch:** `version-history-shortcuts` (already created and checked out)

---

## Context for the implementer (read first)

- `src/contents/ui/main.qml` is ~1984 lines. Line numbers below refer to the state at branch point and shift as tasks land — anchor on the quoted code, not the numbers.
- Existing machinery you will reuse, all in `main.qml`:
  - `loadWindowsFromSettings()` (~line 1527) — parses the compact JSON blob into the expanded runtime structure.
  - `saveWindowsToSettings(shutdown)` (~line 1601) — serializes `config.windows` to the compact blob and writes `settings.rememberwindowpositions_windows`. Called from 5 sites; do not touch the call sites.
  - `isValidWindow(client)` (~line 239), `getHighestCaptionScore(windowData, client, ignoreMatched, returnIndex)` (~line 282), `getHighestCaptionScoreIgnoreNumbers(...)` (~line 314), `getCurrentConfig(client)` (~line 937), `restoreWindowPlacement(saveData, client, captionScore, windowConfig, ...)` (~line 390). `restoreWindowPlacement` already enforces `config.minimumCaptionMatch` (it returns early when `captionScore < config.minimumCaptionMatch`), so `applyVersion` does not re-check the threshold.
  - `Settings { id: settings ... }` block (~line 1840), `ShortcutHandler` elements (~line 1938), `DBusCall { id: onScreenDisplay }` OSD helper (file end).
  - Logging helpers: `log(string)` (debug-gated), `logE(string)` (errors/always).
- Code style: 4-space indent, `let`/`const`, single quotes in JS strings, functions declared inside the root `Item`.
- Verification commands (run from repo root `/home/ubuntu/progetti/RememberWindowPositions`):
  - `qmllint src/contents/ui/main.qml` — config in `.qmllint.ini`. If `qmllint` is not on PATH try `/usr/lib/qt6/bin/qmllint`. Pre-existing warnings are acceptable; the gate is **no new errors**.
  - `make build` — packages `rememberwindowpositions.kwinscript`; fails on malformed QML packaging.
- Commit after every task. Repo-local git identity is already configured.

---

### Task 1: Extract `parseWindowsBlob()` from `loadWindowsFromSettings()`

**Files:**
- Modify: `src/contents/ui/main.qml` (function at ~line 1527)

- [ ] **Step 1: Rename the function head and parse parameter**

Find:

```qml
    function loadWindowsFromSettings() {
        let savedWindows = JSON.parse(settings.rememberwindowpositions_windows);
        let convertedWindows = {};
```

Replace with:

```qml
    function parseWindowsBlob(jsonString) {
        let savedWindows = JSON.parse(jsonString);
        let convertedWindows = {};
```

- [ ] **Step 2: Return the result and re-add the thin wrapper**

Find (end of the same function, ~line 1597):

```qml
        //log('Load - converted windows: ' + JSON.stringify(convertedWindows));
        config.windows = convertedWindows;
    }
```

Replace with:

```qml
        //log('Load - converted windows: ' + JSON.stringify(convertedWindows));
        return convertedWindows;
    }

    function loadWindowsFromSettings() {
        config.windows = parseWindowsBlob(settings.rememberwindowpositions_windows);
    }
```

Everything between head and tail (the conversion loop, including its `logE`/`log` lines) stays untouched.

- [ ] **Step 3: Lint**

Run: `qmllint src/contents/ui/main.qml`
Expected: no new errors compared to running it on `git stash`-clean tree (pre-existing warnings OK).

- [ ] **Step 4: Commit**

```bash
git add src/contents/ui/main.qml
git commit -m "Extract parseWindowsBlob from loadWindowsFromSettings"
```

---

### Task 2: History storage + capture on save

**Files:**
- Modify: `src/contents/ui/main.qml` (root properties ~line 25, `saveWindowsToSettings` tail ~line 1666, `Settings` block ~line 1840)

- [ ] **Step 1: Add the runtime navigation index property**

Find:

```qml
    property int restoreMode: 0
```

Replace with:

```qml
    property int restoreMode: 0
    property int historyIndex: 0
```

- [ ] **Step 2: Add the persisted history key**

Find:

```qml
        property string rememberwindowpositions_windows: "{}"
        property string rememberwindowpositions_configOverrides: "{}"
```

Replace with:

```qml
        property string rememberwindowpositions_windows: "{}"
        property string rememberwindowpositions_windowsHistory: "[]"
        property string rememberwindowpositions_configOverrides: "{}"
```

- [ ] **Step 3: Add `captureVersion()` directly above `saveWindowsToSettings`**

Find:

```qml
    function saveWindowsToSettings(shutdown) {
```

Replace with:

```qml
    function captureVersion(blob) {
        let history;
        try {
            history = JSON.parse(settings.rememberwindowpositions_windowsHistory);
            if (!Array.isArray(history)) history = [];
        } catch (e) {
            logE('Version history corrupted, resetting: ' + e);
            history = [];
        }
        if (history.length > 0 && history[0].d === blob) return; // unchanged state - no new version
        history.unshift({ t: Date.now(), d: blob });
        if (history.length > 5) history.length = 5;
        settings.rememberwindowpositions_windowsHistory = JSON.stringify(history);
        historyIndex = 0;
        log('Version history captured - versions stored: ' + history.length);
    }

    function saveWindowsToSettings(shutdown) {
```

- [ ] **Step 4: Capture at the end of `saveWindowsToSettings`**

Find:

```qml
        // log('Save - converted windows: ' + JSON.stringify(convertedWindows));
        log('Attempting to save windows...');
        settings.rememberwindowpositions_windows = JSON.stringify(convertedWindows);
        log('Windows saved!');
```

Replace with:

```qml
        // log('Save - converted windows: ' + JSON.stringify(convertedWindows));
        log('Attempting to save windows...');
        let blob = JSON.stringify(convertedWindows);
        settings.rememberwindowpositions_windows = blob;
        captureVersion(blob);
        log('Windows saved!');
```

- [ ] **Step 5: Lint**

Run: `qmllint src/contents/ui/main.qml`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/contents/ui/main.qml
git commit -m "Capture saved window layouts into 5-deep version history"
```

---

### Task 3: `getVersionHistory()` + `applyVersion()` reapply engine

**Files:**
- Modify: `src/contents/ui/main.qml` (insert both functions directly above `captureVersion`, added in Task 2)

- [ ] **Step 1: Insert both functions**

Find:

```qml
    function captureVersion(blob) {
```

Replace with:

```qml
    function getVersionHistory() {
        try {
            let history = JSON.parse(settings.rememberwindowpositions_windowsHistory);
            return Array.isArray(history) ? history : [];
        } catch (e) {
            logE('Version history corrupted, resetting: ' + e);
            settings.rememberwindowpositions_windowsHistory = "[]";
            onScreenDisplay.show('Version history corrupted, resetting', 'data-error');
            return [];
        }
    }

    function applyVersion(blob) {
        let versionWindows;
        try {
            versionWindows = parseWindowsBlob(blob);
        } catch (e) {
            logE('Could not parse version data: ' + e);
            onScreenDisplay.show('Could not apply version', 'data-error');
            return false;
        }

        const clients = Workspace.stackingOrder;
        for (let i = 0; i < clients.length; i++) {
            let client = clients[i];
            if (!isValidWindow(client)) continue;

            let windowData = versionWindows[client.resourceClass];
            if (!windowData || windowData.saved.length === 0) continue;

            let match = config.ignoreNumbers
                ? getHighestCaptionScoreIgnoreNumbers(windowData, client, true, true)
                : getHighestCaptionScore(windowData, client, true, true);
            let captionScore = match[0];
            let savedIndex = match[1];
            if (savedIndex < 0) continue;

            windowData.saved[savedIndex].alreadyMatched = true;
            restoreWindowPlacement(windowData.saved[savedIndex], client, captionScore, getCurrentConfig(client));
        }
        return true;
    }

    function captureVersion(blob) {
```

Notes baked into this code (do not "improve" them away):
- `parseWindowsBlob` is parsed fresh on every call, so `alreadyMatched` starts false for every save entry; setting it to true prevents two open windows from grabbing the same saved slot, and `getHighestCaptionScore(..., true, ...)` (ignoreMatched=true) respects it.
- `restoreWindowPlacement` is called with its default trailing args (`restoreZ = true, moveVirtualDesktop = false, moveActivity = false`) — same call shape as the existing restore path at ~line 862.
- `applyVersion` never writes `config.windows` or any settings key.

- [ ] **Step 2: Lint**

Run: `qmllint src/contents/ui/main.qml`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/contents/ui/main.qml
git commit -m "Add applyVersion engine to reapply a stored layout to open windows"
```

---

### Task 4: Navigation function + two ShortcutHandlers + OSD

**Files:**
- Modify: `src/contents/ui/main.qml` (insert navigation helpers above `getVersionHistory` from Task 3; insert ShortcutHandlers after the existing "Block Restore" handler at file end)

- [ ] **Step 1: Insert `formatVersionTime()` and `applyHistoryStep()`**

Find:

```qml
    function getVersionHistory() {
```

Replace with:

```qml
    function formatVersionTime(t) {
        let date = new Date(t);
        return date.getHours().toString().padStart(2, '0') + ':' + date.getMinutes().toString().padStart(2, '0');
    }

    function applyHistoryStep(direction) {
        let history = getVersionHistory();
        if (history.length === 0) {
            onScreenDisplay.show('No saved versions yet', 'emblem-information');
            return;
        }

        let newIndex = historyIndex + direction;
        if (newIndex > history.length) {
            onScreenDisplay.show('No older version', 'emblem-information');
            return;
        }
        if (newIndex < 0) {
            onScreenDisplay.show('No newer version', 'emblem-information');
            return;
        }

        historyIndex = newIndex;
        if (historyIndex === 0) {
            if (applyVersion(settings.rememberwindowpositions_windows)) {
                onScreenDisplay.show('Current layout restored', 'emblem-default');
            }
        } else {
            let version = history[historyIndex - 1];
            if (applyVersion(version.d)) {
                onScreenDisplay.show('Window layout: version -' + historyIndex + '/' + history.length + ' (' + formatVersionTime(version.t) + ')', 'document-open-recent');
            }
        }
    }

    function getVersionHistory() {
```

- [ ] **Step 2: Add the two ShortcutHandlers**

Find (the closing brace of the existing "Block Restore" handler followed by the DBusCall):

```qml
    DBusCall {
        id: onScreenDisplay
```

Replace with:

```qml
    ShortcutHandler {
        name: "Remember Window Positions: Apply Previous Version"
        text: "Remember Window Positions: Apply Previous Version"
        sequence: "Meta+Ctrl+PgDown"
        onActivated: applyHistoryStep(1)
    }

    ShortcutHandler {
        name: "Remember Window Positions: Apply Next Version"
        text: "Remember Window Positions: Apply Next Version"
        sequence: "Meta+Ctrl+PgUp"
        onActivated: applyHistoryStep(-1)
    }

    DBusCall {
        id: onScreenDisplay
```

- [ ] **Step 3: Lint**

Run: `qmllint src/contents/ui/main.qml`
Expected: no new errors.

- [ ] **Step 4: Build the package**

Run: `make build`
Expected: produces `rememberwindowpositions.kwinscript` without errors.

- [ ] **Step 5: Commit**

```bash
git add src/contents/ui/main.qml
git commit -m "Add shortcuts to step through and reapply window layout versions"
```

---

### Task 5: README documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate the features list and the shortcuts documentation**

Run: `grep -n 'Meta+X\|Meta+Ctrl+W\|## ' README.md | head -30`
Identify (a) the feature bullet list near the top, (b) the section documenting the existing shortcuts.

- [ ] **Step 2: Add the feature bullet**

Append to the feature list (match surrounding bullet style):

```markdown
- Keeps a history of the last 5 saved window layouts; step back/forward through them with `Meta+Ctrl+PgDown` / `Meta+Ctrl+PgUp` to instantly reapply a previous layout to the open windows.
```

- [ ] **Step 3: Document the shortcuts next to the existing ones**

Add alongside the existing shortcut documentation (match the format used for "Show Config" / "Block Restore"):

```markdown
- **Remember Window Positions: Apply Previous Version** (`Meta+Ctrl+PgDown` by default) - reapplies the previous saved layout version to the currently open windows. Press repeatedly to go further back (up to 5 versions).
- **Remember Window Positions: Apply Next Version** (`Meta+Ctrl+PgUp` by default) - steps forward again toward the most recent saved layout.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "Document window layout version history and recall shortcuts"
```

---

### Task 6: Final verification

**Files:** none modified.

- [ ] **Step 1: Lint + build clean tree**

Run: `qmllint src/contents/ui/main.qml && make build`
Expected: no new lint errors; package builds.

- [ ] **Step 2: Static sanity greps**

Run: `grep -c 'ShortcutHandler' src/contents/ui/main.qml`
Expected: `4` (2 existing + 2 new).

Run: `grep -n 'rememberwindowpositions_windowsHistory' src/contents/ui/main.qml`
Expected: 5 hits (Settings property, captureVersion read+write, getVersionHistory read+reset).

- [ ] **Step 3: Manual checklist on a Plasma 6 machine (requires GUI session — hand to user if headless)**

Using `make load` (or `bin/load.sh`) and `make logs`:
1. Close a window of a remembered app → journal shows "Version history captured", history grows (cap 5).
2. Re-trigger a save with unchanged state → no new "Version history captured" line.
3. `Meta+Ctrl+PgDown` repeatedly → layouts -1, -2, ... applied; OSD shows "Window layout: version -N/<count> (HH:MM)".
4. `Meta+Ctrl+PgUp` → steps forward; at index 0 OSD "Current layout restored".
5. Past either end → OSD "No older version" / "No newer version", windows untouched.
6. Fresh install (empty history) → OSD "No saved versions yet".
7. Manually corrupt `rememberwindowpositions_windowsHistory` in `~/.config/kde.org/kwin.conf` → next shortcut press resets it with OSD "Version history corrupted, resetting", no crash.
8. Restart KWin → history persists; index restarts at 0.

- [ ] **Step 4: Update the knowledge graph**

Run: `graphify update .`

---

## Self-review (done at plan time)

- Spec coverage: data model → Task 2; capture+dedup → Task 2; navigation state → Tasks 2/4; reapply engine → Tasks 1/3; shortcuts+OSD → Task 4; error handling → Tasks 3/4; testing → Task 6; README → Task 5.
- No placeholders; all code blocks complete.
- Type consistency: `historyIndex` (int property) used in Tasks 2 and 4; `captureVersion(blob)`/`getVersionHistory()`/`applyVersion(blob)`/`applyHistoryStep(direction)` names match across tasks; history entry shape `{t, d}` consistent.
