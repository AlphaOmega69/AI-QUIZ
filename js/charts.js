/**
 * ============================================================================
 * VIZ — dependency-free charts for Analytics + Report
 * ============================================================================
 * No Chart.js, no network: everything is inline SVG / HTML and works offline.
 * Colours come from the app's CSS variables, so dark / light theme switches
 * need no re-render. Every chart has:
 *   - a headline figure (+ delta) instead of a bare plot
 *   - hover / touch / keyboard tooltips (one readout per position)
 *   - a TABLE view with the same numbers (tooltips never gate information)
 *   - labels that are only on the points that matter (latest / best / worst)
 * All text from user data goes through textContent (topic names are untrusted).
 */
(function () {
    'use strict';

    const NS = 'http://www.w3.org/2000/svg';
    let uid = 0;
    const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ---------- tiny DOM helpers ---------- */
    function h(tag, attrs, ...kids) {
        const el = document.createElement(tag);
        if (attrs) for (const k in attrs) {
            if (k === 'class') el.className = attrs[k];
            else if (k === 'text') el.textContent = attrs[k];
            else el.setAttribute(k, attrs[k]);
        }
        kids.forEach(c => { if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
        return el;
    }
    function s(tag, attrs, ...kids) {
        const el = document.createElementNS(NS, tag);
        if (attrs) for (const k in attrs) el.setAttribute(k, attrs[k]);
        kids.forEach(c => { if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c))); });
        return el;
    }

    /* ---------- status tiers (colour never travels alone: label + glyph too) ---------- */
    function tier(pct) {
        if (pct >= 80) return { key: 'strong', label: 'Strong', glyph: '▲' };
        if (pct >= 50) return { key: 'mid', label: 'Developing', glyph: '●' };
        return { key: 'weak', label: 'Needs work', glyph: '▼' };
    }

    /* ---------- shared tooltip ---------- */
    let tipEl = null;
    function tip() {
        if (!tipEl) { tipEl = h('div', { class: 'vz-tip', role: 'status' }); tipEl.style.display = 'none'; document.body.append(tipEl); }
        return tipEl;
    }
    function showTip(clientX, clientY, spec) {
        const t = tip();
        t.textContent = '';
        t.append(h('div', { class: 'vz-tip-title', text: spec.title }));
        const val = h('div', { class: 'vz-tip-row' });
        if (spec.tone) val.append(h('span', { class: 'vz-tip-key tone-' + spec.tone }));
        val.append(h('span', { class: 'vz-tip-val', text: spec.value }));
        if (spec.tag) val.append(h('span', { class: 'vz-tip-tag', text: spec.tag }));
        t.append(val);
        if (spec.sub) t.append(h('div', { class: 'vz-tip-sub', text: spec.sub }));
        t.style.display = 'block';
        const r = t.getBoundingClientRect(), pad = 10;
        let x = clientX + 14, y = clientY - r.height - 12;
        if (x + r.width > innerWidth - pad) x = clientX - r.width - 14;
        if (x < pad) x = pad;
        if (y < pad) y = clientY + 18;
        t.style.left = x + 'px'; t.style.top = y + 'px';
    }
    function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('pagehide', hideTip);

    /* ---------- card shell: headline + delta + TABLE toggle + plot + table ---------- */
    function shell(host, o) {
        host.textContent = '';
        host.classList.add('vz-card');
        if (host.__vzRO) { host.__vzRO.disconnect(); host.__vzRO = null; }

        const head = h('div', { class: 'vz-head' });
        const left = h('div', { class: 'vz-head-main' });
        if (o.kicker) left.append(h('div', { class: 'vz-kicker', text: o.kicker }));
        if (o.value != null) {
            const row = h('div', { class: 'vz-hero-row' }, h('span', { class: 'vz-hero', text: o.value }));
            if (o.delta) row.append(h('span', { class: 'vz-delta ' + o.delta.dir, text: o.delta.text }));
            left.append(row);
        }
        if (o.sub) left.append(h('div', { class: 'vz-sub', text: o.sub }));
        const toggle = h('button', { class: 'vz-toggle', type: 'button', 'aria-pressed': 'false', text: 'TABLE' });
        head.append(left, toggle);

        const plot = h('div', { class: 'vz-plot' });
        const legend = o.legend ? legendRow(o.legend) : null;

        const table = h('table', { class: 'vz-table' });
        const thead = h('thead'), trh = h('tr');
        o.table.cols.forEach(c => trh.append(h('th', { scope: 'col', text: c })));
        thead.append(trh); table.append(thead);
        const tb = h('tbody');
        o.table.rows.forEach(r => { const tr = h('tr'); r.forEach(c => tr.append(h('td', { text: c }))); tb.append(tr); });
        table.append(tb);
        const tableWrap = h('div', { class: 'vz-table-wrap' }, table);
        tableWrap.hidden = true;

        toggle.addEventListener('click', () => {
            const on = tableWrap.hidden;           // hidden -> about to show the table
            tableWrap.hidden = !on; plot.hidden = on; if (legend) legend.hidden = on;
            toggle.setAttribute('aria-pressed', String(on));
            toggle.textContent = on ? 'CHART' : 'TABLE';
            hideTip();
        });

        host.append(head, plot);
        if (legend) host.append(legend);
        host.append(tableWrap);
        return plot;
    }

    function legendRow(items) {
        const row = h('div', { class: 'vz-legend' });
        items.forEach(it => {
            const key = h('span', { class: 'vz-lkey ' + (it.shape || 'dot') + ' ' + (it.cls || '') });
            row.append(h('span', { class: 'vz-litem' }, key, h('span', { text: it.text })));
        });
        return row;
    }

    function observe(host, plot, draw) {
        let last = 0;
        const run = () => {
            const w = Math.floor(plot.clientWidth);
            if (w < 40 || w === last) return;
            last = w; draw(w);
        };
        run();
        if (window.ResizeObserver) { host.__vzRO = new ResizeObserver(run); host.__vzRO.observe(plot); }
    }

    /* ---------- monotone cubic path (no overshoot below 0 / above 100) ---------- */
    function smoothPath(p) {
        const n = p.length;
        if (n === 1) return 'M' + p[0].x + ' ' + p[0].y;
        if (n === 2) return 'M' + p[0].x + ' ' + p[0].y + 'L' + p[1].x + ' ' + p[1].y;
        const dx = [], m = [], t = new Array(n);
        for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1].x - p[i].x; m[i] = (p[i + 1].y - p[i].y) / dx[i]; }
        t[0] = m[0]; t[n - 1] = m[n - 2];
        for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
        for (let i = 0; i < n - 1; i++) {
            if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
            const a = t[i] / m[i], b = t[i + 1] / m[i], q = a * a + b * b;
            if (q > 9) { const k = 3 / Math.sqrt(q); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
        }
        let d = 'M' + p[0].x + ' ' + p[0].y;
        for (let i = 0; i < n - 1; i++) {
            const w = dx[i] / 3;
            d += 'C' + (p[i].x + w) + ' ' + (p[i].y + t[i] * w) + ' ' + (p[i + 1].x - w) + ' ' + (p[i + 1].y - t[i + 1] * w) + ' ' + p[i + 1].x + ' ' + p[i + 1].y;
        }
        return d;
    }

    /* ======================================================================
       LINE — score trend (smooth line, wash fill, mastery line, rolling avg)
       pts: [{label, value, topic, sub}]   value 0..100
       ====================================================================== */
    function line(host, o) {
        const pts = o.points, n = pts.length;
        const vals = pts.map(p => p.value);
        const latest = vals[n - 1], avg = Math.round(vals.reduce((a, b) => a + b, 0) / n);
        const best = Math.max.apply(null, vals);
        let delta = null;
        if (n > 1) {
            const d = latest - vals[n - 2];
            delta = d === 0 ? { dir: 'flat', text: '— no change' } :
                { dir: d > 0 ? 'up' : 'down', text: (d > 0 ? '▲ +' : '▼ ') + d + ' pts vs previous' };
        }
        const showAvg = n >= 5;
        const roll = vals.map((_, i) => { const a = vals.slice(Math.max(0, i - 2), i + 1); return a.reduce((x, y) => x + y, 0) / a.length; });

        const plot = shell(host, {
            kicker: 'LATEST SESSION', value: latest + '%', delta,
            sub: n + (n === 1 ? ' session' : ' sessions') + ' · average ' + avg + '% · best ' + best + '%',
            legend: [{ shape: 'line', cls: 'k-primary', text: 'Score' }]
                .concat(showAvg ? [{ shape: 'line', cls: 'k-muted', text: '3-session average' }] : [])
                .concat([{ shape: 'tick', cls: 'k-success', text: 'Mastery 80%' }]),
            table: { cols: ['#', 'Topic', 'Score', 'Result'], rows: pts.map(p => [p.label, p.topic, p.value + '%', p.sub]) }
        });

        const id = 'vzg' + (++uid);
        const animate = !host.__vzDrawn && !reduceMotion();

        observe(host, plot, function (W) {
            plot.textContent = '';
            const H = W < 420 ? 200 : 240;
            const m = { l: 38, r: 14, t: 18, b: 28 };
            const iw = W - m.l - m.r, ih = H - m.t - m.b;
            const X = i => m.l + 10 + (n === 1 ? (iw - 20) / 2 : (iw - 20) * i / (n - 1));
            const Y = v => m.t + ih * (1 - v / 100);

            const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'vz-svg', tabindex: '0', role: 'img',
                'aria-label': 'Score trend over ' + n + ' sessions. Latest ' + latest + ' percent, average ' + avg + ' percent. Use left and right arrow keys to read each session.' });
            const defs = s('defs');
            const grad = s('linearGradient', { id: id, x1: 0, y1: 0, x2: 0, y2: 1 });
            grad.append(s('stop', { offset: '0%', class: 'vz-stop-a' }), s('stop', { offset: '100%', class: 'vz-stop-b' }));
            defs.append(grad); svg.append(defs);

            // grid + y ticks (hairline, solid, recessive)
            [0, 25, 50, 75, 100].forEach(v => {
                svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? 'vz-axis' : 'vz-grid' }));
                svg.append(s('text', { x: m.l - 8, y: Y(v) + 4, class: 'vz-tick', 'text-anchor': 'end' }, v + '%'));
            });
            // mastery reference
            svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(80), y2: Y(80), class: 'vz-ref' }));

            // x labels (thin out when crowded)
            const every = Math.ceil(n / Math.max(2, Math.floor(iw / 44)));
            pts.forEach((p, i) => {
                if (i % every === 0 || i === n - 1)
                    svg.append(s('text', { x: X(i), y: H - 8, class: 'vz-tick', 'text-anchor': 'middle' }, p.label));
            });

            const P = pts.map((p, i) => ({ x: X(i), y: Y(p.value) }));
            if (showAvg) {
                const A = roll.map((v, i) => ({ x: X(i), y: Y(v) }));
                svg.append(s('path', { d: smoothPath(A), class: 'vz-line-avg' }));
            }
            if (n > 1) {
                const d = smoothPath(P);
                svg.append(s('path', { d: d + 'L' + P[n - 1].x + ' ' + Y(0) + 'L' + P[0].x + ' ' + Y(0) + 'Z', fill: 'url(#' + id + ')', class: 'vz-area' + (animate ? ' vz-fade' : '') }));
                svg.append(s('path', { d: d, pathLength: 1, class: 'vz-line' + (animate ? ' vz-draw' : '') }));
            }
            // markers: all when few, otherwise only the latest
            const markAll = n <= 12;
            P.forEach((q, i) => { if (markAll || i === n - 1) svg.append(s('circle', { cx: q.x, cy: q.y, r: 4, class: 'vz-dot' + (i === n - 1 ? ' last' : '') })); });
            // end label (the one direct label)
            const ex = P[n - 1].x, ey = P[n - 1].y;
            const below = ey < m.t + 16 || (n > 1 && P[n - 2].y < ey);   // keep the label off the incoming line
            svg.append(s('text', { x: Math.min(ex, W - m.r - 2), y: below ? ey + 22 : ey - 12, class: 'vz-endlabel', 'text-anchor': ex > W - 50 ? 'end' : 'middle' }, latest + '%'));

            // hover layer
            const cross = s('line', { y1: m.t, y2: Y(0), class: 'vz-cross', style: 'display:none' });
            const act = s('circle', { r: 6, class: 'vz-dot active', style: 'display:none' });
            svg.append(cross, act);

            let cur = -1;
            const focus = (i, cx, cy) => {
                i = Math.max(0, Math.min(n - 1, i)); cur = i;
                cross.setAttribute('x1', P[i].x); cross.setAttribute('x2', P[i].x); cross.style.display = '';
                act.setAttribute('cx', P[i].x); act.setAttribute('cy', P[i].y); act.style.display = '';
                const r = svg.getBoundingClientRect();
                const t = tier(pts[i].value);
                showTip(cx != null ? cx : r.left + P[i].x, cy != null ? cy : r.top + P[i].y, {
                    title: 'Session ' + pts[i].label + ' · ' + pts[i].topic, value: pts[i].value + '%',
                    tone: t.key, tag: t.glyph + ' ' + t.label, sub: pts[i].sub
                });
            };
            const clear = () => { cross.style.display = 'none'; act.style.display = 'none'; hideTip(); cur = -1; };
            const pick = e => {
                const r = svg.getBoundingClientRect(), x = e.clientX - r.left;
                let bi = 0, bd = 1e9;
                P.forEach((q, i) => { const d = Math.abs(q.x - x); if (d < bd) { bd = d; bi = i; } });
                focus(bi, e.clientX, e.clientY);
            };
            svg.addEventListener('pointermove', pick);
            svg.addEventListener('pointerdown', pick);
            svg.addEventListener('pointerleave', clear);
            svg.addEventListener('blur', clear);
            svg.addEventListener('keydown', e => {
                if (e.key === 'ArrowLeft') { focus((cur < 0 ? n : cur) - 1); e.preventDefault(); }
                else if (e.key === 'ArrowRight') { focus(cur < 0 ? 0 : cur + 1); e.preventDefault(); }
                else if (e.key === 'Escape') clear();
            });
            plot.append(svg);
            host.__vzDrawn = true;
        });
    }

    /* ======================================================================
       BARS — ranked horizontal bars (accuracy by topic, time by topic)
       rows: [{label, value, sub, text}]
       o: {max, unit, tiers, ref:{value,text}, kicker, headline, sub, legend}
       ====================================================================== */
    function bars(host, o) {
        const rows = o.rows;
        const plot = shell(host, {
            kicker: o.kicker, value: o.headline, sub: o.sub, legend: o.legend,
            table: { cols: o.tableCols, rows: rows.map(r => [r.label, r.text, r.sub]) }
        });
        plot.classList.add('vz-bars');
        const max = o.max || Math.max.apply(null, rows.map(r => r.value)) * 1.08 || 1;
        const animate = !host.__vzDrawn && !reduceMotion();
        const fills = [];

        rows.forEach(r => {
            const t = o.tiers ? tier(r.value) : null;
            const row = h('div', { class: 'vz-brow', tabindex: '0' });
            const name = h('span', { class: 'vz-bname', text: r.label });
            const val = h('span', { class: 'vz-bval', text: r.text });
            const head = h('div', { class: 'vz-bhead' }, name, val);
            if (t) head.append(h('span', { class: 'vz-btier tone-' + t.key, text: t.glyph + ' ' + t.label }));
            const track = h('div', { class: 'vz-btrack' });
            const fill = h('div', { class: 'vz-bfill ' + (t ? 'tone-' + t.key : 'tone-primary') });
            fill.style.width = animate ? '0%' : (Math.max(r.value / max, 0.012) * 100) + '%';
            fills.push([fill, Math.max(r.value / max, 0.012) * 100]);
            track.append(fill);
            if (o.ref) {
                const tk = h('div', { class: 'vz-bref' });
                tk.style.left = Math.min(o.ref.value / max, 1) * 100 + '%';
                track.append(tk);
            }
            row.append(head, track);
            if (r.sub) row.append(h('div', { class: 'vz-bsub', text: r.sub }));
            row.setAttribute('aria-label', r.label + ': ' + r.text + (t ? ', ' + t.label : '') + (r.sub ? '. ' + r.sub : ''));

            const spec = (cx, cy) => showTip(cx, cy, { title: r.label, value: r.text, tone: t ? t.key : 'primary', tag: t ? t.glyph + ' ' + t.label : '', sub: r.sub });
            row.addEventListener('pointermove', e => spec(e.clientX, e.clientY));
            row.addEventListener('pointerdown', e => spec(e.clientX, e.clientY));
            row.addEventListener('pointerleave', hideTip);
            row.addEventListener('focus', () => { const b = row.getBoundingClientRect(); spec(b.left + b.width / 2, b.top); });
            row.addEventListener('blur', hideTip);
            plot.append(row);
        });
        if (animate) requestAnimationFrame(() => requestAnimationFrame(() => fills.forEach(([f, w]) => { f.style.width = w + '%'; })));
        host.__vzDrawn = true;
    }

    /* ======================================================================
       COLUMNS — per-session results (report page)
       pts: [{label, value, topic, sub}]
       ====================================================================== */
    function columns(host, o) {
        const pts = o.points, n = pts.length, vals = pts.map(p => p.value);
        const avg = Math.round(vals.reduce((a, b) => a + b, 0) / n);
        const iMax = vals.indexOf(Math.max.apply(null, vals)), iMin = vals.indexOf(Math.min.apply(null, vals));
        const plot = shell(host, {
            kicker: 'LAST ' + n + ' SESSIONS', value: avg + '%', sub: 'average · best ' + vals[iMax] + '% · lowest ' + vals[iMin] + '%',
            legend: [
                { shape: 'dot', cls: 'tone-strong', text: '▲ Strong ≥80%' },
                { shape: 'dot', cls: 'tone-mid', text: '● Developing 50–79%' },
                { shape: 'dot', cls: 'tone-weak', text: '▼ Needs work <50%' }
            ],
            table: { cols: ['#', 'Topic', 'Score', 'Result'], rows: pts.map(p => [p.label, p.topic, p.value + '%', p.sub]) }
        });
        const animate = !host.__vzDrawn && !reduceMotion();

        observe(host, plot, function (W) {
            plot.textContent = '';
            const H = 180, m = { l: 34, r: 8, t: 20, b: 26 };
            const iw = W - m.l - m.r, ih = H - m.t - m.b;
            const slot = iw / n, bw = Math.min(24, slot * 0.62);
            const Y = v => m.t + ih * (1 - v / 100);
            const svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, class: 'vz-svg', role: 'img',
                'aria-label': 'Score of the last ' + n + ' sessions, average ' + avg + ' percent' });
            [0, 50, 100].forEach(v => {
                svg.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: v === 0 ? 'vz-axis' : 'vz-grid' }));
                svg.append(s('text', { x: m.l - 8, y: Y(v) + 4, class: 'vz-tick', 'text-anchor': 'end' }, v + '%'));
            });
            const hits = [];
            pts.forEach((p, i) => {
                const cx = m.l + slot * (i + 0.5), x = cx - bw / 2;
                const hgt = Math.max(ih * p.value / 100, 3), y = Y(0) - hgt, r = Math.min(4, hgt);
                const t = tier(p.value);
                const d = 'M' + x + ' ' + (y + hgt) + 'V' + (y + r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' -' + r + 'H' + (x + bw - r) + 'a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r + 'V' + (y + hgt) + 'Z';
                const col = s('path', { d: d, class: 'vz-col tone-' + t.key + (animate ? ' vz-grow' : ''), style: animate ? 'animation-delay:' + (i * 45) + 'ms' : '' });
                svg.append(col);
                if (i === n - 1 || i === iMax || i === iMin)
                    svg.append(s('text', { x: cx, y: y - 6, class: 'vz-endlabel', 'text-anchor': 'middle' }, p.value + '%'));
                if (n <= 6 || i % 2 === 0 || i === n - 1)
                    svg.append(s('text', { x: cx, y: H - 8, class: 'vz-tick', 'text-anchor': 'middle' }, p.label));
                const hit = s('rect', { x: cx - slot / 2, y: m.t, width: slot, height: ih + 6, class: 'vz-hit', tabindex: '0', 'aria-label': 'Session ' + p.label + ', ' + p.topic + ': ' + p.value + ' percent, ' + t.label });
                const show = (cx2, cy2) => { col.classList.add('hot'); showTip(cx2, cy2, { title: 'Session ' + p.label + ' · ' + p.topic, value: p.value + '%', tone: t.key, tag: t.glyph + ' ' + t.label, sub: p.sub }); };
                hit.addEventListener('pointermove', e => show(e.clientX, e.clientY));
                hit.addEventListener('pointerdown', e => show(e.clientX, e.clientY));
                hit.addEventListener('pointerleave', () => { col.classList.remove('hot'); hideTip(); });
                hit.addEventListener('focus', () => { const b = hit.getBoundingClientRect(); show(b.left + b.width / 2, b.top + 20); });
                hit.addEventListener('blur', () => { col.classList.remove('hot'); hideTip(); });
                hits.push(hit);
            });
            hits.forEach(x => svg.append(x));
            plot.append(svg);
            host.__vzDrawn = true;
        });
    }

    window.Viz = { line, bars, columns, tier, hideTip };
})();
