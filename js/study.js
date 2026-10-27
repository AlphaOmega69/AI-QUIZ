/**
 * ============================================================================
 * STUDY HUB — Notes, PDF library + in-app reader, local-folder music player
 * ============================================================================
 * PDFs are stored in IndexedDB (not localStorage — localStorage caps out
 * around 5-10MB total, which even a couple of PDFs would blow through).
 * Music files are read live from a folder you pick each session via the
 * File System Access — browsers don't allow a site to remember folder
 * access across reloads, for your own privacy/security, so you'll re-pick
 * the folder each visit. Nothing in either feature is uploaded anywhere.
 */

window.saveNotesAsPdf = function() {
    const text = (document.getElementById('study-notepad')?.value || '').trim();
    if (!text) { alert("Your notes are empty — write something first!"); return; }
    if (!window.jspdf || !window.jspdf.jsPDF) {
        alert("PDF export library didn't load — check your connection and try again.");
        return;
    }
    if (typeof playSound === 'function') playSound('snd-click');

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 50;
    const maxWidth = pageWidth - margin * 2;
    let y = margin;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.setTextColor(20, 20, 30);
    doc.text('AI Quiz Pro — Study Notes', margin, y);
    y += 20;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(120, 120, 130);
    doc.text(new Date().toLocaleString(), margin, y);
    y += 10;
    doc.setDrawColor(200, 200, 210);
    doc.line(margin, y, pageWidth - margin, y);
    y += 20;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(30, 30, 40);

    const paragraphs = text.split('\n');
    paragraphs.forEach(paragraph => {
        const lines = doc.splitTextToSize(paragraph || ' ', maxWidth);
        lines.forEach(line => {
            if (y > pageHeight - margin) { doc.addPage(); y = margin; }
            doc.text(line, margin, y);
            y += 15;
        });
    });

    doc.save(`study-notes-${new Date().toISOString().slice(0, 10)}.pdf`);
};

window.showStudyHub = function() {
    if (typeof playSound === 'function') playSound('snd-click');
    navigateTo('study');
    if (window.todayKey) localStorage.setItem('study_visited_date', todayKey());
    if (window.checkDailyTasks) checkDailyTasks();
    document.getElementById('study-notepad').value = localStorage.getItem('neural_notes') || '';
    renderPdfLibrary();
};

window.switchStudyTab = function(tabId, btn) {
    if (typeof playSound === 'function') playSound('snd-click');
    const scope = document.getElementById('page-study');
    scope.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    scope.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('study-tab-' + tabId).classList.add('active');
};

/* ============================================================================
   INDEXEDDB — small helper
   ============================================================================ */
const STUDY_DB_NAME = 'ai_quiz_pro_study';
const STUDY_DB_VERSION = 1;
let studyDbPromise = null;

