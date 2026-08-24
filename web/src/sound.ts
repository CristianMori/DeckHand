/** Two-note synthesized chime — no audio asset needed. */
let ctx: AudioContext | null = null;

export function soundEnabled(): boolean {
  return localStorage.getItem('hub-sound') !== 'off';
}

export function setSoundEnabled(on: boolean) {
  localStorage.setItem('hub-sound', on ? 'on' : 'off');
}

export function chime() {
  if (!soundEnabled()) return;
  ctx ??= new AudioContext();
  const t0 = ctx.currentTime;
  for (const [freq, at] of [
    [880, 0],
    [1174.66, 0.12],
  ] as const) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + 0.4);
  }
}
