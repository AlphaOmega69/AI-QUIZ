/**
 * ============================================================================
 * AI QUIZ PRO - HYBRID CORE SYSTEM (V2.0 - ADVANCED MULTIMODAL)
 * ============================================================================
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';

// --- HYBRID API KEYS ---
// SECURITY: keys are never hardcoded here. Each user supplies their own free key via
// Settings, stored only in this browser's localStorage. This is required both for
// safety (a key baked into shipped/public code gets stolen and abused within hours)
// and because it's the only way this app can be distributed (web, Android, or PC)
// without leaking a personal key to every installer.
/**
 * ============================================================================
 * API KEY STORAGE — obfuscated, NOT encrypted (read this before trusting it)
 * ============================================================================
 * This app has no server. Any key used to scramble these values has to live
 * in this same JS file, which means anyone who opens devtools and reads the
 * source can trivially reverse it in seconds. This stops your API key from
 * sitting in localStorage as plain, instantly-readable text — it does NOT
 * protect against a determined attacker with devtools access, and it is not
 * a substitute for real secrecy (which would require a server holding the
 * key instead of the browser — the same tradeoff explained for OAuth in
 * AUTH_SETUP.md). Treat this as "not shown at a glance", not "secure".
 */
const _OBF_KEY = 'aiquizpro-local-only-v1';
// Adaptive accent colour (topic colour, then right/wrong momentum during a quiz).
// The legacy neon values map onto the claymorphism palette through [data-accent] in
// style.css, so tints, shadows and the light theme all stay consistent. Anything
// unknown falls back to the default accent.
const _ACCENT_NAMES = { '#00f2ff': '', '#00ff88': 'green', '#ff0055': 'red', '#ff00ff': 'pink', '#007bff': 'blue', '#ffb700': 'amber' };
function setAccent(hex) {
    const name = _ACCENT_NAMES[String(hex || '').toLowerCase()] || '';
    const root = document.documentElement;
    if (name) root.setAttribute('data-accent', name); else root.removeAttribute('data-accent');
    root.style.removeProperty('--primary');
    root.style.removeProperty('--primary-rgb');
}
window.setAccent = setAccent;

const _KEY_MARK = 'enc1:';                       // versioned marker: stored value = "enc1:" + base64(xor(key))
const _KEY_CHARS = /^[A-Za-z0-9_\-.]{8,}$/;       // what real Gemini / Groq / RapidAPI keys look like

function _xorKey(str) {
    let out = '';
    for (let i = 0; i < str.length; i++) {
        out += String.fromCharCode(str.charCodeAt(i) ^ _OBF_KEY.charCodeAt(i % _OBF_KEY.length));
    }
    return out;
}
function obfuscateKey(str) {
    if (!str) return '';
    try { return _KEY_MARK + btoa(_xorKey(str)); } catch (e) { return ''; }
}
function deobfuscateKey(stored) {
    if (!stored) return '';
    try { return _xorKey(atob(stored)); } catch (e) { return ''; }
}

// Returns the usable key or '' — and never anything that isn't shaped like a real key.
// Storage formats seen over time:
//   1. "enc1:<base64>"   current, unambiguous
//   2. "<base64>"        earlier builds, no marker
//   3. "<plain text>"    the very first builds (and anything pasted straight into storage)
// Formats 2 and 3 can't be told apart by "does atob() succeed?" — a plain key made only of
// letters/digits IS valid base64 and used to be "decoded" into binary junk that then got
// pasted into the request URL (the "Unknown name ... Cannot bind query parameter" error).
// So a decode only counts if the result looks like a key; otherwise the raw value is used.
function readObfuscatedKey(storageId) {
    const raw = (localStorage.getItem(storageId) || '').trim();
    if (!raw) return '';
    if (raw.indexOf(_KEY_MARK) === 0) {
        const k = deobfuscateKey(raw.slice(_KEY_MARK.length)).trim();
        return _KEY_CHARS.test(k) ? k : '';
    }
    const decoded = deobfuscateKey(raw).trim();
    // A padded base64 string ("...==") can't be turned back into the exact original key (the last
    // character loses bits), so it is reported as unreadable rather than guessed at.
    const key = _KEY_CHARS.test(decoded) ? decoded : (_KEY_CHARS.test(raw) ? raw : '');
    if (key) localStorage.setItem(storageId, obfuscateKey(key));   // upgrade to the marked format
    return key;
}
function writeObfuscatedKey(storageId, value) {
    value = (value || '').trim();
    if (value) localStorage.setItem(storageId, obfuscateKey(value));
    else localStorage.removeItem(storageId);
}
// True when something is stored but it isn't a usable key (lets callers explain instead of sending junk).
function storedKeyIsCorrupt(storageId) {
    return !!localStorage.getItem(storageId) && !readObfuscatedKey(storageId);
}

function getGeminiKey() { return readObfuscatedKey('key_gemini'); }
function getGroqKey() { return readObfuscatedKey('key_groq'); }
function getRapidApiKey() { return readObfuscatedKey('key_rapidapi'); }

// --- GLOBAL STATE VARIABLES ---
let quizData = [];
let currentQ = 0;
let score = 0;
let topicName = "";
let multimodalData = { type: null, payload: null }; // Replaces pdfText & pdfBase64 to handle Audio/Image/PDF universally
let hintsLeft = 3;
let targetQCount = 10;
window.setTargetQCount = (n) => { targetQCount = n; };
let timeLeft = 30;
let timerTotalForBar = 30;
let timerInterval = null;
let currentDiff = "";
let userAnswers = [];
let hintUsedThisQuestion = false;
let questionShownAt = 0;
let currentAnswerStreak = 0;

// Other files (e.g. study.js's SM-2 "Due for Review" mode) need to load a
// pre-built quiz directly, bypassing AI generation. Since the variables above
// are `let`-scoped to this file, `window.quizData = ...` from elsewhere would
// silently create an unrelated global instead of actually updating them —
// this setter is the correct way to do it.
window.loadPrebuiltQuiz = function(data, topic, diff) {
    quizData = data;
    topicName = topic;
    currentDiff = diff || 'Review';
    multimodalData = { type: null, payload: null };
    currentQ = 0; score = 0; hintsLeft = 3; userAnswers = [];
    currentAnswerStreak = 0;
};
let recordedAudioBlob = null; // Stores the recording for download

/**
 * ============================================================================
 * QUIZ SESSION — pause / resume / discard / persist (used by the router in nav.js)
 * ============================================================================
 * The quiz lives in a full-screen overlay at the route #/quiz. Leaving that route
 * (browser Back, Android Back, another page) PAUSES the quiz: the countdown, the
 * auto-advance timer and any speech stop, but every answer, the score and the
 * current question stay exactly as they were. Returning to #/quiz (Forward, or the
 * "Resume" banner) restarts the clock from the time that was left.
 * Only an explicit action resets it: TERMINATE, HOME, DISCARD, or starting another
 * quiz after confirming. A snapshot in sessionStorage also lets an accidental
 * page reload pick the quiz back up.
 */
