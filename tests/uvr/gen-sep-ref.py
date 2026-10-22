"""產生 tests/fixtures/uvr-sep-ref.json：分塊管線（模型＝輸出×0.5 的替身）的 numpy 參考輸出。
為什麼要有參考值而不只比「輸出＝0.5×輸入」：頻帶上限 17.6 kHz 使訊號首尾（階躍／折角）無法完全還原，
邊緣誤差約 0.03；只比內部會漏掉邊緣與分塊接縫的對位錯誤，與 numpy 逐點比對則全段都驗。
用法：python3 tests/uvr/gen-sep-ref.py　　訊號公式同 gen-stft-ref.py／spec 的 sig()。"""
import json, os
import numpy as np
import uvr_ref as R

def sig(n, rate=44100):
    j = np.arange(n, dtype=np.float64)
    L = 0.5 * np.sin(2 * np.pi * 440 * j / rate) + 0.25 * np.sin(2 * np.pi * 3000 * j / rate + 0.3)
    r = 0.4 * np.sin(2 * np.pi * 523.25 * j / rate) - 0.2 * np.sin(2 * np.pi * 7000 * j / rate)
    return L.astype(np.float32), r.astype(np.float32)

G = R.GEN
CASES = [
    (1, [0]),
    (100, list(range(0, 100, 7)) + [99]),
    (G + 1, [0, 1, 2, 50, 3000, 100000, G - 3, G - 2, G - 1, G]),
    (2 * G + 5, [0, 100, G - 2, G - 1, G, G + 1, 2 * G - 2, 2 * G - 1, 2 * G, 2 * G + 3, 2 * G + 4]),
]
out = {"gen": G, "cases": []}
for n, idx in CASES:
    L, Rr = sig(n)
    y = R.separate(np.stack([L, Rr]), lambda s: s * np.float32(0.5))
    out["cases"].append({"n": n, "idx": idx,
                         "left": [float(y[0, i]) for i in idx], "right": [float(y[1, i]) for i in idx]})
here = os.path.dirname(os.path.abspath(__file__))
dest = os.path.join(here, '..', 'fixtures', 'uvr-sep-ref.json')
with open(dest, 'w') as f:
    json.dump(out, f)
print('wrote', os.path.normpath(dest))
