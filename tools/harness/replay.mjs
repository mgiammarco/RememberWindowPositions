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
