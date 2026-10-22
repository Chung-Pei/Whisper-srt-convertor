// tests/round12-r5-review.spec.ts — r5 穿透式審查的回歸測試（每項先紅後綠）
import { test, expect } from '@playwright/test';
import { newCtx, openWithHook, installScriptedWorker, buildSegments, ensureMedia, BASE_URL } from './harness';
import { setToggles } from './helpers';

test.describe('r5 審查：批次取消計數', () => {
  test.setTimeout(120_000);

  test('TR-01 三個檔案、第 1 個辨識中按取消 → 摘要「取消」= 3（目前執行中的那一個也算）', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
    const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: segs, rules: [{ segIdx: 0, silent: true }] });   // 第 1 段永不回覆 → 停在辨識中
    await page.goto(BASE_URL);
    await setToggles(page, [], ['tog_vad', 'tog_diarization']);
    await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-60s.wav', 'mono48k-60s.wav', 'st44k-60s.wav']));
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => ((window as any).__workerLog || []).some((e: any) => e.type === 'RUN_CHUNK' && e.segIdx === 0), null, { timeout: 30_000 });
    await page.locator('#cancelBtn').click();
    await page.locator('#batchSummary.show').waitFor({ timeout: 10_000 });
    const stats = (await page.locator('#batchSummaryStats').textContent()) ?? '';
    expect(stats).toMatch(/取消：3 個/);
    // 三個項目的實際狀態也都是「已取消」，計數必須與畫面一致
    await expect(page.locator('.batch-item-status', { hasText: '已取消' })).toHaveCount(3);
  });
});

test.describe('r5 審查：詞典條目驗證只有一份', () => {
  test.setTimeout(120_000);

  const importJson = async (page: any, name: string, body: string) => {
    await page.locator('#dictImportFile').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(body, 'utf8') });
  };

  test('TR-02 JSON 匯入：非字串／空白欄位的條目被略過、字串去前後空白；匯入後精確詞典與模糊比對都不丟例外', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), ['buildDictMap', 'applyMedicalDict', 'applyFuzzyMedicalDict'], 'new');
    await setToggles(p, ['tog_medical'], []);          // 詞典編輯區預設隱藏
    await importJson(p, 'd.json', JSON.stringify([
      { raw: ' 糖尿病|糖尿症 ', zh: ' 糖尿病', en: ' Diabetes ' },   // 合格（要去空白）
      { raw: 123, zh: '壞一', en: 'Bad1' },                           // raw 非字串 → 舊版會在 buildDictMap 丟 TypeError
      { raw: '壞二', zh: 456, en: 'Bad2' },
      { raw: '壞三', zh: '壞三', en: { x: 1 } },
      { raw: '   ', zh: '壞四', en: 'Bad4' },
      { raw: '|', zh: '壞五', en: 'Bad5' },                          // 沒有任何有效別稱
      { raw: '高血壓', zh: '高血壓', en: 'Hypertension', extra: 'x' },
    ]));
    await p.locator('#logBox', { hasText: '已匯入' }).waitFor();
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      const dict = T.evalIn('medicalDict');
      let err = '';
      try {
        const subs = [{ index: 1, start: 0, end: 1, text: '糖尿症和高血壓' }];
        await T.applyMedicalDict(subs, T.buildDictMap(dict));
        await T.applyFuzzyMedicalDict(subs, dict, 0.75);
      } catch (e: any) { err = String(e?.message ?? e); }
      return { dict: JSON.parse(JSON.stringify(dict)), err, log: document.getElementById('logBox')!.textContent };
    });
    expect(r.err).toBe('');
    expect(r.dict).toEqual([
      { raw: '糖尿病|糖尿症', zh: '糖尿病', en: 'Diabetes' },
      { raw: '高血壓', zh: '高血壓', en: 'Hypertension' },
    ]);
    expect(r.log).toContain('已匯入 2 條');
    expect(r.log).toContain('略過 5 條');
  });

  test('TR-03 CSV 匯入與手動新增：與 JSON 同一套規則（去前後空白；缺欄位／無有效別稱者拒絕）', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), [], 'new');
    await p.locator('#postPanelHeader').click();       // 後處理面板預設收合
    await setToggles(p, ['tog_medical'], []);
    await p.locator('#dictImportFile').setInputFiles({ name: 'd.csv', mimeType: 'text/csv', buffer: Buffer.from('" 甲狀腺亢進 ", 甲狀腺亢進 , Hyperthyroidism \n|,空別稱,Empty\n', 'utf8') });
    await p.locator('#logBox', { hasText: '已匯入' }).waitFor();
    await p.locator('#dictAddRaw').fill('  癲癇  ');
    await p.locator('#dictAddZh').fill(' 癲癇');
    await p.locator('#dictAddEn').fill('Epilepsy ');
    await p.locator('#btnDictAdd').click();
    const dict = await p.evaluate(() => JSON.parse(JSON.stringify((window as any).__t.evalIn('medicalDict'))));
    expect(dict).toEqual([
      { raw: '甲狀腺亢進', zh: '甲狀腺亢進', en: 'Hyperthyroidism' },
      { raw: '癲癇', zh: '癲癇', en: 'Epilepsy' },
    ]);
  });

  for (const fmt of ['json', 'csv', 'tsv']) {
    test(`TR-04 匯出 ${fmt.toUpperCase()} 再匯入：詞典與原本完全相同（不得多出「標題列」詞條）`, async ({ browser }) => {
      const ctx = await newCtx(browser);
      const p = await openWithHook(ctx, ['DEFAULT_MEDICAL_DICT'], 'new');
      await p.locator('#postPanelHeader').click();
      await setToggles(p, ['tog_medical'], []);
      await p.locator('#dictFormatSelect').selectOption(fmt);
      const [dl] = await Promise.all([p.waitForEvent('download'), p.locator('#btnDictExport').click()]);
      const file = (await dl.path())!;
      await p.locator('#dictImportFile').setInputFiles({ name: dl.suggestedFilename(), mimeType: 'application/octet-stream', buffer: (await import('fs')).readFileSync(file) });
      await p.locator('#logBox', { hasText: '已匯入' }).waitFor();
      const r = await p.evaluate(() => {
        const T = (window as any).__t;
        return { now: JSON.parse(JSON.stringify(T.evalIn('medicalDict'))), def: JSON.parse(JSON.stringify(T.DEFAULT_MEDICAL_DICT)) };
      });
      expect(r.now.length).toBe(r.def.length);
      expect(r.now).toEqual(r.def);
    });
  }
});