function openStudyDb() {
    if (studyDbPromise) return studyDbPromise;
    studyDbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(STUDY_DB_NAME, STUDY_DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('pdfs')) {
                db.createObjectStore('pdfs', { keyPath: 'id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return studyDbPromise;
}

async function dbAddPdf(record) {
    const db = await openStudyDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pdfs', 'readwrite');
        tx.objectStore('pdfs').put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
async function dbGetAllPdfs() {
    const db = await openStudyDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pdfs', 'readonly');
        const req = tx.objectStore('pdfs').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
    });
}
async function dbGetPdf(id) {
    const db = await openStudyDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pdfs', 'readonly');
        const req = tx.objectStore('pdfs').get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
    });
}
async function dbDeletePdf(id) {
    const db = await openStudyDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('pdfs', 'readwrite');
        tx.objectStore('pdfs').delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/* ============================================================================
   PDF LIBRARY
   ============================================================================ */
window.handlePdfUpload = async function(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) {
        if (file.type !== 'application/pdf') continue;
        const buffer = await file.arrayBuffer();
        await dbAddPdf({
            id: `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            size: file.size,
            addedAt: new Date().toISOString(),
            data: buffer
        });
    }
    renderPdfLibrary();
    if (typeof playSound === 'function') playSound('snd-correct');
};

let selectedPdfIds = new Set();

async function renderPdfLibrary() {
    const list = document.getElementById('pdf-library-list');
    if (!list) return;
    let items;
    try { items = await dbGetAllPdfs(); }
    catch (e) { list.innerHTML = `<div class="report-empty">Couldn't access local PDF storage in this browser.</div>`; return; }

    // drop selections for PDFs that no longer exist (e.g. deleted)
    const existingIds = new Set(items.map(i => i.id));
    selectedPdfIds.forEach(id => { if (!existingIds.has(id)) selectedPdfIds.delete(id); });

    if (items.length === 0) {
        list.innerHTML = `<div class="report-empty">No PDFs added yet.</div>`;
        renderMegaQuizBar();
        return;
    }
    items.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
    list.innerHTML = items.map(item => `
        <div class="lib-item">
            <label class="pdf-select-check">
                <input type="checkbox" ${selectedPdfIds.has(item.id) ? 'checked' : ''} onchange="togglePdfSelect('${item.id}', this.checked)">
            </label>
            <span class="lib-name" title="${escStudy(item.name)}">📄 ${escStudy(item.name)}</span>
            <div style="display:flex; gap:6px; flex-shrink:0;">
                <button class="ui-btn" style="padding:5px 8px; font-size:0.55rem;" onclick="openPdfViewer('${item.id}')">OPEN</button>
                <button class="ui-btn" style="padding:5px 8px; font-size:0.55rem; border-color:var(--danger); color:var(--danger);" onclick="deletePdf('${item.id}')">DEL</button>
            </div>
        </div>
    `).join('');
    renderMegaQuizBar();
}

window.togglePdfSelect = function(id, checked) {
    if (checked) selectedPdfIds.add(id); else selectedPdfIds.delete(id);
    renderMegaQuizBar();
};

function renderMegaQuizBar() {
    const bar = document.getElementById('mega-quiz-bar');
    if (!bar) return;
    const n = selectedPdfIds.size;
    if (n >= 2) {
        bar.style.display = 'flex';
        document.getElementById('mega-quiz-count').textContent = `${n} PDFs selected`;
    } else {
        bar.style.display = 'none';
    }
}

window.generateMegaQuiz = async function() {
    if (selectedPdfIds.size < 2) return;
    if (typeof playSound === 'function') playSound('snd-click');

    const statusEl = document.getElementById('mega-quiz-count');
    const ids = [...selectedPdfIds];
    const names = [];
    let combinedText = '';

    try {
        for (const id of ids) {
            const record = await dbGetPdf(id);
            if (!record) continue;
            statusEl.textContent = `Reading ${record.name}...`;
            const text = await extractPdfText(record, 12);
            names.push(record.name.replace(/\.pdf$/i, ''));
            combinedText += `\n\n=== TOPIC: ${record.name.replace(/\.pdf$/i, '')} ===\n${text.slice(0, 6000)}`;
        }
    } catch (e) {
        alert("Couldn't read one of the selected PDFs: " + e.message);
        renderMegaQuizBar();
        return;
    }

    if (!combinedText.trim()) {
        alert("Couldn't extract any readable text from the selected PDFs.");
        return;
    }

    multimodalData = { type: 'text', payload: combinedText.trim() };
    if (window.setTargetQCount) setTargetQCount(100);
    const megaTopicName = `MEGA QUIZ: ${names.join(' + ')}`;

    selectedPdfIds.clear();
    renderMegaQuizBar();
    selectTopic(megaTopicName, true);
};

async function extractPdfText(record, maxPages) {
    const pdf = await pdfjsLib.getDocument({ data: record.data.slice(0) }).promise;
    let text = '';
    const pages = Math.min(pdf.numPages, maxPages || 12);
    for (let i = 1; i <= pages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(' ') + ' ';
    }
    return text.trim();
}

window.deletePdf = async function(id) {
    await dbDeletePdf(id);
    renderPdfLibrary();
};

function escStudy(str) {
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}

/* ============================================================================
   PDF READER (pdf.js, canvas paging) — pdfjsLib already loaded in app.js
   ============================================================================ */
let pdfCurrentDoc = null;
let pdfCurrentPage = 1;

window.openPdfViewer = async function(id) {
    const record = await dbGetPdf(id);
    if (!record) return;

    document.getElementById('pdf-library-list').style.display = 'none';
    document.querySelector('#study-tab-pdfs > .btn').style.display = 'none';
    document.getElementById('pdf-viewer').style.display = 'block';
    document.getElementById('pdf-viewer-title').textContent = record.name;

    try {
        const loadingTask = pdfjsLib.getDocument({ data: record.data.slice(0) });
        pdfCurrentDoc = await loadingTask.promise;
        pdfCurrentPage = 1;
        renderPdfPage();
    } catch (e) {
        console.error('PDF render failed:', e);
        alert("Couldn't open this PDF — it may be corrupted or password-protected.");
        closePdfViewer();
    }
};

async function renderPdfPage() {
    if (!pdfCurrentDoc) return;
    const page = await pdfCurrentDoc.getPage(pdfCurrentPage);
    const canvas = document.getElementById('pdf-canvas');
    const wrap = document.getElementById('pdf-canvas-wrap');
    const unscaledViewport = page.getViewport({ scale: 1 });

    // Fit-to-width in CSS pixels, then multiply by devicePixelRatio so the canvas
    // is actually rendered at the phone's native pixel density. Without this, a
    // canvas sized purely in CSS pixels gets blur-upscaled by the browser on any
    // high-DPI screen (basically every modern phone) — text looks visibly soft.
    const dpr = window.devicePixelRatio || 1;
    const cssScale = Math.min((wrap.clientWidth || 300) / unscaledViewport.width, 2.2);
    const viewport = page.getViewport({ scale: cssScale * dpr });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
    canvas.style.height = Math.floor(viewport.height / dpr) + 'px';

    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    document.getElementById('pdf-page-indicator').textContent = `PAGE ${pdfCurrentPage} / ${pdfCurrentDoc.numPages}`;
}

window.pdfPrevPage = function() {
    if (!pdfCurrentDoc || pdfCurrentPage <= 1) return;
    pdfCurrentPage--; renderPdfPage();
    if (typeof playSound === 'function') playSound('snd-click');
};
window.pdfNextPage = function() {
    if (!pdfCurrentDoc || pdfCurrentPage >= pdfCurrentDoc.numPages) return;
    pdfCurrentPage++; renderPdfPage();
    if (typeof playSound === 'function') playSound('snd-click');
};
window.closePdfViewer = function() {
    pdfCurrentDoc = null;
    document.getElementById('pdf-viewer').style.display = 'none';
    document.getElementById('pdf-library-list').style.display = 'block';
    const addBtn = document.querySelector('#study-tab-pdfs > .btn');
    if (addBtn) addBtn.style.display = 'block';
};

/* ============================================================================
   LOCAL FOLDER MUSIC PLAYER
   ============================================================================ */
let musicPlaylist = [];
let musicIndex = -1;
let musicShuffle = false;
const musicAudio = () => document.getElementById('study-music-player');

window.handleMusicFolder = function(event) {
    const files = Array.from(event.target.files || []).filter(f => f.type.startsWith('audio/'));
    if (files.length === 0) { alert('No audio files found in that folder.'); return; }

    // revoke any previous object URLs before replacing the playlist
    musicPlaylist.forEach(t => { if (t.url) URL.revokeObjectURL(t.url); });

    musicPlaylist = files.map(f => ({ name: f.name.replace(/\.[^/.]+$/, ''), url: URL.createObjectURL(f) }));
    musicIndex = -1;
    document.getElementById('music-player').style.display = 'block';
    renderMusicPlaylist();
    playMusicAt(0);
};

function renderMusicPlaylist() {
    const box = document.getElementById('music-playlist');
    box.innerHTML = musicPlaylist.map((t, i) => `
        <div class="music-track-row ${i === musicIndex ? 'playing' : ''}" onclick="playMusicAt(${i})">
            <span>${i === musicIndex ? '▶' : (i + 1)}</span>
            <span class="music-track-title">${escStudy(t.name)}</span>
        </div>
    `).join('');
}

window.playMusicAt = function(i) {
    if (i < 0 || i >= musicPlaylist.length) return;
    musicIndex = i;
    const audio = musicAudio();
    audio.src = musicPlaylist[i].url;
    audio.play().catch(() => {});
    document.getElementById('music-track-name').textContent = musicPlaylist[i].name;
    document.getElementById('music-play-btn').textContent = '⏸';
    renderMusicPlaylist();
};

window.musicTogglePlay = function() {
    const audio = musicAudio();
    if (!audio.src) { if (musicPlaylist.length) playMusicAt(0); return; }
    if (audio.paused) { audio.play().catch(() => {}); document.getElementById('music-play-btn').textContent = '⏸'; }
    else { audio.pause(); document.getElementById('music-play-btn').textContent = '▶'; }
};

window.musicNext = function() {
    if (musicPlaylist.length === 0) return;
    let next;
    if (musicShuffle) { next = Math.floor(Math.random() * musicPlaylist.length); }
    else { next = (musicIndex + 1) % musicPlaylist.length; }
    playMusicAt(next);
};
window.musicPrev = function() {
    if (musicPlaylist.length === 0) return;
    const prev = (musicIndex - 1 + musicPlaylist.length) % musicPlaylist.length;
    playMusicAt(prev);
};
window.musicToggleShuffle = function() {
    musicShuffle = !musicShuffle;
    document.getElementById('music-shuffle-btn').classList.toggle('active-toggle', musicShuffle);
};

document.addEventListener('DOMContentLoaded', () => {
    const audio = document.getElementById('study-music-player');
    if (!audio) return;
    audio.addEventListener('ended', () => musicNext());
    audio.addEventListener('timeupdate', () => {
        const fill = document.getElementById('music-track-progress-fill');
        if (fill && audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
    });
});

/**
 * ============================================================================
 * SPACED REPETITION — SuperMemo-2 (SM-2)
 * ============================================================================
 * Every question the user answers (fresh AI-generated or review) is recorded
 * here as a "card" keyed by a hash of its own text + topic, entirely in
 * localStorage. Each card tracks:
 *   - ef  (Ease Factor)      starts at 2.5, adjusts per SM-2's formula
 *   - i   (Interval, days)   1 -> 6 -> i*ef, reset to 1 on a failed recall
 *   - n   (Repetition count) consecutive successful reviews, resets on failure
 *   - due (ISO UTC timestamp) when the card next becomes eligible for review
 * "Due for Review" pulls every card whose due date has passed and re-quizzes
 * on them directly (no AI call needed — the question/options/answer/
 * explanation are stored on the card itself from when it was first seen).
 */
const SRS_BANK_KEY = 'srs_bank';
const SRS_DEFAULT_EF = 2.5;

function srsHash(str) {
    // Small, fast, deterministic string hash (djb2) — good enough for a local
    // dedupe key; collisions are harmless here since a duplicate id just
    // means "we already have this question" and updates the same card.
    let hash = 5381;
    for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
    return hash.toString(36);
}

function srsCardId(question, topic) {
    return srsHash(`${topic || ''}::${question}`);
}

function getSrsBank() {
    try { return JSON.parse(localStorage.getItem(SRS_BANK_KEY) || '{}'); }
    catch (e) { return {}; }
}
function saveSrsBank(bank) {
    localStorage.setItem(SRS_BANK_KEY, JSON.stringify(bank));
}

// quality: 0-5 scale per SM-2 (we derive it from correctness + hint usage
// below rather than asking the user to self-rate, which fits a quiz app better)
function sm2Apply(card, quality) {
    if (quality < 3) {
        card.n = 0;
        card.i = 1;
    } else {
        if (card.n === 0) card.i = 1;
        else if (card.n === 1) card.i = 6;
        else card.i = Math.round(card.i * card.ef);
        card.n += 1;
    }
    card.ef = card.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
    if (card.ef < 1.3) card.ef = 1.3;

    const now = new Date();
    card.lastReviewed = now.toISOString();
    const due = new Date(now);
    due.setUTCDate(due.getUTCDate() + card.i);
    card.due = due.toISOString();
    return card;
}

/**
 * Records the outcome of a single answered question against its SM-2 card,
 * creating the card on first encounter. Called from app.js's handleAnswer()
 * for every question, whether freshly AI-generated or a due-review replay.
 */
window.recordSm2Review = function(questionObj, isCorrect, hintUsed, topic) {
    if (!questionObj || !questionObj.q) return;
    const bank = getSrsBank();
    const id = srsCardId(questionObj.q, topic || '');
    let card = bank[id];
    if (!card) {
        card = {
            id, question: questionObj.q, options: questionObj.o,
            correctAnswer: questionObj.a, explanation: questionObj.exp,
            topic: topic || '', ef: SRS_DEFAULT_EF, i: 0, n: 0,
            due: new Date().toISOString(), createdAt: new Date().toISOString()
        };
    }
    // quality: correct+no-hint=5 (perfect recall), correct+hint=4 (recalled with help),
    // incorrect=1 (near-total failure) — maps our binary quiz outcome onto SM-2's 0-5 scale.
    const quality = !isCorrect ? 1 : (hintUsed ? 4 : 5);
    sm2Apply(card, quality);
    bank[id] = card;
    saveSrsBank(bank);
    if (window.renderDueReviewBadge) renderDueReviewBadge();
};

function getDueCards() {
    const bank = getSrsBank();
    const now = new Date().toISOString();
    return Object.values(bank).filter(c => c.due <= now);
}
window.getDueCards = getDueCards;

function getDueCardCount() {
    return getDueCards().length;
}
window.getDueCardCount = getDueCardCount;

// Reflects the current due-card count wherever the badge appears (Home + Daily pages)
window.renderDueReviewBadge = function() {
    const count = getDueCardCount();
    document.querySelectorAll('.due-review-count').forEach(el => el.textContent = count);
    document.querySelectorAll('.due-review-card-wrap').forEach(el => el.style.display = count > 0 ? 'block' : 'none');
};

/**
 * Starts a review quiz built entirely from due SM-2 cards — no AI call needed,
 * since each card already stored its full question/options/answer/explanation
 * from when it was first seen. Feeds directly into the existing quiz engine
 * by populating quizData exactly the way startQuiz() normally would.
 */
window.startDueReviewQuiz = function() {
    const due = getDueCards();
    if (due.length === 0) {
        alert("Nothing is due for review right now — nice work staying on top of it!");
        return;
    }
    if (window.QuizSession && !QuizSession.confirmReplace()) return;
    if (typeof playSound === 'function') playSound('snd-click');

    // shuffle so the review order isn't always the same
    const shuffled = [...due].sort(() => Math.random() - 0.5).slice(0, 30);
    const builtQuizData = shuffled.map(card => ({
        q: card.question,
        o: (Array.isArray(card.options) ? [...card.options] : [card.correctAnswer]).sort(() => Math.random() - 0.5),
        a: card.correctAnswer,
        exp: card.explanation || 'No explanation was saved for this question.'
    }));

    const topic = `DUE FOR REVIEW (${builtQuizData.length} cards)`;
    window.loadPrebuiltQuiz(builtQuizData, topic, 'Review');
    document.getElementById('gameplay-topic-name').textContent = topic.toUpperCase();

    if (window.QuizSession) QuizSession.showPanel('play');   // hides setup/result/review panels, shows the quiz
    if (window.enterQuizFocus) enterQuizFocus();
    if (window.resetPowerupButtonsForNewQuiz) resetPowerupButtonsForNewQuiz();
    showQ();
};

/**
 * ============================================================================
 * WEAK AREA DIAGNOSTIC + TARGETED REVISION SET
 * ============================================================================
 * Builds on the SM-2 bank above rather than a separate tracking system —
 * every question already answered (right or wrong) lives there with an Ease
 * Factor that naturally reflects how shaky it is (low EF = repeatedly hard).
 * "Weak" here means: failed on its most recent attempt, or has an EF close
 * to the 1.3 floor (a history of struggling), sorted worst-first.
 */
function getWeakQuestions(limit) {
    const bank = getSrsBank();
    const scored = Object.values(bank).map(card => ({
        card,
        // lower score = weaker. n===0 means the last attempt failed (SM-2 resets
        // repetitions to 0 on failure), so it's weighted heavily.
        weaknessScore: (card.n === 0 ? 0 : 10) + card.ef
    }));
    scored.sort((a, b) => a.weaknessScore - b.weaknessScore);
    return scored.slice(0, limit || 20).map(s => s.card);
}
window.getWeakQuestions = getWeakQuestions;

function getWeakTopics(limit) {
    const bank = getSrsBank();
    const byTopic = {};
    Object.values(bank).forEach(card => {
        const key = card.topic || 'Unknown';
        if (!byTopic[key]) byTopic[key] = { failures: 0, total: 0 };
        byTopic[key].total += 1;
        if (card.n === 0) byTopic[key].failures += 1;
    });
    return Object.entries(byTopic)
        .map(([topic, d]) => ({ topic, failRate: d.total > 0 ? d.failures / d.total : 0, total: d.total }))
        .filter(t => t.total >= 2)
        .sort((a, b) => b.failRate - a.failRate)
        .slice(0, limit || 5);
}
window.getWeakTopics = getWeakTopics;

/**
 * Called right after a quiz ends. Builds a 3-question set prioritizing
 * whatever was just missed in THIS quiz (most actionable/recent), padding
 * with other weak cards from the bank if fewer than 3 were missed here.
 * Returns null if there simply isn't enough weak material yet.
 */
window.buildTargetedRevisionSet = function(justMissedQuestions, topic) {
    const bank = getSrsBank();
    const seen = new Set();
    const picks = [];

    (justMissedQuestions || []).forEach(q => {
        if (picks.length >= 3) return;
        const id = srsCardId(q.question, topic || '');
        const card = bank[id];
        if (card && !seen.has(id)) { picks.push(card); seen.add(id); }
    });

    if (picks.length < 3) {
        getWeakQuestions(15).forEach(card => {
            if (picks.length >= 3) return;
            if (!seen.has(card.id)) { picks.push(card); seen.add(card.id); }
        });
    }

    if (picks.length === 0) return null;
    return picks.slice(0, 3);
};

window.startTargetedRevisionQuiz = function() {
    const set = window._pendingRevisionSet;
    if (!set || set.length === 0) return;
    if (typeof playSound === 'function') playSound('snd-click');

    const builtQuizData = set.map(card => ({
        q: card.question,
        o: (Array.isArray(card.options) ? [...card.options] : [card.correctAnswer]).sort(() => Math.random() - 0.5),
        a: card.correctAnswer,
        exp: card.explanation || 'No explanation was saved for this question.'
    }));

    const topic = `TARGETED REVISION (${builtQuizData.length} weak spots)`;
    window.loadPrebuiltQuiz(builtQuizData, topic, 'Review');
    document.getElementById('gameplay-topic-name').textContent = topic.toUpperCase();

    if (window.QuizSession) QuizSession.showPanel('play');   // hides setup/result/review panels, shows the quiz
    if (window.enterQuizFocus) enterQuizFocus();
    if (window.resetPowerupButtonsForNewQuiz) resetPowerupButtonsForNewQuiz();
    showQ();
};

/**
 * ============================================================================
 * FLASHCARDS — 3D-flip study mode with a Leitner box system
 * ============================================================================
 * Separate from the SM-2 quiz-question bank above on purpose: flashcards are
 * a different content type (a front/back pair you self-grade, not a graded
 * multiple-choice answer) and the Leitner box model is intentionally simpler
 * than SM-2 — 3 discrete boxes on fixed intervals rather than a continuously
 * adjusting ease factor. Box 1 = due again in 1 day, Box 2 = 3 days,
 * Box 3 = 7 days. A correct self-grade promotes a card one box (capped at 3);
 * an incorrect one demotes it straight back to Box 1.
 */
const LEITNER_BANK_KEY = 'leitner_bank';
const LEITNER_INTERVALS = { 1: 1, 2: 3, 3: 7 }; // box -> days

function getLeitnerBank() {
    try { return JSON.parse(localStorage.getItem(LEITNER_BANK_KEY) || '{}'); }
    catch (e) { return {}; }
}
function saveLeitnerBank(bank) {
    localStorage.setItem(LEITNER_BANK_KEY, JSON.stringify(bank));
}

function leitnerDueDate(box) {
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + (LEITNER_INTERVALS[box] || 1));
    return due.toISOString();
}

window.addFlashcard = function(front, back, source) {
    front = (front || '').trim(); back = (back || '').trim();
    if (!front || !back) return null;
    const bank = getLeitnerBank();
    const id = srsHash(`${front}::${back}`);
    if (bank[id]) return bank[id]; // already exists, don't duplicate
    const card = { id, front, back, box: 1, due: new Date().toISOString(), createdAt: new Date().toISOString(), source: source || 'manual' };
    bank[id] = card;
    saveLeitnerBank(bank);
    return card;
};

// Bulk-converts weak SM-2 questions into flashcards (question -> front, correct answer -> back)
window.addFlashcardsFromWeakQuestions = function(limit) {
    const weak = getWeakQuestions(limit || 10);
    let added = 0;
    weak.forEach(card => {
        const result = window.addFlashcard(card.question, card.correctAnswer, 'quiz');
        if (result) added++;
    });
    return added;
};

function getAllFlashcards() {
    return Object.values(getLeitnerBank()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
window.getAllFlashcards = getAllFlashcards;

function getDueFlashcards() {
    const now = new Date().toISOString();
    return Object.values(getLeitnerBank()).filter(c => c.due <= now);
}
window.getDueFlashcards = getDueFlashcards;

window.deleteFlashcard = function(id) {
    const bank = getLeitnerBank();
    delete bank[id];
    saveLeitnerBank(bank);
    renderFlashcardLibrary();
    renderFlashcardStats();
};

// Applies a Leitner self-grade and returns the updated card.
window.gradeFlashcard = function(id, knewIt) {
    const bank = getLeitnerBank();
    const card = bank[id];
    if (!card) return null;
    card.box = knewIt ? Math.min(3, card.box + 1) : 1;
    card.due = leitnerDueDate(card.box);
    card.lastReviewed = new Date().toISOString();
    bank[id] = card;
    saveLeitnerBank(bank);
    return card;
};

/* ---- Study session state (in-memory, one card visible at a time) ---- */
let flashcardQueue = [];
let flashcardIndex = 0;

window.startFlashcardSession = function() {
    flashcardQueue = getDueFlashcards().sort(() => Math.random() - 0.5);
    flashcardIndex = 0;
    if (flashcardQueue.length === 0) {
        document.getElementById('flashcard-session-empty').style.display = 'block';
        document.getElementById('flashcard-session-active').style.display = 'none';
        return;
    }
    document.getElementById('flashcard-session-empty').style.display = 'none';
    document.getElementById('flashcard-session-active').style.display = 'block';
    renderCurrentFlashcard();
};

function renderCurrentFlashcard() {
    const wrap = document.getElementById('flashcard-3d');
    const progressEl = document.getElementById('flashcard-progress');
    if (flashcardIndex >= flashcardQueue.length) {
        document.getElementById('flashcard-session-active').style.display = 'none';
        document.getElementById('flashcard-session-done').style.display = 'block';
        return;
    }
    const card = flashcardQueue[flashcardIndex];
    wrap.classList.remove('flipped');
    document.getElementById('flashcard-front-text').textContent = card.front;
    document.getElementById('flashcard-back-text').textContent = card.back;
    document.getElementById('flashcard-grade-buttons').style.display = 'none';
    if (progressEl) progressEl.textContent = `${flashcardIndex + 1} / ${flashcardQueue.length}`;
}

window.flipFlashcard = function() {
    const wrap = document.getElementById('flashcard-3d');
    const willFlip = !wrap.classList.contains('flipped');
    wrap.classList.toggle('flipped', willFlip);
    if (typeof playSound === 'function') playSound('snd-click');
    if (willFlip) document.getElementById('flashcard-grade-buttons').style.display = 'flex';
};

window.answerFlashcard = function(knewIt) {
    const card = flashcardQueue[flashcardIndex];
    if (!card) return;
    gradeFlashcard(card.id, knewIt);
    if (typeof playSound === 'function') playSound(knewIt ? 'snd-correct' : 'snd-wrong');
    flashcardIndex++;
    setTimeout(renderCurrentFlashcard, 250);
};

function renderFlashcardStats() {
    const dueCountEl = document.getElementById('flashcard-due-count');
    const totalCountEl = document.getElementById('flashcard-total-count');
    if (dueCountEl) dueCountEl.textContent = getDueFlashcards().length;
    if (totalCountEl) totalCountEl.textContent = getAllFlashcards().length;
}
window.renderFlashcardStats = renderFlashcardStats;

function renderFlashcardLibrary() {
    const list = document.getElementById('flashcard-library-list');
    if (!list) return;
    const cards = getAllFlashcards();
    if (cards.length === 0) {
        list.innerHTML = `<div class="report-empty">No flashcards yet — add one manually or generate a set from your weak questions.</div>`;
        return;
    }
    const boxLabel = { 1: 'Box 1 · 1 day', 2: 'Box 2 · 3 days', 3: 'Box 3 · 7 days' };
    list.innerHTML = cards.map(c => `
        <div class="lib-item flashcard-lib-item">
            <div style="min-width:0; flex:1;">
                <div class="lib-name" style="max-width:none; white-space:normal;">${escStudy(c.front)}</div>
                <div class="flashcard-box-tag">${boxLabel[c.box] || 'Box 1'}</div>
            </div>
            <button class="ui-btn" style="padding:5px 8px; font-size:0.55rem; border-color:var(--danger); color:var(--danger);" onclick="deleteFlashcard('${c.id}')">DEL</button>
        </div>
    `).join('');
}
window.renderFlashcardLibrary = renderFlashcardLibrary;

window.showFlashcardsPage = function() {
    if (typeof playSound === 'function') playSound('snd-click');
    navigateTo('flashcards');
    document.getElementById('flashcard-session-active').style.display = 'none';
    document.getElementById('flashcard-session-done').style.display = 'none';
    document.getElementById('flashcard-session-empty').style.display = 'none';
    renderFlashcardStats();
    renderFlashcardLibrary();
};

window.submitNewFlashcard = function() {
    const front = document.getElementById('flashcard-front-input').value;
    const back = document.getElementById('flashcard-back-input').value;
    const card = window.addFlashcard(front, back, 'manual');
    if (!card) { alert("Fill in both the front and back of the card."); return; }
    document.getElementById('flashcard-front-input').value = '';
    document.getElementById('flashcard-back-input').value = '';
    if (typeof playSound === 'function') playSound('snd-correct');
    renderFlashcardStats();
    renderFlashcardLibrary();
};

window.generateFlashcardsFromWeakSpots = function() {
    const added = window.addFlashcardsFromWeakQuestions(10);
    if (added === 0) {
        alert("No weak questions found yet — take a few quizzes first, then come back to generate flashcards from what you missed.");
        return;
    }
    if (typeof playSound === 'function') playSound('snd-achievement');
    renderFlashcardStats();
    renderFlashcardLibrary();
};
