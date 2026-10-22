"""產生 tests/fixtures/uvr-stft-ref.json：確定性訊號的 STFT 參考值（numpy）。
用法：python3 tests/uvr/gen-stft-ref.py
訊號公式必須與 tests/round13-uvr.spec.ts 的 sig() 完全一致。"""
import json, os
import numpy as np
import uvr_ref as R

FRAMES = [0, 1, 128, 255]
BINS = [0, 1, 2, 3, 10, 50, 76, 77, 78, 100, 200, 522, 523, 524, 1000, 1219, 1220, 1221, 2000, 3071]

def sig(n, rate=44100):
    j = np.arange(n, dtype=np.float64)
    L = 0.5 * np.sin(2 * np.pi * 440 * j / rate) + 0.25 * np.sin(2 * np.pi * 3000 * j / rate + 0.3)
    r = 0.4 * np.sin(2 * np.pi * 523.25 * j / rate) - 0.2 * np.sin(2 * np.pi * 7000 * j / rate)
    return L.astype(np.float32), r.astype(np.float32)

L, Rr = sig(R.CHUNK)
spec = R.stft_chunk(np.stack([L, Rr]))            # [4, DIM_F, DIM_T]
out = {"frames": FRAMES, "bins": BINS,
       "values": [[[float(spec[c, k, t]) for k in BINS] for c in range(4)] for t in FRAMES]}
here = os.path.dirname(os.path.abspath(__file__))
dest = os.path.join(here, '..', 'fixtures', 'uvr-stft-ref.json')
with open(dest, 'w') as f:
    json.dump(out, f)
print('wrote', os.path.normpath(dest), 'max |value|', float(np.abs(spec).max()))