test.describe('r5 審查：建置與檢查指令用同一份檢查清單', () => {
  test('TR-05 index.html 違反單一來源守門（多一個 MessageChannel）→ npm run build 必須中止且不產生 dist', async () => {
    const fs = await import('fs'), os = await import('os'), path = await import('path');
    const { spawnSync } = await import('child_process');
    const root = path.join(__dirname, '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-build-'));
    try {
      for (const f of ['index.html', 'sw.js', 'manifest.json']) fs.copyFileSync(path.join(root, f), path.join(tmp, f));
      fs.cpSync(path.join(root, 'icons'), path.join(tmp, 'icons'), { recursive: true });
      fs.cpSync(path.join(root, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
      const html = fs.readFileSync(path.join(tmp, 'index.html'), 'utf8');
      // 在第一段 <script> 內多放一個 MessageChannel 呼叫：npm run check 會擋（TX-01 的規則），build 以前不會
      const bad = html.replace('<script>', '<script>\nconst __probe = () => new MessageChannel();\n');
      expect(bad).not.toBe(html);
      fs.writeFileSync(path.join(tmp, 'index.html'), bad, 'utf8');
      const chk = spawnSync(process.execPath, ['scripts/check-consistency.mjs'], { cwd: tmp, encoding: 'utf8' });
      expect(chk.status, chk.stdout + chk.stderr).not.toBe(0);                 // 對照：check 指令本來就會擋
      const b = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: tmp, encoding: 'utf8' });
      expect(b.status, b.stdout + b.stderr).not.toBe(0);
      expect(fs.existsSync(path.join(tmp, 'dist', 'index.html'))).toBe(false);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

test.describe('r5 審查：動態載入腳本只有一份實作', () => {
  test('TR-06 同時兩次 loadOpenCC → 只發出 1 次腳本請求；失敗後重試可成功', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await openWithHook(ctx, ['loadOpenCC'], 'new');
    let hits = 0, failFirst = false;
    await p.route('**/opencc-js@*/dist/umd/cn2t.js', async (route) => {
      hits++;
      if (failFirst) { failFirst = false; return route.abort(); }
      await new Promise((r) => setTimeout(r, 150));          // 讓兩次呼叫確實重疊
      return route.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' });
    });
    const both = await p.evaluate(async () => {
      const T = (window as any).__t;
      const r = await Promise.all([T.loadOpenCC(), T.loadOpenCC()]);
      return r[0] === r[1];
    });
    expect(both).toBe(true);
    expect(hits).toBe(1);

    // 失敗不可被快取：第一次失敗 → 丟出原本的錯誤訊息；第二次重試成功
    const p2 = await openWithHook(ctx, ['loadOpenCC'], 'new');
    hits = 0; failFirst = true;
    await p2.route('**/opencc-js@*/dist/umd/cn2t.js', async (route) => {
      hits++;
      if (failFirst) { failFirst = false; return route.abort(); }
      return route.fulfill({ contentType: 'application/javascript', body: 'window.OpenCC = { Converter: () => (t) => t };' });
    });
    const r2 = await p2.evaluate(async () => {
      const T = (window as any).__t;
      let first = '';
      try { await T.loadOpenCC(); } catch (e: any) { first = e.message; }
      const conv = await T.loadOpenCC();
      return { first, ok: typeof conv === 'function' };
    });
    expect(r2.first).toBe('OpenCC 載入失敗');
    expect(r2.ok).toBe(true);
    expect(hits).toBe(2);
  });
});

test.describe('r5 審查：IndexedDB 分片讀取失敗不得被靜默吞掉', () => {
  test.setTimeout(240_000);

  test('TR-07 大檔（IDB 分片路徑）辨識中暫存被清掉 → 失敗段落要記錄並計入跳過／連續失敗，不得悄悄少字幕', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const segs = await buildSegments(ctx, { segments: 3, linesPerSegment: 3, charsPerLine: 12, termRate: 0.2, seed: 3 });
    const page = await ctx.newPage();
    await installScriptedWorker(page, { segments: segs });
    await page.goto(BASE_URL);
    await setToggles(page, [], ['tog_vad', 'tog_diarization']);
    await page.locator('#fileInput').setInputFiles(ensureMedia(['mono16k-1h.wav'])[0]);   // > 50 MB → 分片存入 IndexedDB
    await page.locator('#startBtn').click();
    await page.waitForFunction(() => ((window as any).__workerLog || []).some((e: any) => e.type === 'RUN_CHUNK' && e.segIdx === 1), null, { timeout: 120_000 });
    // 模擬另一個分頁開啟本程式（頁面載入時會清空整個 shards 暫存）
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('whisper-audio-cache');
      req.onsuccess = () => {
        const db = req.result, tx = db.transaction('shards', 'readwrite');
        tx.objectStore('shards').clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    }));
    await page.locator('#logBox', { hasText: /已停止|完成|辨識失敗已跳過/ }).waitFor({ timeout: 200_000 }).catch(() => {});
    await page.waitForFunction(() => !(document.getElementById('startBtn') as HTMLButtonElement).disabled || document.querySelector('.batch-item.done, .batch-item.error'), null, { timeout: 200_000 });
    const log = (await page.locator('#logBox').textContent()) ?? '';
    expect(log).toContain('音訊分片讀取失敗');
    expect(log).toMatch(/連續 5 段辨識失敗/);
    await expect(page.locator('.batch-item.error')).toHaveCount(1);
  });
});

