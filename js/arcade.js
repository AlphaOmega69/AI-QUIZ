/**
 * ============================================================================
 * ARCADE HUB — launcher page: lifetime stats + the Daily Riddle
 * ============================================================================
 * The hub is deliberately "dumb": it only reads stats and renders the daily
 * riddle. Games live in their own windows (#page-riddles, #page-duel — see
 * riddles.js / quizduel.js) and are opened with navigateTo(). Visiting the hub
 * never touches a game in progress.
 */
(function () {
    'use strict';

    function $(id) { return document.getElementById(id); }
    function num(key) { return parseInt(localStorage.getItem(key) || '0', 10) || 0; }

    function todayKey() {
        const d = new Date();
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    // Same riddle for everyone on a given date, rotating through the whole bank.
    function dailyRiddle() {
        const bank = window.RiddleCore ? window.RiddleCore.bank : [];
        if (!bank.length) return null;
        const key = todayKey();
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return bank[h % bank.length];
    }

    let dailyWrong = 0;

    window.renderArcadeHub = function () {
        if (!$('arcade-stat-riddles')) return;
        $('arcade-stat-riddles').textContent = num('riddles_solved');
        $('arcade-stat-best').textContent = num('riddle_best_score');
        $('arcade-stat-streak').textContent = num('riddle_best_streak');
        $('arcade-stat-duel').textContent = num('duel_wins');
        renderDaily();
    };

    function renderDaily() {
        const r = dailyRiddle();
        const status = $('daily-riddle-status'), text = $('daily-riddle-text'),
              form = $('daily-riddle-form'), fb = $('daily-riddle-feedback');
        if (!r || !status) return;
        text.textContent = r.q;
        const done = localStorage.getItem('daily_riddle_date') === todayKey();
        if (done) {
            status.textContent = '✔ SOLVED TODAY · NEW RIDDLE TOMORROW';
            status.className = 'arcade-daily-status done';
            form.style.display = 'none';
            fb.className = 'rd-feedback good';
            fb.textContent = 'Answer: ' + window.RiddleCore.pretty(r.a[0]);
        } else {
            status.textContent = '📅 DAILY RIDDLE · +15 XP';
            status.className = 'arcade-daily-status';
            form.style.display = 'block';
            fb.className = 'rd-feedback'; fb.textContent = '';
        }
    }

    window.submitDailyRiddle = function () {
        const r = dailyRiddle();
        const input = $('daily-riddle-input'), fb = $('daily-riddle-feedback');
        if (!r || !input || !input.value.trim()) return;
        if (window.RiddleCore.isCorrect(r, input.value)) {
            localStorage.setItem('daily_riddle_date', todayKey());
            localStorage.setItem('daily_riddle_total', String(num('daily_riddle_total') + 1));
            localStorage.setItem('riddles_solved', String(num('riddles_solved') + 1));
            input.value = ''; dailyWrong = 0;
            if (typeof playSound === 'function') playSound('snd-correct');
            if (window.awardExp) awardExp(15, 'Daily Riddle');
            if (window.checkAndToastNewAchievements) checkAndToastNewAchievements();
            window.renderArcadeHub();
        } else {
            dailyWrong++;
            if (typeof playSound === 'function') playSound('snd-wrong');
            if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
            fb.className = 'rd-feedback bad';
            fb.textContent = dailyWrong >= 3 ? '✕ Not yet. Hint: ' + r.h : '✕ Not quite — give it another go.';
            input.select();
        }
    };
})();
