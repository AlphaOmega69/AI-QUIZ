/**
 * ============================================================================
 * QUIZ DUEL — 1v1 knowledge battle (vs Bot or a friend over P2P)
 * ============================================================================
 * Lives in its own window (#page-duel). Rules:
 *   - 8 questions, 20s each, 20 damage per hit, 100 HP each.
 *   - Answer correctly -> the OPPONENT takes 20. Answer wrong or time out -> YOU take 20.
 *   - A match ends when someone hits 0 HP, or when both players have finished all
 *     questions (most HP left wins; equal HP is a draw).
 *
 * Fairness: the Host (or the local player in Bot mode) generates the question set
 * once and sends the whole set to the Guest, so both screens show identical
 * questions in identical order. Each side applies every answer event to BOTH
 * health bars with the same rule, so the two screens stay in sync.
 *
 * Works without an AI key: if generation fails, built-in questions are used.
 */
(function () {
    'use strict';

    const QUESTIONS_PER_DUEL = 8;
    const QUESTION_SECONDS = 20;
    const DAMAGE = 20;
    const BOT = {
        easy:   { name: 'ROOKIE BOT',    accuracy: 0.40, speed: 1.35, xp: 8 },
        normal: { name: 'BOT',           accuracy: 0.62, speed: 1.0,  xp: 15 },
        hard:   { name: 'NIGHTMARE BOT', accuracy: 0.85, speed: 0.65, xp: 25 }
    };

    const FALLBACK = [
        ['Which planet is known as the Red Planet?', 'Mars', ['Venus', 'Jupiter', 'Mercury'], 'Iron oxide on its surface gives Mars its red colour.'],
        ['What is H2O commonly known as?', 'Water', ['Hydrogen gas', 'Salt', 'Acid'], 'Two hydrogen atoms and one oxygen atom make water.'],
        ['Who wrote "Romeo and Juliet"?', 'William Shakespeare', ['Charles Dickens', 'Jane Austen', 'Mark Twain'], 'Shakespeare wrote it in the 1590s.'],
        ['How many continents are there?', '7', ['5', '6', '8'], 'Africa, Antarctica, Asia, Australia/Oceania, Europe, North America, South America.'],
        ['What is the largest ocean on Earth?', 'Pacific Ocean', ['Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'], 'The Pacific covers about a third of the planet.'],
        ['Which gas do plants absorb for photosynthesis?', 'Carbon dioxide', ['Oxygen', 'Nitrogen', 'Helium'], 'Plants turn CO2 and water into sugar and oxygen.'],
        ['What is the capital of Japan?', 'Tokyo', ['Kyoto', 'Osaka', 'Seoul'], 'Tokyo has been the capital since 1868.'],
        ['What does CPU stand for?', 'Central Processing Unit', ['Central Program Utility', 'Computer Personal Unit', 'Core Processing Union'], 'The CPU executes a computer\'s instructions.'],
        ['What is the smallest prime number?', '2', ['1', '3', '0'], '2 is the only even prime; 1 is not prime.'],
        ['Who painted the Mona Lisa?', 'Leonardo da Vinci', ['Michelangelo', 'Raphael', 'Vincent van Gogh'], 'Painted in the early 1500s.'],
        ['What is the hardest natural substance?', 'Diamond', ['Gold', 'Iron', 'Quartz'], 'Diamond scores 10 on the Mohs scale.'],
        ['How many sides does a hexagon have?', '6', ['5', '7', '8'], 'Hex means six.'],
        ['Which organ pumps blood around the body?', 'Heart', ['Liver', 'Lungs', 'Kidney'], 'The heart beats roughly 100,000 times a day.'],
        ['In which year did World War II end?', '1945', ['1939', '1918', '1950'], 'Germany surrendered in May and Japan in September 1945.']
    ];

    function $(id) { return document.getElementById(id); }
    function sfx(id) { if (typeof playSound === 'function') playSound(id); }
    function num(key) { return parseInt(localStorage.getItem(key) || '0', 10) || 0; }
    function shuffle(arr) {
        const a = arr.slice();
        for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
        return a;
    }

    let botLevel = 'normal';
    let du = fresh();

    function fresh() {
        return {
            active: false, finished: false, mode: null, isHost: false, topic: 'General Knowledge',
            questions: [], idx: 0, myHp: 100, oppHp: 100, myDone: false, oppDone: false, oppIdx: 0,
            answered: false, timerId: null, deadline: 0, nextId: null, botId: null, botIdx: 0, botCfg: null,
            peerLost: false, generating: false
        };
    }
    function clearTimers() {
        clearInterval(du.timerId); du.timerId = null;
        clearTimeout(du.nextId); du.nextId = null;
        clearTimeout(du.botId); du.botId = null;
    }

    /* ------------------------------------------------------------------ */
    /* Screens + lifecycle                                                */
    /* ------------------------------------------------------------------ */
    function show(screen) {
        $('duel-setup').style.display = screen === 'setup' ? 'block' : 'none';
        $('duel-arena').style.display = screen === 'arena' ? 'block' : 'none';
        const c = $('page-content'); if (c) c.scrollTop = 0;
    }
    function setStatus(text, tone) {
        const el = $('duel-setup-status'); if (!el) return;
        el.textContent = text || '';
        el.className = 'rd-feedback' + (tone ? ' ' + tone : '');
    }

    window.duelEnter = function () {
        if (du.active) return; // never wipe a match in progress
        show('setup'); setStatus('');
    };
    window.duelCanLeave = function () {
        if (du.active && du.mode === 'pvp' && !du.finished) return window.confirm('Leave the duel? This counts as a forfeit.');
        return true;
    };
    window.duelLeave = function () {
        if (du.active && du.mode === 'pvp' && !du.finished && window.p2pSend) p2pSend({ type: 'duel-quit' });
        teardown();
        const o = $('pvp-connect-overlay');
        if (o && o.classList.contains('show') && window.pvpCancelConnect) pvpCancelConnect();
    };
    function teardown() {
        clearTimers();
        if (du.mode === 'pvp' && window.p2pDisconnect) p2pDisconnect();
        du = fresh();
    }

    window.duelPickTopic = function (t) { $('duel-topic-input').value = t; sfx('snd-click'); };
    window.duelSelectBot = function (level) {
        botLevel = level; sfx('snd-click');
        document.querySelectorAll('#duel-bot-chips .rd-chip').forEach(b => b.classList.toggle('active', b.dataset.level === level));
    };
    function topicValue() { return ($('duel-topic-input').value || '').trim() || 'General Knowledge'; }

    /* ------------------------------------------------------------------ */
    /* Question generation (AI first, built-in fallback)                  */
    /* ------------------------------------------------------------------ */
    function validQuestion(q) {
        return q && typeof q.q === 'string' && typeof q.a === 'string' && Array.isArray(q.o) && q.o.length === 4 &&
            new Set(q.o).size === 4 && q.o.indexOf(q.a) !== -1;
    }
    function fallbackSet() {
        return shuffle(FALLBACK).slice(0, QUESTIONS_PER_DUEL).map(([q, a, wrong, exp]) => ({ q, a, o: shuffle([a].concat(wrong)), exp }));
    }
    async function generateQuestions(topic) {
        try {
            if (typeof executeAPIRequest !== 'function') throw new Error('AI engine unavailable');
            const promptText = `Topic: ${topic}. Generate exactly ${QUESTIONS_PER_DUEL} multiple-choice questions for a competitive 1v1 quiz duel. Keep them punchy and fair (not overly obscure), each with exactly 3 wrong answers that are plausible but clearly wrong. Return JSON strictly: {"questions": [{"question": "...", "correct_answer": "...", "incorrect_answers": ["...", "...", "..."], "explanation": "..."}]}`;
            const raw = await executeAPIRequest(promptText, false);
            const parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
            const qs = (parsed.questions || []).map(q => ({
                q: q.question, a: q.correct_answer,
                o: shuffle([q.correct_answer].concat(q.incorrect_answers || [])), exp: q.explanation || ''
            })).filter(validQuestion).slice(0, QUESTIONS_PER_DUEL);
            if (qs.length < 4) throw new Error('Too few valid questions');
            return { questions: qs, fallback: false };
        } catch (e) {
            console.warn('Quiz Duel: using built-in questions —', e && e.message);
            return { questions: fallbackSet(), fallback: true };
        }
    }

    /* ------------------------------------------------------------------ */
    /* Starting a match                                                   */
    /* ------------------------------------------------------------------ */
    function enterArena(oppLabel) {
        show('arena');
        $('duel-opp-label').textContent = oppLabel;
        $('duel-result-banner').style.display = 'none';
        $('duel-result-actions').innerHTML = '';
        $('duel-quit-btn').style.display = '';
        $('duel-options').innerHTML = '';
        $('duel-question-num').textContent = '';
        $('duel-timer-text').textContent = '';
        $('duel-opp-progress').textContent = '';
        $('duel-feedback').textContent = '';
        renderHp();
    }
    function loading(text) { $('duel-question-text').textContent = text; $('duel-options').innerHTML = ''; }

    window.duelStartBot = async function () {
        teardown();
        du = fresh();
        du.active = true; du.mode = 'bot'; du.topic = topicValue(); du.botCfg = BOT[botLevel];
        sfx('snd-click');
        enterArena(du.botCfg.name);
        await startWithQuestions(true);
    };

    async function startWithQuestions(generate) {
        if (generate) {
            du.generating = true;
            loading(`Generating battle questions about "${du.topic}"...`);
            const gen = await generateQuestions(du.topic);
            if (!du.active) return; // player left while the AI was thinking
            du.generating = false;
            du.questions = gen.questions;
            if (du.mode === 'pvp') p2pSend({ type: 'duel-questions', questions: du.questions, topic: du.topic });
            beginMatch();
            if (gen.fallback) $('duel-feedback').textContent = 'ℹ️ AI unavailable — using built-in questions.';
        } else {
            beginMatch();
        }
    }

    function beginMatch() {
        clearTimers();
        const keep = { mode: du.mode, isHost: du.isHost, topic: du.topic, questions: du.questions, botCfg: du.botCfg };
        du = fresh();
        du.active = true; du.mode = keep.mode; du.isHost = keep.isHost; du.topic = keep.topic;
        du.questions = keep.questions; du.botCfg = keep.botCfg;
        $('duel-result-banner').style.display = 'none';
        $('duel-result-actions').innerHTML = '';
        $('duel-quit-btn').style.display = '';
        renderHp();
        sfx('snd-powerup-time');
        showQuestion();
        if (du.mode === 'bot') scheduleBot();
    }

    window.duelOpenPvp = function () {
        if (!window.RTCPeerConnection) { alert('This browser does not support peer-to-peer connections (WebRTC).'); return; }
        teardown();
        setStatus('');
        showPvpConnect('duel', { topic: topicValue() });
    };

    window.pvpLaunchers = window.pvpLaunchers || {};
    window.pvpLaunchers.duel = function (isHost, opts) {
        du = fresh();
        du.active = true; du.mode = 'pvp'; du.isHost = isHost; du.topic = (opts && opts.topic) || 'General Knowledge';
        window.p2pOnMessage(onPeerMessage);
        window.p2pOnPeerLost(onPeerLost);
        enterArena('OPPONENT');
        loading(isHost ? 'Opponent connected. Waiting for them to get ready...' : 'Connected! Waiting for the host to send battle questions...');
        // Host builds the question set only after the guest confirms it is listening.
        if (!isHost) p2pSend({ type: 'duel-ready' });
    };

    /* ------------------------------------------------------------------ */
    /* Question flow                                                      */
    /* ------------------------------------------------------------------ */
    function renderHp() {
        const me = Math.max(0, du.myHp), opp = Math.max(0, du.oppHp);
        $('duel-my-hp-fill').style.width = me + '%';
        $('duel-opp-hp-fill').style.width = opp + '%';
        $('duel-my-hp-num').textContent = me;
        $('duel-opp-hp-num').textContent = opp;
    }
    function flashHp(which) {
        const el = $(which === 'me' ? 'duel-my-hp-fill' : 'duel-opp-hp-fill');
        if (!el) return;
        el.classList.remove('duel-hit'); void el.offsetWidth; el.classList.add('duel-hit');
    }
    function renderOppProgress() {
        const total = du.questions.length;
        $('duel-opp-progress').textContent = total ? (du.oppDone ? 'Opponent: finished' : `Opponent: Q${Math.min(du.oppIdx + 1, total)}/${total}`) : '';
    }

    function showQuestion() {
        if (du.finished) return;
        if (du.idx >= du.questions.length) {
            du.myDone = true;
            if (du.mode === 'pvp') p2pSend({ type: 'duel-done' });
            clearInterval(du.timerId);
            $('duel-timer-text').textContent = '';
            $('duel-options').innerHTML = '';
            $('duel-question-num').textContent = 'All questions answered';
            $('duel-question-text').textContent = du.oppDone ? 'Calculating result...' : 'Waiting for your opponent to finish...';
            checkEnd();
            return;
        }
        const q = du.questions[du.idx];
        du.answered = false;
        $('duel-question-text').textContent = q.q;
        $('duel-question-num').textContent = `Q${du.idx + 1} / ${du.questions.length}`;
        $('duel-feedback').textContent = '';
        const optsEl = $('duel-options');
        optsEl.innerHTML = '';
        q.o.forEach(opt => {
            const btn = document.createElement('button');
            btn.className = 'option'; btn.type = 'button'; btn.textContent = opt;
            btn.onclick = () => answer(opt);
            optsEl.appendChild(btn);
        });
        renderOppProgress();
        startTimer();
    }

    function startTimer() {
        clearInterval(du.timerId);
        du.deadline = Date.now() + QUESTION_SECONDS * 1000;
        const tick = () => {
            const left = Math.max(0, Math.ceil((du.deadline - Date.now()) / 1000));
            const t = $('duel-timer-text'); if (t) { t.textContent = left + 's'; t.classList.toggle('low', left <= 5); }
            if (left <= 0) { clearInterval(du.timerId); du.timerId = null; answer(null); }
        };
        tick();
        du.timerId = setInterval(tick, 250);
    }

    function answer(selected) {
        if (!du.active || du.answered || du.finished) return;
        du.answered = true;
        clearInterval(du.timerId); du.timerId = null;
        const q = du.questions[du.idx];
        const correct = selected !== null && selected === q.a;

        document.querySelectorAll('#duel-options .option').forEach(b => {
            b.disabled = true;
            if (b.textContent === q.a) b.classList.add('correct');
            else if (b.textContent === selected) b.classList.add('wrong');
        });

        if (correct) { du.oppHp -= DAMAGE; flashHp('opp'); sfx('snd-correct'); if (navigator.vibrate) navigator.vibrate(30); }
        else { du.myHp -= DAMAGE; flashHp('me'); sfx('snd-wrong'); if (navigator.vibrate) navigator.vibrate([50, 30, 50]); }
        renderHp();

        $('duel-feedback').className = 'rd-feedback ' + (correct ? 'good' : 'bad');
        $('duel-feedback').textContent = (correct ? `💥 Direct hit! −${DAMAGE} to them.` : (selected === null ? `⏰ Too slow! You take ${DAMAGE}.` : `✕ Wrong! You take ${DAMAGE}.`)) + (q.exp ? '  ' + q.exp : '');

        if (du.mode === 'pvp') p2pSend({ type: 'duel-answer', correct, q: du.idx });
        du.idx++;
        if (checkEnd()) return;
        clearTimeout(du.nextId);
        du.nextId = setTimeout(showQuestion, 1700);
    }

    /* ------------------------------------------------------------------ */
    /* Opponent events (real peer or the bot) — same rule either way      */
    /* ------------------------------------------------------------------ */
    function applyOpponentAnswer(correct, qIndex) {
        if (!du.active || du.finished) return;
        if (correct) { du.myHp -= DAMAGE; flashHp('me'); sfx('snd-wrong'); if (navigator.vibrate) navigator.vibrate([40, 30, 40]); }
        else { du.oppHp -= DAMAGE; flashHp('opp'); }
        du.oppIdx = (typeof qIndex === 'number' ? qIndex : du.oppIdx) + 1;
        renderHp(); renderOppProgress();
        checkEnd();
    }

    function onPeerMessage(data) {
        if (!data || typeof data.type !== 'string') return;
        switch (data.type) {
            case 'duel-ready':
                if (du.isHost && !du.generating && !du.questions.length) startWithQuestions(true);
                break;
            case 'duel-questions':
                if (!du.isHost && Array.isArray(data.questions) && data.questions.every(validQuestion)) {
                    du.questions = data.questions; du.topic = data.topic || du.topic;
                    beginMatch();
                }
                break;
            case 'duel-answer':
                applyOpponentAnswer(!!data.correct, data.q);
                break;
            case 'duel-done':
                du.oppDone = true; renderOppProgress(); checkEnd();
                break;
            case 'duel-quit':
                onPeerLost('quit');
                break;
        }
    }

    function onPeerLost() {
        if (!du.active || du.mode !== 'pvp' || du.peerLost) return;
        du.peerLost = true;
        if (du.finished) {
            $('duel-result-actions').innerHTML = '<div class="rd-feedback warn" style="grid-column:span 2;">🔌 Opponent disconnected.</div>';
            return;
        }
        clearTimers();
        du.finished = true; du.active = false;
        $('duel-options').innerHTML = '';
        $('duel-timer-text').textContent = '';
        $('duel-question-text').textContent = '';
        const b = $('duel-result-banner');
        b.style.display = 'flex';
        b.innerHTML = '<div class="rd-grade">🔌</div><div><div class="rd-result-title">OPPONENT LEFT</div><div class="rd-result-sub">The connection closed before the duel ended. No result recorded.</div></div>';
        $('duel-result-actions').innerHTML = '<button class="btn" style="grid-column:span 2;" onclick="duelBackToSetup()">← BACK TO SETUP</button>';
        $('duel-quit-btn').style.display = 'none';
    }

    /* ------------------------------------------------------------------ */
    /* Bot opponent                                                       */
    /* ------------------------------------------------------------------ */
    function scheduleBot() {
        clearTimeout(du.botId);
        if (!du.active || du.finished) return;
        const cfg = du.botCfg;
        const delay = (4500 + Math.random() * 9000) * cfg.speed;
        du.botId = setTimeout(() => {
            if (!du.active || du.finished) return;
            applyOpponentAnswer(Math.random() < cfg.accuracy, du.botIdx);
            du.botIdx++;
            if (du.botIdx >= du.questions.length) { du.oppDone = true; renderOppProgress(); checkEnd(); }
            else scheduleBot();
        }, delay);
    }

    /* ------------------------------------------------------------------ */
    /* Ending                                                             */
    /* ------------------------------------------------------------------ */
    function checkEnd() {
        if (du.finished || !du.questions.length) return false;
        if (du.myHp <= 0 || du.oppHp <= 0 || (du.myDone && du.oppDone)) {
            finish();
            return true;
        }
        return false;
    }

    function finish() {
        if (du.finished) return;
        du.finished = true;
        clearTimers();
        const me = Math.max(0, du.myHp), opp = Math.max(0, du.oppHp);
        const draw = me === opp, win = me > opp;
        $('duel-options').innerHTML = '';
        $('duel-timer-text').textContent = '';
        $('duel-question-num').textContent = 'Final';
        $('duel-question-text').textContent = `${me} HP vs ${opp} HP`;

        let xp = 0, title, grade, sub;
        if (draw) { title = 'DRAW'; grade = '🤝'; xp = 12; sub = 'Dead even.'; }
        else if (win) {
            title = 'VICTORY'; grade = '🏆';
            xp = du.mode === 'bot' ? du.botCfg.xp : 30; sub = du.mode === 'bot' ? `You beat ${du.botCfg.name}.` : 'You outplayed your opponent.';
            localStorage.setItem('duel_wins', String(num('duel_wins') + 1));
            sfx('snd-achievement');
        } else { title = 'DEFEATED'; grade = '💀'; xp = du.mode === 'bot' ? 3 : 8; sub = 'Good fight. Review and come back stronger.'; }
        if (xp && window.awardExp) awardExp(xp, win ? 'Quiz Duel won' : 'Quiz Duel played');

        const b = $('duel-result-banner');
        b.style.display = 'flex';
        b.innerHTML = `<div class="rd-grade">${grade}</div><div><div class="rd-result-title">${title}</div><div class="rd-result-sub">${sub} · +${xp} XP</div></div>`;

        const actions = $('duel-result-actions');
        if (du.mode === 'bot') {
            actions.innerHTML = '<button class="btn" onclick="duelStartBot()">🔁 REMATCH</button><button class="btn" onclick="duelBackToSetup()">⚙ NEW SETTINGS</button>';
        } else if (du.isHost) {
            actions.innerHTML = '<button class="btn" onclick="duelRematch()">🔁 REMATCH</button><button class="btn" onclick="duelBackToSetup()">← LEAVE</button>';
        } else {
            actions.innerHTML = '<div class="rd-feedback warn" style="grid-column:span 2;">Waiting for the host to start a rematch...</div><button class="btn" style="grid-column:span 2;" onclick="duelBackToSetup()">← LEAVE</button>';
        }
        $('duel-quit-btn').style.display = 'none';
        if (window.checkAndToastNewAchievements) checkAndToastNewAchievements();
    }

    window.duelRematch = function () {
        if (!du.isHost || !window.p2pIsConnected()) return;
        du.questions = []; du.finished = false; du.generating = false;
        enterArena('OPPONENT');
        startWithQuestions(true);
    };

    window.duelBackToSetup = function () {
        teardown();
        show('setup'); setStatus('');
    };

    window.duelQuit = function () {
        if (du.active && !du.finished && du.mode === 'pvp') {
            if (!window.confirm('Forfeit this duel?')) return;
            p2pSend({ type: 'duel-quit' });
        }
        duelBackToSetup();
    };
})();
