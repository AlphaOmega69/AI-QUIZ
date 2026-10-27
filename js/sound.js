/**
 * ============================================================================
 * SOUND ENGINE — synthesized via Web Audio API
 * ============================================================================
 * The original playSound() pointed at assets/*.mp3 files that were never
 * actually included in this project, so no sound has ever really played.
 * Rather than ship binary audio (which we can't author here), every sound
 * is synthesized on the fly with oscillators — zero asset weight, works
 * everywhere, and is trivial to retune (just numbers below).
 */
let audioCtx = null;
function getAudioCtx() {
    if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
}

// A single tone with a short attack/decay envelope so it doesn't click.
function tone(freq, startTime, duration, type = 'sine', gainPeak = 0.14) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(gainPeak, startTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(startTime); osc.stop(startTime + duration + 0.02);
}

const SOUND_RECIPES = {
    'snd-click':   () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(720, t, 0.06, 'triangle', 0.08); },
    'snd-correct': () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(660, t, 0.14, 'sine', 0.12); tone(990, t + 0.07, 0.16, 'sine', 0.11); },
    'snd-wrong':   () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(220, t, 0.18, 'sawtooth', 0.09); tone(160, t + 0.09, 0.2, 'sawtooth', 0.08); },
    'snd-achievement': () => {
        const t = getAudioCtx()?.currentTime; if (t == null) return;
        [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, 0.22, 'sine', 0.13));
    },
    'snd-levelup': () => {
        const t = getAudioCtx()?.currentTime; if (t == null) return;
        [392, 523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, t + i * 0.075, 0.3, 'triangle', 0.13));
    },
    'snd-exp': () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(880, t, 0.08, 'sine', 0.09); },
    'snd-task': () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(587, t, 0.1, 'sine', 0.1); tone(880, t + 0.05, 0.14, 'sine', 0.1); },
    'snd-powerup-buy': () => {
        const t = getAudioCtx()?.currentTime; if (t == null) return;
        tone(440, t, 0.1, 'triangle', 0.1); tone(660, t + 0.06, 0.1, 'triangle', 0.1); tone(880, t + 0.12, 0.16, 'triangle', 0.11);
    },
    'snd-powerup-fifty': () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(1046, t, 0.08, 'square', 0.06); tone(784, t + 0.05, 0.1, 'square', 0.05); },
    'snd-powerup-time': () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(523, t, 0.09, 'sine', 0.1); tone(659, t + 0.05, 0.09, 'sine', 0.1); tone(784, t + 0.1, 0.12, 'sine', 0.1); },
    'snd-powerup-skip': () => { const t = getAudioCtx()?.currentTime; if (t == null) return; tone(300, t, 0.05, 'triangle', 0.08); tone(500, t + 0.04, 0.05, 'triangle', 0.08); tone(700, t + 0.08, 0.08, 'triangle', 0.08); },
    'snd-powerup-freeze': () => {
        const t = getAudioCtx()?.currentTime; if (t == null) return;
        tone(1200, t, 0.25, 'sine', 0.07); tone(1500, t + 0.03, 0.22, 'sine', 0.05);
    },
};

// Drop-in replacement for the old file-based playSound(id) — same call sites,
// same ids, now backed by synthesis instead of a missing mp3.
function playSound(id) {
    try {
        const recipe = SOUND_RECIPES[id];
        if (recipe) { recipe(); return; }
        // Unknown id — leave any other real <audio> elements (e.g. study-music-player) alone.
        const el = document.getElementById(id);
        if (el && el.tagName === 'AUDIO') { el.currentTime = 0; el.play().catch(() => {}); }
    } catch (e) { /* audio is a nice-to-have, never let it break the app */ }
}
window.playSound = playSound;

// Most browsers block AudioContext until a user gesture — prime it on first touch/click.
document.addEventListener('click', () => getAudioCtx(), { once: true });
document.addEventListener('touchstart', () => getAudioCtx(), { once: true });

/**
 * ============================================================================
 * AMBIENT BACKGROUND MUSIC — synthesized, replaces the old <audio id="bg-music">
 * ============================================================================
 * assets/background-loop.mp3 never existed in this project (same root cause as
 * the sound effects above), so the music toggle had nothing to actually play —
 * that's why it looked broken. This generates a real, soft ambient pad loop
 * with Web Audio instead: a slow four-note chord through a lowpass filter with
 * a gentle LFO sweep, so there's genuinely something audible to turn on/off.
 */
let ambientNodes = null;
let ambientOn = false;
const AMBIENT_TARGET_GAIN = 0.11;

function startAmbientMusic() {
    const ctx = getAudioCtx();
    if (!ctx || ambientNodes) { ambientOn = true; return; }

    const masterGain = ctx.createGain();
    masterGain.gain.value = 0.0001;
    masterGain.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.7;
    filter.connect(masterGain);

    // slow filter sweep for gentle movement, so the pad doesn't feel static
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.04;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 220;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    // soft minor-leaning pad chord (C3, Eb3, G3, C4), slightly detuned per voice for warmth
    const freqs = [130.81, 155.56, 196.00, 261.63];
    const oscs = freqs.map((f, i) => {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = f;
        o.detune.value = (i % 2 === 0) ? 5 : -5;
        const g = ctx.createGain();
        g.gain.value = 1 / freqs.length;
        o.connect(g); g.connect(filter);
        o.start();
        return { o, g };
    });

    masterGain.gain.linearRampToValueAtTime(AMBIENT_TARGET_GAIN, ctx.currentTime + 2.2);
    ambientNodes = { oscs, lfo, filter, masterGain };
    ambientOn = true;
}

function stopAmbientMusic() {
    ambientOn = false;
    if (!ambientNodes) return;
    const ctx = getAudioCtx();
    const { oscs, lfo, masterGain } = ambientNodes;
    const now = ctx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.linearRampToValueAtTime(0.0001, now + 0.6);
    const nodesToClean = ambientNodes;
    ambientNodes = null;
    setTimeout(() => {
        nodesToClean.oscs.forEach(({ o }) => { try { o.stop(); } catch (e) {} });
        try { nodesToClean.lfo.stop(); } catch (e) {}
    }, 700);
}

// 0–1 scale — used to duck the ambient pad while Senpai/question narration speaks
function setAmbientVolume(scale) {
    if (!ambientNodes) return;
    const ctx = getAudioCtx();
    ambientNodes.masterGain.gain.cancelScheduledValues(ctx.currentTime);
    ambientNodes.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, AMBIENT_TARGET_GAIN * scale), ctx.currentTime + 0.3);
}

window.startAmbientMusic = startAmbientMusic;
window.stopAmbientMusic = stopAmbientMusic;
window.setAmbientVolume = setAmbientVolume;
window.isAmbientMusicOn = () => ambientOn;
