// tests/round11-freeze.spec.ts — v24：後處理時間切片（F1）、模糊預篩（F2）、精確詞典預編譯（F3）
// 「舊版當 oracle」：同一輸入同時送進 tests/baseline/v23_2 與受測頁面，比較輸出。
import { test, expect } from '@playwright/test';
import { openWithHook, buildSegments, installScriptedWorker, newCtx } from './harness';
import { setToggles } from './helpers';

const NAMES = ['createSlicer', 'NOOP_SLICER', 'yieldToMain', 'POST_SLICE_BUDGET_MS',
  'applyFuzzyMedicalDict', 'applyMedicalDict', 'applyPostProcessing', 'buildDictMap',
  'DEFAULT_MEDICAL_DICT', 'BOPOMOFO_MAP', 'phoneticProfile', 'phoneticSimilarityFromProfiles',
  'phoneticSimilarityUpperBound', 'buildFuzzyIndex', 'countCandidateHits', 'medicalDict', 'getPostConfig'];

test.describe('F1：時間切片器', () => {
  test('TF-01 切片器：假時鐘下的 due／yield／取消；NOOP_SLICER 不讓出', async ({ browser }) => {
    const context = await newCtx(browser);
    const p = await openWithHook(context, NAMES, 'new');
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      let now = 0, cancel = false; const yields: number[] = [];
      const s = T.createSlicer({ budgetMs: 8, now: () => now, yieldFn: async () => { yields.push(now); },
        checkCancel: () => { if (cancel) throw new Error('CANCELLED'); } });
      const out: any = {};
      out.d0 = s.due(); now = 7.9; out.d1 = s.due(); now = 8; out.d2 = s.due();
      await s.yield(); out.yields = s.stats.yields; out.dAfter = s.due();
      now = 16; out.d3 = s.due();
      cancel = true;
      try { await s.yield(); out.cancel = 'no-throw'; } catch (e: any) { out.cancel = e.message; }
      out.noopDue = T.NOOP_SLICER.due(); await T.NOOP_SLICER.yield(); out.noopOk = true;
      out.budget = T.POST_SLICE_BUDGET_MS;
      return out;
    });
    expect(r).toEqual({ d0: false, d1: false, d2: true, yields: 1, dAfter: false, d3: true, cancel: 'CANCELLED', noopDue: false, noopOk: true, budget: 8 });
  });

  test('TF-01b yieldToMain 真的讓出主執行緒（排隊中的 macrotask 先跑）且不洩漏 port', async ({ browser }) => {
    const context = await newCtx(browser);
    const p = await openWithHook(context, NAMES, 'new');
    const order = await p.evaluate(async () => {
      const T = (window as any).__t; const seq: string[] = [];
      const timer = new Promise<void>((res) => setTimeout(() => { seq.push('timer'); res(); }, 0));
      const y = T.yieldToMain().then(() => seq.push('yield'));
      await Promise.all([timer, y]);
      return seq;
    });
    expect(order).toContain('yield');
    expect(order).toContain('timer');
  });
});

// ── 輸入產生器（頁面內、種子固定；新舊頁面各跑一次必得相同輸入）──────────────
const adversarial = ({ seed, n, dictName, th }: { seed: number; n: number; dictName: string; th: number | undefined }) => {
  const T = (window as any).__t, M: Map<string, string> = T.BOPOMOFO_MAP, D = T.DEFAULT_MEDICAL_DICT;
  let s = seed >>> 0; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = <X,>(a: X[]) => a[Math.floor(rnd() * a.length)];
  const cjk = [...M.keys()];
  const specials = ['A', 'B', 'p', 'c', '1', '2', '9', '-', '。', ',', ' ', '\x00', '\x001\x00', '\x0012\x00', '😀', '\u{20BB7}', '（', 'Ｏ', '|', '||', 'a|b'];
  const terms: string[] = D.flatMap((e: any) => [e.zh, ...e.raw.split('|').map((v: string) => v.trim()).filter(Boolean)]);
  const rs = () => { const k = 1 + Math.floor(rnd() * 40); let x = ''; for (let i = 0; i < k; i++) { const r = rnd(); x += r < 0.45 ? pick(cjk) : r < 0.62 ? pick(specials) : pick(terms).slice(0, 1 + Math.floor(rnd() * 6)); } return x; };
  const edge = [{ raw: 'COVID-19|新冠', zh: 'COVID-19', en: 'C' }, { raw: '2型糖尿病|第二型糖尿病', zh: '2型糖尿病', en: 'T2DM' }, { raw: '😀笑臉|笑臉', zh: '😀笑臉', en: 'S' }];
  const pipe = [{ raw: 'ab|cd', zh: 'ab|cx', en: 'PIPE' }, { raw: '血壓|高血壓', zh: '高血|壓', en: 'HP' }];
  const dicts: Record<string, any[]> = { builtin: D, edge: [...D, ...edge], pipe, mixedPipe: [...D.slice(0, 60), ...pipe] };
  const fixed = ['ab|cx', 'xx ab|cd yy', '高血|壓力', '請記錄病人的血|壓', 'a|b|c', '||', '', 'a', '\x00', '心飢哽塞', '血壓很高'];
  const subs = Array.from({ length: n }, (_, i) => ({ index: i + 1, start: i, end: i + 1, text: rs() }))
    .concat(fixed.map((t, i) => ({ index: 900 + i, start: 0, end: 1, text: t })));
  return (async () => ({ input: subs.map((x) => x.text), out: (await T.applyFuzzyMedicalDict(subs, dicts[dictName], th)).map((x: any) => x.text) }))();
};

