// 合成訊號公式（生成器與測試共用，單一來源）：四個語音頻帶音調 × 0.7 Hz 緩慢調幅。真值為解析式。
export const TONES = [300, 1000, 2500, 3900];
export const AM_HZ = 0.7;
export const AMP = 0.18;
export function signalAt(t) {
  let v = 0;
  for (const f of TONES) v += AMP * Math.sin(2 * Math.PI * f * t);
  return v * (0.6 + 0.4 * Math.sin(2 * Math.PI * AM_HZ * t));
}
