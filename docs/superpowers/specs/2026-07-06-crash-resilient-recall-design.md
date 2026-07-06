# Crash-Resilient Layout Persistence and Recall — Design

Date: 2026-07-06
Status: approved by user
Supersedes/extends: `2026-06-10-version-history-shortcuts-design.md`

## Problem

Three failures observed and root-caused on real crash data (journal + decoded
`~/.config/kde.org/kwin.conf`):

- **P1 — post-crash history churn.** The 60s snapshot re-captures the broken
  post-crash layout; within ~5 minutes all 5 good pre-crash versions are evicted.
  The recall shortcuts then have nothing good to return to.
- **P2 — login-restore misplacement.** The original design waits for window
  captions to settle (instant match → captionChanged listener → 1s retry loop,
  ~10s budget with loginBoost), then force-commits at
  `minimumCaptionMatch` (default 0). After a crash, ~40 same-class Chrome windows
  are still loading when the budget expires; the forced weak pairing placed 37
  windows on caption scores < 50 (observed 2026-06-30 boot).
- **P3 — no stable cross-session identity.** KWin regenerates every
  `internalId` at session start, so exact-id matching (recall Pass 1) works only
  in-session. No caption threshold can disambiguate dozens of same-app windows.

## User decisions

1. **Success criterion — both:** best-effort automatic restore at login, plus an
   explicit recall shortcut that reapplies the pre-crash layout once the session
   is stable.
2. **Ambiguity trade-off — hybrid:** honor confident matches first (id, strong
   caption), then fill the remaining saved slots with the remaining same-app
   windows (layout shape restored; window↔slot pairing best-effort). This
   generalizes the original app's intentional "last unmatched window is
   force-restored" behavior.
3. **History protection — automatic, session-scoped.** No manual pin (keeps the
   2026-06-10 decision "automatic history only").

## Design

### 1. Crash detection

New persisted key `rememberwindowpositions_cleanShutdown` (string `"1"`/`"0"`).

- Script init: read it; `crashedLastSession = (value !== "1")`; then immediately
  write `"0"`.
- Clean shutdown path (`saveWindowsToSettings(shutdown=true)`): write `"1"`.
- False positive on manual script reload is accepted: the flag only extends
  wait budgets and protects history — never destructive.

### 2. Session-scoped protected history

- Runtime `sessionId` generated at script init (timestamp string, not persisted
  as its own key). A manual in-session script reload therefore mints a new
  sessionId and the same real session's earlier captures become "protected";
  accepted as benign (they only occupy the 2 reserved slots for up to 24h).
- Version entries gain a session field: `{ t, d, s: sessionId }`.
- **Protected version:** `s !== <current sessionId>` (or `s` missing — legacy
  entries) AND `Date.now() - t < 24h`.
- Eviction in `captureVersion` when trimming to 5: evict unprotected entries
  first (oldest unprotected first); protected entries are reserved up to 2 slots
  — i.e. the current session can occupy at most 3 slots while ≥2 protected
  prior-session versions exist. If more than 2 protected versions exist, the
  oldest protected ones beyond 2 may be evicted last.
- Expiry: protection lapses purely by age (24h); no other release mechanism.
  A recalled-and-adopted layout is re-captured under the current sessionId by
  the existing navIdleTimer/snapshot flow, so the protected original remains
  until it ages out.
- Dedup (`versionSignature`) unchanged; `s` is not part of the signature.

### 3. Recall: three-pass `applyVersion`

- **Pass 1 (unchanged):** exact `internalId` match per app.
- **Pass 2 (unchanged, current fix):** `twoWayMatch` confidence ladder with
  `recallMinConfidence = 85`.
- **Pass 3 (new — slot fill):** per app, remaining unmatched saved slots ×
  remaining unmatched live windows. Deterministic greedy assignment:
  iterate saved slots by ascending `stackingOrder`; each slot takes the nearest
  remaining window by Euclidean distance between geometry centers; ties broken
  by window stacking order. Fills `min(windows, slots)`; surplus windows are
  left untouched. Placement via the existing `restoreWindowPlacement` with the
  slot's saved data and captionScore reported as the actual (sub-85) score.
- No new configuration; Pass 3 is always on for explicit recall.

### 4. Post-crash login restore

- New config `crashBoostMultiplier` (`KWin.readConfig`, default 4). When
  `crashedLastSession`, the caption-wait budget
  (`multiWindowRestoreAttempts`, already ×2 by loginBoost) is additionally
  multiplied — e.g. default budget ~10s becomes ~40s, giving heavy sessions
  time to publish real captions.
- Final commit change (`restoreWindowsBasedOnConfidence` when the retry budget
  is exhausted): the `twoWayMatch` ladder stops at the rungs with
  `caption >= 85`; windows still unmatched are then placed by the same
  deterministic slot-fill as recall Pass 3 instead of the sub-85 ladder rungs
  (which produced random weak pairings). `minimumCaptionMatch` keeps its
  existing meaning for the ladder portion.
- The original safe forced paths stay at floor 0 untouched: single-window app
  restore, "last unmatched window" restore (both have exactly one candidate).

### 5. Error handling

- Existing parse fallbacks (backup blob, history reset + OSD) unchanged.
- Slot-fill placements wrapped in per-window try/catch (same pattern as
  existing restore loops); a failed placement consumes the slot.
- Missing `s` on a version → treated as protected (legacy), expires by age.
- `cleanShutdown` unreadable/absent → treated as crash (safe direction).

### 6. Testing

- **Offline harness promoted into the repo** (`tools/harness/`): Node scripts
  that decode the real QSettings blobs and replay matching/eviction logic
  offline (`decode.py`, `harness.mjs` evolution). Extended with:
  - Pass 3 slot-fill replay on real data (assert: every saved slot filled,
    deterministic output, no cross-app assignment);
  - eviction simulation (assert: ≥2 prior-session versions survive 10 simulated
    post-crash captures; age expiry honored).
  - The harness mirrors main.qml logic by construction (ported functions); a
    comment in each file states the source lines it mirrors and must be kept in
    sync manually.
- `qmllint` on main.qml.
- Manual checklist on Plasma 6 (`make reload-installed`, `make logs`):
  1. Recall round-trip in-session: -1 → back to current, no window moves
     (Pass 1 all-100 path).
  2. Simulated crash (`kill -9` kwin_wayland… or SIGKILL plasmashell session) →
     relogin: `crashedLastSession` logged true; extended budget visible in log;
     final commit shows slot-fill lines, no sub-85 twoWayMatch placements.
  3. Post-crash: ≥2 pre-crash versions still present in
     `rememberwindowpositions_windowsHistory` after 10+ minutes of uptime.
  4. Recall of a pre-crash version post-crash: OSD shown; all saved slots
     occupied; no cross-app moves.
  5. Clean relogin: `crashedLastSession` false; normal (non-boosted) budget.

## Out of scope

- Matching-engine extraction/refactor (approach B) — revisit if this area
  regresses again.
- Manual layout pin shortcut.
- History browser UI; retention/config UI beyond `crashBoostMultiplier`.
- Any change to `MainMenu.qml`.