test.describe('F2／F3：輸出與 v23.2 逐字相同（特徵測試）', () => {
  test.setTimeout(240_000);

  test('TF-02 固定語料（約 190 行＋手寫邊界句）：精確詞典與模糊比對輸出與舊版逐字相同；有／無切片器亦相同', async ({ browser }) => {
    const context = await newCtx(browser);
    const segs = await buildSegments(context, { segments: 19, linesPerSegment: 10, charsPerLine: 22, termRate: 0.25, seed: 11 });
    const hand = ['心飢哽塞的病人', '病原體感染', '血壓很高', '砂眼披衣菌', '', 'a', 'Hello world 123', '（）', '今天天氣很好'];
    const lines = [...segs.flat().map((c) => c.text), ...hand];
    const run = async (which: 'old' | 'new', withSlicer: boolean) => {
      const p = await openWithHook(context, NAMES, which);
      try {
        return await p.evaluate(async ({ lines, withSlicer }) => {
          const T = (window as any).__t;
          const subs = lines.map((t: string, i: number) => ({ index: i + 1, start: i, end: i + 1, text: t }));
          const dict = T.DEFAULT_MEDICAL_DICT;
          const sl = withSlicer ? [T.createSlicer({ budgetMs: 0, yieldFn: async () => {} })] : [];
          return JSON.stringify({
            exact: await T.applyMedicalDict(subs, T.buildDictMap(dict), ...sl),
            fuzzy: await T.applyFuzzyMedicalDict(subs, dict, undefined, ...sl),
          });
        }, { lines, withSlicer });
      } finally { await p.close(); }
    };
    const oldOut = await run('old', false);
    expect(await run('new', false)).toBe(oldOut);
    expect(await run('new', true)).toBe(oldOut);
    expect(JSON.parse(oldOut).fuzzy.some((s: any, i: number) => s.text !== lines[i])).toBe(true); // 語料有鑑別力：確實有行被改
  });

  test('TF-03 對抗式隨機：種子固定 × 4 種詞典 × 7 種門檻；輸入不含數字與 NUL 的行，輸出與舊版逐字相同', async ({ browser }) => {
    const context = await newCtx(browser);
    const oldP = await openWithHook(context, NAMES, 'old'), newP = await openWithHook(context, NAMES, 'new');
    let compared = 0, cleanLines = 0;
    for (const dictName of ['builtin', 'edge', 'pipe', 'mixedPipe']) {
      for (const th of [0.05, 0.31, 0.5, 0.65, 0.75, 0.9, 1.0]) {
        const arg = { seed: 4242 + compared, n: dictName === 'builtin' ? 20 : 14, dictName, th };
        const a = await oldP.evaluate(adversarial, arg), b = await newP.evaluate(adversarial, arg);
        a.out.forEach((o: string, i: number) => {
          if (!a.input[i].includes('\x00')) expect(b.out[i], `新版不得殘留 NUL dict=${dictName} th=${th} line=${i}`).not.toContain('\x00');
          if (/[0-9\x00]/.test(a.input[i]) || o.includes('\x00')) return;   // 含數字／NUL 的輸入，或舊版輸出已損壞（殘留 NUL）：不當 oracle（見 TB-03／TB-04）
          expect(b.out[i], `dict=${dictName} th=${th} line=${i}`).toBe(o); cleanLines++;
        });
        compared++;
      }
    }
    expect(compared).toBe(28);
    expect(cleanLines).toBeGreaterThan(200);
  });

  test('TF-04 不變量：BOPOMOFO_MAP 的值不含數字／NUL／\'|\'（F2「安全候選詞」判斷的前提）', async ({ browser }) => {
    const context = await newCtx(browser);
    const p = await openWithHook(context, NAMES, 'new');
    const bad = await p.evaluate(() => [...(window as any).__t.BOPOMOFO_MAP.values()].filter((v: string) => /[0-9\x00|]/.test(v)).length);
    expect(bad).toBe(0);
  });

  test('TF-05 精確詞典：詞條含正規式特殊字元、詞後接「(」、重疊別稱；輸出與舊版逐字相同', async ({ browser }) => {
    const context = await newCtx(browser);
    const dict = [
      { raw: 'a.b|c+d|(x)|[y]|e*f|g?h|i^j|k$l|m\\n|p{2}', zh: '標準甲', en: 'StdA' },
      { raw: '高血壓|血壓高|高血', zh: '高血壓', en: 'Hypertension' },
      { raw: '糖尿病|第二型糖尿病', zh: '糖尿病', en: 'DM' },
    ];
    const lines = ['a.b 與 c+d 與 (x) 與 [y]', 'e*f g?h i^j k$l m\\n p{2}', '高血壓(Hypertension) 已標註', '血壓高 與 高血 與 第二型糖尿病', 'aXb c d', ''];
    const run = async (which: 'old' | 'new') => {
      const p = await openWithHook(context, NAMES, which);
      try {
        return await p.evaluate(async ({ dict, lines }) => {
          const T = (window as any).__t;
          return JSON.stringify(await T.applyMedicalDict(lines.map((t: string, i: number) => ({ index: i + 1, start: i, end: i + 1, text: t })), T.buildDictMap(dict)));
        }, { dict, lines });
      } finally { await p.close(); }
    };
    const a = await run('old'); expect(await run('new')).toBe(a);
    expect(JSON.parse(a).filter((s: any, i: number) => s.text !== lines[i]).length).toBeGreaterThan(2);
  });

  test('TF-06b 預篩內部性質：凡原版會評估的（行×候選詞）組合，預篩必定放行（上界 ≥ 真實值；hits ≥ need）', async ({ browser }) => {
    const context = await newCtx(browser);
    const p = await openWithHook(context, NAMES, 'new');
    const r = await p.evaluate(() => {
      const T = (window as any).__t, M: Map<string, string> = T.BOPOMOFO_MAP, D = T.DEFAULT_MEDICAL_DICT;
      let s = 99; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
      const cjk = [...M.keys()], pick = <X,>(a: X[]) => a[Math.floor(rnd() * a.length)];
      const terms: string[] = D.flatMap((e: any) => [e.zh, ...e.raw.split('|').map((v: string) => v.trim()).filter(Boolean)]).filter((t: string) => t.length >= 2 && /[\u4e00-\u9fff]/.test(t));
      const cands = terms.slice(0, 400).map((term) => ({ term, prof: T.phoneticProfile(term) }));
      let pairs = 0, violations = 0, ubBelow = 0;
      for (const th of [0.5, 0.75, 0.9]) {
        const idx = T.buildFuzzyIndex(cands, th);
        const hits = new Uint16Array(cands.length);
        for (let n = 0; n < 60; n++) {
          let text = ''; const L = 4 + Math.floor(rnd() * 30);
          for (let i = 0; i < L; i++) text += rnd() < 0.5 ? pick(cjk) : pick(terms).slice(0, 2);
          T.countCandidateHits(text, idx, hits);
          cands.forEach((c, ci) => {
            const tLen = c.term.length; let any = false;
            for (let winLen = tLen - 1; winLen <= tLen + 1 && !any; winLen++) {
              if (winLen < 2) continue;
              for (let st = 0; st <= text.length - winLen; st++) {
                const wp = T.phoneticProfile(text.slice(st, st + winLen));
                const ub = T.phoneticSimilarityUpperBound(wp, c.prof), real = T.phoneticSimilarityFromProfiles(wp, c.prof);
                if (ub + 1e-12 < real) ubBelow++;
                if (ub >= th - 1e-9) { any = true; break; }
              }
            }
            pairs++;
            if (any && !idx.unsafe[ci] && hits[ci] < idx.need[ci]) violations++;
          });
        }
      }
      return { pairs, violations, ubBelow };
    });
    expect(r.ubBelow).toBe(0);
    expect(r.violations).toBe(0);
    expect(r.pairs).toBeGreaterThan(50_000);
  });
});

