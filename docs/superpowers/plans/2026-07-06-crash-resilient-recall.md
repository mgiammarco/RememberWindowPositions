# Crash-Resilient Layout Persistence and Recall — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a KWin crash, the pre-crash window layout survives in version history and can be reapplied (automatically at login best-effort, exactly-shaped via recall shortcut), instead of being evicted by post-crash snapshots and scrambled by random weak caption matches.

**Architecture:** Four surgical changes to the existing `src/contents/ui/main.qml` monolith (approach A of the spec): a persisted clean-shutdown flag, session-tagged protected version history, a third "slot fill" pass in `applyVersion`, and a crash-boosted login wait whose final commit uses the same deterministic slot fill instead of sub-85 caption roulette. Algorithms are developed TDD-first in a Node harness (`tools/harness/`) that replays the exact logic offline, then ported verbatim into QML.

**Tech Stack:** Plasma 6 KWin scripting (QML/JS, Qt 6), Node.js ≥ 18 (harness, zero npm dependencies), GNU Make.

**Spec:** `docs/superpowers/specs/2026-07-06-crash-resilient-recall-design.md`

## Global Constraints

- All persisted settings keys are prefixed `rememberwindowpositions_` (QML `Settings` element writes to `~/.config/kde.org/kwin.conf` group `[General]`).
- History invariants: max **5** versions, **2** reserved slots for protected prior-session versions, protection expiry **24h**, freshest capture (index 0) is never evicted.
- Matching invariants: recall Pass 2 floor stays `recallMinConfidence = 85`; original floor-0 paths for single-window apps and "last unmatched window" stay untouched; slot fill never assigns across `resourceClass`.
- New config keys read via `KWin.readConfig`: `crashBoostMultiplier` (default **4**). No config UI changes (`MainMenu.qml` untouched).
- Harness: plain Node, no dependencies, `node tools/harness/replay.mjs` exits 0 on pass / 1 on failure. Harness functions are manual mirrors of main.qml functions — each mirrored function carries a comment naming its main.qml source.
- QML verification: `make install` + `make reload-installed`, then `isScriptLoaded` must be `true` and journal must show no `SyntaxError`/`ReferenceError` for the script. (`qdbus` is broken on Plasma 6 — Makefile already pins `qdbus6`.)
- Code style: match main.qml (4-space indent, `let`, explanatory comments on non-obvious logic, `log`/`logE` helpers).
- Commits: conventional prefix + task reference, ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Do NOT change: `debugLogs` state on the user's machine (currently enabled for crash validation), `MainMenu.qml`, packaging metadata.

---

### Task 1: Harness scaffold with current-behavior regression tests

**Files:**
- Create: `tools/harness/replay.mjs`
- Create: `tools/harness/decode.py`
- Create: `tools/harness/README.md`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `matchCaption(a, b) -> number 0..100`, `matchCaptionIgnoreNumbers(a, b) -> number`, `twoWayMatch(windowData, confidence, minConfidence) -> [{loading, saved, captionScore}]` (mutates `windowData.loading`/`windowData.saved` by splicing matches out), `CONFIDENCE` ladder array, `applyVersion(versionWindows, clients, opts) -> [{app, client, saved, captionScore, pass}]`, and the test helpers `check(name, cond)` / `summary()`. Later tasks add functions and tests to this same file.

- [ ] **Step 1: Create `tools/harness/decode.py`** — offline inspector for the real persisted state (used in manual verification steps of later tasks, not in the automated tests):

```python
#!/usr/bin/env python3
"""Decode RememberWindowPositions blobs from ~/.config/kde.org/kwin.conf.

QSettings quoting: value wrapped in "...", with \" and \\ escaping.
Decode order matters: strip quotes, then \\ -> \, \" -> ", THEN json.loads.
"""
import json, os, re, sys

conf = os.path.expanduser("~/.config/kde.org/kwin.conf")

def get_raw(key):
    text = open(conf, encoding="utf-8", errors="replace").read()
    m = re.search(r'^' + re.escape(key) + r'=(.*)$', text, re.MULTILINE)
    return m.group(1) if m else None

def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        v = v[1:-1]
    return v.replace('\\\\', '\x00').replace('\\"', '"').replace('\x00', '\\')

def load(key):
    v = get_raw(key)
    return json.loads(unquote(v)) if v is not None else None

if __name__ == "__main__":
    cur = load("rememberwindowpositions_windows") or {}
    hist = load("rememberwindowpositions_windowsHistory") or []
    clean = get_raw("rememberwindowpositions_cleanShutdown")
    print(f"cleanShutdown raw: {clean!r}")
    total = sum(len(w.get('s', [])) for w in cur.values())
    print(f"current: {len(cur)} apps, {total} windows")
    for n, v in enumerate(hist):
        blob = json.loads(v['d']) if isinstance(v.get('d'), str) else v.get('d', {})
        wins = sum(len(w.get('s', [])) for w in blob.values())
        print(f"v-{n+1}: t={v.get('t')} session={v.get('s', '(none)')} windows={wins}")
```

- [ ] **Step 2: Create `tools/harness/replay.mjs`** — mirrors of the matching logic plus regression tests for today's behavior (Pass 1 id match; Pass 2 floor 85 skips weak matches):