window.QuizSession = (function () {
    const SNAP_KEY = 'quiz_session_v1';
    let pausedAdvance = false;   // an answer was given and we were waiting to show the next question
    let loadingHidden = false;   // the "generating..." screen was hidden because the user navigated away
    const $ = id => document.getElementById(id);
    const shown = id => { const e = $(id); return !!e && getComputedStyle(e).display !== 'none'; };

    function phase() {
        if (shown('loading')) return 'loading';
        if (shown('quiz-content')) return 'play';
        if (shown('review-screen')) return 'review';
        if (shown('result-screen')) return 'result';
        if (shown('diff-menu')) return 'setup';
        return loadingHidden ? 'loading' : 'idle';
    }
    function inQuizRoute() { return !!(window.Router && Router.enabled && Router.current === 'quiz'); }
    function answered() { return Array.from(document.querySelectorAll('#options .option')).some(b => b.disabled); }

    function setBar(pct, animateSeconds) {
        const bar = $('timer-bar'); if (!bar) return;
        bar.style.transition = 'none';
        bar.style.width = pct + '%';
        if (animateSeconds != null) {
            void bar.offsetWidth;
            requestAnimationFrame(() => requestAnimationFrame(() => {
                bar.style.transition = `width ${animateSeconds}s linear`;
                bar.style.width = '0%';
            }));
        }
    }

    function pause() {
        const ph = phase();
        if (ph === 'loading' && shown('loading')) {
            // Don't leave a full-screen spinner covering the page the user just navigated to.
            $('loading').style.display = 'none';
            loadingHidden = true;
            return;
        }
        if (ph !== 'play') return;
        clearInterval(timerInterval);
        pausedAdvance = answered();
        clearTimeout(advanceTimer); advanceTimer = null;
        if (!pausedAdvance) {
            setBar(Math.max(0, Math.min(100, (timeLeft / timerTotalForBar) * 100)));
            $('timer-text').textContent = `TIME: ${timeLeft}s`;
        }
        if (window.speechSynthesis && window.speechSynthesis.cancel) window.speechSynthesis.cancel();
        try { if (voiceAnswerRecognition) voiceAnswerRecognition.abort(); } catch (e) {}
        const v = $('voice-listening-indicator'); if (v) v.style.display = 'none';
        saveSnapshot();
    }

    function resume() {
        if (loadingHidden) {
            loadingHidden = false;
            const nothingElse = !shown('quiz-content') && !shown('result-screen') && !shown('review-screen') && !shown('diff-menu');
            if (nothingElse) $('loading').style.display = 'flex';
        }
        if (phase() !== 'play') return;
        if (pausedAdvance || answered()) {
            pausedAdvance = false;
            clearTimeout(advanceTimer);
            advanceTimer = setTimeout(advanceToNextQuestion, 900);
        } else if (quizData.length && currentQ < quizData.length) {
            setBar(Math.max(0, Math.min(100, (timeLeft / timerTotalForBar) * 100)), timeLeft);
            $('timer-text').textContent = `TIME: ${timeLeft}s`;
            startTimerLoop();
        }
    }

    // Wipes the session (explicit user action only).
    function discard() {
        clearInterval(timerInterval); timerInterval = null;
        clearTimeout(advanceTimer); advanceTimer = null;
        pausedAdvance = false; loadingHidden = false;
        if (window.speechSynthesis && window.speechSynthesis.cancel) window.speechSynthesis.cancel();
        try { if (voiceAnswerRecognition) voiceAnswerRecognition.abort(); } catch (e) {}
        ['diff-menu', 'quiz-content', 'result-screen', 'review-screen'].forEach(id => { const e = $(id); if (e) e.style.display = 'none'; });
        const l = $('loading'); if (l) l.style.display = 'none';
        clearSnapshot();
        refreshBanner();
    }

    // Starting a new quiz while a paused one exists: ask before throwing it away.
    function confirmReplace() {
        if (phase() === 'play' && !inQuizRoute()) {
            if (!window.confirm('You have a quiz in progress. Discard it and start a new one?')) return false;
            discard();
        }
        return true;
    }

    function showPanel(name) {
        const map = { setup: 'diff-menu', play: 'quiz-content', result: 'result-screen', review: 'review-screen' };
        Object.keys(map).forEach(k => { const e = $(map[k]); if (e) e.style.display = (k === name) ? 'block' : 'none'; });
    }

    function refreshBanner() {
        const b = $('quiz-resume-banner'); if (!b) return;
        const ph = phase();
        const away = !inQuizRoute();
        const show = away && (ph === 'play' || ph === 'loading');
        b.style.display = show ? 'flex' : 'none';
        if (show) {
            const t = $('qrb-text');
            if (t) t.textContent = ph === 'loading'
                ? 'Your quiz is being generated…'
                : `Quiz in progress · ${topicName} · Q${Math.min(currentQ + 1, quizData.length)}/${quizData.length}`;
        }
    }

    /* ---- sessionStorage snapshot (survives an accidental reload) ---- */
    function saveSnapshot() {
        try {
            if (phase() !== 'play' || !quizData.length || (multimodalData && multimodalData.type === 'image_base64')) return;
            sessionStorage.setItem(SNAP_KEY, JSON.stringify({
                quizData, currentQ, score, topicName, hintsLeft, targetQCount, currentDiff, userAnswers, currentAnswerStreak
            }));
        } catch (e) { /* quota or privacy mode: skip */ }
    }
    function clearSnapshot() { try { sessionStorage.removeItem(SNAP_KEY); } catch (e) {} }
    function restore() {
        if (phase() !== 'idle') return;
        let snap = null;
        try { snap = JSON.parse(sessionStorage.getItem(SNAP_KEY) || 'null'); } catch (e) {}
        if (!snap || !Array.isArray(snap.quizData) || !snap.quizData.length || snap.currentQ >= snap.quizData.length) { clearSnapshot(); return; }
        quizData = snap.quizData; currentQ = snap.currentQ; score = snap.score; topicName = snap.topicName;
        hintsLeft = snap.hintsLeft; targetQCount = snap.targetQCount; currentDiff = snap.currentDiff;
        userAnswers = snap.userAnswers || []; currentAnswerStreak = snap.currentAnswerStreak || 0;
        multimodalData = { type: null, payload: null };
        $('gameplay-topic-name').textContent = String(topicName).toUpperCase();
        showPanel('play');
        if (window.renderPowerupQuizButtons) renderPowerupQuizButtons();
        showQ();            // not in the quiz route yet, so startTimer() leaves the clock paused
        refreshBanner();
    }

    return {
        phase, pause, resume, discard, confirmReplace, showPanel, refreshBanner, restore, saveSnapshot, clearSnapshot,
        canEnter: () => phase() !== 'idle',
        isInProgress: () => { const p = phase(); return p === 'play' || p === 'loading'; }
    };
})();

window.resumeQuizFromBanner = function () { if (window.playSound) playSound('snd-click'); enterQuizFocus(); };
window.discardQuizFromBanner = function () {
    if (!window.confirm('Discard your quiz in progress? Your answers so far will be lost.')) return;
    QuizSession.discard();
};


// [NEW FEATURE: API Prompt Versioning based on Rank]
const PROMPT_CONFIG = {
    "LEARNER": "Use straightforward language. Focus on fundamental, foundational concepts.",
    "ELITE": "Use technical and professional terminology. Include moderately complex distractors.",
    "SAGE": "Use advanced academic phrasing. Create highly plausible but incorrect distractors requiring deep understanding to differentiate.",
    "ELITE SAGE": "Master level difficulty. Test edge cases, obscure exceptions, and complex multi-step reasoning."
};

/**
 * ============================================================================
 * BACKGROUND PARTICLE NETWORK SYSTEM (Intact)
 * ============================================================================
 */
class NeuralNetworkParticleSystem {
    constructor() {
        this.canvas = document.getElementById('particle-network');
        if(!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.mouse = { x: null, y: null, radius: 150 };
        this.initCanvas();
        this.createParticles();
        this.animate();
        this.bindEvents();
    }
    initCanvas() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    }
    bindEvents() {
        window.addEventListener('resize', () => { this.initCanvas(); this.createParticles(); });
        window.addEventListener('mousemove', (e) => { this.mouse.x = e.x; this.mouse.y = e.y; });
        window.addEventListener('mouseout', () => { this.mouse.x = null; this.mouse.y = null; });
    }
    createParticles() {
        this.particles = [];
        let numberOfParticles = (this.canvas.width * this.canvas.height) / 15000;
        for (let i = 0; i < numberOfParticles; i++) {
            let size = (Math.random() * 2) + 1;
            let x = (Math.random() * ((innerWidth - size * 2) - (size * 2)) + size * 2);
            let y = (Math.random() * ((innerHeight - size * 2) - (size * 2)) + size * 2);
            let directionX = (Math.random() * 2) - 1;
            let directionY = (Math.random() * 2) - 1;
            this.particles.push(new Particle(this.canvas, this.ctx, x, y, directionX, directionY, size, '#00f2ff', this.mouse));
        }
    }
    animate() {
        requestAnimationFrame(() => this.animate());
        this.ctx.clearRect(0, 0, innerWidth, innerHeight);
        for (let i = 0; i < this.particles.length; i++) this.particles[i].update();
        this.connectParticles();
    }
    connectParticles() {
        let opacityValue = 1;
        for (let a = 0; a < this.particles.length; a++) {
            for (let b = a; b < this.particles.length; b++) {
                let distance = ((this.particles[a].x - this.particles[b].x) * (this.particles[a].x - this.particles[b].x)) + 
                               ((this.particles[a].y - this.particles[b].y) * (this.particles[a].y - this.particles[b].y));
                if (distance < (this.canvas.width / 10) * (this.canvas.height / 10)) {
                    opacityValue = 1 - (distance / 20000);
                    this.ctx.strokeStyle = 'rgba(0, 242, 255,' + opacityValue + ')';
                    this.ctx.lineWidth = 1;
                    this.ctx.beginPath();
                    this.ctx.moveTo(this.particles[a].x, this.particles[a].y);
                    this.ctx.lineTo(this.particles[b].x, this.particles[b].y);
                    this.ctx.stroke();
                }
            }
        }
    }
}

class Particle {
    constructor(canvas, ctx, x, y, directionX, directionY, size, color, mouseRef) {
        this.canvas = canvas; this.ctx = ctx; this.x = x; this.y = y;
        this.directionX = directionX; this.directionY = directionY;
        this.size = size; this.color = color; this.mouseRef = mouseRef;
    }
    draw() {
        this.ctx.beginPath(); this.ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2, false);
        this.ctx.fillStyle = this.color; this.ctx.fill();
    }
    update() {
        if (this.x > this.canvas.width || this.x < 0) this.directionX = -this.directionX;
        if (this.y > this.canvas.height || this.y < 0) this.directionY = -this.directionY;
        let dx = this.mouseRef.x - this.x; let dy = this.mouseRef.y - this.y;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < this.mouseRef.radius + this.size) {
            if (this.mouseRef.x < this.x && this.x < this.canvas.width - this.size * 10) this.x += 5;
            if (this.mouseRef.x > this.x && this.x > this.size * 10) this.x -= 5;
            if (this.mouseRef.y < this.y && this.y < this.canvas.height - this.size * 10) this.y += 5;
            if (this.mouseRef.y > this.y && this.y > this.size * 10) this.y -= 5;
        }
        this.x += this.directionX; this.y += this.directionY;
        this.draw();
    }
}

document.addEventListener("DOMContentLoaded", () => { new NeuralNetworkParticleSystem(); });

/**
 * ============================================================================
 * AUDIO AND MEDIA CONTROLLERS
 * ============================================================================
 */
// playSound(id) now lives in js/sound.js (synthesized — no audio files ever shipped with this project)

function toggleMusic() {
    const btn = document.getElementById('music-ctrl');
    if (!isAmbientMusicOn()) {
        startAmbientMusic();
        btn.textContent = "🔊 MUSIC: ON"; btn.style.color = "var(--primary)"; btn.style.borderColor = "var(--primary)";
    } else {
        stopAmbientMusic();
        btn.textContent = "🔇 MUSIC: OFF"; btn.style.color = "var(--danger)"; btn.style.borderColor = "var(--danger)";
    }
}

function readQuestionAloud() {
    if (!('speechSynthesis' in window)) return alert("Audio Synthesis not supported.");
    window.speechSynthesis.cancel();
    const questionText = document.getElementById('question').textContent;
    const msg = new SpeechSynthesisUtterance(questionText);
    msg.volume = 1; msg.rate = 0.95; msg.pitch = 0.8;
    
    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find(v => v.lang.includes('en') && v.name.includes('Google'));
    if (englishVoice) msg.voice = englishVoice;
    
    msg.onstart = () => { if (window.setAmbientVolume) setAmbientVolume(0.15); };
    msg.onend = () => {
        if (window.setAmbientVolume) setAmbientVolume(1);
        // In voice mode, start listening for a spoken answer right after the
        // question finishes being read aloud — the natural "your turn" cue.
        if (isVoiceModeOn() && document.getElementById('quiz-content').style.display !== 'none') {
            startVoiceAnswerListening();
        }
    };
    msg.onerror = () => { if (window.setAmbientVolume) setAmbientVolume(1); };
    
    window.speechSynthesis.speak(msg);
}