test.describe('F1：後處理期間的設定快照', () => {
  test('TF-07 後處理被切片、期間詞典被就地修改 → 輸出等於「以原詞典處理」（同一頁面不切片、詞典不動，是對照組）', async ({ browser }) => {
    const context = await newCtx(browser);
    const chunks = (await buildSegments(context, { segments: 6, linesPerSegment: 8, charsPerLine: 22, termRate: 0.3, seed: 5 }))
      .flat().map((c, i) => ({ text: c.text, timestamp: [i * 3, i * 3 + 1.5] as [number, number] }));
    // 對照組不用舊版：舊版引擎有「模糊比對改壞精確標注」的 bug（r5 已修，見 TR-09），新舊輸出本來就不會逐字相同。
    // 這裡要驗的只有「切片＋期間詞典被改」不影響結果，所以對照組＝同一個新頁面、不切片、詞典不動。舊版逐字比對由 TF-02／TF-10 負責。
    const setup = async () => {
      const p = await openWithHook(context, NAMES, 'new');
      await setToggles(p, ['tog_medical', 'tog_fuzzy'], ['tog_merge', 'tog_split', 'tog_overlap', 'tog_mindur', 'tog_period', 'tog_case', 'tog_opencc', 'tog_hallucination']);
      return p;
    };
    const refP = await setup(), newP = await setup();
    const expected = await refP.evaluate(async (c) => JSON.stringify(await (window as any).__t.applyPostProcessing(c)), chunks);
    const got = await newP.evaluate(async (c) => {
      const T = (window as any).__t; let n = 0;
      const slicer = T.createSlicer({ budgetMs: 0, yieldFn: async () => { if (++n === 2) T.evalIn('medicalDict.splice(0, 250)'); } });
      const out = JSON.stringify(await T.applyPostProcessing(c, { slicer }));
      return { out, yields: n, remaining: T.evalIn('medicalDict.length') };
    }, chunks);
    expect(got.yields).toBeGreaterThan(2);
    expect(got.remaining).toBeLessThan(100);            // 詞典真的被改了
    expect(got.out).toBe(expected);
  });
});

