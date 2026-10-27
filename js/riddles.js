/**
 * ============================================================================
 * RIDDLE RUSH — solo timed runs + PvP riddle duel (replaces the old Escape Room)
 * ============================================================================
 * Lives in its own window (#page-riddles). Two modes share one riddle bank:
 *
 *  SOLO  — 8 riddles against a per-riddle clock. Points = base(difficulty)
 *          x (1 - 25% per hint - 10% per wrong guess, floor 25%) + time bonus,
 *          then a streak multiplier (up to x1.5). Skip/timeout resets the streak.
 *
 *  PVP   — both players see the SAME riddle at the same time; first correct
 *          answer wins the round. The Host is the referee: a Guest's correct
 *          answer is sent as a "claim", the Host awards the round to whoever
 *          reached it first and broadcasts the result, so both screens always
 *          agree. Each player has one ⚡ Static Interference (blocks the other
 *          player's input for 4s). Hints are disabled in PvP to keep it fair.
 *
 * Lifecycle: riddlesEnter() / riddlesCanLeave() / riddlesLeave() are called by
 * nav.js, so leaving the window always stops timers and detaches P2P listeners.
 */
(function () {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* Riddle bank                                                        */
    /* ------------------------------------------------------------------ */
    // a: accepted answers (articles/spaces/punctuation are ignored when matching)
    // h: text hint shown for the first hint; the second hint reveals first letter + length
    const BANK = [
        // ---- EASY ----
        { id: 'e1', d: 'easy', q: 'What has hands but cannot clap?', a: ['clock', 'watch'], h: 'You glance at it to know the time.' },
        { id: 'e2', d: 'easy', q: 'What has keys but cannot open a single lock?', a: ['piano', 'keyboard'], h: 'Press them and you get music or letters.' },
        { id: 'e3', d: 'easy', q: 'What gets wetter the more it dries?', a: ['towel'], h: 'Found hanging in every bathroom.' },
        { id: 'e4', d: 'easy', q: 'What can you catch, but never throw?', a: ['cold', 'a cold'], h: 'Sneezes spread it.' },
        { id: 'e5', d: 'easy', q: 'What goes up but never comes back down?', a: ['age', 'your age'], h: 'Every birthday adds to it.' },
        { id: 'e6', d: 'easy', q: 'What has a neck but no head?', a: ['bottle'], h: 'You pour from it.' },
        { id: 'e7', d: 'easy', q: 'What has an eye but cannot see?', a: ['needle', 'potato', 'hurricane', 'storm'], h: 'Tailors thread it.' },
        { id: 'e8', d: 'easy', q: 'What runs but never walks, and has a mouth but never talks?', a: ['river', 'stream'], h: 'It flows to the sea.' },
        { id: 'e9', d: 'easy', q: 'What has to be broken before you can use it?', a: ['egg'], h: 'Breakfast food.' },
        { id: 'e10', d: 'easy', q: 'I am tall when I am young and short when I am old. What am I?', a: ['candle'], h: 'I give light and melt away.' },
        { id: 'e11', d: 'easy', q: 'What building has the most stories?', a: ['library'], h: 'Think books, not floors.' },
        { id: 'e12', d: 'easy', q: 'What has teeth but cannot bite?', a: ['comb', 'zipper', 'zip', 'saw', 'gear', 'cog'], h: 'You use it on your hair.' },

        // ---- MEDIUM ----
        { id: 'm1', d: 'medium', q: 'I speak without a mouth and hear without ears. I have no body, but I come alive with the wind. What am I?', a: ['echo'], h: 'Shout in a canyon and I answer.' },
        { id: 'm2', d: 'medium', q: 'The more of me there is, the less you see. What am I?', a: ['darkness', 'dark', 'fog'], h: 'Turn on a light to chase me away.' },
        { id: 'm3', d: 'medium', q: 'What can travel around the world while staying in a corner?', a: ['stamp', 'postage stamp'], h: 'Stuck on the top right of an envelope.' },
        { id: 'm4', d: 'medium', q: 'What has one head, one foot, and four legs?', a: ['bed'], h: 'You sleep on it.' },
        { id: 'm5', d: 'medium', q: 'What comes once in a minute, twice in a moment, but never in a thousand years?', a: ['m', 'letter m', 'the letter m'], h: 'Count letters, not time.' },
        { id: 'm6', d: 'medium', q: 'What word becomes shorter when you add two letters to it?', a: ['short'], h: 'The answer describes the effect.' },
        { id: 'm7', d: 'medium', q: 'Forward I am heavy, but backward I am not. What am I?', a: ['ton'], h: 'A unit of weight. Read it in reverse.' },
        { id: 'm8', d: 'medium', q: 'What can fill a room but takes up no space?', a: ['light', 'air', 'sound'], h: 'Flip a switch.' },
        { id: 'm9', d: 'medium', q: 'I shave every day, yet my beard stays exactly the same. What am I?', a: ['barber'], h: 'I do it for a living.' },
        { id: 'm10', d: 'medium', q: 'What is full of holes but still holds water?', a: ['sponge'], h: 'Found by the kitchen sink.' },
        { id: 'm11', d: 'medium', q: 'What has cities but no houses, forests but no trees, and water but no fish?', a: ['map'], h: 'You unfold it or open it on your phone.' },
        { id: 'm12', d: 'medium', q: 'You see me once in June, twice in November, but not at all in May. What am I?', a: ['e', 'letter e', 'the letter e'], h: 'Look at how the months are spelled.' },
        { id: 'm13', d: 'medium', q: 'If you have me, you want to share me. If you share me, you no longer have me. What am I?', a: ['secret'], h: 'Whispered between friends.' },
        { id: 'm14', d: 'medium', q: 'A farmer has 17 sheep. All but 9 run away. How many are left?', a: ['9', 'nine'], h: 'Read "all but" carefully.' },

        // ---- HARD ----
        { id: 'h1', d: 'hard', q: 'What belongs to you, but other people use it more than you do?', a: ['name', 'your name'], h: 'You were given it at birth.' },
        { id: 'h2', d: 'hard', q: 'I am not alive, but I grow. I have no lungs, but I need air. I have no mouth, but water kills me. What am I?', a: ['fire', 'flame'], h: 'Handle with care, and never with water.' },
        { id: 'h3', d: 'hard', q: 'The person who makes it sells it. The person who buys it never uses it. The person who uses it never knows. What is it?', a: ['coffin', 'casket'], h: 'A very final purchase.' },
        { id: 'h4', d: 'hard', q: 'What is so fragile that saying its name breaks it?', a: ['silence'], h: 'You are breaking it right now by reading aloud.' },
        { id: 'h5', d: 'hard', q: 'I have branches, but no fruit, trunk, or leaves. What am I?', a: ['bank'], h: 'Money lives here.' },
        { id: 'h6', d: 'hard', q: 'Brothers and sisters I have none, but that man\'s father is my father\'s son. Who is that man?', a: ['my son', 'his son', 'son', 'his own son', 'the son'], h: 'My father\'s son is... me.' },
        { id: 'h7', d: 'hard', q: 'Two in a corner, one in a room, zero in a house, but one in a shelter. What am I?', a: ['r', 'letter r', 'the letter r'], h: 'Count the letters in each word.' },
        { id: 'h8', d: 'hard', q: 'What is always in front of you but can never be seen?', a: ['future', 'the future'], h: 'It has not happened yet.' },
        { id: 'h9', d: 'hard', q: 'I am taken from a mine and shut in a wooden case, never released, and yet I am used by almost everyone. What am I?', a: ['pencil lead', 'pencil', 'graphite', 'lead'], h: 'Students use me daily.' },
        { id: 'h10', d: 'hard', q: 'What goes through cities and fields, but never moves?', a: ['road', 'path', 'highway', 'street'], h: 'Cars travel on it.' },
        { id: 'h11', d: 'hard', q: 'The more you take, the more you leave behind. What are they?', a: ['footsteps', 'steps', 'footprints'], h: 'Walk on sand and look back.' },
        { id: 'h12', d: 'hard', q: 'What has 13 hearts, but no other organs?', a: ['deck of cards', 'deck', 'cards', 'playing cards', 'a deck of cards'], h: 'Shuffle, cut, deal.' }
    ];

    const DIFF = {
        easy:   { label: 'EASY',   base: 10, time: 40 },
        medium: { label: 'MEDIUM', base: 20, time: 50 },
        hard:   { label: 'HARD',   base: 30, time: 60 }
    };
    const SOLO_ROUNDS = 8;
    const PVP_ROUNDS = 6;
    const STATIC_MS = 4000;
    const NEXT_DELAY_MS = 2200;

    /* ------------------------------------------------------------------ */
    /* Answer matching                                                    */
    /* ------------------------------------------------------------------ */
    function norm(str) {
        return String(str || '').toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/^(a|an|the)\s+/, '')
            .replace(/\s+/g, '');
    }
    function lev(a, b) {
        if (a === b) return 0;
        const m = a.length, n = b.length;
        if (!m) return n; if (!n) return m;
        let prev = Array.from({ length: n + 1 }, (_, i) => i);
        for (let i = 1; i <= m; i++) {
            const cur = [i];
            for (let j = 1; j <= n; j++) {
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = cur;
        }
        return prev[n];
    }
    function isCorrect(riddle, input) {
        const guess = norm(input);
        if (!guess) return false;
        return riddle.a.some(ans => {
            const target = norm(ans);
            if (guess === target) return true;
            // forgive a single typo, but only on longer words (so "ton" vs "tin" stays wrong)
            return target.length >= 5 && lev(guess, target) <= 1;
        });
    }
    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function pretty(ans) { return ans.length <= 2 ? ans.toUpperCase() : ans.charAt(0).toUpperCase() + ans.slice(1); }
    function byId(id) { return BANK.find(r => r.id === id); }
    function $(id) { return document.getElementById(id); }
    function num(key) { return parseInt(localStorage.getItem(key) || '0', 10) || 0; }
    function bump(key, by) { localStorage.setItem(key, String(num(key) + (by || 1))); }
    function sfx(id) { if (typeof playSound === 'function') playSound(id); }
    function buzz(p) { if (navigator.vibrate) navigator.vibrate(p); }
    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    }

    // Prefer riddles the player hasn't seen recently so repeat runs feel fresh.
    function getSeen() { try { return JSON.parse(localStorage.getItem('riddle_seen') || '[]'); } catch (e) { return []; } }
    function markSeen(ids) {
        const seen = getSeen().filter(x => ids.indexOf(x) === -1).concat(ids);
        try { localStorage.setItem('riddle_seen', JSON.stringify(seen.slice(-30))); } catch (e) {}
    }
    function pickIds(diff, n) {
        const seen = getSeen();
        const fresh = pool => shuffle(pool).sort((a, b) => (seen.indexOf(a.id) !== -1) - (seen.indexOf(b.id) !== -1));
        let chosen;
        if (diff === 'mixed') {
            const take = (d, k) => fresh(BANK.filter(r => r.d === d)).slice(0, k);
            const hardN = Math.floor(n / 4), easyN = Math.ceil(n * 3 / 8), medN = n - hardN - easyN;
            chosen = take('easy', easyN).concat(take('medium', medN), take('hard', hardN));
        } else {
            chosen = fresh(BANK.filter(r => r.d === diff)).slice(0, n);
        }
        return chosen.map(r => r.id);
    }

    /* ------------------------------------------------------------------ */
    /* State                                                              */
    /* ------------------------------------------------------------------ */
    let selectedDiff = 'medium';
    let rd = freshState();

    function freshState() {
        return {
            active: false, finished: false, mode: null, diff: 'medium',
            ids: [], idx: 0, score: 0, streak: 0, bestStreak: 0, solved: 0, hintsUsed: 0,
            hints: 0, wrong: 0, locked: false, deadline: 0, limit: 45, timerId: null, advanceId: null,
            review: [],
            // pvp
            isHost: false, decided: {}, applied: {}, myWins: 0, oppWins: 0, staticUsed: false, blockedUntil: 0, peerLost: false
        };
    }
    function clearTimers() {
        clearInterval(rd.timerId); rd.timerId = null;
        clearTimeout(rd.advanceId); rd.advanceId = null;
    }
    function current() { return byId(rd.ids[rd.idx]); }

    /* ------------------------------------------------------------------ */
    /* Screens                                                            */
    /* ------------------------------------------------------------------ */
    function show(screen) {
        $('rd-setup').style.display = screen === 'setup' ? 'block' : 'none';
        $('rd-play').style.display = screen === 'play' ? 'block' : 'none';
        $('rd-result').style.display = screen === 'result' ? 'block' : 'none';
        const c = $('page-content'); if (c) c.scrollTop = 0;
    }
    function renderSetup() {
        document.querySelectorAll('#rd-diff-chips .rd-chip').forEach(b => b.classList.toggle('active', b.dataset.diff === selectedDiff));
        const best = num('riddle_best_score');
        $('rd-best-line').textContent = best
            ? `🏆 Best run: ${best} pts · Riddles solved: ${num('riddles_solved')} · Best streak: ${num('riddle_best_streak')}`
            : 'No runs yet — your best score will show up here.';
    }

    window.rdSelectDiff = function (d) {
        selectedDiff = d; sfx('snd-click');
        document.querySelectorAll('#rd-diff-chips .rd-chip').forEach(b => b.classList.toggle('active', b.dataset.diff === d));
    };

    /* ------------------------------------------------------------------ */
    /* Lifecycle hooks (called from nav.js)                               */
    /* ------------------------------------------------------------------ */
    window.riddlesEnter = function () {
        if (rd.active) return; // never wipe a game in progress
        show('setup'); renderSetup();
    };
    window.riddlesCanLeave = function () {
        if (rd.active && rd.mode === 'pvp' && !rd.finished) {
            return window.confirm('Leave the duel? This counts as a forfeit.');
        }
        return true;
    };
    window.riddlesLeave = function () {
        if (rd.active && rd.mode === 'pvp' && !rd.finished && window.p2pSend) p2pSend({ type: 'rd-quit' });
        teardown();
        if (window.pvpCancelConnect && p2pPendingIsRiddles()) pvpCancelConnect();
    };
    function p2pPendingIsRiddles() {
        const o = $('pvp-connect-overlay');
        return !!(o && o.classList.contains('show'));
    }
    function teardown() {
        clearTimers();
        if (rd.mode === 'pvp') { if (window.p2pDisconnect) p2pDisconnect(); }
        rd = freshState();
    }

    /* ------------------------------------------------------------------ */
    /* Shared round rendering                                             */
    /* ------------------------------------------------------------------ */
    function renderRound() {
        const r = current();
        if (!r) return;
        const dm = DIFF[r.d];
        rd.hints = 0; rd.wrong = 0; rd.locked = false;
        $('rd-round-label').textContent = `ROUND ${rd.idx + 1} / ${rd.ids.length}`;
        $('rd-score').textContent = rd.score;
        $('rd-streak').textContent = rd.streak;
        $('rd-diff-tag').textContent = dm.label;
        $('rd-diff-tag').className = 'rd-diff-tag ' + r.d;
        $('rd-points-tag').textContent = rd.mode === 'pvp' ? 'FIRST TO ANSWER WINS' : `+${dm.base} pts`;
        const t = $('rd-riddle-text'); t.textContent = r.q;
        t.classList.remove('rd-riddle-in'); void t.offsetWidth; t.classList.add('rd-riddle-in');
        const hb = $('rd-hint-box'); hb.style.display = 'none'; hb.textContent = '';
        const inp = $('rd-answer-input'); inp.value = ''; inp.disabled = false;
        setFeedback('', '');
        $('rd-submit-btn').disabled = false;
        $('rd-hint-btn').disabled = false;
        $('rd-hint-btn').style.display = rd.mode === 'pvp' ? 'none' : '';
        $('rd-skip-btn').style.display = rd.mode === 'pvp' ? 'none' : '';
        $('rd-streak-wrap').style.display = rd.mode === 'pvp' ? 'none' : '';
        $('rd-versus').style.display = rd.mode === 'pvp' ? 'flex' : 'none';
        $('rd-static-btn').style.display = rd.mode === 'pvp' ? 'block' : 'none';
        $('rd-static-btn').disabled = rd.staticUsed;
        if (rd.mode === 'pvp') { $('rd-my-wins').textContent = rd.myWins; $('rd-opp-wins').textContent = rd.oppWins; }
        startTimer(dm.time);
        try { inp.focus({ preventScroll: true }); } catch (e) { inp.focus(); }
    }
    function setFeedback(text, tone) {
        const el = $('rd-feedback');
        el.textContent = text;
        el.className = 'rd-feedback' + (tone ? ' ' + tone : '');
    }
    function startTimer(seconds) {
        clearInterval(rd.timerId);
        rd.limit = seconds;
        rd.deadline = Date.now() + seconds * 1000;
        tick();
        rd.timerId = setInterval(tick, 200);
    }
    function tick() {
        const left = Math.max(0, rd.deadline - Date.now());
        const pct = (left / (rd.limit * 1000)) * 100;
        const bar = $('rd-timer-bar');
        if (bar) { bar.style.width = pct + '%'; bar.classList.toggle('low', pct < 25); }
        const tt = $('rd-timer-text'); if (tt) tt.textContent = Math.ceil(left / 1000) + 's';
        if (left <= 0) {
            clearInterval(rd.timerId); rd.timerId = null;
            onTimeout();
        }
    }
    function lockInput(disabled) {
        $('rd-answer-input').disabled = disabled;
        $('rd-submit-btn').disabled = disabled;
        $('rd-hint-btn').disabled = disabled || rd.hints >= 2;
        $('rd-skip-btn').disabled = disabled;
    }
    function shake() {
        const el = $('rd-answer-input');
        el.classList.remove('rd-shake'); void el.offsetWidth; el.classList.add('rd-shake');
    }

    /* ------------------------------------------------------------------ */
    /* SOLO                                                               */
    /* ------------------------------------------------------------------ */
    window.rdStartSolo = function () {
        teardown();
        rd = freshState();
        rd.active = true; rd.mode = 'solo'; rd.diff = selectedDiff;
        rd.ids = pickIds(selectedDiff, SOLO_ROUNDS);
        markSeen(rd.ids);
        sfx('snd-click');
        show('play');
        renderRound();
    };

    window.rdSubmit = function () {
        if (!rd.active || rd.locked) return;
        if (rd.mode === 'pvp' && Date.now() < rd.blockedUntil) return;
        const r = current();
        const input = $('rd-answer-input');
        if (!input.value.trim()) return;

        if (isCorrect(r, input.value)) {
            if (rd.mode === 'solo') soloCorrect(r);
            else pvpCorrect(r);
        } else {
            sfx('snd-wrong'); buzz([40, 30, 40]); shake();
            rd.wrong++;
            if (rd.mode === 'pvp') {
                // brief cooldown so a player can't brute-force guesses
                rd.blockedUntil = Date.now() + 1200;
                setFeedback('✕ Not it — 1.2s cooldown.', 'bad');
                input.select();
            } else {
                setFeedback(rd.wrong >= 2 && rd.hints < 2 ? '✕ Not quite. Try a 💡 hint?' : '✕ Not quite — try again.', 'bad');
                input.select();
            }
        }
    };

    function soloCorrect(r) {
        const dm = DIFF[r.d];
        const left = Math.max(0, rd.deadline - Date.now()) / 1000;
        const factor = Math.max(0.25, 1 - 0.25 * rd.hints - 0.1 * Math.min(3, rd.wrong));
        const timeBonus = Math.round(dm.base * 0.5 * (left / dm.time));
        rd.streak++;
        rd.bestStreak = Math.max(rd.bestStreak, rd.streak);
        const mult = 1 + Math.min(rd.streak - 1, 5) * 0.1;
        const pts = Math.round((dm.base * factor + timeBonus) * mult);
        rd.score += pts; rd.solved++;
        rd.hintsUsed += rd.hints;
        rd.review.push({ id: r.id, result: 'solved', pts, hints: rd.hints });
        bump('riddles_solved');
        if (rd.bestStreak > num('riddle_best_streak')) localStorage.setItem('riddle_best_streak', String(rd.bestStreak));

        clearInterval(rd.timerId); rd.timerId = null;
        rd.locked = true; lockInput(true);
        $('rd-score').textContent = rd.score; $('rd-streak').textContent = rd.streak;
        sfx('snd-correct'); buzz(30);
        setFeedback(`✔ Correct! +${pts} pts${mult > 1 ? ` (streak ×${mult.toFixed(1)})` : ''}`, 'good');
        if (window.checkAndToastNewAchievements) checkAndToastNewAchievements();
        scheduleAdvance(1500);
    }

    function soloMiss(kind) {
        const r = current();
        rd.streak = 0;
        rd.hintsUsed += rd.hints;
        rd.review.push({ id: r.id, result: kind, pts: 0, hints: rd.hints });
        clearInterval(rd.timerId); rd.timerId = null;
        rd.locked = true; lockInput(true);
        $('rd-streak').textContent = 0;
        setFeedback((kind === 'timeout' ? '⏰ Time\'s up! ' : '⏭ Skipped. ') + 'Answer: ' + pretty(r.a[0]), 'warn');
        scheduleAdvance(2200);
    }

    window.rdSkip = function () {
        if (!rd.active || rd.mode !== 'solo' || rd.locked) return;
        sfx('snd-powerup-skip'); soloMiss('skipped');
    };

    window.rdUseHint = function () {
        if (!rd.active || rd.mode !== 'solo' || rd.locked || rd.hints >= 2) return;
        const r = current();
        rd.hints++;
        const box = $('rd-hint-box');
        box.style.display = 'block';
        if (rd.hints === 1) {
            box.textContent = '💡 ' + r.h;
        } else {
            const word = r.a[0];
            const pattern = word.split('').map((ch, i) => (ch === ' ' ? '   ' : (i === 0 ? ch.toUpperCase() : '_'))).join(' ');
            box.textContent = '💡 ' + r.h + '\n🔤 ' + pattern + `  (${word.replace(/\s/g, '').length} letters)`;
        }
        $('rd-hint-btn').disabled = rd.hints >= 2;
        sfx('snd-powerup-time');
        setFeedback('Hint used: −25% points for this riddle.', 'warn');
    };

    function scheduleAdvance(ms) {
        clearTimeout(rd.advanceId);
        rd.advanceId = setTimeout(() => {
            rd.idx++;
            if (rd.idx >= rd.ids.length) finishSolo(false); else renderRound();
        }, ms);
    }

    function onTimeout() {
        if (!rd.active) return;
        if (rd.mode === 'solo' && !rd.locked) { sfx('snd-wrong'); soloMiss('timeout'); }
        else if (rd.mode === 'pvp' && !rd.locked) {
            // The host is the referee; the guest simply waits for the host's verdict.
            lockInput(true);
            if (rd.isHost) hostResolve(rd.idx, null);
            else setFeedback('⏰ Time\'s up — waiting for the result...', 'warn');
        }
    }

    function finishSolo(quit) {
        clearTimers();
        const total = rd.ids.length;
        const perfect = !quit && rd.solved === total && rd.hintsUsed === 0;
        const prevBest = num('riddle_best_score');
        const newBest = rd.score > prevBest;
        if (newBest) localStorage.setItem('riddle_best_score', String(rd.score));
        if (perfect) bump('riddle_perfect_runs');
        const xp = rd.solved ? Math.min(40, 6 + rd.solved * 4) + (perfect ? 10 : 0) : 0;
        if (xp && window.awardExp) awardExp(xp, 'Riddle Rush');

        const grade = rd.solved === total ? 'S' : rd.solved >= total * 0.75 ? 'A' : rd.solved >= total * 0.5 ? 'B' : 'C';
        $('rd-result-banner').innerHTML = `<div class="rd-grade">${grade}</div><div><div class="rd-result-title">${quit ? 'RUN ENDED' : (grade === 'S' ? 'FLAWLESS' : 'RUN COMPLETE')}</div><div class="rd-result-sub">${newBest && rd.score > 0 ? '🏆 New personal best! · ' : ''}${xp ? '+' + xp + ' XP' : 'No XP this time — solve a riddle to earn some'}</div></div>`;
        $('rd-result-stats').innerHTML = [
            ['SCORE', rd.score], ['SOLVED', `${rd.solved}/${total}`], ['BEST STREAK', rd.bestStreak], ['HINTS USED', rd.hintsUsed]
        ].map(([l, v]) => `<div class="arcade-stat"><div class="arcade-stat-num">${v}</div><div class="arcade-stat-label">${l}</div></div>`).join('');
        const icons = { solved: '✔', skipped: '⏭', timeout: '⏰' };
        $('rd-review-list').innerHTML = '<div class="section-label" style="margin-top:6px;">REVIEW</div>' + rd.review.map(item => {
            const r = byId(item.id);
            return `<div class="rd-review-row ${item.result}"><span class="rd-review-icon">${icons[item.result]}</span><div><div class="rd-review-q">${esc(r.q)}</div><div class="rd-review-a">Answer: ${esc(pretty(r.a[0]))}${item.pts ? ' · +' + item.pts + ' pts' : ''}</div></div></div>`;
        }).join('');
        $('rd-result-actions').innerHTML = '<button class="btn" onclick="rdStartSolo()">▶ PLAY AGAIN</button><button class="btn" onclick="rdBackToSetup()">⚙ CHANGE SETTINGS</button>';
        rd.active = false; rd.finished = true;
        show('result');
        if (xp || perfect) sfx('snd-achievement');
        if (window.checkAndToastNewAchievements) checkAndToastNewAchievements();
    }

    window.rdQuit = function () {
        if (!rd.active) { rdBackToSetup(); return; }
        if (rd.mode === 'solo') {
            if (rd.review.length === 0 && rd.score === 0) { rdBackToSetup(); return; }
            finishSolo(true);
        } else {
            if (!rd.finished && !window.confirm('Forfeit this duel?')) return;
            if (window.p2pSend && !rd.finished) p2pSend({ type: 'rd-quit' });
            rdBackToSetup();
        }
    };

    window.rdBackToSetup = function () {
        teardown();
        show('setup'); renderSetup();
    };

    /* ------------------------------------------------------------------ */
    /* PVP                                                                */
    /* ------------------------------------------------------------------ */
    window.rdOpenPvp = function () {
        if (!window.RTCPeerConnection) { alert('This browser does not support peer-to-peer connections (WebRTC).'); return; }
        teardown();
        showPvpConnect('riddles', { diff: selectedDiff });
    };

    window.pvpLaunchers = window.pvpLaunchers || {};
    window.pvpLaunchers.riddles = function (isHost, opts) {
        rd = freshState();
        rd.active = true; rd.mode = 'pvp'; rd.isHost = isHost;
        rd.diff = (opts && opts.diff) || selectedDiff;
        window.p2pOnMessage(onPeerMessage);
        window.p2pOnPeerLost(onPeerLost);
        show('play');
        $('rd-versus').style.display = 'flex';
        $('rd-static-btn').style.display = 'block';
        $('rd-riddle-text').textContent = isHost ? 'Shuffling riddles...' : 'Waiting for the host to start the duel...';
        $('rd-answer-input').disabled = true;
        $('rd-hint-btn').style.display = 'none'; $('rd-skip-btn').style.display = 'none';
        // The host starts the match only once the guest says its handlers are attached —
        // starting immediately could send the riddle list before the guest is listening.
        if (!isHost) p2pSend({ type: 'rd-ready' });
    };

    function hostBeginMatch() {
        const ids = pickIds(rd.diff, PVP_ROUNDS);
        markSeen(ids);
        p2pSend({ type: 'rd-start', ids });
        beginMatch(ids);
    }
    function beginMatch(ids) {
        const keep = { isHost: rd.isHost, diff: rd.diff };
        clearTimers();
        rd = freshState();
        rd.active = true; rd.mode = 'pvp'; rd.isHost = keep.isHost; rd.diff = keep.diff;
        rd.ids = ids;
        window.p2pOnMessage(onPeerMessage);
        window.p2pOnPeerLost(onPeerLost);
        sfx('snd-powerup-time');
        show('play');
        renderRound();
    }

    function pvpCorrect(r) {
        rd.locked = true; lockInput(true);
        clearInterval(rd.timerId); rd.timerId = null;
        if (rd.isHost) {
            hostResolve(rd.idx, 'host');
        } else {
            setFeedback('✔ Correct! Checking who was first...', 'good');
            p2pSend({ type: 'rd-claim', r: rd.idx });
        }
    }

    // Host-only: decide a round exactly once and tell the guest.
    function hostResolve(r, who) {
        if (rd.decided[r]) return;
        rd.decided[r] = true;
        p2pSend({ type: 'rd-result', r, who });
        applyResult(r, who);
    }

    function applyResult(r, who) {
        if (rd.applied[r] || !rd.active) return;
        rd.applied[r] = true;
        if (r !== rd.idx) return; // stale message for another round
        clearInterval(rd.timerId); rd.timerId = null;
        rd.locked = true; lockInput(true);
        const riddle = current();
        let line, tone;
        if (who === null) {
            line = `⏰ Nobody got it. Answer: ${pretty(riddle.a[0])}`; tone = 'warn'; sfx('snd-wrong');
        } else {
            const iWon = (who === 'host') === rd.isHost;
            if (iWon) { rd.myWins++; line = '🏆 You got it first!'; tone = 'good'; sfx('snd-correct'); buzz(30); bump('riddles_solved'); }
            else { rd.oppWins++; line = `😬 Opponent was faster. Answer: ${pretty(riddle.a[0])}`; tone = 'bad'; sfx('snd-wrong'); buzz([40, 30, 40]); }
        }
        setFeedback(line, tone);
        $('rd-my-wins').textContent = rd.myWins; $('rd-opp-wins').textContent = rd.oppWins;
        clearTimeout(rd.advanceId);
        rd.advanceId = setTimeout(() => {
            rd.idx++;
            if (rd.idx >= rd.ids.length) finishPvp(); else renderRound();
        }, NEXT_DELAY_MS);
    }

    window.rdFireStatic = function () {
        if (!rd.active || rd.mode !== 'pvp' || rd.staticUsed || rd.locked) return;
        rd.staticUsed = true;
        $('rd-static-btn').disabled = true;
        p2pSend({ type: 'rd-static' });
        sfx('snd-powerup-time');
        setFeedback('⚡ Static fired! Their input is blocked for 4s.', 'warn');
    };
    function receiveStatic() {
        if (!rd.active || rd.locked) return;
        rd.blockedUntil = Date.now() + STATIC_MS;
        const inp = $('rd-answer-input');
        inp.disabled = true; $('rd-submit-btn').disabled = true;
        setFeedback('⚡ Static interference! Input blocked for 4s...', 'warn');
        buzz([60, 40, 60]);
        const roundAtHit = rd.idx;
        setTimeout(() => {
            if (!rd.active || rd.locked || rd.idx !== roundAtHit) return;
            inp.disabled = false; $('rd-submit-btn').disabled = false;
            setFeedback('', ''); try { inp.focus({ preventScroll: true }); } catch (e) {}
        }, STATIC_MS);
    }

    function onPeerMessage(data) {
        if (!data || typeof data.type !== 'string') return;
        switch (data.type) {
            case 'rd-ready':
                if (rd.isHost && !rd.ids.length) hostBeginMatch();
                break;
            case 'rd-start':
                if (!rd.isHost && Array.isArray(data.ids) && data.ids.every(id => byId(id))) beginMatch(data.ids);
                break;
            case 'rd-claim':
                if (rd.isHost && typeof data.r === 'number') hostResolve(data.r, 'guest');
                break;
            case 'rd-result':
                if (!rd.isHost) applyResult(data.r, data.who);
                break;
            case 'rd-static':
                receiveStatic();
                break;
            case 'rd-quit':
                onPeerLost('quit');
                break;
        }
    }

    function onPeerLost() {
        if (!rd.active || rd.mode !== 'pvp' || rd.peerLost) return;
        rd.peerLost = true;
        if (rd.finished) { // match already over — just stop offering a rematch
            const b = $('rd-result-actions'); if (b) b.innerHTML = '<div class="rd-feedback warn">🔌 Opponent disconnected.</div><button class="btn" onclick="rdBackToSetup()">← BACK</button>';
            return;
        }
        clearTimers();
        rd.active = false; rd.finished = true;
        $('rd-result-banner').innerHTML = '<div class="rd-grade">🔌</div><div><div class="rd-result-title">OPPONENT LEFT</div><div class="rd-result-sub">The connection closed before the duel ended. No result recorded.</div></div>';
        $('rd-result-stats').innerHTML = ''; $('rd-review-list').innerHTML = '';
        $('rd-result-actions').innerHTML = '<button class="btn" onclick="rdBackToSetup()">← BACK TO SETUP</button>';
        show('result');
    }

    function finishPvp() {
        clearTimers();
        rd.finished = true;
        const win = rd.myWins > rd.oppWins, draw = rd.myWins === rd.oppWins;
        let title, sub, grade;
        if (draw) { title = 'DRAW'; grade = '🤝'; sub = 'Perfectly matched. Rematch?'; if (window.awardExp) awardExp(12, 'Riddle Duel played'); }
        else if (win) {
            title = 'VICTORY'; grade = '🏆'; sub = '+35 XP'; bump('riddle_duel_wins');
            if (window.awardExp) awardExp(35, 'Riddle Duel won');
            sfx('snd-achievement');
        } else { title = 'DEFEATED'; grade = '💀'; sub = 'Good fight — +8 XP for playing'; if (window.awardExp) awardExp(8, 'Riddle Duel played'); }
        $('rd-result-banner').innerHTML = `<div class="rd-grade">${grade}</div><div><div class="rd-result-title">${title}</div><div class="rd-result-sub">${rd.myWins} – ${rd.oppWins} · ${sub}</div></div>`;
        $('rd-result-stats').innerHTML = [['YOUR WINS', rd.myWins], ['THEIR WINS', rd.oppWins]]
            .map(([l, v]) => `<div class="arcade-stat"><div class="arcade-stat-num">${v}</div><div class="arcade-stat-label">${l}</div></div>`).join('');
        $('rd-review-list').innerHTML = '';
        $('rd-result-actions').innerHTML = rd.isHost
            ? '<button class="btn" onclick="rdRematch()">🔁 REMATCH</button><button class="btn" onclick="rdBackToSetup()">← LEAVE</button>'
            : '<div class="rd-feedback warn" style="grid-column:span 2;">Waiting for the host to start a rematch...</div><button class="btn" onclick="rdBackToSetup()">← LEAVE</button>';
        show('result');
        if (window.checkAndToastNewAchievements) checkAndToastNewAchievements();
    }

    window.rdRematch = function () {
        if (!rd.isHost || !p2pIsConnected()) return;
        hostBeginMatch();
    };

    /* ------------------------------------------------------------------ */
    /* Public bits for the Arcade hub / daily riddle                      */
    /* ------------------------------------------------------------------ */
    window.RiddleCore = { bank: BANK, isCorrect, pretty, esc };
})();
