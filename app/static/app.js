(() => {
  'use strict';

  /* ---------- Helpers ---------- */

  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, props = {}, ...kids) {
    const node = document.createElement(tag);
    for (const [key, val] of Object.entries(props)) {
      if (val == null || val === false) continue;
      if (key === 'class') node.className = val;
      else if (key === 'dataset') Object.assign(node.dataset, val);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), val);
      else node.setAttribute(key, val === true ? '' : val);
    }
    for (const kid of kids.flat()) {
      if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return node;
  }

  const esc = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
    },
  };

  /* ---------- State ---------- */

  const app = $('#app');
  const thread = $('#thread');
  const scroller = $('#scroller');
  const input = $('#input');
  const sendBtn = $('#send');
  const composer = $('#composer');
  const docList = $('#docList');
  const hello = $('#hello');

  const state = {
    docs: [],
    pending: [],                              // uploads in flight or just failed
    excluded: new Set(store.get('folio.excluded', [])),
    thread: [],
    streaming: false,
    abort: null,
    active: null,                             // { i, n, claim } for the open passage
  };

  const SUPPORTED = /\.(pdf|txt|md|markdown)$/i;

  /* ---------- Library ---------- */

  async function loadDocs() {
    try {
      const res = await fetch('/api/documents');
      if (!res.ok) throw new Error();
      state.docs = await res.json();
    } catch {
      state.docs = [];
      $('#railEmpty').textContent = "Couldn't reach the server. Check that Folio is running, then reload.";
    }
    renderDocs();
  }

  function renderDocs() {
    const rows = [];

    for (const p of state.pending) {
      rows.push(
        el('li', { class: `doc pending ${p.status === 'error' ? 'failed' : ''}` },
          el('div', { class: 'doc-main' },
            el('span', { class: 'doc-box', 'aria-hidden': 'true' }),
            el('span', { class: 'doc-text' },
              el('span', { class: 'doc-name' }, p.name),
              el('span', { class: 'doc-meta', role: p.status === 'error' ? 'alert' : null },
                p.status === 'working' ? 'Reading and indexing' : p.message),
              p.status === 'working' ? el('div', { class: 'bar', 'aria-hidden': 'true' }) : null)),
          p.status !== 'working'
            ? el('button', { class: 'doc-del', type: 'button', 'aria-label': 'Dismiss', onclick: () => {
                state.pending = state.pending.filter((x) => x !== p); renderDocs();
              } }, 'Dismiss')
            : null));
    }

    for (const d of state.docs) {
      const included = !state.excluded.has(d.id);
      const meta = [d.pages ? plural(d.pages, 'page') : null, plural(d.chunk_count, 'passage')]
        .filter(Boolean).join(', ');
      const check = el('input', { class: 'doc-check', type: 'checkbox', checked: included,
        'aria-label': `Search ${d.filename}` });
      check.checked = included;
      check.addEventListener('change', () => {
        if (check.checked) state.excluded.delete(d.id); else state.excluded.add(d.id);
        store.set('folio.excluded', [...state.excluded]);
        row.classList.toggle('off', !check.checked);
        updateScope();
      });
      const del = el('button', { class: 'doc-del', type: 'button', 'aria-label': `Remove ${d.filename}` }, 'Remove');
      del.addEventListener('click', () => removeDoc(d, del));
      const row = el('li', { class: `doc ${included ? '' : 'off'}` },
        el('label', { class: 'doc-main' },
          check,
          el('span', { class: 'doc-box', 'aria-hidden': 'true' }),
          el('span', { class: 'doc-text' },
            el('span', { class: 'doc-name' }, d.filename),
            el('span', { class: 'doc-meta' }, meta))),
        del);
      rows.push(row);
    }

    docList.replaceChildren(...rows);
    $('#railEmpty').hidden = rows.length > 0;
    updateScope();
    updateHello();
  }

  let armTimer = null;
  async function removeDoc(doc, btn) {
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Remove?';
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = 'Remove'; }, 3000);
      return;
    }
    btn.disabled = true;
    try {
      const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error();
      state.docs = state.docs.filter((d) => d.id !== doc.id);
      state.excluded.delete(doc.id);
      store.set('folio.excluded', [...state.excluded]);
      renderDocs();
    } catch {
      btn.disabled = false;
      btn.classList.remove('armed');
      btn.textContent = 'Failed. Retry';
    }
  }

  async function addFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const jobs = files.map((file) => ({ file, row: { name: file.name, status: 'working', message: '' } }));
    state.pending.push(...jobs.map((j) => j.row));
    renderDocs();

    for (const { file, row } of jobs) {
      try {
        if (!SUPPORTED.test(file.name)) throw new Error('Only PDF, Markdown and plain-text files are supported.');
        const body = new FormData();
        body.append('files', file);
        const res = await fetch('/api/documents', { method: 'POST', body });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The upload failed.');
        const item = data.results[0];
        if (item.status === 'failed') throw new Error(item.error);

        state.pending = state.pending.filter((x) => x !== row);
        if (item.status === 'added') {
          state.docs = [item.document, ...state.docs.filter((d) => d.id !== item.document.id)];
        } else {
          const note = { name: item.filename, status: 'note', message: 'Already in your library' };
          state.pending.push(note);
          setTimeout(() => { state.pending = state.pending.filter((x) => x !== note); renderDocs(); }, 3500);
        }
      } catch (err) {
        row.status = 'error';
        row.message = err.message;
      }
      renderDocs();
    }
  }

  function includedIds() {
    return state.docs.filter((d) => !state.excluded.has(d.id)).map((d) => d.id);
  }

  function updateScope() {
    const note = $('#scopeNote');
    const total = state.docs.length;
    const n = includedIds().length;
    note.classList.toggle('warn', total > 0 && n === 0);
    if (total === 0) note.textContent = 'Add a document to the library to start asking.';
    else if (n === 0) note.textContent = 'Select at least one document in the library.';
    else if (n === total) note.textContent = total === 1 ? 'Searching your document.' : `Searching all ${total} documents.`;
    else note.textContent = `Searching ${n} of ${total} documents.`;
    syncSend();
  }

  function updateHello() {
    const total = state.docs.length;
    const passages = state.docs.reduce((sum, d) => sum + d.chunk_count, 0);
    $('#helloText').textContent = total === 0
      ? 'Add a PDF, Markdown or text file to the library, then ask about it here. Every answer points back to the passage it came from.'
      : `${plural(total, 'document')} and ${plural(passages, 'passage')} are ready. Every answer points back to the passage it came from.`;
  }

  /* ---------- Markdown and citations ---------- */

  const CITE_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

  function fmtInline(raw) {
    let t = esc(raw);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return t;
  }

  function lastSentence(text) {
    let t = text.replace(/[*`]/g, '').trim().replace(/[.!?]+$/, '');
    const cut = Math.max(t.lastIndexOf('. '), t.lastIndexOf('? '), t.lastIndexOf('! '));
    return (cut >= 0 ? t.slice(cut + 2) : t).trim();
  }

  function inline(raw, ctx) {
    let out = '', plain = '', last = 0, m;
    CITE_RE.lastIndex = 0;
    while ((m = CITE_RE.exec(raw))) {
      const before = raw.slice(last, m.index);
      out += fmtInline(before);
      plain += before;
      last = m.index + m[0].length;
      const claim = lastSentence(plain);
      for (const n of m[1].split(',').map((x) => Number(x.trim()))) {
        if (n < 1 || n > ctx.count) continue;
        if (!ctx.used.includes(n)) ctx.used.push(n);
        out += `<button type="button" class="cite" data-n="${n}" data-claim="${esc(claim)}" aria-label="Source ${n}" aria-pressed="false">${n}</button>`;
      }
    }
    return out + fmtInline(raw.slice(last));
  }

  function renderMarkdown(text, count) {
    const ctx = { used: [], count };
    const lines = text.replace(/\r/g, '').split('\n');
    const bullet = /^\s*[-*]\s+/, numbered = /^\s*\d+[.)]\s+/, heading = /^#{1,4}\s+/;
    const html = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      if (/^```/.test(line)) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        html.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if (heading.test(line)) {
        html.push(`<h3>${inline(line.replace(heading, ''), ctx)}</h3>`);
        i++;
      } else if (bullet.test(line) || numbered.test(line)) {
        const isBullet = bullet.test(line);
        const re = isBullet ? bullet : numbered;
        const items = [];
        while (i < lines.length && re.test(lines[i])) items.push(lines[i++].replace(re, ''));
        const tag = isBullet ? 'ul' : 'ol';
        html.push(`<${tag}>${items.map((x) => `<li>${inline(x, ctx)}</li>`).join('')}</${tag}>`);
      } else {
        const buf = [];
        while (i < lines.length && lines[i].trim() &&
               !/^```/.test(lines[i]) && !heading.test(lines[i]) && !bullet.test(lines[i]) && !numbered.test(lines[i])) {
          buf.push(lines[i++]);
        }
        html.push(`<p>${inline(buf.join(' '), ctx)}</p>`);
      }
    }
    return { html: html.join(''), used: ctx.used };
  }

  /* ---------- Passage highlighting ---------- */

  const STOP = new Set(('the and for that with this from are was were has have had not but can will its their there which what ' +
    'when where how why who whom into than then them they you your about also been being does did over such').split(' '));
  const words = (s) => (s.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w));

  function highlight(text, claim) {
    const parts = text.match(/[^.!?]+[.!?]*["”')\]]*\s*|[.!?]+\s*/g) || [text];
    const claimWords = new Set(words(claim || ''));
    const scores = parts.map((p) => (claimWords.size ? new Set(words(p)) : new Set()))
      .map((set) => [...set].filter((w) => claimWords.has(w)).length);
    const best = Math.max(0, ...scores);
    const floor = Math.max(2, best * 0.7);
    return parts.map((p, idx) => (best >= 2 && scores[idx] >= floor ? `<mark>${esc(p)}</mark>` : esc(p))).join('');
  }

  /* ---------- Passage panel ---------- */

  function openPassage(turnIndex, n, claim) {
    const turn = state.thread[turnIndex];
    const source = turn && turn.sources[n - 1];
    if (!source) return;
    const same = state.active && state.active.i === turnIndex && state.active.n === n &&
      state.active.claim === claim && app.dataset.panel === 'open';
    if (same) { closePassage(); return; }

    state.active = { i: turnIndex, n, claim };
    $('#pName').textContent = source.filename;
    $('#pMeta').textContent = source.page ? `Page ${source.page}` : `Passage ${source.chunk_index + 1}`;
    const claimEl = $('#pClaim');
    claimEl.hidden = !claim;
    claimEl.replaceChildren('Supports ', el('em', {}, `\u201c${claim}\u201d`));
    $('#pText').innerHTML = highlight(source.text, claim);
    $('#pBody').scrollTop = 0;
    app.dataset.panel = 'open';
    $('#passage').setAttribute('aria-hidden', 'false');
    syncActive();
  }

  function closePassage() {
    state.active = null;
    app.dataset.panel = 'closed';
    $('#passage').setAttribute('aria-hidden', 'true');
    syncActive();
  }

  function syncActive() {
    const a = state.active;
    thread.querySelectorAll('.cite, .note').forEach((b) => {
      const turnEl = b.closest('.turn');
      const on = !!a && Number(turnEl.dataset.i) === a.i && Number(b.dataset.n) === a.n &&
        (b.classList.contains('note') || b.dataset.claim === a.claim);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  thread.addEventListener('click', (e) => {
    const btn = e.target.closest('.cite, .note');
    if (!btn) return;
    const turnEl = btn.closest('.turn');
    const n = Number(btn.dataset.n);
    let claim = btn.dataset.claim;
    if (claim == null) {
      const first = turnEl.querySelector(`.cite[data-n="${n}"]`);
      claim = first ? first.dataset.claim : '';
    }
    openPassage(Number(turnEl.dataset.i), n, claim);
  });

  $('#pClose').addEventListener('click', closePassage);

  /* ---------- Thread rendering ---------- */

  function mountTurn(turn, index) {
    const view = {
      root: el('article', { class: 'turn', dataset: { i: index } }),
      status: el('p', { class: 'status', role: 'status' }),
      sweep: el('div', { class: 'sweep', 'aria-hidden': 'true' }),
      answer: el('div', { class: 'prose' }),
      notes: el('ol', { class: 'notes' }),
      tools: el('div', { class: 'tools' }),
      error: null,
    };
    view.root.append(el('h3', { class: 'q' }, turn.q), view.status, view.sweep, view.answer, view.notes, view.tools);
    turn.view = view;
    thread.append(view.root);
    hello.hidden = true;
    return view;
  }

  function paint(turn, streaming) {
    const v = turn.view;
    let text = turn.a;
    if (streaming) text = text.replace(/\[[\d,\s]*$/, '');     // hide a half-typed [1
    const { html, used } = renderMarkdown(text, turn.sources.length);
    v.answer.innerHTML = html;

    if (!streaming) {
      v.notes.replaceChildren(...used.map((n) => {
        const s = turn.sources[n - 1];
        return el('li', {},
          el('button', { class: 'note', type: 'button', dataset: { n }, 'aria-pressed': 'false' },
            el('span', { class: 'n' }, String(n)),
            el('span', {}, s.filename + (s.page ? `, page ${s.page}` : ''))));
      }));
      syncActive();
    }
  }

  function finishTools(turn) {
    const v = turn.view;
    v.tools.replaceChildren();
    if (!turn.a) return;
    const copy = el('button', { class: 'text-btn', type: 'button' }, 'Copy answer');
    copy.addEventListener('click', async () => {
      const plain = turn.a.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '');
      try { await navigator.clipboard.writeText(plain); copy.textContent = 'Copied'; }
      catch { copy.textContent = 'Copy failed'; }
      setTimeout(() => { copy.textContent = 'Copy answer'; }, 1600);
    });
    v.tools.append(copy);
  }

  function showError(turn, message) {
    const v = turn.view;
    v.sweep.hidden = true;
    v.status.textContent = '';
    const retry = el('button', { class: 'text-btn', type: 'button' }, 'Try again');
    retry.addEventListener('click', () => {
      const i = state.thread.indexOf(turn);
      state.thread.splice(i, 1);
      v.root.remove();
      ask(turn.q);
    });
    v.error = el('div', { class: 'error', role: 'alert' }, el('p', {}, message), retry);
    v.root.append(v.error);
  }

  function persist() {
    const clean = state.thread
      .filter((t) => t.a && !t.error)
      .slice(-30)
      .map((t) => ({ q: t.q, a: t.a, sources: t.sources }));
    store.set('folio.thread.v1', clean);
  }

  function restore() {
    for (const saved of store.get('folio.thread.v1', [])) {
      const turn = { q: saved.q, a: saved.a, sources: saved.sources || [], error: null };
      state.thread.push(turn);
      mountTurn(turn, state.thread.length - 1);
      turn.view.sweep.hidden = true;
      paint(turn, false);
      finishTools(turn);
    }
  }

  /* ---------- Asking ---------- */

  async function* readEvents(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(raw);
        const data = /^data: (.*)$/m.exec(raw);
        if (event && data) yield { event: event[1], data: JSON.parse(data[1]) };
      }
    }
  }

  async function ask(question) {
    if (state.streaming) return;
    const ids = includedIds();
    if (!ids.length) return;

    const history = state.thread
      .filter((t) => t.a && !t.error)
      .slice(-3)
      .flatMap((t) => [{ role: 'user', content: t.q }, { role: 'assistant', content: t.a }]);

    const turn = { q: question, a: '', sources: [], error: null };
    state.thread.push(turn);
    const view = mountTurn(turn, state.thread.length - 1);
    const scopeText = ids.length === state.docs.length
      ? (ids.length === 1 ? 'Searching your document' : `Searching ${ids.length} documents`)
      : `Searching ${ids.length} of ${state.docs.length} documents`;
    view.status.textContent = scopeText;
    view.root.scrollIntoView({ block: 'start', behavior: 'smooth' });

    state.streaming = true;
    state.abort = new AbortController();
    syncSend();

    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; paint(turn, true); }); };

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: state.abort.signal,
        body: JSON.stringify({ question, history, document_ids: ids.length === state.docs.length ? null : ids }),
      });
      if (!res.ok) {
        let detail = 'The server rejected that question.';
        try { const body = await res.json(); if (typeof body.detail === 'string') detail = body.detail; } catch { /* keep default */ }
        throw new Error(detail);
      }

      for await (const { event, data } of readEvents(res)) {
        if (event === 'sources') {
          turn.sources = data.sources;
          view.status.textContent = data.sources.length
            ? `Reading ${plural(data.sources.length, 'passage')}`
            : 'Nothing relevant found';
        } else if (event === 'token') {
          if (!turn.a) { view.sweep.hidden = true; view.status.textContent = ''; }
          turn.a += data.text;
          schedule();
        } else if (event === 'error') {
          turn.error = data.message;
        }
      }

      if (frame) cancelAnimationFrame(frame);
      if (turn.error) {
        paint(turn, false);
        showError(turn, turn.error);
      } else {
        view.sweep.hidden = true;
        view.status.textContent = '';
        paint(turn, false);
        finishTools(turn);
      }
    } catch (err) {
      if (frame) cancelAnimationFrame(frame);
      view.sweep.hidden = true;
      if (err.name === 'AbortError') {
        view.status.textContent = turn.a ? 'Stopped' : '';
        paint(turn, false);
        finishTools(turn);
        if (!turn.a) { state.thread.pop(); view.root.remove(); hello.hidden = state.thread.length > 0; }
      } else {
        turn.error = err.message || 'Something went wrong.';
        paint(turn, false);
        showError(turn, turn.error === 'Failed to fetch' ? "Couldn't reach the server. Check that Folio is running." : turn.error);
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      syncSend();
      persist();
    }
  }

  /* ---------- Composer ---------- */

  function syncSend() {
    if (state.streaming) {
      sendBtn.textContent = 'Stop';
      sendBtn.classList.add('stop');
      sendBtn.disabled = false;
    } else {
      sendBtn.textContent = 'Ask';
      sendBtn.classList.remove('stop');
      sendBtn.disabled = includedIds().length === 0;
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 176)}px`;
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.streaming) { state.abort && state.abort.abort(); return; }
    const question = input.value.trim();
    if (!question || !includedIds().length) return;
    input.value = '';
    autosize();
    ask(question);
  });

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composer.requestSubmit();
    }
  });

  /* ---------- Chrome: rail, new conversation, upload, drag and drop, keys ---------- */

  const setRail = (open) => {
    app.dataset.rail = open ? 'open' : 'closed';
    $('#railToggle').setAttribute('aria-expanded', String(open));
  };
  $('#railToggle').addEventListener('click', () => setRail(app.dataset.rail !== 'open'));
  $('#scrim').addEventListener('click', () => setRail(false));

  $('#newChat').addEventListener('click', () => {
    if (state.streaming && state.abort) state.abort.abort();
    state.thread = [];
    thread.querySelectorAll('.turn').forEach((n) => n.remove());
    hello.hidden = false;
    closePassage();
    persist();
    setRail(false);
    input.focus();
  });

  const fileInput = $('#fileInput');
  $('#addBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });

  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
  window.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (app.dataset.panel === 'open') closePassage();
      else if (app.dataset.rail === 'open') setRail(false);
    } else if (e.key === '/' && !e.metaKey && !e.ctrlKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      input.focus();
    }
  });

  /* ---------- Start ---------- */

  restore();
  hello.hidden = state.thread.length > 0;
  syncSend();
  loadDocs();
})();