/**
 * ============================================================================
 * VOICE ASSISTANT — hands-free answer selection via Web Speech API
 * ============================================================================
 * Voice Mode auto-reads each question aloud (readQuestionAloud, above), then
 * listens for a spoken answer — "A"/"one", the option's own text, or any
 * close match — and selects it exactly as if it had been tapped.
 */
function isVoiceModeOn() {
    return localStorage.getItem('voice_mode') === '1';
}

window.toggleVoiceMode = function() {
    const on = !isVoiceModeOn();
    localStorage.setItem('voice_mode', on ? '1' : '0');
    const btn = document.getElementById('voice-mode-btn');
    if (btn) { btn.classList.toggle('active', on); btn.textContent = on ? '🎙️ VOICE: ON' : '🎙️ VOICE: OFF'; }
    if (typeof playSound === 'function') playSound('snd-click');
    if (on && document.getElementById('quiz-content').style.display !== 'none') {
        readQuestionAloud(); // read the current question immediately if a quiz is already in progress
    } else if (!on && voiceAnswerRecognition) {
        try { voiceAnswerRecognition.stop(); } catch (e) {}
    }
};

let voiceAnswerRecognition = null;
function getVoiceAnswerRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return null;
    if (!voiceAnswerRecognition) {
        voiceAnswerRecognition = new SR();
        voiceAnswerRecognition.continuous = false;
        voiceAnswerRecognition.interimResults = false;
        voiceAnswerRecognition.lang = 'en-US';
    }
    return voiceAnswerRecognition;
}

function matchSpokenAnswer(transcript, options) {
    const t = transcript.toLowerCase().trim();
    const letterWords = ['a', 'b', 'c', 'd'];
    const numberWords = ['one', 'two', 'three', 'four'];

    // direct letter or number match ("A", "option A", "1", "number one"...)
    for (let i = 0; i < options.length; i++) {
        if (t === letterWords[i] || t.endsWith(' ' + letterWords[i]) || t.includes(`option ${letterWords[i]}`)) return options[i];
        if (t === String(i + 1) || t === numberWords[i] || t.includes(numberWords[i])) return options[i];
    }
    // fuzzy text match against the option's own wording
    let best = null, bestScore = 0;
    options.forEach(opt => {
        const optLower = opt.toLowerCase();
        if (t === optLower) { best = opt; bestScore = 999; return; }
        if (optLower.includes(t) || t.includes(optLower)) {
            const score = Math.min(optLower.length, t.length);
            if (score > bestScore) { best = opt; bestScore = score; }
        }
    });
    return bestScore > 2 ? best : null;
}

function startVoiceAnswerListening() {
    const rec = getVoiceAnswerRecognition();
    const statusEl = document.getElementById('voice-listening-indicator');
    if (!rec) return;
    if (statusEl) statusEl.style.display = 'flex';

    rec.onresult = (e) => {
        const transcript = e.results[0][0].transcript;
        const buttons = Array.from(document.querySelectorAll('.option')).filter(b => !b.disabled);
        const options = buttons.map(b => b.dataset.value);
        const match = matchSpokenAnswer(transcript, options);
        if (statusEl) statusEl.style.display = 'none';
        if (match) {
            const btn = buttons.find(b => b.dataset.value === match);
            if (btn) btn.click();
        }
    };
    rec.onerror = () => { if (statusEl) statusEl.style.display = 'none'; };
    rec.onend = () => { if (statusEl) statusEl.style.display = 'none'; };
    try { rec.start(); } catch (e) { if (statusEl) statusEl.style.display = 'none'; }
}

/**
 * ============================================================================
 * NAVIGATION AND UI ROUTING LOGIC
 * ============================================================================
 */
 window.backToHome = () => {
    try {
        playSound('snd-click');
        if (window.speechSynthesis && window.speechSynthesis.cancel) window.speechSynthesis.cancel();
        if (window.setAmbientVolume) setAmbientVolume(1);
        
        multimodalData = { type: null, payload: null };
        targetQCount = 10;
        const statusEl = document.getElementById('custom-status');
        if (statusEl) statusEl.textContent = "No active data stream";
      
                const downloadBtn = document.getElementById('audio-download-btn');
        if (downloadBtn) downloadBtn.style.display = 'none';
        recordedAudioBlob = null;

        
        ['custom-topic', 'yt-url'].forEach(id => {
            const el = document.getElementById(id);
            if(el) el.value = "";
        });
        
        document.getElementById('loading').style.display = 'none';
        window.closeDrawers ? window.closeDrawers() : document.getElementById('profile-modal').classList.remove('open');
        const senpaiPanel = document.getElementById('senpai-panel');
        if (senpaiPanel) senpaiPanel.classList.remove('open');

        if (window.QuizSession) QuizSession.discard();   // explicit exit: this is the one place a quiz is wiped
        ['custom-topic', 'yt-url'].forEach(id => { if (window.Drafts) Drafts.save(id); });
        navigateTo('home', { silent: true }); // also leaves the quiz route and hides the overlay
        updateVideo('default.mp4');
        clearInterval(timerInterval);
        
        // [NEW FEATURE: Reset Adaptive Theme]
        setAccent('#00f2ff');
    } catch (error) {
        console.error("CRITICAL NAVIGATION ERROR:", error);
    }
};

window.backToHomeFromDiff = () => { window.backToHome(); };

window.forceQuit = () => {
    if(confirm("TERMINATE NEURAL LINK AND RETURN TO HOME?")) {
        if (window.speechSynthesis && window.speechSynthesis.cancel) window.speechSynthesis.cancel();
        clearInterval(timerInterval); window.backToHome();
    }
};

window.openCustomQuiz = () => {
    navigateTo('custom');
};

window.backToMainMenu = () => {
    navigateTo('home');
};

/**
 * ============================================================================
 * IDENTITY, PROFILE, & NOTE MANAGEMENT
 * ============================================================================
 */
function updateHomeNav() { 
    const savedName = localStorage.getItem('user_name') || 'GUEST_01';
    const savedPfp = localStorage.getItem('user_pfp');
    const navNameEl = document.getElementById('nav-name');
    const navPfpEl = document.getElementById('nav-pfp');
    if (navNameEl) navNameEl.textContent = savedName.toUpperCase();
    if (savedPfp && navPfpEl) navPfpEl.src = savedPfp;

    // The topbar profile chip (top-right, visible on every page) was never
    // actually wired to the saved identity — it was stuck showing the
    // hardcoded default avatar/name no matter what the user set.
    const topbarNameEl = document.getElementById('topbar-profile-name');
    const topbarPfpEl = document.getElementById('topbar-pfp');
    if (topbarNameEl) topbarNameEl.textContent = savedName.toUpperCase();
    if (savedPfp && topbarPfpEl) topbarPfpEl.src = savedPfp;
}

window.addEventListener('DOMContentLoaded', () => {
    const savedName = localStorage.getItem('user_name') || 'GUEST_01';
    const savedPfp = localStorage.getItem('user_pfp');
    document.getElementById('display-name').textContent = savedName;
    document.getElementById('user-name-input').value = savedName;
    if (savedPfp) document.getElementById('user-pfp').src = savedPfp;
    
    updateHomeNav(); updateStats(); renderLibrary();
    document.getElementById('notepad-area').value = localStorage.getItem('neural_notes') || '';

    if (window.onAppReady) { try { window.onAppReady(); } catch(e) { console.warn(e); } }
});

// UI only (no history side effects) — also what the router calls on Back/Forward.
function setProfileOpen(open) {
    const modal = document.getElementById('profile-modal');
    if (modal.classList.contains('open') === open) return;
    modal.classList.toggle('open', open);
    setDrawerBackdrop(open);
    if (open) {
        playSound('snd-click');
        updateStats();
        if (window.renderExpChips) renderExpChips();
        if (window.prefillApiKeyInputs) prefillApiKeyInputs();
    }
}

// The drawer is a history entry on top of the current screen: Back closes it.
function toggleProfile() {
    const modal = document.getElementById('profile-modal');
    const willOpen = !modal.classList.contains('open');
    setProfileOpen(willOpen);
    if (window.Router) { if (willOpen) Router.openOverlay('profile'); else Router.closeOverlay('profile'); }
}
if (window.Router) Router.registerOverlay('profile', { open: () => setProfileOpen(true), close: () => setProfileOpen(false) });

function setDrawerBackdrop(show) {
    const backdrop = document.getElementById('drawer-backdrop');
    if (!backdrop) return;
    if (show) {
        backdrop.classList.add('show');
        requestAnimationFrame(() => backdrop.classList.add('in'));
    } else {
        backdrop.classList.remove('in');
        setTimeout(() => backdrop.classList.remove('show'), 250);
    }
}

// Closes the profile drawer — used by the ✕ button, backdrop tap, Escape key, and swipe-to-close.
window.closeDrawers = function() {
    const profile = document.getElementById('profile-modal');
    const wasOpen = profile.classList.contains('open');
    profile.classList.remove('open');
    setDrawerBackdrop(false);
    if (wasOpen) { playSound('snd-click'); if (window.Router) Router.closeOverlay('profile'); }
};

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.closeDrawers();
});

// Quiz hotkeys — only active while the quiz-content screen is actually visible,
// and only when focus isn't in a text field (so typing a custom topic etc. isn't hijacked).
document.addEventListener('keydown', (e) => {
    const quizVisible = document.getElementById('quiz-content')?.style.display !== 'none';
    if (!quizVisible) return;
    // A paused quiz keeps its DOM while hidden — its hotkeys must not fire from another page.
    if (window.Router && Router.enabled && Router.current !== 'quiz') return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    const key = e.key.toLowerCase();
    const numberMap = { '1': 0, '2': 1, '3': 2, '4': 3 };
    const letterMap = { 'a': 0, 'b': 1, 'c': 2, 'd': 3 };
    const index = numberMap[key] !== undefined ? numberMap[key] : letterMap[key];

    if (index !== undefined) {
        const buttons = document.querySelectorAll('.option');
        const btn = buttons[index];
        if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    } else if (key === 'enter' || key === ' ') {
        // If an option is currently keyboard-focused, let the browser's native
        // Enter/Space-activates-a-focused-button behavior handle it (that's
        // "confirm the highlighted choice" for free). Otherwise, if we're in
        // the post-answer waiting period, fast-forward straight to the next question.
        const focusedIsOption = document.activeElement && document.activeElement.classList.contains('option');
        if (!focusedIsOption && advanceTimer) {
            e.preventDefault();
            advanceToNextQuestion();
        }
    }
});

