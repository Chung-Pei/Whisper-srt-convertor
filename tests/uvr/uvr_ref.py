"""MDX-Net（Kim_Vocal_2）分離流程的獨立參考實作（numpy）。
與 index.html 內的 JS 實作互不引用，用來交叉驗證（tests/round13-uvr.spec.ts）。
已用真實 Kim_Vocal_2.onnx 驗證：單獨語音 SI-SDR 40.8 dB；語音＋背景音樂（0 dB）分離後 24.6 dB。
規格：輸入／輸出 [batch, 4, 3072, 256]；n_fft=7680、hop=1024；聲道順序 [L_re, L_im, R_re, R_im]。
"""
import numpy as np

N_FFT = 7680
HOP = 1024
DIM_F = 3072
DIM_T = 256
N_BINS = N_FFT // 2 + 1
CHUNK = HOP * (DIM_T - 1)          # 261120
TRIM = N_FFT // 2                  # 3840
GEN = CHUNK - 2 * TRIM             # 253440
WINDOW = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float64)  # periodic Hann


def stft_chunk(x):
    """x: [2, CHUNK] -> [4, DIM_F, DIM_T]（同 torch.stft center=True、pad_mode=reflect）"""
    out = np.empty((4, DIM_F, DIM_T), np.float32)
    for ch in range(2):
        p = np.pad(x[ch].astype(np.float64), (N_FFT // 2, N_FFT // 2), mode='reflect')
        idx = np.arange(DIM_T)[:, None] * HOP + np.arange(N_FFT)[None, :]
        spec = np.fft.rfft(p[idx] * WINDOW, axis=1)          # [DIM_T, N_BINS]
        spec = spec.T[:DIM_F]                                 # [DIM_F, DIM_T]
        out[2 * ch] = spec.real
        out[2 * ch + 1] = spec.imag
    return out


def istft_chunk(spec):
    """spec: [4, DIM_F, DIM_T] -> [2, CHUNK]（同 torch.istft center=True；高頻補零）"""
    y = np.zeros((2, CHUNK), np.float64)
    env = np.zeros(N_FFT + HOP * (DIM_T - 1), np.float64)
    for t in range(DIM_T):
        env[t * HOP:t * HOP + N_FFT] += WINDOW ** 2
    for ch in range(2):
        full = np.zeros((N_BINS, DIM_T), np.complex128)
        full[:DIM_F] = spec[2 * ch] + 1j * spec[2 * ch + 1]
        frames = np.fft.irfft(full.T, n=N_FFT, axis=1) * WINDOW   # [DIM_T, N_FFT]
        buf = np.zeros(N_FFT + HOP * (DIM_T - 1), np.float64)
        for t in range(DIM_T):
            buf[t * HOP:t * HOP + N_FFT] += frames[t]
        buf = np.divide(buf, env, out=np.zeros_like(buf), where=env > 1e-11)
        y[ch] = buf[N_FFT // 2: N_FFT // 2 + CHUNK]
    return y.astype(np.float32)


def plan(n):
    """回傳補零後的混音長度與分塊數。"""
    k = n // GEN + 1
    return k


def separate(mix, run_model):
    """mix: [2, n] float32；run_model: [1,4,DIM_F,DIM_T] -> 同形。回傳 [2, n]。"""
    n = mix.shape[1]
    k = plan(n)
    mixture = np.zeros((2, k * GEN + 2 * TRIM), np.float32)
    mixture[:, TRIM:TRIM + n] = mix
    pieces = []
    for i in range(k):
        chunk = mixture[:, i * GEN:i * GEN + CHUNK]
        spec = stft_chunk(chunk)
        pred = run_model(spec[None])[0]
        wav = istft_chunk(pred)
        pieces.append(wav[:, TRIM:CHUNK - TRIM])
    return np.concatenate(pieces, axis=1)[:, :n]


def si_sdr(est, ref):
    est = est - est.mean()
    ref = ref - ref.mean()
    a = np.dot(est, ref) / (np.dot(ref, ref) + 1e-12)
    tgt = a * ref
    noise = est - tgt
    return 10 * np.log10((np.dot(tgt, tgt) + 1e-12) / (np.dot(noise, noise) + 1e-12))
