// tests/round11-bugfix.spec.ts — T-B1：v23.2 既有 bug「守護標記內部的數字被數字詞條替換 → 輸出含 NUL 亂碼」
// 前提：P 系列（輸出逐字相同）已完成並提交；本檔在其後加入，並把 round11-freeze 的 TF-03c 改為 TB-02 的反向斷言。
import { test, expect } from '@playwright/test';
import { newCtx, openWithHook } from './harness';

const NAMES = ['applyMedicalDict', 'applyFuzzyMedicalDict', 'buildDictMap', 'DEFAULT_MEDICAL_DICT', 'BOPOMOFO_MAP'];
const vis = (s: string) => s.replace(/\x00/g, '<NUL>');

test.describe('T-B1：標記內部數字 bug', () => {
  test.setTimeout(240_000);

  test('TB-01 精確詞典：純數字詞條「1」＋同行 2 次以上替換 → 不得殘留 NUL，且每個詞都被正確標注', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), NAMES, 'new');
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      const dict = [{ raw: '高血壓', zh: '高血壓', en: 'HTN' }, { raw: '糖尿病', zh: '糖尿病', en: 'DM' }, { raw: '1', zh: '一', en: 'One' }];
      const run = async (text: string) => (await T.applyMedicalDict([{ index: 1, start: 0, end: 1, text }], T.buildDictMap(dict)))[0].text as string;
      return { a: await run('高血壓 糖尿病'), b: await run('高血壓 糖尿病 1') };
    });
    expect(vis(r.a)).toBe('高血壓 (HTN) 糖尿病 (DM)');            // v23.2：'高血壓 (HTN) <NUL>一 (One)<NUL>'（糖尿病消失）
    expect(vis(r.b)).toBe('高血壓 (HTN) 糖尿病 (DM) 一 (One)');   // v23.2：'高血壓 (HTN) <NUL>一 (One)<NUL> 一 (One)'
  });

  test('TB-02 模糊比對：一行 ≥ 11 次替換＋詞條「10」→ 12 次替換全部正確，不得殘留 NUL，且不得出現「10 (ten)」', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), NAMES, 'new');
    const out = await p.evaluate(async () => {
      const T = (window as any).__t, M: Map<string, string> = T.BOPOMOFO_MAP;
      const groups = new Map<string, string[]>();
      for (const [k, v] of M) { if (!groups.has(v)) groups.set(v, []); groups.get(v)!.push(k); }
      const pairs = [...groups.values()].filter((g) => g.length >= 2).slice(0, 40);
      const tails = ['的', '是', '在', '有', '很', '大', '小', '多', '少', '好', '壞', '快'];
      const used: string[] = [], dict: any[] = []; let text = '';
      for (let i = 0, j = 0; j < 12 && i < pairs.length; i++) {
        const [a1, a2] = pairs[i], x = tails[j];
        if (used.some((u) => u.includes(a1) || u.includes(a2))) continue;
        used.push(a1 + x); dict.push({ raw: a1 + x, zh: a1 + x, en: 'E' + 'abcdefghijkl'[j] }); text += a2 + x + '，'; j++;
      }
      dict.push({ raw: '10', zh: '10', en: 'ten' });
      return (await T.applyFuzzyMedicalDict([{ index: 1, start: 0, end: 1, text }], dict, 0.75))[0].text as string;
    });
    expect(out).not.toContain('\x00');
    expect(out).not.toContain('10 (ten)');
    expect((out.match(/\(E[a-l]\)/g) || []).length).toBe(12);
  });

  test('TB-04 夾在兩個標記之間的原文數字不得被當成標記（v23.2：「高血壓1糖尿病」→ 輸出 NUL 亂碼並丟失文字）', async ({ browser }) => {
    const p = await openWithHook(await newCtx(browser), NAMES, 'new');
    const r = await p.evaluate(async () => {
      const T = (window as any).__t;
      const dict = [{ raw: '高血壓', zh: '高血壓', en: 'HTN' }, { raw: '糖尿病', zh: '糖尿病', en: 'DM' }];
      const ex = async (t: string) => (await T.applyMedicalDict([{ index: 1, start: 0, end: 1, text: t }], T.buildDictMap(dict)))[0].text as string;
      const fz = async (t: string) => (await T.applyFuzzyMedicalDict([{ index: 1, start: 0, end: 1, text: t }], dict, 0.75))[0].text as string;
      return { e1: await ex('高血壓1糖尿病'), e10: await ex('高血壓10糖尿病'), f1: await fz('高血壓1糖尿病'), f0: await fz('高血壓0糖尿病') };
    });
    expect(vis(r.e1)).toBe('高血壓 (HTN)1糖尿病 (DM)');      // v23.2：'<NUL>0糖尿病 (DM)1<NUL>'
    expect(vis(r.e10)).toBe('高血壓 (HTN)10糖尿病 (DM)');
    expect(vis(r.f1)).toBe('高血壓1糖尿病');                  // v23.2：'<NUL>0糖尿病1<NUL>'；兩詞都是標準詞，應原樣保留
    expect(vis(r.f0)).toBe('高血壓0糖尿病');
  });

  test('TB-03 修正前後：輸入不含數字且舊版輸出未損壞的行必須逐字相同；任何行新版都不得含 NUL（4 詞典 × 5 門檻，兩個階段）', async ({ browser }) => {
    const ctx = await newCtx(browser);
    const oldP = await openWithHook(ctx, NAMES, 'old'), newP = await openWithHook(ctx, NAMES, 'new');
    const gen = ({ seed, n, dictName, th }: { seed: number; n: number; dictName: string; th: number }) => {
      const T = (window as any).__t, M: Map<string, string> = T.BOPOMOFO_MAP, D = T.DEFAULT_MEDICAL_DICT;
      let s = seed >>> 0; const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
      const pick = <X,>(a: X[]) => a[Math.floor(rnd() * a.length)];
      const cjk = [...M.keys()];
      const specials = ['A', 'p', '1', '2', '10', '19', '-', '。', ' ', '😀', '（', 'Ｏ', '|'];      // 不含 NUL：Whisper 輸出不會有 NUL
      const terms: string[] = D.flatMap((e: any) => [e.zh, ...e.raw.split('|').map((v: string) => v.trim()).filter(Boolean)]);
      const rs = () => { const k = 3 + Math.floor(rnd() * 50); let x = ''; for (let i = 0; i < k; i++) { const r = rnd(); x += r < 0.35 ? pick(cjk) : r < 0.5 ? pick(specials) : pick(terms); } return x; };
      const digitDict = [{ raw: '1', zh: '一', en: 'One' }, { raw: '10', zh: '十', en: 'Ten' }, { raw: '19', zh: '十九', en: 'Nineteen' }, { raw: '0', zh: '零', en: 'Zero' }];
      const dicts: Record<string, any[]> = { builtin: D, builtinDigits: [...D, ...digitDict], digitsOnly: digitDict, edge: [...D, { raw: 'COVID-19|新冠', zh: 'COVID-19', en: 'C' }, { raw: '2型糖尿病', zh: '2型糖尿病', en: 'T2DM' }] };
      const subs = Array.from({ length: n }, (_, i) => ({ index: i + 1, start: i, end: i + 1, text: rs() }));
      return (async () => ({
        input: subs.map((x: any) => x.text),
        exact: (await T.applyMedicalDict(subs, T.buildDictMap(dicts[dictName]))).map((x: any) => x.text),
        fuzzy: (await T.applyFuzzyMedicalDict(subs, dicts[dictName], th)).map((x: any) => x.text),
      }))();
    };
    let lines = 0, corruptedOld = 0, equalClean = 0;
    for (const dictName of ['builtin', 'builtinDigits', 'digitsOnly', 'edge']) {
      for (const th of [0.5, 0.65, 0.75, 0.9, 1.0]) {
        const arg = { seed: 777 + lines, n: dictName === 'builtin' || dictName === 'edge' ? 12 : 25, dictName, th };
        const a = await oldP.evaluate(gen, arg), b = await newP.evaluate(gen, arg);
        for (const stage of ['exact', 'fuzzy'] as const) {
          a[stage].forEach((oldText: string, i: number) => {
            lines++;
            const newText = b[stage][i];
            expect(newText, `${stage} ${dictName} th=${th} line ${i}`).not.toContain('\x00');
            if (oldText.includes('\x00')) corruptedOld++;
            // 輸入含阿拉伯數字時，舊版即使沒有殘留 NUL 也可能已被誤改（夾在兩個標記之間的原文數字被當成標記，見 TB-04），不能當 oracle
            else if (!/[0-9]/.test(a.input[i])) { expect(newText, `${stage} ${dictName} th=${th} line ${i} input=${JSON.stringify(a.input[i])} old=${JSON.stringify(oldText)}`).toBe(oldText); equalClean++; }
          });
        }
      }
    }
    console.log(`TB-03 行數 ${lines}；舊版損壞 ${corruptedOld}；舊版未損壞且逐字相同 ${equalClean}`);
    expect(corruptedOld).toBeGreaterThan(0);          // 語料有鑑別力：確實重現了舊版的損壞
    expect(equalClean).toBeGreaterThan(100);
  });
});