// Swipe-to-close: the drawer slides in from the right, so a rightward swipe
// dismisses it — the same direction you'd naturally drag it away.
(function enableDrawerSwipeToClose() {
    let startX = null, startY = null;
    const el = document.getElementById('profile-modal');
    if (!el) return;
    el.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
    }, { passive: true });
    el.addEventListener('touchend', (e) => {
        if (startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        if (dx > 70 && Math.abs(dy) < 60) window.closeDrawers();
        startX = null; startY = null;
    }, { passive: true });
})();

function toggleEditMode() {
    playSound('snd-click');
    const display = document.getElementById('profile-display-area');
    const edit = document.getElementById('profile-edit-area');
    const gear = document.getElementById('edit-toggle');
    const isEditing = edit.style.display === 'block';
    display.style.display = isEditing ? 'block' : 'none';
    edit.style.display = isEditing ? 'none' : 'block';
    gear.style.color = isEditing ? 'var(--primary)' : 'var(--danger)';
    gear.textContent = isEditing ? '⚙️' : '✖';
}

function saveChanges() {
    const nameInput = document.getElementById('user-name-input').value.trim();
    if (nameInput) {
        localStorage.setItem('user_name', nameInput);
        document.getElementById('display-name').textContent = nameInput;
        // keep the unified login profile's name in sync (single identity, no drift)
        try {
            const profile = JSON.parse(localStorage.getItem('user_profile') || 'null');
            if (profile) { profile.name = nameInput; localStorage.setItem('user_profile', JSON.stringify(profile)); }
        } catch (e) {}
        if (window.applyProfileGreeting) applyProfileGreeting();
        updateHomeNav(); playSound('snd-correct');
    }
    toggleEditMode();
}

function updateProfilePic(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const base64Image = e.target.result;
        document.getElementById('user-pfp').src = base64Image;
        localStorage.setItem('user_pfp', base64Image);
        try {
            const profile = JSON.parse(localStorage.getItem('user_profile') || 'null');
            if (profile) { profile.avatar = base64Image; localStorage.setItem('user_profile', JSON.stringify(profile)); }
        } catch (e) {}
        updateHomeNav(); // keeps the sidebar AND topbar chip avatars in sync too
        playSound('snd-correct');
    };
    reader.readAsDataURL(file);
}

function switchTab(tabId, btn) {
    playSound('snd-click');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tabId).classList.add('active');
}

// [NEW FEATURE: Debounced Storage Writing for Performance]
let noteDebounceTimer;
function saveNotes(sourceId) {
    const id = sourceId || 'notepad-area';
    const el = document.getElementById(id);
    if (!el) return;
    const value = el.value;
    // mirror into the other notepad instance (profile modal <-> Study Hub) so both stay in sync
    ['notepad-area', 'study-notepad'].forEach(otherId => {
        if (otherId === id) return;
        const other = document.getElementById(otherId);
        if (other && other.value !== value) other.value = value;
    });
    clearTimeout(noteDebounceTimer);
    noteDebounceTimer = setTimeout(() => {
        localStorage.setItem('neural_notes', value);
    }, 600); // Wait 600ms after last keystroke before saving
}

/**
 * ============================================================================
 * LOCAL PDF LIBRARY STORAGE 
 * ============================================================================
 */
async function handleLibraryUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async function() {
        try {
            const typedarray = new Uint8Array(this.result);
            const pdf = await pdfjsLib.getDocument(typedarray).promise;
            let text = "";
            for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                text += content.items.map(item => item.str).join(" ") + " ";
            }
            let lib = JSON.parse(localStorage.getItem('neural_library') || '[]');
            lib.push({ name: file.name, content: text.substring(0, 10000) });
            localStorage.setItem('neural_library', JSON.stringify(lib));
            renderLibrary(); playSound('snd-correct');
        } catch(e) { alert("LIB COMPRESSION ERROR"); }
    };
    reader.readAsArrayBuffer(file);
}

function renderLibrary() {
    const container = document.getElementById('library-list');
    const lib = JSON.parse(localStorage.getItem('neural_library') || '[]');
    if (lib.length === 0) return container.innerHTML = '<div style="font-size:0.6rem; opacity:0.3; padding:10px;">ARCHIVE EMPTY</div>'; 
    
    container.innerHTML = lib.map((item, idx) => `
        <div class="lib-item">
            <div class="lib-name">${(window.esc ? esc(item.name.toUpperCase()) : item.name.toUpperCase())}</div>
            <div>
                <button class="ui-btn" style="padding:4px 8px; font-size:0.5rem;" onclick="launchFromLib(${idx})">LINK</button>
                <button class="ui-btn" style="padding:4px 8px; font-size:0.5rem; border-color:var(--danger); color:var(--danger);" onclick="deleteFromLib(${idx})">X</button>
            </div>
        </div>
    `).join('');
}

function launchFromLib(idx) {
    const lib = JSON.parse(localStorage.getItem('neural_library') || '[]');
    multimodalData = { type: "text", payload: lib[idx].content };
    topicName = lib[idx].name;
    document.getElementById('custom-status').textContent = "LINKED: " + lib[idx].name;
    toggleProfile(); selectTopic(topicName, true); 
}

function deleteFromLib(idx) {
    let lib = JSON.parse(localStorage.getItem('neural_library') || '[]');
    lib.splice(idx, 1);
    localStorage.setItem('neural_library', JSON.stringify(lib));
    renderLibrary();
}

/**
 * ============================================================================
 * PLAYER STATISTICS SYSTEM & EDUCATIONAL ANALYTICS
 * ============================================================================
 */
function updateStats() {
    const history = JSON.parse(localStorage.getItem('quiz_history') || '[]');
    let totalCorrect = 0; let totalPossible = 0;
    
    // [NEW FEATURE: Educational Weakness Mapping]
    let categoryScores = {};

    history.forEach(item => { 
        totalCorrect += item.score; 
        totalPossible += item.total; 
        
        // Track for weakness mapping
        if(!categoryScores[item.topic]) categoryScores[item.topic] = { c: 0, t: 0 };
        categoryScores[item.topic].c += item.score;
        categoryScores[item.topic].t += item.total;
    });
    
    const accuracy = totalPossible > 0 ? Math.round((totalCorrect / totalPossible) * 100) : 0;
    
    document.getElementById('stat-links').textContent = history.length;
    document.getElementById('stat-correct').textContent = totalCorrect;
    document.getElementById('stat-acc').textContent = accuracy + "%";
    
    let rank = "LEARNER";
    if (totalCorrect > 20) rank = "ELITE";
    if (totalCorrect > 100) rank = "SAGE";
    if (accuracy > 95 && history.length > 5) rank = "ELITE SAGE";
    
    document.getElementById('stat-rank').textContent = rank;
    document.getElementById('display-rank').textContent = rank;

    // Execute Weakness Analysis Update
    let weakestTopic = null;
    let lowestAcc = 100;
    for(const [topic, data] of Object.entries(categoryScores)) {
        if(data.t >= 5) { // Only analyze topics with enough data points
            let acc = (data.c / data.t) * 100;
            if(acc < lowestAcc) { lowestAcc = acc; weakestTopic = topic; }
        }
    }

    const weakEl = document.getElementById('stat-weakness');
    if(weakestTopic && lowestAcc < 70) {
        weakEl.textContent = `VULNERABILITY DETECTED: ${weakestTopic.toUpperCase()} (${Math.round(lowestAcc)}%)`;
    } else {
        weakEl.textContent = `SYSTEM STABLE: NO GLARING VULNERABILITIES`;
        weakEl.style.color = "var(--success)";
    }
}

/**
 * ============================================================================
 * MULTIMODAL MEDIA PROCESSING (AUDIO, IMAGE, VIDEO, TEXT)
 * ============================================================================
 */
