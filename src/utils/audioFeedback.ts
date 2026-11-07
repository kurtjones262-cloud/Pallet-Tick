/**
 * Audio & Haptic Feedback Engine for PalletTick
 * Uses browser Web Audio API synthesizer for zero-latency, high-volume industrial beeps
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

export const playAudio = {
  /**
   * Crisp, high-frequency ascending chime for a successful part scan match
   */
  success: (enabled = true) => {
    if (!enabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      const now = ctx.currentTime;

      // Two-tone rising chime (1200Hz -> 1800Hz)
      osc.frequency.setValueAtTime(1100, now);
      osc.frequency.exponentialRampToValueAtTime(1760, now + 0.08);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.15);
    } catch {
      // Audio autoplay policy fallback
    }
  },

  /**
   * Low double-pulse warning buzzer for duplicate scan
   */
  duplicate: (enabled = true) => {
    if (!enabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;

      // Beep 1
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(420, now);
      gain1.gain.setValueAtTime(0.25, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.1);

      // Beep 2
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(360, now + 0.12);
      gain2.gain.setValueAtTime(0.25, now + 0.12);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.24);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.12);
      osc2.stop(now + 0.24);
    } catch {}
  },

  /**
   * High-urgency alert tone for unexpected part (code not found on docket)
   */
  unexpected: (enabled = true) => {
    if (!enabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(280, now);
      osc.frequency.setValueAtTime(220, now + 0.1);

      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.28);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.28);
    } catch {}
  },

  /**
   * Subtle descending blip for undo action
   */
  undo: (enabled = true) => {
    if (!enabled) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;

      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(700, now);
      osc.frequency.exponentialRampToValueAtTime(350, now + 0.12);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.12);
    } catch {}
  },
};

export const triggerHaptic = (
  type: 'success' | 'duplicate' | 'unexpected' | 'undo',
  enabled = true
) => {
  if (!enabled || typeof navigator === 'undefined' || !navigator.vibrate) return;
  try {
    switch (type) {
      case 'success':
        navigator.vibrate([70]);
        break;
      case 'duplicate':
        navigator.vibrate([100, 50, 100]);
        break;
      case 'unexpected':
        navigator.vibrate([180, 80, 180]);
        break;
      case 'undo':
        navigator.vibrate([40]);
        break;
    }
  } catch {}
};

export const speakAlert = (text: string, enabled = false) => {
  if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.15;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  } catch {}
};