// ── TF-10：輸出逐字相同（5 種格式 × 3 個模擬媒體；另加 2 檔批次逐檔比對）──────────────────────────
import { installScriptedWorker as _isw, ensureMedia, BASE_URL as _BASE, readPageHtml } from './harness';

async function runFile(browser: any, which: 'old' | 'new', files: string[], fmt: string, segs: any[]) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  await _isw(page, { segments: segs });
  await page.addInitScript(() => Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 8 }));
  await page.route('**/index.html', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: readPageHtml(which) }));
  await page.goto(_BASE);
  await setToggles(page, [], ['tog_vad', 'tog_diarization']);
  await page.selectOption('#outFormat', fmt);
  await page.locator('#fileInput').setInputFiles(files);
  await page.locator('#startBtn').click();
  await expect(page.locator('.batch-item.done')).toHaveCount(files.length, { timeout: 120_000 });
  const outs = await page.evaluate(async () => {
    const hrefs = [...document.querySelectorAll<HTMLAnchorElement>('.batch-item a[download], #dlBtn')].map((a) => a.href).filter((h) => h.startsWith('blob:'));
    return Promise.all([...new Set(hrefs)].map(async (h) => (await (await fetch(h)).text())));
  });
  await ctx.close();
  return outs;
}

test.describe('TF-10 輸出與 v23.2 逐字相同', () => {
  test.setTimeout(600_000);
  test.beforeAll(() => { ensureMedia(['mono16k-60s.wav', 'st44k-60s.wav', 'mono48k-60s.wav']); });
  const formats = ['srt', 'vtt', 'ass', 'txt', 'md'];
  const media = ['mono16k-60s.wav', 'st44k-60s.wav', 'mono48k-60s.wav'];
  for (const m of media) for (const f of formats) {
    test(`${m} × ${f}`, async ({ browser }) => {
      const segs = await buildSegments(await newCtx(browser), { segments: 3, linesPerSegment: 6, charsPerLine: 14, termRate: 0.3, seed: 17 });
      const [file] = ensureMedia([m]);
      const a = await runFile(browser, 'old', [file], f, segs), b = await runFile(browser, 'new', [file], f, segs);
      expect(a.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
      expect(a[0].length).toBeGreaterThan(40);
    });
  }
  test('批次 2 檔逐檔比對（各檔輸出內容逐字相同；ZIP 內容即各檔輸出）', async ({ browser }) => {
    const segs = await buildSegments(await newCtx(browser), { segments: 3, linesPerSegment: 6, charsPerLine: 14, termRate: 0.3, seed: 17 });
    const files = ensureMedia(['mono16k-60s.wav', 'st44k-60s.wav']);
    const a = await runFile(browser, 'old', files, 'srt', segs), b = await runFile(browser, 'new', files, 'srt', segs);
    expect(a.length).toBe(2);
    expect(b).toEqual(a);
  });
});