```js
// Offline replay of RememberWindowPositions matching logic.
// Every mirrored function names its src/contents/ui/main.qml source; keep in
// sync manually when main.qml changes.
// Run: node tools/harness/replay.mjs   (exit 0 = all tests pass)

// --- mirrors: main.qml matchCaption / matchCaptionIgnoreNumbers ---
export function matchCaption(a, b) {
  if (a === b) return 100;
  if (!a || !b) return 0;
  const la = a.length, lb = b.length;
  const lmin = Math.min(la, lb), lmax = Math.max(la, lb);
  if (lmin <= 0) return 0;
  let m = 0, r = 0;
  for (let i = 0; i < lmin; i++) {
    if (a[i] === b[i]) m++;
    if (a[la - i - 1] === b[lb - i - 1]) r++;
  }
  return Math.max(Math.min(Math.max(m, r) * 100 / lmax, 100), 0);
}
export function matchCaptionIgnoreNumbers(a, b) {
  if (!a || !b) return 0;
  return matchCaption(a.replace(/\d+/g, ''), b.replace(/\d+/g, ''));
}

// --- mirror: main.qml loadConfig confidence ladder ---
export const CONFIDENCE = [
  { caption: 100, matchingDimentions: 2, allowHeightShrinking: false },
  { caption: 100, matchingDimentions: 2, allowHeightShrinking: true  },
  { caption: 100, matchingDimentions: 1, allowHeightShrinking: false },
  { caption: 100, matchingDimentions: 0, allowHeightShrinking: false },
  { caption:  85, matchingDimentions: 2, allowHeightShrinking: false },
  { caption:  85, matchingDimentions: 2, allowHeightShrinking: true  },
  { caption:  85, matchingDimentions: 1, allowHeightShrinking: false },
  { caption:  85, matchingDimentions: 0, allowHeightShrinking: false },
  { caption:  50, matchingDimentions: 0, allowHeightShrinking: false },
  { caption:   0, matchingDimentions: 2, allowHeightShrinking: false },
  { caption:   0, matchingDimentions: 2, allowHeightShrinking: true  },
  { caption:   0, matchingDimentions: 1, allowHeightShrinking: false },
  { caption:   0, matchingDimentions: 0, allowHeightShrinking: true  },
];

// --- mirror: main.qml twoWayMatch (ignoreNumbers=true variant) ---
export function twoWayMatch(windowData, confidence, minConfidence) {
  const cap = matchCaptionIgnoreNumbers;
  const results = [];
  let li = 0;
  while (li < windowData.loading.length) {
    let hSc = -1, hDim = 0, hIdx = -1, found = false;
    const loading = windowData.loading[li];
    for (let s = 0; s < windowData.saved.length; s++) {
      const sv = windowData.saved[s];
      if (sv.alreadyMatched) continue;
      let dim = 0;
      if (sv.width === loading.width) dim++;
      if (sv.height === loading.height || (confidence.allowHeightShrinking && Math.abs(sv.height - loading.height) < 60)) dim++;
      if (dim < confidence.matchingDimentions) continue;
      const sc = cap(sv.caption, loading.caption);
      if (sc < confidence.caption) continue;
      if (sv.singleWindow && sc < 100) continue;
      if (sc >= hSc && (dim > hDim || sc > hSc)) { hSc = sc; hDim = dim; hIdx = s; found = true; }
    }
    if (found) {
      let lSc = hSc, lDim = hDim, lIdx = li;
      const sv = windowData.saved[hIdx];
      for (let l = 0; l < windowData.loading.length; l++) {
        const ld = windowData.loading[l];
        let dim = 0;
        if (sv.width === ld.width) dim++;
        if (sv.height === ld.height || (confidence.allowHeightShrinking && Math.abs(sv.height - ld.height) < 60)) dim++;
        if (dim < confidence.matchingDimentions) continue;
        const sc = cap(sv.caption, ld.caption);
        if (sc < confidence.caption) continue;
        if (sc >= lSc && (dim > lDim || sc > lSc)) { lSc = sc; lDim = dim; lIdx = l; }
      }
      if (lSc >= minConfidence) {
        results.push({ loading: windowData.loading.splice(lIdx, 1)[0], saved: windowData.saved.splice(hIdx, 1)[0], captionScore: lSc });
      } else li++;
    } else li++;
  }
  return results;
}

// --- mirror: main.qml applyVersion (Pass 1 + Pass 2; Pass 3 added in Task 4) ---
// versionWindows: { app: { saved: [saveRecord] } }; clients: [{resourceClass, internalId, caption, x, y, width, height, stackingOrder}]
export function applyVersion(versionWindows, clients, opts = {}) {
  const recallMinConfidence = opts.recallMinConfidence ?? 85;
  const placements = [];
  const byApp = {};
  for (const c of clients) {
    const wd = versionWindows[c.resourceClass];
    if (!wd || wd.saved.length === 0) continue;
    (byApp[c.resourceClass] ||= []).push(c);
  }
  for (const app in byApp) {
    const wd = versionWindows[app];
    const remaining = [];
    for (const c of byApp[app]) {              // Pass 1: exact internalId
      let matched = false;
      if (c.internalId) {
        for (const sv of wd.saved) {
          if (sv.alreadyMatched || !sv.internalId) continue;
          if (String(sv.internalId) === String(c.internalId)) {
            sv.alreadyMatched = true;
            placements.push({ app, client: c, saved: sv, captionScore: 100, pass: 1 });
            matched = true;
            break;
          }
        }
      }
      if (!matched) remaining.push(c);
    }
    if (remaining.length > 0) {                // Pass 2: confidence ladder, floor 85
      wd.loading = remaining;
      let ci = 0;
      while (wd.loading.length > 0 && ci < CONFIDENCE.length) {
        for (const r of twoWayMatch(wd, CONFIDENCE[ci], recallMinConfidence)) {
          placements.push({ app, client: r.loading, saved: r.saved, captionScore: r.captionScore, pass: 2 });
        }
        ci++;
      }
    }
  }
  return placements;
}

// ---------------------------------------------------------------- tests ----
let failures = 0;
export function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name);
  if (!cond) failures++;
}
export function summary() {
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

const S = (caption, x, y, extra = {}) => ({ caption, x, y, width: 800, height: 600, stackingOrder: extra.so ?? 0, internalId: extra.id, singleWindow: false, alreadyMatched: false, ...extra });
const C = (caption, x, y, extra = {}) => ({ resourceClass: 'app', caption, x, y, width: 800, height: 600, stackingOrder: extra.so ?? 0, internalId: extra.id ?? '', ...extra });

// Regression: Pass 1 wins over caption similarity
{
  const vw = { app: { saved: [S('Doc A', 0, 0, { id: 'i1' }), S('Doc B', 100, 100, { id: 'i2' })] } };
  const placements = applyVersion(vw, [C('Doc B', 5, 5, { id: 'i1' }), C('Doc A', 105, 105, { id: 'i2' })]);
  check('pass1: id match beats caption', placements.every(p => p.pass === 1) &&
    placements.find(p => p.client.caption === 'Doc B').saved.caption === 'Doc A');
}
// Regression: Pass 2 floor 85 leaves weak matches unplaced (bug #1 fix)
{
  const vw = { app: { saved: [S('Sprint Planning | Fibery', 0, 0), S('Nuova scheda', 900, 900)] } };
  const placements = applyVersion(vw, [C('Kindle - Google Chrome', 10, 10), C('Totally Different Title', 910, 910)]);
  check('pass2: sub-85 matches are not placed', placements.length === 0);
}
// Regression: Pass 2 places strong caption matches
{
  const vw = { app: { saved: [S('(23) Calendar | Microsoft Teams', 0, 0)] } };
  const placements = applyVersion(vw, [C('(25) Calendar | Microsoft Teams', 500, 500)]);
  check('pass2: >=85 caption match is placed', placements.length === 1 && placements[0].pass === 2);
}
summary();
```