// 1. YouTube Data
// NOTE ON WHY THIS BROKE: YouTube itself blocks direct browser (CORS) requests for
// captions/transcripts — there is no client-side-only way around that, it requires a
// backend proxy. The previous build depended on one specific RapidAPI transcript
// service (with a hardcoded, now-dead key) which YouTube/RapidAPI rate-limits and
// blocks aggressively, so it failed silently for most videos/keys.
// This version: (1) never ships a dead key, (2) tries the transcript API only if the
// user supplied their OWN RapidAPI key in Settings, (3) tries a second provider as a
// fallback, and (4) if both fail (or no key is set) it drops straight into the manual
// transcript box instead of a dead-end alert — that path always works.
async function analyzeYouTube() {
    const url = document.getElementById('yt-url').value;
    const regExp = /^.*(youtu\.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    const videoId = (match && match[2].length == 11) ? match[2] : null;
    if (!videoId) return alert("INVALID NEURAL LINK — paste a full YouTube watch/share URL.");

    playSound('snd-click');
    const rapidKey = getRapidApiKey();
    const statusEl = document.getElementById('custom-status');

    if (!rapidKey) {
        openYtManualFallback(videoId, "No transcript key configured — paste the transcript below to continue (see tip).");
        return;
    }

    document.getElementById('loading').style.display = 'flex';
    document.getElementById('loading-text').textContent = "INTERCEPTING VIDEO STREAM...";
    document.getElementById('loading-subtext').textContent = `ID: ${videoId}`;

    const providers = [
        {
            host: 'youtube-transcriptor.p.rapidapi.com',
            url: `https://youtube-transcriptor.p.rapidapi.com/transcript?video_id=${videoId}&lang=en`,
            parse: (data) => Array.isArray(data) ? data.map(i => i.text).join(' ')
                             : (data && data.transcript) ? data.transcript.map(i => i.text).join(' ')
                             : null
        },
        {
            host: 'youtube-transcript3.p.rapidapi.com',
            url: `https://youtube-transcript3.p.rapidapi.com/api/transcript?videoId=${videoId}`,
            parse: (data) => (data && Array.isArray(data.transcript)) ? data.transcript.map(i => i.text).join(' ') : null
        }
    ];

    for (const provider of providers) {
        try {
            const response = await fetch(provider.url, {
                method: 'GET',
                headers: {
                    'x-rapidapi-host': provider.host,
                    'x-rapidapi-key': rapidKey,
                    'Content-Type': 'application/json'
                }
            });
            if (!response.ok) throw new Error(`${provider.host} returned ${response.status}`);
            const data = await response.json();
            const combinedText = provider.parse(data);
            if (!combinedText || combinedText.length < 30) throw new Error("Empty transcript returned");

            multimodalData = { type: "text", payload: combinedText };
            topicName = "YT_" + videoId;
            statusEl.textContent = "VIDEO SYNC ACTIVE";
            document.getElementById('loading').style.display = 'none';
            selectTopic(topicName);
            return;
        } catch (e) {
            console.warn("YT provider failed:", provider.host, e.message);
        }
    }

    document.getElementById('loading').style.display = 'none';
    openYtManualFallback(videoId, "Both transcript providers were blocked or rate-limited for this video.");
}

function openYtManualFallback(videoId, reason) {
    const ytFallback = document.getElementById('yt-fallback');
    if (ytFallback) ytFallback.style.display = 'block';
    const statusEl = document.getElementById('custom-status');
    if (statusEl) statusEl.textContent = reason + " Open the video, copy its transcript (YouTube: ⋯ menu → Show transcript), and paste it below.";
    const manualBox = document.getElementById('manual-transcript');
    if (manualBox) manualBox.focus();
}


function processManualTranscript() {
    const text = document.getElementById('manual-transcript').value.trim();
    if (text.length < 50) return alert("DATA STREAM TOO WEAK (Paste more text)");
    multimodalData = { type: "text", payload: text };
    topicName = "MANUAL_VIDEO_DATA";
    document.getElementById('custom-status').textContent = "MANUAL DATA LINKED";
    selectTopic(topicName); playSound('snd-correct');
}

// 2. PDF Parsing via FileReader & PDF.js
async function handlePDFUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const name = file.name.toLowerCase();

    // .txt / .md are plain text — no parsing library needed, just read and go.
    if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.markdown')) {
        document.getElementById('custom-status').textContent = "READING DOCUMENT...";
        const reader = new FileReader();
        reader.onload = function() {
            const text = String(reader.result || '').trim();
            if (!text) { document.getElementById('custom-status').textContent = "FILE APPEARS EMPTY"; return; }
            multimodalData = { type: "text", payload: text.substring(0, 12000) };
            document.getElementById('custom-status').textContent = `ACTIVE: ${file.name.toUpperCase()}`;
        };
        reader.onerror = () => { document.getElementById('custom-status').textContent = "COULDN'T READ FILE"; };
        reader.readAsText(file);
        return;
    }

    document.getElementById('custom-status').textContent = "DECRYPTING PDF...";
    const reader = new FileReader();
    reader.onload = async function() {
        try {
            const typedarray = new Uint8Array(this.result);
            const pdf = await pdfjsLib.getDocument(typedarray).promise;
            let text = "";
            for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                text += content.items.map(item => item.str).join(" ") + " ";
            }
            
            let binary = '';
            const len = typedarray.byteLength;
            for (let i = 0; i < len; i++) binary += String.fromCharCode(typedarray[i]);
            
            // Using Vision API for PDF as per original logic structure
            multimodalData = { type: "pdf_base64", payload: { b64: btoa(binary), fallbackText: text.trim().substring(0, 10000) } };
            document.getElementById('custom-status').textContent = `ACTIVE: ${file.name.toUpperCase()}`;
        } catch(e) { document.getElementById('custom-status').textContent = "FATAL DECRYPTION ERROR"; }
    };
    reader.readAsArrayBuffer(file);
}

// [NEW FEATURE: 3. Visual Domain (Image Analysis)]
function handleImageAnalysisUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        const base64Str = e.target.result.split(',')[1]; 
        // NEW: Added fullSrc to payload for UI rendering
        multimodalData = { type: "image_base64", payload: { b64: base64Str, mime: file.type, fullSrc: e.target.result } };
        document.getElementById('custom-status').textContent = `VISUAL LINK ESTABLISHED: ${file.name.toUpperCase()}`;
        playSound('snd-correct');
    };
    reader.readAsDataURL(file);
}

// [NEW FEATURE: 4. Audio Processing via MediaRecorder API]
let mediaRecorder;
let audioChunks = [];
async function toggleAudioRecord() {
    const btn = document.getElementById('audio-record-btn');
    const downloadBtn = document.getElementById('audio-download-btn');
    
    if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        btn.textContent = "🎙️ RECORD LIVE";
        btn.classList.remove('recording-pulse');
        document.getElementById('custom-status').textContent = "AUDIO STREAM COMPILED. READY FOR LINK.";
        playSound('snd-correct');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream);
        audioChunks = [];
        
        // Reset state for new recording
        downloadBtn.style.display = 'none'; 
        recordedAudioBlob = null;
        
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = () => {
            recordedAudioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.onload = function() {
                multimodalData = { type: "audio_base64", payload: { b64: reader.result.split(',')[1], mime: 'audio/webm' } };
            };
            reader.readAsDataURL(recordedAudioBlob);
            stream.getTracks().forEach(track => track.stop()); // kill microphone
            
            // Reveal download button once processing is complete
            downloadBtn.style.display = 'block'; 
        };
        
        mediaRecorder.start();
        btn.textContent = "🛑 STOP RECORDING";
        btn.classList.add('recording-pulse');
        document.getElementById('custom-status').textContent = "LIVE AUDIO INTERCEPTION ACTIVE...";
        playSound('snd-click');
    } catch (err) {
        alert("Microphone access denied or unavailable.");
    }
}

// [NEW FEATURE: Audio Upload]
function handleAudioUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    document.getElementById('custom-status').textContent = `AUDIO LINK ESTABLISHED: ${file.name.toUpperCase()}`;
    const reader = new FileReader();
    
    reader.onload = function(e) {
        const base64Str = e.target.result.split(',')[1];
        multimodalData = { type: "audio_base64", payload: { b64: base64Str, mime: file.type } };
        playSound('snd-correct');
    };
    reader.readAsDataURL(file);
}