// ── 詞典：P4 高信心新增＋重複別稱＋精確→模糊串接 ─────────────────────────────────────────────
import fs from 'fs';
import path from 'path';
const DICT_NAMES = ['DEFAULT_MEDICAL_DICT', 'buildDictMap', 'applyMedicalDict', 'applyFuzzyMedicalDict'];
const BENIGN = fs.readFileSync(path.join(__dirname, 'fixtures', 'benign-zh.txt'), 'utf8').split('\n').filter(Boolean);

// handoff P4 A 組：只收「誤辨字串本身不會出現在一般文句」者（排除理由見 HANDOFF-whisper-srt-v24-r5.md）
const TARGETS: [string, string][] = [
  ['維生物會感染人體', '微生物 (Microorganism)'], ['這些維收物很小', '微生物 (Microorganism)'], ['素族的免疫反應', '宿主 (Host)'],
  ['表成感染很常見', '表淺感染 (Superficial Infection)'], ['表稱感染的症狀', '表淺感染 (Superficial Infection)'],
  ['往狀內皮系統', '網狀內皮系統 (Reticuloendothelial System)'], ['分口傳染途徑', '糞口傳染 (Fecal-oral Transmission)'],
  ['潛伏其很長', '潛伏期 (Incubation Period)'], ['潛伏器很長', '潛伏期 (Incubation Period)'],
  ['分子感菌很難殺', '分枝桿菌 (Mycobacterium)'], ['分支感菌的特性', '分枝桿菌 (Mycobacterium)'],
  ['民旗統的功能', '免疫系統 (Immune System)'], ['干燃了病原', '感染 (Infection)'],
  ['先天民意反應', '先天性免疫 (Innate Immunity)'], ['鮮天免疫很快', '先天性免疫 (Innate Immunity)'], ['非私隱性的免疫', '先天性免疫 (Innate Immunity)'],
  ['後天民意要時間', '後天性免疫 (Adaptive Immunity)'],
  ['費肺結核傳染', '肺結核 (Tuberculosis)'], ['廢肺結核病人', '肺結核 (Tuberculosis)'], ['大長感菌很常見', '大腸桿菌 (Escherichia coli)'],
];

