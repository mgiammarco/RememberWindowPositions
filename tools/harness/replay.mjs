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
    if ((opts.slotFill ?? true) && wd.loading && wd.loading.length > 0) {   // Pass 3: slot fill
      const slots = wd.saved.filter((sv) => !sv.alreadyMatched);
      for (const pair of slotFillAssign(slots, wd.loading)) {
        pair.saved.alreadyMatched = true;
        placements.push({ app, client: pair.loading, saved: pair.saved, captionScore: matchCaptionIgnoreNumbers(pair.saved.caption, pair.loading.caption), pass: 3 });
      }
    }
  }
  return placements;
}

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
// Regression: Pass 2 floor 85 leaves weak matches unplaced (bug #1 fix).
// slotFill disabled: this isolates Pass 2's own floor from Pass 3 (Task 4),
// which by design DOES fill these same slots (see pass3 tests below).
{
  const vw = { app: { saved: [S('Sprint Planning | Fibery', 0, 0), S('Nuova scheda', 900, 900)] } };
  const placements = applyVersion(vw, [C('Kindle - Google Chrome', 10, 10), C('Totally Different Title', 910, 910)], { slotFill: false });
  check('pass2: sub-85 matches are not placed', placements.length === 0);
}
// Regression: Pass 2 places strong caption matches
{
  const vw = { app: { saved: [S('(23) Calendar | Microsoft Teams', 0, 0)] } };
  const placements = applyVersion(vw, [C('(25) Calendar | Microsoft Teams', 500, 500)]);
  check('pass2: >=85 caption match is placed', placements.length === 1 && placements[0].pass === 2);
}

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
{
  // equal-distance tie broken by ascending window stackingOrder
  const slot = [S('s1', 0, 0)];
  const wins = [C('w-high', 100, 0, { so: 5 }), C('w-low', -100, 0, { so: 1 })];
  const pair = slotFillAssign(slot, wins);
  check('slotfill: distance tie broken by window stackingOrder', pair.length === 1 && pair[0].loading.caption === 'w-low');
}

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

summary();