// [NEW FEATURE: Audio Download]
function downloadRecording() {
    if (!recordedAudioBlob) return;
    playSound('snd-click');
    
    const url = URL.createObjectURL(recordedAudioBlob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `neural_audio_log_${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    
    // Cleanup to prevent memory leaks
    setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(a);
    }, 100);
}


/**
 * ============================================================================
 * PRE-GAME CONFIGURATION & ROUTING
 * ============================================================================
 */
document.getElementById('init-btn').addEventListener('click', () => {
    playSound('snd-click');
    if (window.startAmbientMusic) startAmbientMusic();
    document.getElementById('splash-screen').style.opacity = "0";
    setTimeout(() => {
        document.getElementById('splash-screen').style.display = "none";
        if (window.routeAfterSplash) { window.routeAfterSplash(); }
        else { window.enterMainApp && window.enterMainApp(); }
    }, 800);
});

function setQCount(num, btn) {
    playSound('snd-click'); targetQCount = num;
    document.querySelectorAll('.q-btn').forEach(b => { b.style.borderColor = 'rgba(255,255,255,0.1)'; b.classList.remove('selected'); });
    btn.style.borderColor = 'var(--primary)'; btn.classList.add('selected');
}

window.selectTopic = (topic, isFromLibrary = false) => {
    if (window.QuizSession && !QuizSession.confirmReplace()) return;
    playSound('snd-click');
    const custom = document.getElementById('custom-topic').value;
    topicName = topic || custom; 
    
    if (topic && !topic.includes("ARCHIVE") && !topic.includes("YT_") && !topic.includes("MANUAL_") && !isFromLibrary) {
        multimodalData = { type: null, payload: null };
        document.getElementById('custom-status').textContent = "No active data stream";
    }
    
    if (!topicName && !multimodalData.payload) return;
    if (!topicName && multimodalData.payload) topicName = `MULTIMODAL: ${multimodalData.type.toUpperCase()}`;
    
    const config = {
        'Video Games': { color: '#ff00ff', video: 'games.mp4' },
        'Science': { color: '#00ff88', video: 'science.mp4' },
        'Mathematics': { color: '#007bff', video: 'maths.mp4' },
        'General Knowledge': { color: '#ffb700', video: 'gk.mp4' }
    };
    
    const sel = config[topicName] || { color: '#00f2ff', video: 'default.mp4' };
    setAccent(sel.color);
    updateVideo(sel.video);
    
    if (window.QuizSession) QuizSession.showPanel('setup');
    enterQuizFocus();
    document.getElementById('diff-title').textContent = topicName.toUpperCase();

    // Mega quizzes are always exactly 100 questions — showing the normal
    // 5/10/20 picker here was misleading (it looked selectable even though
    // clicking it would silently override the 100-question setting).
    const isMegaQuiz = topicName.startsWith('MEGA QUIZ:');
    const qtyLabel = document.getElementById('qty-selector-label');
    const qtyGrid = document.getElementById('qty-selector-grid');
    const megaBadge = document.getElementById('mega-qty-badge');
    if (isMegaQuiz) {
        if (qtyLabel) qtyLabel.style.display = 'none';
        if (qtyGrid) qtyGrid.style.display = 'none';
        if (megaBadge) megaBadge.style.display = 'block';
        setTargetQCount(100);
    } else {
        if (qtyLabel) qtyLabel.style.display = 'block';
        if (qtyGrid) qtyGrid.style.display = 'grid';
        if (megaBadge) megaBadge.style.display = 'none';
        // reset to the default 10 + re-highlight it, so a leftover mega-quiz
        // override (or a previous manual pick) doesn't silently carry over
        setTargetQCount(10);
        document.querySelectorAll('.q-btn').forEach(b => { b.style.borderColor = 'rgba(255,255,255,0.1)'; b.classList.remove('selected'); });
        const defaultQBtn = document.getElementById('default-q');
        if (defaultQBtn) { defaultQBtn.style.borderColor = 'var(--primary)'; defaultQBtn.classList.add('selected'); }
    }

    const container = document.getElementById('diff-buttons');
    container.innerHTML = '';
    
    const lvls = multimodalData.payload ? ['Standard', 'Expert'] : ['Beginner', 'Expert'];
    lvls.forEach(lvl => {
        const b = document.createElement('button');
        b.className = 'btn'; b.textContent = lvl; 
        b.onclick = () => startQuiz(lvl);
        container.appendChild(b);
    });
};

function updateVideo(fileName) {
    const video = document.getElementById('bg-video');
    const source = video.querySelector('source');
    if(!video || !source) return; 
    video.style.opacity = "0.2";
    source.onerror = () => { video.style.display = 'none'; };
    video.onerror = () => { video.style.display = 'none'; };
    setTimeout(() => {
        source.src = `assets/${fileName}`; video.load(); 
        video.play().catch(e => console.log("Video play blocked or missing"));
        video.style.opacity = "0.6";
    }, 300);
} 

/**
 * ============================================================================
 * HYBRID INTELLIGENCE ROUTER (GEMINI + GROQ WITH FAILOVER LOGIC)
 * ============================================================================
 */
async function startQuiz(diff) {
    currentDiff = diff; currentQ = 0; score = 0; hintsLeft = 3; userAnswers = [];
    currentAnswerStreak = 0;
    if (window.renderPowerupQuizButtons) renderPowerupQuizButtons();
    
    document.getElementById('loading').style.display = 'flex';
    document.getElementById('gameplay-topic-name').textContent = topicName.toUpperCase();
    if (targetQCount >= 50) {
        document.getElementById('loading-subtext').textContent = `Generating ${targetQCount} questions — this can take up to a minute...`;
    }

    // Fetch Versioned Prompt based on current Rank
    const currentRank = document.getElementById('stat-rank').textContent;
    const rankPrompt = PROMPT_CONFIG[currentRank] || PROMPT_CONFIG["LEARNER"];

    // Base Prompt Construction
    let promptText = `Topic: ${topicName}. Difficulty: ${diff}. Personality: ${rankPrompt}. `;
    if (multimodalData.type === "text") {
        promptText += `CRITICAL: You MUST extract facts and generate questions EXCLUSIVELY from the provided Context text. Context: ${multimodalData.payload}. `;
    }
    if (targetQCount >= 50) {
        // Large batches (e.g. a multi-PDF mega quiz) need every field kept short,
        // or the response is liable to get cut off before the JSON closes.
        promptText += `Generate exactly ${targetQCount} MCQs, spreading them evenly across every topic section in the context above. Keep each "explanation" to one short sentence (under 15 words) to conserve output length. `;
    } else {
        promptText += `Generate ${targetQCount} MCQs. `;
    }
    promptText += `Return JSON strictly: {"questions": [{"question": "...", "correct_answer": "...", "incorrect_answers": ["...", "...", "..."], "explanation": "..."}]}`;
    
    // Determine Router Path
    let useGemini = false;
    if (topicName.startsWith("YT_") || topicName.startsWith("MANUAL_") || multimodalData.type !== null && multimodalData.type !== "text") {
        useGemini = true; // Multimodal needs Gemini Vision/Audio
    }

    try {
        let text = await executeAPIRequest(promptText, useGemini);
        const rawData = JSON.parse(text.match(/\{[\s\S]*\}/)[0]);
        quizData = rawData.questions.map(q => {
            // 1. Combine all answers into one array
            let rawOptions = [...q.incorrect_answers, q.correct_answer];
            
            // 2. Use a 'Set' to magically delete any duplicates
            let uniqueOptions = [...new Set(rawOptions)];
            
            // 3. Force the array to be exactly 4 items max, then shuffle
            let finalOptions = uniqueOptions.slice(0, 4).sort(() => Math.random() - 0.5);

            return {
                q: q.question, 
                a: q.correct_answer, 
                exp: q.explanation,
                o: finalOptions,
                crop_box: q.crop_box || [] 
            };
        });

        
        document.getElementById('loading').style.display = 'none';
        document.getElementById('diff-menu').style.display = 'none';
        document.getElementById('quiz-content').style.display = 'block';
        showQ();
        
    } catch(e) { 
        console.error(e);
        alert("SYNC ERROR: " + e.message); 
        document.getElementById('loading').style.display = 'none';
        backToHome(); 
    }
}

// [NEW FEATURE: Resilient API Fallback Wrapper]
async function executeAPIRequest(promptText, forceGemini) {
    const groqKey = getGroqKey();
    const geminiKey = getGeminiKey();

    if (!forceGemini && groqKey) {
        try {
            document.getElementById('loading-text').textContent = "SYNCING NEURAL NETWORK...";
            document.getElementById('loading-subtext').textContent = "Targeting Groq Llama-3...";
            
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${groqKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "user", content: promptText }],
                    response_format: { type: "json_object" }
                })
            });
            if (!response.ok) throw new Error("Groq Limit Reached");
            const result = await response.json();
            return result.choices[0].message.content;
            
        } catch (err) {
            console.warn("Groq failed, failing over to Gemini:", err);
            // Fallthrough to Gemini intentionally
        }
    }

    if (!geminiKey && storedKeyIsCorrupt('key_gemini')) {
        throw new Error("YOUR SAVED GEMINI KEY LOOKS CORRUPTED. Open ⚙️ SETTINGS and paste it again.");
    }
    if (!geminiKey) {
        throw new Error("NO API KEY CONFIGURED. Open ⚙️ SETTINGS and add a free Gemini API key from aistudio.google.com/apikey.");
    }

    // Gemini Execution Block
    document.getElementById('loading-text').textContent = "REROUTING MULTIMODAL NETWORK...";
    document.getElementById('loading-subtext').textContent = "Targeting Gemini 2.5 Flash...";
    
    let geminiPayload = {
        contents: [{ parts: [] }],
        generationConfig: { response_mime_type: "application/json" }
    };
    
    // Inject Multimodal Data
    if (multimodalData.type === "pdf_base64") {
        geminiPayload.contents[0].parts.push({ inlineData: { mimeType: "application/pdf", data: multimodalData.payload.b64 }});
        geminiPayload.contents[0].parts.push({ text: `Analyze the document visually. Generate ${targetQCount} MCQs based EXCLUSIVELY on it. Return JSON strictly: {"questions": [{"question": "...", "correct_answer": "...", "incorrect_answers": ["...", "...", "..."], "explanation": "..."}]}` });
    } else if (multimodalData.type === "image_base64") {
        geminiPayload.contents[0].parts.push({ inlineData: { mimeType: multimodalData.payload.mime, data: multimodalData.payload.b64 }});
        geminiPayload.contents[0].parts.push({ text: `Analyze the attached image. 
        
        INSTRUCTIONS:
        1. Determine the image type. 
        2. IF it is a grid of distinct items (like a logo sheet): You MUST select individual items. Provide the spatial bounding box coordinates for that specific item in the format [ymin, xmin, ymax, xmax] scaled from 0 to 1000. Ask a direct question about it (e.g., "Identify this brand"). DO NOT ask positional questions anymore, as the image will be cropped for the user.
        3. IF it is a document, worksheet, or text-heavy image: Extract the factual knowledge and generate standard trivia. Provide an empty array [] for crop_box.
        
        Generate ${targetQCount} MCQs. Return JSON strictly matching this format: {"questions": [{"question": "...", "correct_answer": "...", "incorrect_answers": ["...", "...", "..."], "explanation": "...", "crop_box": [ymin, xmin, ymax, xmax]}]}` });
    }
 else if (multimodalData.type === "audio_base64") {
        geminiPayload.contents[0].parts.push({ inlineData: { mimeType: multimodalData.payload.mime, data: multimodalData.payload.b64 }});
        geminiPayload.contents[0].parts.push({ text: `Transcribe and analyze this audio. Generate ${targetQCount} MCQs based EXCLUSIVELY on it. Return JSON strictly: {"questions": [{"question": "...", "correct_answer": "...", "incorrect_answers": ["...", "...", "..."], "explanation": "..."}]}` });
    } else {
        geminiPayload.contents[0].parts.push({ text: promptText });
    }

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(geminiKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(geminiPayload)
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || "Both APIs Refused Connection");
    }

    const result = await response.json();
    let text = result.candidates[0].content.parts[0].text;
    if (text.startsWith("```json")) text = text.substring(7, text.length - 3).trim();
    else if (text.startsWith("```")) text = text.substring(3, text.length - 3).trim();
    return text;
}

  /**
 * ============================================================================
 * GAMEPLAY LOOP & LOGIC
 * ============================================================================
 */
function showQ() {
    if(currentQ >= quizData.length) return end();
    hintUsedThisQuestion = false;
    questionShownAt = Date.now();
    const voiceBtn = document.getElementById('voice-mode-btn');
    const tutorBtn = document.getElementById('ai-tutor-btn');
    if (tutorBtn) tutorBtn.style.display = 'none';
    if (voiceBtn) {
        const on = isVoiceModeOn();
        voiceBtn.classList.toggle('active', on);
        voiceBtn.textContent = on ? '🎙️ VOICE: ON' : '🎙️ VOICE: OFF';
    }
    
    const q = quizData[currentQ]; // Moved up to access coordinates
    
    const imgContainer = document.getElementById('quiz-image-container');
    const imgPreview = document.getElementById('quiz-image-preview');
    
    if (multimodalData && multimodalData.type === "image_base64") {
        imgContainer.style.display = "block";
        
        // AUTO-CROP LOGIC: Check if AI provided coordinates [ymin, xmin, ymax, xmax]
        if (q.crop_box && q.crop_box.length === 4 && q.crop_box[2] > 0) {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                
                // Convert AI's 0-1000 scale to actual image pixels
                const ymin = (q.crop_box[0] / 1000) * img.height;
                const xmin = (q.crop_box[1] / 1000) * img.width;
                const ymax = (q.crop_box[2] / 1000) * img.height;
                const xmax = (q.crop_box[3] / 1000) * img.width;
                
                const w = xmax - xmin;
                const h = ymax - ymin;
                
                // Add 15px padding so it doesn't crop too tightly
                const pad = 15;
                const sx = Math.max(0, xmin - pad);
                const sy = Math.max(0, ymin - pad);
                const sw = Math.min(img.width - sx, w + pad*2);
                const sh = Math.min(img.height - sy, h + pad*2);
                
                canvas.width = sw;
                canvas.height = sh;
                ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
                
                // Show ONLY the cropped logo
                imgPreview.src = canvas.toDataURL('image/png');
            };
            img.src = multimodalData.payload.fullSrc;
        } else {
            // HIDE IMAGE: If it's a text document, hide the cheat sheet!
            imgContainer.style.display = "none";
            imgPreview.src = "";
        }
    } else {
        imgContainer.style.display = "none";
        imgPreview.src = ""; 
    }

    document.getElementById('question').textContent = q.q;
    
    // Reset visual hints
    document.getElementById('ai-insight').style.opacity = "0";
    document.getElementById('ai-insight').style.background = "rgba(0,242,255,0.1)";
    document.getElementById('ai-insight').style.borderColor = "var(--primary)";
    document.getElementById('hint-display').textContent = "";
    
    const hintBtn = document.getElementById('hint-btn-el');
    hintBtn.textContent = `💡 HINT (${hintsLeft})`;
    hintBtn.disabled = (hintsLeft <= 0);
    
    const box = document.getElementById('options'); 
    box.innerHTML = '';
    
    q.o.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'option'; btn.textContent = opt;
        btn.dataset.value = opt;
        btn.onclick = () => { handleAnswer(opt, btn); };
        box.appendChild(btn);
    });

    const prog = document.getElementById('progress-fill');
    if(prog) prog.style.width = ((currentQ + 1) / quizData.length) * 100 + "%";
    
    startTimer();

    if (isVoiceModeOn() && (!window.Router || !Router.enabled || Router.current === 'quiz')) {
        setTimeout(readQuestionAloud, 400); // small delay lets the UI paint first
    }
    if (window.QuizSession) { QuizSession.saveSnapshot(); QuizSession.refreshBanner(); }
} 