test.describe('r5 詞典', () => {
  test.setTimeout(180_000);

  test('TR-08 P4 高信心誤辨：精確詞典與「精確＋模糊」都改正成「標準詞 (英文)」，且模糊比對不得再改動精確結果', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), DICT_NAMES, 'new');
    const r = await p.evaluate(async (targets) => {
      const T = (window as any).__t, dict = T.DEFAULT_MEDICAL_DICT, map = T.buildDictMap(dict);
      const mk = (t: string) => [{ index: 1, start: 0, end: 1, text: t }];
      const out: any[] = [];
      for (const [src, want] of targets) {
        const ex = (await T.applyMedicalDict(mk(src), map))[0].text as string;
        const both = (await T.applyFuzzyMedicalDict(mk(ex), dict, 0.75))[0].text as string;
        out.push({ src, want, ex, both });
      }
      return out;
    }, TARGETS);
    for (const o of r) {
      expect(o.ex, `${o.src} → ${o.ex}`).toContain(o.want);
      expect(o.both, `${o.src}: 精確 ${o.ex} → 模糊 ${o.both}`).toBe(o.ex);
    }
  });

  test('TR-09 精確標注的結果不得被模糊比對改壞：預設詞典每一筆的 zh 與每個別稱（含前後文）先精確、再模糊，輸出必須等於精確結果', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), DICT_NAMES, 'new');
    const bad = await p.evaluate(async () => {
      const T = (window as any).__t, dict = T.DEFAULT_MEDICAL_DICT, map = T.buildDictMap(dict);
      const lines: string[] = [];
      for (const e of dict) for (const v of [e.zh, ...e.raw.split('|').map((x: string) => x.trim()).filter(Boolean)]) lines.push(`我們來看${v}的特性`);
      const subs = lines.map((t, i) => ({ index: i + 1, start: i, end: i + 0.9, text: t }));
      const ex = await T.applyMedicalDict(subs, map);
      const both = await T.applyFuzzyMedicalDict(ex, dict, 0.75);
      const diffs: string[] = [];
      ex.forEach((s: any, i: number) => { if (s.text.includes(' (') && both[i].text !== s.text) diffs.push(`${s.text}  →  ${both[i].text}`); });
      return { n: lines.length, diffs };
    });
    expect(bad.diffs.slice(0, 10), `共 ${bad.diffs.length}/${bad.n} 句被改壞`).toEqual([]);
  });

  test('TR-10 預設詞典沒有重複別稱：同一個別稱只能屬於一筆（精確詞典「後者蓋前者」與模糊比對「前者優先」會各選不同條目）', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), DICT_NAMES, 'new');
    const dup = await p.evaluate(() => {
      const D = (window as any).__t.DEFAULT_MEDICAL_DICT, owner = new Map<string, string>(), dup: string[] = [];
      for (const e of D) for (const v of e.raw.split('|').map((x: string) => x.trim()).filter(Boolean)) {
        if (owner.has(v)) dup.push(`${v}：${owner.get(v)} / ${e.zh}`); else owner.set(v, e.zh);
      }
      return dup;
    });
    expect(dup).toEqual([]);
  });

  test('TR-11 新增詞條沒有附帶傷害：130 句一般語句（含刻意設計的碰撞句）在新舊詞典下的輸出逐字相同（精確、精確＋模糊各一輪）', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const run = async (which: 'old' | 'new') => {
      const p = await openWithHook(ctx, DICT_NAMES, which);
      return p.evaluate(async (lines) => {
        const T = (window as any).__t, dict = T.DEFAULT_MEDICAL_DICT, map = T.buildDictMap(dict);
        const subs = lines.map((t: string, i: number) => ({ index: i + 1, start: i, end: i + 0.9, text: t }));
        const ex = await T.applyMedicalDict(subs, map);
        const both = await T.applyFuzzyMedicalDict(ex, dict, 0.75);
        const fz = await T.applyFuzzyMedicalDict(subs, dict, 0.75);
        return { ex: ex.map((s: any) => s.text), both: both.map((s: any) => s.text), fz: fz.map((s: any) => s.text) };
      }, BENIGN);
    };
    const [a, b] = [await run('old'), await run('new')];
    expect(BENIGN.length).toBeGreaterThan(100);
    expect(b.ex).toEqual(a.ex);
    expect(b.fz).toEqual(a.fz);
    // 「精確＋模糊」：舊頁面有 v23.2 起的標注損壞（模糊比對改壞精確詞典寫好的英文標注），新頁面已修，所以不能要求逐字相同。
    // 容許的差異只有一種：舊頁面的結果被模糊比對改壞（a.both≠a.ex），而新頁面的結果等於精確結果（b.both＝b.ex）。其餘一律逐字相同。
    const diffs = BENIGN.map((_, i) => i).filter((i) => b.both[i] !== a.both[i]);
    const unexplained = diffs.filter((i) => !(a.both[i] !== a.ex[i] && b.both[i] === b.ex[i]));
    expect(unexplained.map((i) => ({ in: BENIGN[i], old: a.both[i], now: b.both[i] }))).toEqual([]);
  });
});