- [ ] **Step 3: Run the tests, verify they pass**

Run: `node tools/harness/replay.mjs`
Expected: 3 × `PASS`, `ALL TESTS PASSED`, exit 0.

- [ ] **Step 4: Create `tools/harness/README.md`**

```markdown
# Offline harness

Mirrors the matching/eviction logic of `src/contents/ui/main.qml` for offline
TDD and regression testing (there is no QML test infrastructure). Functions are
manual mirrors — when you change one in main.qml, update its mirror here.

- `node tools/harness/replay.mjs` — run all tests (exit 0 = pass).
- `python3 tools/harness/decode.py` — inspect the real persisted state in
  `~/.config/kde.org/kwin.conf` (current blob, version history, crash flag).
```

- [ ] **Step 5: Commit**

```bash
git add tools/harness/
git commit -m "test: add offline harness replaying matching logic with regression tests

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Slot-fill algorithm (harness TDD)

**Files:**
- Modify: `tools/harness/replay.mjs`

**Interfaces:**
- Consumes: `check`, `summary`, fixtures from Task 1.
- Produces: `slotFillAssign(savedSlots, clients) -> [{saved, loading}]` — pure, does not mutate inputs, pairs length = `min(savedSlots.length, clients.length)`. Ported to QML in Task 4, reused in Task 7.

- [ ] **Step 1: Add failing tests** — insert before the `summary();` line:

```js
// --- slot fill (Task 2) ---
{
  // nearest-window assignment, deterministic
  const slots = [S('s1', 0, 0, { so: 1 }), S('s2', 1000, 0, { so: 2 }), S('s3', 0, 1000, { so: 3 })];
  const wins = [C('w-near-s3', 20, 980), C('w-near-s1', 10, 10), C('w-near-s2', 990, 20)];
  const pairs = slotFillAssign(slots, wins);
  check('slotfill: fills all slots', pairs.length === 3);
  check('slotfill: nearest wins', pairs[0].loading.caption === 'w-near-s1' &&
    pairs[1].loading.caption === 'w-near-s2' && pairs[2].loading.caption === 'w-near-s3');
  const pairs2 = slotFillAssign(slots, wins);
  check('slotfill: deterministic', JSON.stringify(pairs.map(p => p.loading.caption)) === JSON.stringify(pairs2.map(p => p.loading.caption)));
}
{
  // surplus windows stay unassigned; surplus slots stay unfilled
  const oneSlot = slotFillAssign([S('s1', 0, 0)], [C('w1', 0, 0), C('w2', 5, 5)]);
  check('slotfill: surplus windows untouched', oneSlot.length === 1);
  const oneWin = slotFillAssign([S('s1', 0, 0, { so: 2 }), S('s2', 900, 900, { so: 1 })], [C('w1', 890, 890)]);
  check('slotfill: slots consumed in stackingOrder', oneWin.length === 1 && oneWin[0].saved.caption === 's2');
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node tools/harness/replay.mjs`
Expected: `ReferenceError: slotFillAssign is not defined` (exit ≠ 0).

- [ ] **Step 3: Implement `slotFillAssign`** — insert above the tests section:

```js
// Deterministic slot fill: assign remaining live windows to remaining saved
// slots of the SAME app. Slots are consumed in ascending stackingOrder; each
// takes the nearest remaining window (squared Euclidean distance between
// geometry centers), ties broken by ascending window stackingOrder. Surplus
// windows are left untouched. Mirrors main.qml slotFillAssign (Task 4).
export function slotFillAssign(savedSlots, clients) {
  const slots = savedSlots.slice().sort((a, b) => (a.stackingOrder || 0) - (b.stackingOrder || 0));
  const remaining = clients.slice();
  const pairs = [];
  for (let s = 0; s < slots.length && remaining.length > 0; s++) {
    const slot = slots[s];
    const sx = slot.x + slot.width / 2, sy = slot.y + slot.height / 2;
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cx = remaining[i].x + remaining[i].width / 2, cy = remaining[i].y + remaining[i].height / 2;
      const d = (cx - sx) * (cx - sx) + (cy - sy) * (cy - sy);
      if (d < bestDist || (d === bestDist && (remaining[i].stackingOrder || 0) < (remaining[bestIdx].stackingOrder || 0))) {
        bestDist = d;
        bestIdx = i;
      }
    }
    pairs.push({ saved: slot, loading: remaining.splice(bestIdx, 1)[0] });
  }
  return pairs;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node tools/harness/replay.mjs`
Expected: all `PASS` including the 5 new checks, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tools/harness/replay.mjs
git commit -m "feat: deterministic slot-fill assignment (harness TDD)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Protected-history eviction (harness TDD)

**Files:**
- Modify: `tools/harness/replay.mjs`

**Interfaces:**
- Consumes: `check`, `summary` from Task 1.
- Produces: `trimVersionHistory(history, scriptSessionId, now) -> history` (mutates and returns; entries are `{t, d, s?}` newest-first). Ported to QML in Task 5.

- [ ] **Step 1: Add failing tests** — insert before `summary();`:

```js
// --- protected history eviction (Task 3) ---
{
  const H = 60 * 60 * 1000;
  const now = 1000 * H;
  const P = (ageH) => ({ t: now - ageH * H, d: 'pre-crash', s: 'session-A' });
  const N = (ageMin) => ({ t: now - ageMin * 60000, d: 'post-crash', s: 'session-B' });
  // 10 post-crash captures against 5 pre-crash versions: >=2 pre-crash survive
  let hist = [P(1), P(2), P(3), P(4), P(5)];
  for (let i = 10; i >= 1; i--) {
    hist.unshift(N(i));
    trimVersionHistory(hist, 'session-B', now);
  }
  check('evict: history capped at 5', hist.length === 5);
  check('evict: >=2 protected pre-crash versions survive', hist.filter(v => v.s === 'session-A').length >= 2);
  check('evict: freshest capture kept at head', hist[0].s === 'session-B' && hist[0].t === now - 60000);
  // expired prior-session versions (>24h) lose protection
  let hist2 = [P(30), P(40), P(50), P(60), P(70)];
  for (let i = 5; i >= 1; i--) {
    hist2.unshift(N(i));
    trimVersionHistory(hist2, 'session-B', now);
  }
  check('evict: expired versions are not protected', hist2.filter(v => v.s === 'session-A').length === 0);
  // single-session behavior unchanged: oldest evicted
  let hist3 = [N(2), N(3), N(4), N(5), N(6)];
  hist3.unshift(N(1));
  trimVersionHistory(hist3, 'session-B', now);
  check('evict: same-session trims oldest', hist3.length === 5 && hist3[4].t === now - 5 * 60000);
  // legacy entries without s are protected while young
  let hist4 = [{ t: now - 2 * H, d: 'legacy' }, N(3), N(4), N(5), N(6)];
  hist4.unshift(N(1));
  trimVersionHistory(hist4, 'session-B', now);
  check('evict: legacy (no s) treated as protected', hist4.some(v => v.d === 'legacy'));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node tools/harness/replay.mjs`
Expected: `ReferenceError: trimVersionHistory is not defined` (exit ≠ 0).

- [ ] **Step 3: Implement `trimVersionHistory`** — insert above the tests section:

```js
// Trim version history to 5 entries, evicting unprotected entries first.
// Protected = captured by a DIFFERENT script session (s missing = legacy,
// treated as protected) and younger than 24h — the layouts crash recovery
// needs. The freshest capture (index 0) is never evicted directly. When only
// protected entries remain, the oldest protected beyond the 2 reserved slots
// are evicted. Mirrors main.qml trimVersionHistory (Task 5).
export function trimVersionHistory(history, scriptSessionId, now) {
  const maxVersions = 5;
  const reservedProtected = 2;
  const protectedMs = 24 * 60 * 60 * 1000;
  const isProtected = (v) => (v.s === undefined || v.s !== scriptSessionId) && (now - v.t < protectedMs);
  while (history.length > maxVersions) {
    let evict = -1;
    for (let i = history.length - 1; i >= 1; i--) {   // oldest unprotected, never index 0
      if (!isProtected(history[i])) { evict = i; break; }
    }
    if (evict === -1) {                                // all protected: oldest beyond reserve
      let seen = 0;
      for (let i = 0; i < history.length; i++) {
        if (isProtected(history[i])) { seen++; if (seen > reservedProtected) evict = i; }
      }
    }
    if (evict === -1) evict = history.length - 1;      // absolute fallback
    history.splice(evict, 1);
  }
  return history;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `node tools/harness/replay.mjs`
Expected: all `PASS` including the 6 new checks, exit 0.

- [ ] **Step 5: Commit**

```bash
git add tools/harness/replay.mjs
git commit -m "feat: session-protected version-history eviction (harness TDD)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Recall Pass 3 (slot fill) in main.qml

**Files:**
- Modify: `src/contents/ui/main.qml` (function `applyVersion`, ~line 1792; add new function `slotFillAssign` right before it)
- Modify: `tools/harness/replay.mjs` (extend the harness `applyVersion` mirror with Pass 3 + test)

**Interfaces:**
- Consumes: `slotFillAssign` algorithm from Task 2 (verbatim port).
- Produces: QML `slotFillAssign(savedSlots, clients)` (same contract as harness) — reused by Task 7. Harness `applyVersion(versionWindows, clients, opts)` gains `opts.slotFill` (default `true`) and emits placements with `pass: 3`.

- [ ] **Step 1: Harness first — failing test for 3-pass recall.** In `replay.mjs`, insert before `summary();`:

```js
// --- recall Pass 3 (Task 4) ---
{
  // captions all garbage (sub-85): Pass 2 places nothing, Pass 3 fills every slot
  const vw = { app: { saved: [S('AAAA', 0, 0, { so: 1 }), S('BBBB', 1000, 0, { so: 2 })] } };
  const clients = [C('ZZZZ', 950, 10), C('QQQQ', 30, 20)];
  const placements = applyVersion(vw, clients);
  check('pass3: all slots filled', placements.length === 2 && placements.every(p => p.pass === 3));
  check('pass3: nearest assignment', placements.find(p => p.saved.caption === 'AAAA').client.caption === 'QQQQ');
  // no cross-app fill
  const vw2 = { appX: { saved: [S('AAAA', 0, 0)] } };
  const placements2 = applyVersion(vw2, [C('ZZZZ', 10, 10)]); // client is resourceClass 'app'
  check('pass3: never crosses resourceClass', placements2.length === 0);
  // opt-out for the login final-commit ladder tests
  const vw3 = { app: { saved: [S('AAAA', 0, 0)] } };
  check('pass3: can be disabled', applyVersion(vw3, [C('ZZZZ', 10, 10)], { slotFill: false }).length === 0);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node tools/harness/replay.mjs`
Expected: `FAIL pass3: all slots filled` (and exit 1).

- [ ] **Step 3: Extend the harness `applyVersion`** — inside the `for (const app in byApp)` loop, after the Pass 2 block, add:

```js
    if ((opts.slotFill ?? true) && wd.loading && wd.loading.length > 0) {   // Pass 3: slot fill
      const slots = wd.saved.filter((sv) => !sv.alreadyMatched);
      for (const pair of slotFillAssign(slots, wd.loading)) {
        pair.saved.alreadyMatched = true;
        placements.push({ app, client: pair.loading, saved: pair.saved, captionScore: matchCaptionIgnoreNumbers(pair.saved.caption, pair.loading.caption), pass: 3 });
      }
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `node tools/harness/replay.mjs`
Expected: all `PASS`, exit 0.

- [ ] **Step 5: Port to QML.** In `src/contents/ui/main.qml`, insert this function immediately BEFORE `function applyVersion(blob) {`:

```js
    // Deterministic slot fill: assign remaining live windows to remaining saved
    // slots of the SAME app. Slots are consumed in ascending stackingOrder; each
    // takes the nearest remaining window (squared Euclidean distance between
    // geometry centers), ties broken by ascending window stackingOrder. Surplus
    // windows are left untouched. Generalizes the original app's intentional
    // "last unmatched window is force-restored" behavior to N windows, replacing
    // the sub-85 caption roulette that shuffled same-app windows after a crash.
    // Mirrored in tools/harness/replay.mjs (slotFillAssign) - keep in sync.
    function slotFillAssign(savedSlots, clients) {
        let slots = savedSlots.slice().sort((a, b) => (a.stackingOrder || 0) - (b.stackingOrder || 0));
        let remaining = clients.slice();
        let pairs = [];
        for (let s = 0; s < slots.length && remaining.length > 0; s++) {
            let slot = slots[s];
            let sx = slot.x + slot.width / 2;
            let sy = slot.y + slot.height / 2;
            let bestIdx = 0;
            let bestDist = Infinity;
            for (let i = 0; i < remaining.length; i++) {
                let cx = remaining[i].x + remaining[i].width / 2;
                let cy = remaining[i].y + remaining[i].height / 2;
                let d = (cx - sx) * (cx - sx) + (cy - sy) * (cy - sy);
                if (d < bestDist || (d === bestDist && (remaining[i].stackingOrder || 0) < (remaining[bestIdx].stackingOrder || 0))) {
                    bestDist = d;
                    bestIdx = i;
                }
            }
            pairs.push({ saved: slot, loading: remaining.splice(bestIdx, 1)[0] });
        }
        return pairs;
    }
```

- [ ] **Step 6: Wire Pass 3 into `applyVersion`.** Locate the end of the Pass 2 block (the `for` loop calling `restoreWindowPlacement(results[r].saved, ...)` inside `if (remaining.length > 0) { ... }`) and add immediately AFTER that `if` block, still inside the `for (let app in liveByApp)` loop:

```js
            // Pass 3: slot fill - the slots twoWayMatch could not confidently
            // assign are filled with the remaining same-app windows, so an
            // explicit recall always restores the layout SHAPE (user decision:
            // hybrid). Confident matches from Pass 1/2 are never overridden.
            if (windowData.loading.length > 0) {
                let slots = windowData.saved.filter((s) => !s.alreadyMatched);
                let filled = slotFillAssign(slots, windowData.loading);
                for (let f = 0; f < filled.length; f++) {
                    filled[f].saved.alreadyMatched = true;
                    let score = config.ignoreNumbers ? matchCaptionIgnoreNumbers(filled[f].saved.caption, filled[f].loading.caption) : matchCaption(filled[f].saved.caption, filled[f].loading.caption);
                    try {
                        restoreWindowPlacement(filled[f].saved, filled[f].loading, score, getCurrentConfig(filled[f].loading));
                    } catch (e) {
                        logE('Could not apply version (slot fill) to window ' + app + ': ' + e);
                    }
                }
                if (filled.length > 0) log('applyVersion slot fill placed ' + filled.length + ' window(s) for ' + app);
            }
```

- [ ] **Step 7: Deploy and verify live**

```bash
make reload-installed
```
Expected: `Script unloaded successfully` … `Script started successfully`.
Then: `journalctl --user -n 50 | grep -iE "SyntaxError|ReferenceError"` → no output.
Manual: trigger recall round-trip (`qdbus6 org.kde.kglobalaccel /component/kwin org.kde.kglobalaccel.Component.invokeShortcut "Remember Window Positions: Apply Previous Version"` then `"...Apply Next Version"`) → OSD appears, in-session round-trip returns windows to their spots (Pass 1 all-100, journal shows no `slot fill` lines because ids all match in-session).

- [ ] **Step 8: Commit**

```bash
git add src/contents/ui/main.qml tools/harness/replay.mjs
git commit -m "feat: three-pass recall - deterministic slot fill for unmatched windows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Session-tagged protected history in main.qml

**Files:**
- Modify: `src/contents/ui/main.qml` (root properties ~line 26; `captureVersion` — locate `history.unshift({ t: Date.now(), d: blob });`)

**Interfaces:**
- Consumes: `trimVersionHistory` algorithm from Task 3 (verbatim port).
- Produces: root property `scriptSessionId` (string, also used in Task 6 logs); persisted version entries gain field `s`.

- [ ] **Step 1: Add the session id root property.** Next to the existing root properties (`property int historyIndex: 0` block):

```js
    // Identifies THIS script run. Version-history entries carry it (field `s`);
    // entries from a different run are protected from post-crash churn eviction.
    // Regenerated on script reload - false "prior session" positives are benign
    // (they only occupy the 2 reserved history slots for up to 24h).
    property string scriptSessionId: 'S' + Date.now()
```

- [ ] **Step 2: Port `trimVersionHistory`.** Insert immediately BEFORE `function captureVersion(blob) {`:

```js
    // Trim version history to 5 entries, evicting unprotected entries first.
    // Protected = captured by a DIFFERENT script session (s missing = legacy,
    // treated as protected) and younger than 24h - the layouts crash recovery
    // needs. Without this, the 60s snapshot re-captures the broken post-crash
    // layout and evicts every good pre-crash version within ~5 minutes. The
    // freshest capture (index 0) is never evicted directly; when only protected
    // entries remain, the oldest beyond the 2 reserved slots are evicted.
    // Mirrored in tools/harness/replay.mjs (trimVersionHistory) - keep in sync.
    function trimVersionHistory(history) {
        const maxVersions = 5;
        const reservedProtected = 2;
        const protectedMs = 24 * 60 * 60 * 1000;
        let now = Date.now();
        let isProtected = (v) => (v.s === undefined || v.s !== scriptSessionId) && (now - v.t < protectedMs);
        while (history.length > maxVersions) {
            let evict = -1;
            for (let i = history.length - 1; i >= 1; i--) {
                if (!isProtected(history[i])) { evict = i; break; }
            }
            if (evict === -1) {
                let seen = 0;
                for (let i = 0; i < history.length; i++) {
                    if (isProtected(history[i])) { seen++; if (seen > reservedProtected) evict = i; }
                }
            }
            if (evict === -1) evict = history.length - 1;
            history.splice(evict, 1);
        }
        return history;
    }
```

- [ ] **Step 3: Use it in `captureVersion`.** Replace:

```js
        history.unshift({ t: Date.now(), d: blob });
        if (history.length > 5) history.length = 5;
```

with:

```js
        history.unshift({ t: Date.now(), d: blob, s: scriptSessionId });
        trimVersionHistory(history);
```

- [ ] **Step 4: Deploy and verify live**

```bash
make reload-installed
```
Then wait ≥60s (one snapshot tick) and run: `python3 tools/harness/decode.py`
Expected: at least the newest history entry shows `session=S<digits>`; older entries show `session=(none)` (legacy) — and after this reload they are protected.
Journal check: `journalctl --user -n 100 | grep -iE "SyntaxError|ReferenceError"` → no output.

- [ ] **Step 5: Commit**

```bash
git add src/contents/ui/main.qml
git commit -m "feat: protect prior-session versions from post-crash history churn

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Clean-shutdown crash flag

**Files:**
- Modify: `src/contents/ui/main.qml` (root properties; `Settings` block ~line 2326; `Component.onCompleted` ~line 2354; `saveWindowsToSettings` ~line 2113)

**Interfaces:**
- Consumes: nothing new.
- Produces: root property `crashedLastSession` (bool) — consumed by Task 7; persisted key `rememberwindowpositions_cleanShutdown` (`"1"` = clean, anything else = crash).

- [ ] **Step 1: Add the root property** next to `scriptSessionId`:

```js
    // True when the previous script session did not reach the clean-shutdown
    // write - i.e. KWin/system crashed. Read once at startup; drives the
    // crash-recovery behaviors (longer caption-wait budget). A manual script
    // reload also reads as a crash: accepted, the effects are never destructive.
    property bool crashedLastSession: false
```

- [ ] **Step 2: Add the settings property.** In the `Settings` block after `property string rememberwindowpositions_configOverrides: "{}"`:

```js
        property string rememberwindowpositions_cleanShutdown: ""
```

- [ ] **Step 3: Detect at startup.** At the very top of `Component.onCompleted: {` (before any existing line):

```js
        // Crash detection: the flag is "1" only if the previous session reached
        // the clean-shutdown write. Read it, then immediately arm it for this
        // session. Absent/unreadable counts as a crash (safe direction).
        crashedLastSession = settings.rememberwindowpositions_cleanShutdown !== "1";
        settings.rememberwindowpositions_cleanShutdown = "0";
        if (crashedLastSession) logE('Previous session did not shut down cleanly - crash recovery mode active');
```

- [ ] **Step 4: Write the flag on clean shutdown.** First line inside `function saveWindowsToSettings(shutdown) {`:

```js
        if (shutdown) settings.rememberwindowpositions_cleanShutdown = "1";
```

(`Component.onDestruction` already calls `saveWindowsToSettings(true)` — no new call site.)

- [ ] **Step 5: Deploy and verify live**

```bash
make reload-installed
python3 tools/harness/decode.py
```
Expected: `cleanShutdown raw: '"0"'` (armed) and journal shows `crash recovery mode active` (the reload itself reads as a crash — expected false positive).
Then verify the clean path: `make reload-installed` again → during its unload phase `Component.onDestruction` fires; the SECOND run's journal must show the same `crash recovery mode active`? **No** — expected: the second reload's journal does NOT show the crash line, because the first instance's unload wrote `"1"`. If it does show it, the destruction write is broken — stop and fix before committing.

- [ ] **Step 6: Commit**

```bash
git add src/contents/ui/main.qml
git commit -m "feat: persisted clean-shutdown flag for crash detection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Crash-boosted login wait + slot-fill final commit

**Files:**
- Modify: `src/contents/ui/main.qml` (`loadConfig` config object ~line 186 and the loginBoost multiplication ~line 233; `restoreWindowsBasedOnConfidence` ladder ~line 868)
- Modify: `tools/harness/replay.mjs` (final-commit ladder test)

**Interfaces:**
- Consumes: `crashedLastSession` (Task 6), QML `slotFillAssign` (Task 4).
- Produces: config key `crashBoostMultiplier` (default 4); changed final-commit behavior for multi-window apps.

- [ ] **Step 1: Harness first — failing test for the final-commit rule.** The rule under test: when >1 window remains at final commit, the ladder stops before sub-85 rungs and slot fill takes over; with exactly 1 window the full original ladder applies. Insert before `summary();`:

```js
// --- login final commit (Task 7) ---
function finalCommitLadder(windowData, minConfidence) {
  // mirrors main.qml restoreWindowsBasedOnConfidence final-commit section
  const results = [];
  const useSlotFill = windowData.loading.length > 1;
  let ci = 0;
  while (windowData.loading.length > 0 && ci < CONFIDENCE.length) {
    if (useSlotFill && CONFIDENCE[ci].caption < 85) break;
    results.push(...twoWayMatch(windowData, CONFIDENCE[ci], minConfidence));
    ci++;
  }
  if (useSlotFill && windowData.loading.length > 0) {
    const slots = windowData.saved.filter((sv) => !sv.alreadyMatched);
    for (const pair of slotFillAssign(slots, windowData.loading)) {
      pair.saved.alreadyMatched = true;
      windowData.loading.splice(windowData.loading.indexOf(pair.loading), 1);
      results.push({ loading: pair.loading, saved: pair.saved, captionScore: matchCaptionIgnoreNumbers(pair.saved.caption, pair.loading.caption), slotFill: true });
    }
  }
  return results;
}
{
  // ambiguous multi-window: no sub-85 twoWayMatch pairing, slot fill instead
  const wd = { saved: [S('AAAA', 0, 0, { so: 1 }), S('BBBB', 1000, 0, { so: 2 })], loading: [C('ZZZZ', 950, 10), C('QQQQ', 30, 20)] };
  const res = finalCommitLadder(wd, 0);
  check('final: ambiguous windows go through slot fill', res.length === 2 && res.every(r => r.slotFill === true));
  check('final: slot fill is nearest-based', res.find(r => r.saved.caption === 'AAAA').loading.caption === 'QQQQ');
  // single remaining window: original full-ladder force placement preserved
  const wd2 = { saved: [S('AAAA', 0, 0)], loading: [C('ZZZZ', 500, 500)] };
  const res2 = finalCommitLadder(wd2, 0);
  check('final: single window keeps original floor-0 ladder', res2.length === 1 && !res2[0].slotFill);
}
```

- [ ] **Step 2: Run to verify these pass in the harness** (the harness mirror is written together with the test here — the failing/passing gate for this task lives in the QML port review, the harness pins the exact intended semantics):

Run: `node tools/harness/replay.mjs`
Expected: all `PASS`, exit 0. If any `final:` check fails, fix `finalCommitLadder` in the harness BEFORE touching QML — the harness is the reference.

- [ ] **Step 3: Add the config.** In `loadConfig`, inside the `config = { ... }` object near `loginBoostMultiplier`:

```js
            crashBoostMultiplier: KWin.readConfig("crashBoostMultiplier", 4),
```

Then AFTER the two existing lines that apply `loginBoost` (`config.multiWindowRestoreAttempts = ...` / `config.perfectMultiWindowRestoreAttempts = ...`):

```js
        // After a crash the whole session reopens at once: tabs lazy-load and
        // captions arrive very late, so the normal ~10s budget expires while
        // windows are still indistinguishable. Give them 4x the time.
        if (crashedLastSession) {
            config.multiWindowRestoreAttempts *= config.crashBoostMultiplier;
            config.perfectMultiWindowRestoreAttempts *= config.crashBoostMultiplier;
        }
```

- [ ] **Step 4: Rework the final-commit ladder in `restoreWindowsBasedOnConfidence`.** Replace:

```js
        if (windowData.loading.length > 0) {
            let results = [];
            let confidenceIndex = 0;

            while (windowData.loading.length > 0 && confidenceIndex < config.confidence.length) {
                results.push(...twoWayMatch(windowData, config.confidence[confidenceIndex], minConfidence));
                confidenceIndex++;
            }
```

with:

```js
        if (windowData.loading.length > 0) {
            let results = [];
            let confidenceIndex = 0;

            // With several indistinguishable windows left, the sub-85 ladder
            // rungs pair them near-randomly (observed post-crash: 37 Chrome
            // windows placed on caption scores < 50). Stop the ladder at the
            // strong rungs and fill the remaining slots deterministically
            // instead. A single remaining window keeps the original full
            // ladder - with one candidate the forced match is safe (this also
            // preserves the single-window-app and last-window paths).
            let useSlotFill = windowData.loading.length > 1;

            while (windowData.loading.length > 0 && confidenceIndex < config.confidence.length) {
                if (useSlotFill && config.confidence[confidenceIndex].caption < 85) break;
                results.push(...twoWayMatch(windowData, config.confidence[confidenceIndex], minConfidence));
                confidenceIndex++;
            }

            if (useSlotFill && windowData.loading.length > 0) {
                let slots = windowData.saved.filter((s) => !s.alreadyMatched);
                let filled = slotFillAssign(slots, windowData.loading);
                for (let f = 0; f < filled.length; f++) {
                    filled[f].saved.alreadyMatched = true;
                    windowData.loading.splice(windowData.loading.indexOf(filled[f].loading), 1);
                    let score = config.ignoreNumbers ? matchCaptionIgnoreNumbers(filled[f].saved.caption, filled[f].loading.caption) : matchCaption(filled[f].saved.caption, filled[f].loading.caption);
                    results.push({ loading: filled[f].loading, saved: filled[f].saved, captionScore: score });
                }
                if (filled.length > 0) logE('Final commit slot fill placed ' + filled.length + ' window(s) for ' + clientName);
            }
```

(The existing `results.sort(...)` and restore loop below stay unchanged — slot-fill results flow through the same placement code.)

- [ ] **Step 5: Deploy and verify live**

```bash
make reload-installed
```
Journal check: `journalctl --user -n 100 | grep -iE "SyntaxError|ReferenceError"` → no output.
Behavior check (reload counts as crash): journal shows `crash recovery mode active`; opening a multi-window app that was saved (e.g. two konsole windows) restores them; any `Final commit slot fill` lines list >0 windows only when captions failed to differentiate.

- [ ] **Step 6: Commit**

```bash
git add src/contents/ui/main.qml tools/harness/replay.mjs
git commit -m "feat: crash-boosted login wait and deterministic slot-fill final commit

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Documentation and final verification

**Files:**
- Modify: `README.md` (version-history section added by commit ef06369)
- Verify: whole feature set

**Interfaces:**
- Consumes: everything above.
- Produces: user-facing docs; a verified installed build.

- [ ] **Step 1: Document the crash-recovery behavior.** In `README.md`, locate the section documenting the version history / recall shortcuts (search for "version") and append:

```markdown
### Crash recovery

The script detects an unclean shutdown (crash) via a persisted flag. After a
crash:

- Versions captured before the crash are **protected** for 24 hours: at least
  2 of the 5 history slots are reserved for them, so the periodic snapshot of
  the (still messy) post-crash session cannot evict your last good layouts.
- The login restore waits longer for window titles to settle
  (`crashBoostMultiplier`, default 4x the normal budget).
- Windows that still cannot be identified by title are placed by a
  deterministic *slot fill* — every saved position is filled by the nearest
  same-application window — instead of random weak title matches. The layout
  shape is restored; for look-alike windows (e.g. many browser windows) the
  exact window↔position pairing is best-effort.
- The recall shortcuts apply the same three passes: exact window id, strong
  title match (≥85), then slot fill.
```

- [ ] **Step 2: Full test suite**

Run: `node tools/harness/replay.mjs`
Expected: all `PASS`, exit 0.
Also run (skip without failing the task if the tool is not installed): `qmllint src/contents/ui/main.qml`
Expected: no NEW errors compared to running it on `git show HEAD~1:src/contents/ui/main.qml` (pre-existing unqualified-access warnings are normal for KWin scripts).

- [ ] **Step 3: Fresh install + reload + smoke test**

```bash
make install
make reload-installed
python3 tools/harness/decode.py
```
Expected: script loaded; `cleanShutdown raw: '"0"'`; history newest entry carries `session=S<digits>`; recall round-trip via the two `invokeShortcut` commands (Task 4 Step 7) shows OSD and returns windows unmoved.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document crash recovery, protected history and slot fill

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Real-world validation note (no code).** The definitive test for Task 6/7 is the next real crash: `crashedLastSession` true at boot, pre-crash versions still recallable after 10+ minutes, no sub-85 `twoWayMatch` placements in the journal (only `Final commit slot fill` lines), recall of a pre-crash version fills every slot. `debugLogs` stays ON until that validation passes; afterwards disable with `kwriteconfig6 --file kwinrc --group Script-rememberwindowpositions --key debugLogs false` + `make reload-installed`.