// AI Tutor quick-action, triggered by the "Ask Senpai to Explain" button that
// appears after a wrong answer — opens the chat (if not already) and sends a
// question-specific prompt so the user doesn't have to type it out themselves.
function askSenpaiToExplain(question, correctAnswer, userAnswer) {
    const panel = document.getElementById('senpai-panel');
    if (!panel.classList.contains('open')) { window.toggleSenpai(); }
    const input = document.getElementById('senpai-input');
    input.value = `I got this wrong: "${question}" — I answered "${userAnswer || '(no answer)'}" but the correct answer is "${correctAnswer}". Can you explain why, simply?`;
    setTimeout(() => window.sendSenpaiMessage(), 300); // small delay lets the panel-open animation/focus settle first
}

function handleAnswer(selected, btn) {
    clearInterval(timerInterval);
    if (window.speechSynthesis && window.speechSynthesis.cancel) window.speechSynthesis.cancel();
    if (navigator.vibrate && selected) navigator.vibrate(15); // immediate tap feedback on the selection itself

    const q = quizData[currentQ];
    const all = document.querySelectorAll('.option');
    all.forEach(b => b.disabled = true);
    
    const insight = document.getElementById('ai-insight');
    insight.textContent = "INSIGHT: " + q.exp; 
    insight.style.opacity = "1";
    
    let isCorrect = (selected === q.a);

    // Spaced repetition: record this question's outcome regardless of whether
    // it came from a fresh AI quiz or a due-review replay, so the SRS bank
    // keeps growing/adjusting either way.
    if (window.recordSm2Review) {
        recordSm2Review(q, isCorrect, hintUsedThisQuestion, topicName);
    }

    userAnswers.push({
        question: q.q, selectedAnswer: selected || "NO DATA (TIME EXPIRED)",
        correctAnswer: q.a, explanation: q.exp, isCorrect: isCorrect,
        timeSpentSec: Math.round((Date.now() - questionShownAt) / 1000)
    });
    
    // [NEW FEATURE: Haptic Feedback]
    if(navigator.vibrate) navigator.vibrate(isCorrect ? 50 : [100, 50, 100]);

    if(isCorrect) { 
        score++; 
        currentAnswerStreak++;
        btn.classList.add('correct'); 
        insight.style.borderColor = "var(--success)";
        insight.style.background = "rgba(0, 255, 136, 0.1)";
        playSound('snd-correct');
        if (window.setSenpaiState) setSenpaiState('happy', 2200);
    } else { 
        if(btn) btn.classList.add('wrong'); 
        all.forEach(b => { if(b.dataset.value === q.a) { b.classList.add('correct'); b.textContent = q.a; b.style.opacity = '1'; } });
        insight.style.borderColor = "var(--danger)";
        insight.style.background = "rgba(255, 0, 85, 0.1)";
        playSound('snd-wrong');
        if (window.setSenpaiState) setSenpaiState('sad', 2200);

        // Streak Freeze auto-consumes on a wrong answer (if owned) to protect
        // the in-quiz answer streak instead of resetting it to zero.
        const frozeIt = (currentAnswerStreak > 0 && window.consumePowerup) ? consumePowerup('streak_freeze') : false;
        if (frozeIt) {
            playSound('snd-powerup-freeze');
            insight.textContent += "  🧊 Streak Freeze saved your streak!";
        } else {
            currentAnswerStreak = 0;
        }

        // Auto-feed the missed question into the Leitner flashcard deck (Box 1,
        // due tomorrow) so it resurfaces for review without needing a manual
        // "generate from weak spots" click every time.
        if (window.addFlashcard) addFlashcard(q.q, q.a, 'quiz');

        // AI Tutor quick-action: offer an instant, question-specific explanation via Senpai.
        const tutorBtn = document.getElementById('ai-tutor-btn');
        if (tutorBtn) {
            tutorBtn.style.display = 'inline-block';
            tutorBtn.onclick = () => askSenpaiToExplain(q.q, q.a, selected);
        }
    }

    // [NEW FEATURE: Adaptive Theme UI shifts based on performance trajectory]
    let accuracyRatio = score / (currentQ + 1);
    if(accuracyRatio >= 0.8) setAccent('#00ff88'); // Green
    else if(accuracyRatio <= 0.4) setAccent('#ff0055'); // Red
    else setAccent('#00f2ff'); // Blue

    // Modify progress bar dynamically based on answer
    const prog = document.getElementById('progress-fill');
    if(prog) prog.style.background = isCorrect ? "var(--success)" : "var(--danger)";
    
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(advanceToNextQuestion, 2800);
}

// Pulled out of handleAnswer() so the Enter/Space keyboard hotkey can trigger
// it immediately instead of waiting out the full delay.
let advanceTimer = null;
function advanceToNextQuestion() {
    clearTimeout(advanceTimer);
    if (document.getElementById('quiz-content').style.display !== 'none') {
        const prog = document.getElementById('progress-fill');
        if (prog) prog.style.background = "var(--primary)"; // reset bar color
        currentQ++; showQ();
    }
}

// Handles the 3 manually-triggered power-ups during a quiz (Streak Freeze is
// passive/automatic — see handleAnswer()). Each checks/consumes its own
// inventory charge via gamification.js's consumePowerup().
window.usePowerupInQuiz = function(id) {
    if (!window.consumePowerup) return;

    if (id === 'fifty_fifty') {
        const q = quizData[currentQ];
        const btns = Array.from(document.querySelectorAll('.option'));
        const wrongs = btns.filter(b => b.dataset.value !== q.a && b.style.opacity !== "0.2" && !b.disabled);
        if (wrongs.length < 2) { alert("Not enough visible wrong answers left to remove."); return; }
        if (!consumePowerup('fifty_fifty')) return;
        playSound('snd-powerup-fifty');
        const toHide = wrongs.sort(() => Math.random() - 0.5).slice(0, 2);
        toHide.forEach(b => { b.style.opacity = "0.2"; b.style.pointerEvents = "none"; b.textContent = "--- REMOVED ---"; });

    } else if (id === 'extra_time') {
        if (!timerInterval) { alert("Timer isn't running right now."); return; }
        if (!consumePowerup('extra_time')) return;
        playSound('snd-powerup-time');
        timeLeft += 15;
        timerTotalForBar += 15;
        const bar = document.getElementById('timer-bar');
        const pct = Math.max(0, Math.min(100, (timeLeft / timerTotalForBar) * 100));
        bar.style.transition = 'none';
        bar.style.width = pct + '%';
        requestAnimationFrame(() => {
            bar.style.transition = `width ${timeLeft}s linear`;
            bar.style.width = '0%';
        });
        document.getElementById('timer-text').textContent = `TIME: ${timeLeft}s`;

    } else if (id === 'skip') {
        if (!consumePowerup('skip')) return;
        playSound('snd-powerup-skip');
        clearInterval(timerInterval);
        // Advance without touching score or the answer streak — logged as a
        // neutral outcome so review/SRS/analytics still have a record of it.
        const q = quizData[currentQ];
        userAnswers.push({
            question: q.q, selectedAnswer: "(skipped with power-up)",
            correctAnswer: q.a, explanation: q.exp, isCorrect: null,
            timeSpentSec: Math.round((Date.now() - questionShownAt) / 1000)
        });
        currentQ++;
        showQ();
    }
};

window.getHint = () => {
    if(hintsLeft > 0) {
        playSound('snd-click');
        const q = quizData[currentQ];
        const btns = Array.from(document.querySelectorAll('.option'));
        const wrongs = btns.filter(b => b.dataset.value !== q.a && b.style.opacity !== "0.2");
        const pruneCount = Math.min(wrongs.length, Math.ceil(wrongs.length / 2));
        for(let i=0; i < pruneCount && wrongs.length > 0; i++) {
            const target = wrongs.splice(Math.floor(Math.random() * wrongs.length), 1)[0];
            if (!target) continue;
            target.style.opacity = "0.2"; target.style.pointerEvents = "none"; target.textContent = "--- REDACTED ---";
        }
        hintsLeft--;
        hintUsedThisQuestion = true;
        document.getElementById('hint-btn-el').textContent = `💡 HINT (${hintsLeft})`;
        document.getElementById('hint-btn-el').disabled = true;
    }
};

function startTimerLoop() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        timeLeft--;
        document.getElementById('timer-text').textContent = `TIME: ${timeLeft}s`;
        if (timeLeft <= 0) { clearInterval(timerInterval); handleAnswer('', null); }
    }, 1000);
}