test.describe('r5 審查：主題樣式只有一份', () => {
  test('TR-12 開頁樣式＝window._themeStyles；按切換鈕換成另一份並記住；重新整理後維持', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const p = await ctx.newPage();
    await p.emulateMedia({ colorScheme: 'dark' });
    await p.goto(BASE_URL);
    const read = () => p.evaluate(() => ({ style: document.documentElement.getAttribute('style'), init: (window as any)._initTheme, styles: (window as any)._themeStyles }));
    const a = await read();
    expect(a.init).toBe('dark');
    expect(a.styles.dark).not.toBe(a.styles.light);
    expect(a.style).toBe(a.styles.dark);
    await p.click('#themeToggleBtn');
    const b = await read();
    expect(b.init).toBe('light');
    expect(b.style).toBe(b.styles.light);
    await p.reload();
    const c = await read();
    expect(c.init).toBe('light');
    expect(c.style).toBe(c.styles.light);
    await p.click('#themeToggleBtn');
    expect((await read()).style).toBe(c.styles.dark);
  });
});

test.describe('r5 審查：刪除死分支後行為不變', () => {
  test('TR-13 fixCasing：新舊頁面輸出逐字相同（含「前一句以句末標點結尾」的各種組合）', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const input = ['hello world', 'Hello.', 'next sentence', 'a?', 'b', '!', 'c', '中文開頭 english', 'english 中文', '', ' lead space', '3d model', 'x.', 'y.z', 'é accent', '😀 emoji'];
    const run = async (which: 'old' | 'new') => {
      const p = await openWithHook(ctx, ['fixCasing'], which);
      return p.evaluate((lines) => (window as any).__t.fixCasing(lines.map((text: string, i: number) => ({ index: i + 1, start: i, end: i + 0.9, text }))), input);
    };
    const [a, b] = [await run('old'), await run('new')];
    expect(b).toEqual(a);
    expect(b.map((x: any) => x.text).slice(0, 4)).toEqual(['Hello world', 'Hello.', 'Next sentence', 'A?']);
  });
});