function startTimer() {
    clearInterval(timerInterval); timeLeft = 30; timerTotalForBar = 30;
    const bar = document.getElementById('timer-bar');
    bar.style.transition = 'none'; bar.style.width = '100%';
    document.getElementById('timer-text').textContent = `TIME: ${timeLeft}s`;
    // The question was prepared while the user is on another page (e.g. generation finished
    // after they navigated away): keep the clock frozen; QuizSession.resume() starts it.
    if (window.Router && Router.enabled && Router.current !== 'quiz') return;
    setTimeout(() => { bar.style.transition = 'width 30s linear'; bar.style.width = '0%'; }, 50);
    startTimerLoop();
}

/**
 * ============================================================================
 * END GAME & DATA PERSISTENCE
 * ============================================================================
 */
function end() {
    clearInterval(timerInterval);
    if (window.QuizSession) { QuizSession.clearSnapshot(); }
    document.getElementById('quiz-content').style.display = 'none';
    document.getElementById('result-screen').style.display = 'block';
    
    document.getElementById('score-text').textContent = `${score}/${quizData.length}`;
    generateReviewScreen();

    // Weak-area diagnostic: offer an immediate 3-question revision set built
    // from whatever was just missed (backfilled from the broader weak bank
    // if fewer than 3 were missed here). recordSm2Review() has already run
    // for every question by this point (called from handleAnswer per-answer).
    const missedThisQuiz = userAnswers.filter(a => a.isCorrect === false);
    const revisionBanner = document.getElementById('revision-set-banner');
    if (window.buildTargetedRevisionSet && revisionBanner) {
        const set = window.buildTargetedRevisionSet(missedThisQuiz, topicName);
        if (set && set.length >= 2) {
            window._pendingRevisionSet = set;
            revisionBanner.style.display = 'flex';
        } else {
            revisionBanner.style.display = 'none';
        }
    }

    const record = {
        topic: topicName, score: score, total: quizData.length,
        date: new Date().toLocaleDateString() + " " + new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}),
        isoDate: new Date().toISOString(),
        hintsUsed: 3 - hintsLeft,
        difficulty: currentDiff,
        questionBreakdown: userAnswers.map(a => ({
            q: a.question, selected: a.selectedAnswer, correct: a.correctAnswer,
            isCorrect: a.isCorrect, timeSpentSec: a.timeSpentSec
        }))
    };
    
    let history = JSON.parse(localStorage.getItem('quiz_history') || '[]');
    history.unshift(record);
    localStorage.setItem('quiz_history', JSON.stringify(history.slice(0, 200)));
    
    updateStats();

    // [NEW FEATURE HOOK] lets features.js evaluate achievements without coupling core logic to it
    if (window.onQuizEnd) {
        try { window.onQuizEnd({ record, score, total: quizData.length, hintsLeft, currentDiff, topicName }); }
        catch(e) { console.warn("onQuizEnd hook failed:", e); }
    }
}

// Exports the just-finished quiz's results as a formatted PDF: header stats
// plus a per-question breakdown (your answer vs correct, time spent).
window.exportQuizSummaryPdf = function() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("PDF export library didn't load — check your connection and try again.");
        return;
    }
    playSound('snd-click');

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    const pct = quizData.length > 0 ? Math.round((score / quizData.length) * 100) : 0;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.setTextColor(20, 20, 30);
    doc.text('AI Quiz Pro — Quiz Summary', margin, y); y += 26;

    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(90, 90, 100);
    doc.text(new Date().toLocaleString(), margin, y); y += 20;

    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(30, 30, 40);
    doc.text(`Topic: ${topicName}`, margin, y); y += 16;
    doc.text(`Score: ${score}/${quizData.length} (${pct}%)`, margin, y); y += 16;
    doc.text(`Difficulty: ${currentDiff}   Hints used: ${3 - hintsLeft}`, margin, y); y += 20;

    doc.setDrawColor(200, 200, 210); doc.line(margin, y, pageWidth - margin, y); y += 20;

    userAnswers.forEach((item, i) => {
        if (y > pageHeight - 90) { doc.addPage(); y = margin; }

        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(20, 20, 30);
        const qLines = doc.splitTextToSize(`${i + 1}. ${item.question}`, maxWidth);
        qLines.forEach(line => { doc.text(line, margin, y); y += 14; });

        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5);
        const skipped = item.isCorrect === null;
        if (skipped) {
            doc.setTextColor(160, 110, 0);
            doc.text(`Skipped with a power-up — correct answer: ${item.correctAnswer}`, margin + 12, y); y += 13;
        } else if (item.isCorrect) {
            doc.setTextColor(0, 130, 70);
            doc.text(`Correct: ${item.selectedAnswer}`, margin + 12, y); y += 13;
        } else {
            doc.setTextColor(180, 0, 50);
            doc.text(`Your answer: ${item.selectedAnswer}`, margin + 12, y); y += 13;
            doc.setTextColor(0, 130, 70);
            doc.text(`Correct answer: ${item.correctAnswer}`, margin + 12, y); y += 13;
        }
        if (typeof item.timeSpentSec === 'number') {
            doc.setTextColor(120, 120, 130);
            doc.text(`Time spent: ${item.timeSpentSec}s`, margin + 12, y); y += 13;
        }
        y += 8;
    });

    const safeTopicName = topicName.replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    doc.save(`quiz-summary-${safeTopicName}-${new Date().toISOString().slice(0, 10)}.pdf`);
};

function generateReviewScreen() {
    const list = document.getElementById('review-list');

    // Summary banner: timing insight across the whole session, plus a nudge
    // toward whatever ended up being this quiz's rough "weak spot" — for a
    // single-topic quiz that's just the topic itself; for a mega quiz (many
    // source PDFs combined) we don't track per-question sub-topic, so we
    // surface real per-question timing extremes instead rather than
    // fabricating a topic breakdown the data doesn't actually support.
    const timed = userAnswers.filter(a => typeof a.timeSpentSec === 'number');
    const avgTime = timed.length ? Math.round(timed.reduce((a, b) => a + b.timeSpentSec, 0) / timed.length) : 0;
    const slowest = timed.length ? timed.reduce((a, b) => (b.timeSpentSec > a.timeSpentSec ? b : a)) : null;
    const wrongCount = userAnswers.filter(a => a.isCorrect === false).length;

    let summaryHtml = `<div class="review-summary-banner">
        <div class="review-summary-item"><span class="val">${avgTime}s</span><span class="lbl">avg / question</span></div>
        <div class="review-summary-item"><span class="val">${wrongCount}</span><span class="lbl">missed</span></div>`;
    if (slowest) {
        const shortQ = slowest.question.length > 40 ? slowest.question.slice(0, 38) + '…' : slowest.question;
        const shortQSafe = window.esc ? esc(shortQ) : shortQ;
        summaryHtml += `<div class="review-summary-item wide"><span class="lbl">Took longest on:</span><span class="val small">"${shortQSafe}" (${slowest.timeSpentSec}s)</span></div>`;
    }
    summaryHtml += `</div>`;

    const cardsHtml = userAnswers.map((item, index) => {
        const skipped = item.isCorrect === null;
        const e = window.esc ? esc : (s) => s; // esc() lives in features.js; guard in case load order ever changes
        const _st = skipped ? 'var(--warning)' : (item.isCorrect ? 'var(--success)' : 'var(--danger)');
        const borderStatus = `border-color: ${_st}; --strip: ${_st};`;
        const answerStatus = skipped
            ? `<div class="review-a" style="color: var(--warning);">Skipped with a power-up</div>
               <div class="review-a">Correct Answer: ${e(item.correctAnswer)}</div>`
            : (item.isCorrect
                ? `<div class="review-a">Answer: ${e(item.selectedAnswer)}</div>`
                : `<div class="review-a" style="color: var(--danger);">Your Answer: ${e(item.selectedAnswer)}</div>
                   <div class="review-a">Correct Answer: ${e(item.correctAnswer)}</div>`);
        const timeBadge = typeof item.timeSpentSec === 'number' ? `<span class="review-time-badge">⏱ ${item.timeSpentSec}s</span>` : '';

        return `
        <div class="review-card" style="${borderStatus}">
            <div style="font-size: 0.6rem; opacity: 0.5; margin-bottom: 5px; display:flex; justify-content:space-between;">
                <span>QUERY 0${index + 1}</span>${timeBadge}
            </div>
            <div class="review-q">${e(item.question)}</div>
            ${answerStatus}
            <div class="review-exp">Insight: ${e(item.explanation)}</div>
        </div>
        `;
    }).join('');

    list.innerHTML = summaryHtml + cardsHtml;
}

window.showReview = () => {
    playSound('snd-click');
    document.getElementById('result-screen').style.display = 'none';
    document.getElementById('review-screen').style.display = 'block';
};

/**
 * ============================================================================
 * HISTORY LOGS & EXPORT
 * ============================================================================
 */
window.showHistory = () => {
    playSound('snd-click');
    navigateTo('history');
    
    const list = document.getElementById('history-list');
    const history = JSON.parse(localStorage.getItem('quiz_history') || '[]');
    
    if (history.length === 0) return list.innerHTML = `<div style="opacity: 0.5; margin: 40px 0;">NO DATA LOGS FOUND</div>`;
    
    list.innerHTML = history.map(item => `
        <div class="history-item">
            <div style="font-size: 0.6rem; opacity: 0.5; margin-bottom: 4px;">${item.date}</div>
            <div>SECTOR: <span>${item.topic.toUpperCase()}</span></div>
            <div>SCORE: <span>${item.score}/${item.total}</span></div>
        </div>
    `).join('');
};

window.clearHistory = () => {
    if(confirm("PERMANENTLY DELETE ALL NEURAL LOGS?")) {
        localStorage.removeItem('quiz_history'); showHistory(); updateStats();
    }
};

window.restartTopic = () => { 
    setAccent('#00f2ff'); // Reset color
    document.getElementById('result-screen').style.display = 'none'; 
    startQuiz(currentDiff); 
};

// [NEW FEATURE: Export Analytics JSON]
window.exportLogs = () => {
    playSound('snd-click');
    const historyData = localStorage.getItem('quiz_history') || '[]';
    const blob = new Blob([historyData], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'neural_logs_export.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};