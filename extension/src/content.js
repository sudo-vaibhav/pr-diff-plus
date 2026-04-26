(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const LIB = globalThis.PRDP_LIB;
  if (!LIB) { console.error('[PRDP] lib.js not loaded'); return; }
  const {
    isGenerated, isTest, complexityScore, parseStats,
    getPRKeyFromPath, isFilesPath,
    buildTree, flattenChains
  } = LIB;

  const state = {
    prKey: null,
    files: [],
    activeIndex: 0,
    approved: new Set(),
    filter: '',
    sidebarOpen: true,
    helpOpen: false,
    viewMode: 'tree',          // 'tree' | 'flat'
    hideApproved: false,
    sortMode: 'order',         // flat-only
    collapsedDirs: new Set()
  };

  function getPRKey() { return getPRKeyFromPath(location.pathname); }
  function isFilesPage() { return isFilesPath(location.pathname); }
  const APPROVED_KEY = () => `approved:${state.prKey}`;
  const LEGACY_KEY   = () => `reviewed:${state.prKey}`;

  async function loadApproved() {
    if (!state.prKey) return;
    const got = await api.storage.local.get([APPROVED_KEY(), LEGACY_KEY(), 'settings']);
    const merged = new Set([...(got[APPROVED_KEY()] ?? []), ...(got[LEGACY_KEY()] ?? [])]);
    state.approved = merged;
    const settings = got.settings ?? {};
    if (settings.viewMode === 'flat' || settings.viewMode === 'tree') state.viewMode = settings.viewMode;
    // hideApproved is intentionally per-session (not persisted) — it's a workflow toggle, not a preference.
  }

  async function saveApproved() {
    if (!state.prKey) return;
    await api.storage.local.set({ [APPROVED_KEY()]: [...state.approved] });
  }

  async function saveSettings() {
    const got = await api.storage.local.get('settings');
    const settings = { ...(got.settings ?? {}), viewMode: state.viewMode };
    await api.storage.local.set({ settings });
  }

  function collectFiles() {
    const out = [];
    const seen = new Set();
    const blocks = [
      ...document.querySelectorAll('copilot-diff-entry'),
      ...document.querySelectorAll('.file.js-file')
    ];
    for (const raw of blocks) {
      const el = raw.tagName === 'COPILOT-DIFF-ENTRY'
        ? (raw.querySelector('.file.js-file') || raw)
        : raw;
      if (seen.has(el)) continue;
      seen.add(el);

      const anchorEl = [...el.querySelectorAll('[id^="diff-"]')]
        .find(a => /^diff-[a-f0-9]+$/.test(a.id)) || (/^diff-[a-f0-9]+$/.test(el.id) ? el : null);
      const anchor = anchorEl?.id || el.id || '';

      const titleEl = el.querySelector('.file-info a[title], a.Link--primary[title], [data-path]');
      const path =
        titleEl?.getAttribute('title') ||
        titleEl?.getAttribute('data-path') ||
        titleEl?.textContent?.trim() ||
        el.querySelector('.file-info')?.textContent?.trim()?.split('\n')[0] ||
        `file-${out.length}`;

      const statsEl = el.querySelector('.diffstat, [data-testid="file-diffstat"]');
      const statsRaw = statsEl?.getAttribute('aria-label') || statsEl?.textContent || '';
      const { added, removed } = parseStats(statsRaw);

      out.push({
        el,
        path,
        anchor,
        added,
        removed,
        score: complexityScore(added, removed, path),
        generated: isGenerated(path),
        test: isTest(path)
      });
    }
    return out;
  }

  function ensureRoot() {
    let root = document.getElementById('prdp-root');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'prdp-root';
    root.innerHTML = `
      <button id="prdp-toggle" title="Toggle sidebar (s)">▸</button>
      <aside id="prdp-sidebar" aria-label="PR Diff Plus">
        <header>
          <div class="prdp-titlerow">
            <div class="prdp-title">PR Diff Plus</div>
            <div class="prdp-viewtoggle" role="tablist" aria-label="View mode">
              <button id="prdp-view-tree" data-mode="tree" title="Tree view (t)">Tree</button>
              <button id="prdp-view-flat" data-mode="flat" title="Flat view (t)">Flat</button>
            </div>
          </div>
          <div class="prdp-progress"><div class="prdp-bar"></div><span class="prdp-count"></span></div>
          <input id="prdp-filter" type="text" placeholder="Filter files (/)" />
          <div class="prdp-sortrow">
            <label class="prdp-sort-only">Sort:</label>
            <select id="prdp-sort" class="prdp-sort-only">
              <option value="order">Order</option>
              <option value="score">Complexity</option>
              <option value="path">Path</option>
            </select>
            <label class="prdp-toggle-label">
              <input type="checkbox" id="prdp-hide-approved"> Hide approved
            </label>
          </div>
        </header>
        <ul id="prdp-list" role="tree"></ul>
        <footer>
          <kbd>j</kbd>/<kbd>k</kbd> nav · <kbd>n</kbd>/<kbd>p</kbd> hunk · <kbd>a</kbd> approve · <kbd>t</kbd> view · <kbd>/</kbd> filter · <kbd>?</kbd> help
        </footer>
      </aside>
      <div id="prdp-help" hidden>
        <div class="prdp-help-card">
          <h3>Keyboard shortcuts</h3>
          <table>
            <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>Next / previous file</td></tr>
            <tr><td><kbd>n</kbd> / <kbd>p</kbd></td><td>Next / previous hunk</td></tr>
            <tr><td><kbd>a</kbd> / <kbd>r</kbd></td><td>Approve / unapprove current file</td></tr>
            <tr><td><kbd>h</kbd></td><td>Toggle hide-approved</td></tr>
            <tr><td><kbd>t</kbd></td><td>Toggle tree / flat view</td></tr>
            <tr><td><kbd>c</kbd></td><td>Collapse / expand current diff</td></tr>
            <tr><td><kbd>g g</kbd></td><td>First file</td></tr>
            <tr><td><kbd>G</kbd></td><td>Last file</td></tr>
            <tr><td><kbd>/</kbd></td><td>Focus filter</td></tr>
            <tr><td><kbd>s</kbd></td><td>Toggle sidebar</td></tr>
            <tr><td><kbd>?</kbd></td><td>This dialog</td></tr>
          </table>
          <button id="prdp-help-close">Close (Esc)</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);
    wireUI(root);
    return root;
  }

  function wireUI(root) {
    root.querySelector('#prdp-toggle').addEventListener('click', toggleSidebar);
    root.querySelector('#prdp-filter').addEventListener('input', e => {
      state.filter = e.target.value.toLowerCase();
      renderList();
    });
    root.querySelector('#prdp-sort').addEventListener('change', e => {
      state.sortMode = e.target.value;
      renderList();
    });
    root.querySelector('#prdp-hide-approved').addEventListener('change', e => {
      state.hideApproved = e.target.checked;
      renderList();
    });
    root.querySelector('#prdp-help-close').addEventListener('click', () => toggleHelp(false));
    root.querySelector('#prdp-view-tree').addEventListener('click', () => setViewMode('tree'));
    root.querySelector('#prdp-view-flat').addEventListener('click', () => setViewMode('flat'));
  }

  function setViewMode(mode) {
    if (mode !== 'tree' && mode !== 'flat') return;
    state.viewMode = mode;
    saveSettings();
    syncControlsToState();
    renderList();
  }

  function syncControlsToState() {
    const root = document.getElementById('prdp-root');
    if (!root) return;
    root.classList.toggle('mode-tree', state.viewMode === 'tree');
    root.classList.toggle('mode-flat', state.viewMode === 'flat');
    root.querySelector('#prdp-view-tree')?.setAttribute('aria-pressed', state.viewMode === 'tree');
    root.querySelector('#prdp-view-flat')?.setAttribute('aria-pressed', state.viewMode === 'flat');
    const cb = root.querySelector('#prdp-hide-approved');
    if (cb) cb.checked = state.hideApproved;
    const sortSel = root.querySelector('#prdp-sort');
    if (sortSel) sortSel.value = state.sortMode;
  }

  function visibleFlatFiles() {
    let items = state.files.map((f, i) => ({ ...f, idx: i }));
    if (state.filter) items = items.filter(f => f.path.toLowerCase().includes(state.filter));
    if (state.hideApproved) items = items.filter(f => !state.approved.has(f.anchor));
    if (state.sortMode === 'score') items.sort((a, b) => b.score - a.score);
    else if (state.sortMode === 'path') items.sort((a, b) => a.path.localeCompare(b.path));
    return items;
  }

  function visibleTreeFiles() {
    // Apply filters, then build tree from survivors. Only files that pass filter are in tree.
    let items = state.files.map((f, i) => ({ ...f, idx: i }));
    if (state.filter) items = items.filter(f => f.path.toLowerCase().includes(state.filter));
    if (state.hideApproved) items = items.filter(f => !state.approved.has(f.anchor));
    return items;
  }

  function renderProgress() {
    const total = state.files.length;
    const done = state.files.filter(f => state.approved.has(f.anchor)).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const root = document.getElementById('prdp-root');
    root?.querySelector('.prdp-bar') && (root.querySelector('.prdp-bar').style.width = `${pct}%`);
    const count = root?.querySelector('.prdp-count');
    if (count) count.textContent = `${done}/${total}`;
  }

  function renderList() {
    const list = document.getElementById('prdp-list');
    if (!list) return;
    syncControlsToState();
    list.innerHTML = '';
    if (state.viewMode === 'flat') renderFlat(list);
    else renderTree(list);
    renderProgress();
  }

  function renderFlat(list) {
    for (const f of visibleFlatFiles()) {
      list.appendChild(makeFileRow(f, 0));
    }
  }

  function renderTree(list) {
    const items = visibleTreeFiles();
    if (!items.length) return;
    const root = flattenChains(buildTree(items));
    renderTreeNode(list, root, 0);
  }

  function renderTreeNode(parentEl, node, depth) {
    // Render directories first
    for (const child of node.children.values()) {
      const collapsed = state.collapsedDirs.has(child.dir);
      const fileCount = countFilesIn(child);
      const approvedCount = countApprovedIn(child);
      const li = document.createElement('li');
      li.className = 'prdp-dir' + (collapsed ? ' collapsed' : '');
      li.style.setProperty('--prdp-depth', depth);
      li.dataset.dir = child.dir;
      li.innerHTML = `
        <span class="prdp-arrow">${collapsed ? '▸' : '▾'}</span>
        <span class="prdp-foldername">${child.name}</span>
        <span class="prdp-dircount">${approvedCount}/${fileCount}</span>
      `;
      li.addEventListener('click', () => {
        if (collapsed) state.collapsedDirs.delete(child.dir);
        else state.collapsedDirs.add(child.dir);
        renderList();
      });
      parentEl.appendChild(li);
      if (!collapsed) renderTreeNode(parentEl, child, depth + 1);
    }
    // Then files at this level
    for (const f of node.files) {
      parentEl.appendChild(makeFileRow(f, depth, /*nameOnly*/ true));
    }
  }

  function countFilesIn(node) {
    let n = node.files.length;
    for (const c of node.children.values()) n += countFilesIn(c);
    return n;
  }
  function countApprovedIn(node) {
    let n = node.files.filter(f => state.approved.has(f.anchor)).length;
    for (const c of node.children.values()) n += countApprovedIn(c);
    return n;
  }

  function makeFileRow(f, depth, nameOnly = false) {
    const li = document.createElement('li');
    li.className = 'prdp-item';
    li.style.setProperty('--prdp-depth', depth);
    if (state.approved.has(f.anchor)) li.classList.add('approved');
    if (f.idx === state.activeIndex) li.classList.add('active');
    if (f.generated) li.classList.add('generated');
    if (f.test) li.classList.add('test');
    const label = nameOnly ? (f.name ?? f.path.split('/').pop()) : f.path;
    li.innerHTML = `
      <span class="prdp-check" role="checkbox" aria-checked="${state.approved.has(f.anchor)}" title="Approve (a)"></span>
      <span class="prdp-tag" title="Complexity score">${f.score}</span>
      <span class="prdp-path" title="${f.path}">${label}</span>
      <span class="prdp-stats">
        <span class="prdp-add">+${f.added}</span>
        <span class="prdp-del">-${f.removed}</span>
      </span>
    `;
    li.querySelector('.prdp-check').addEventListener('click', e => {
      e.stopPropagation();
      toggleApprovedAt(f.idx);
    });
    li.addEventListener('click', () => jumpTo(f.idx));
    return li;
  }

  let scrollLockUntil = 0;
  function jumpTo(idx) {
    if (idx < 0 || idx >= state.files.length) return;
    state.activeIndex = idx;
    const f = state.files[idx];
    try { if (f.anchor) history.replaceState(null, '', `#${f.anchor}`); } catch {}
    scrollLockUntil = Date.now() + 700;
    f.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    renderList();
  }

  function nextVisibleIdx(dir) {
    const visible = (state.viewMode === 'flat' ? visibleFlatFiles() : visibleTreeFiles()).map(f => f.idx);
    if (!visible.length) return state.activeIndex;
    const pos = visible.indexOf(state.activeIndex);
    if (pos === -1) return visible[0];
    return visible[Math.max(0, Math.min(visible.length - 1, pos + dir))];
  }

  function toggleApprovedAt(idx) {
    const f = state.files[idx];
    if (!f) return;
    if (state.approved.has(f.anchor)) state.approved.delete(f.anchor);
    else state.approved.add(f.anchor);
    saveApproved();
    renderList();
    refreshInlineApproveButtons();
    const native = f.el.querySelector('input[name="viewed"], input.js-reviewed-checkbox');
    if (native && native.checked !== state.approved.has(f.anchor)) native.click();
  }
  function toggleApproved() { toggleApprovedAt(state.activeIndex); }

  function toggleCollapse(el) {
    const btn = el?.querySelector('.js-toggle-file, [aria-label*="collapse" i], [aria-label*="expand" i]');
    btn?.click();
  }

  function jumpHunk(dir) {
    const f = state.files[state.activeIndex];
    if (!f) return;
    const hunks = [...f.el.querySelectorAll('.diff-table tbody, .js-expandable-line')];
    if (!hunks.length) { jumpTo(nextVisibleIdx(dir)); return; }
    const y = window.scrollY;
    const sorted = hunks
      .map(h => ({ h, top: h.getBoundingClientRect().top + window.scrollY }))
      .sort((a, b) => a.top - b.top);
    const next = dir > 0 ? sorted.find(x => x.top > y + 10) : [...sorted].reverse().find(x => x.top < y - 10);
    if (next) next.h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else jumpTo(nextVisibleIdx(dir));
  }

  function injectInlineApproveButtons() {
    state.files.forEach((f, idx) => {
      const header = f.el.querySelector('.file-header, .file-info');
      if (!header || header.querySelector('.prdp-inline-approve')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'prdp-inline-approve';
      btn.dataset.anchor = f.anchor;
      btn.title = 'Approve this file';
      btn.innerHTML = `
        <span class="prdp-inline-check"></span>
        <span class="prdp-inline-label">Approve</span>
      `;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        e.preventDefault();
        toggleApprovedAt(idx);
      });
      header.appendChild(btn);
    });
    refreshInlineApproveButtons();
  }

  function refreshInlineApproveButtons() {
    document.querySelectorAll('.prdp-inline-approve').forEach(btn => {
      const isApproved = state.approved.has(btn.dataset.anchor);
      btn.classList.toggle('approved', isApproved);
      btn.querySelector('.prdp-inline-label').textContent = isApproved ? 'Approved' : 'Approve';
      btn.setAttribute('aria-pressed', String(isApproved));
    });
  }

  function autoCollapseGenerated() {
    for (const f of state.files) {
      if (!f.generated) continue;
      const body = f.el.querySelector('.js-file-content, .Box-body');
      if (body && !body.hasAttribute('data-prdp-collapsed')) {
        body.setAttribute('data-prdp-collapsed', '1');
        body.style.display = 'none';
        const header = f.el.querySelector('.file-header, .file-info');
        if (header && !header.querySelector('.prdp-genbadge')) {
          const tag = document.createElement('span');
          tag.className = 'prdp-genbadge';
          tag.textContent = 'auto-collapsed (generated)';
          tag.addEventListener('click', e => {
            e.stopPropagation();
            body.style.display = '';
            tag.remove();
          });
          header.appendChild(tag);
        }
      }
    }
  }

  function applyPushClass() {
    document.documentElement.classList.toggle('prdp-pushed', state.sidebarOpen);
    const r = document.getElementById('prdp-root');
    if (!r) return;
    const w = getComputedStyle(r).getPropertyValue('--prdp-width').trim();
    if (w) document.documentElement.style.setProperty('--prdp-width-global', w);
  }

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    document.getElementById('prdp-root')?.classList.toggle('collapsed', !state.sidebarOpen);
    applyPushClass();
  }

  function toggleHelp(force) {
    state.helpOpen = force ?? !state.helpOpen;
    const help = document.getElementById('prdp-help');
    if (help) help.hidden = !state.helpOpen;
  }

  function toggleHideApproved() {
    state.hideApproved = !state.hideApproved;
    renderList();
  }

  let gPending = false;
  function onKey(e) {
    if (e.target.matches('input, textarea, [contenteditable="true"]')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'j': jumpTo(nextVisibleIdx(+1)); break;
      case 'k': jumpTo(nextVisibleIdx(-1)); break;
      case 'n': jumpHunk(+1); break;
      case 'p': jumpHunk(-1); break;
      case 'a':
      case 'r': toggleApproved(); break;
      case 'h': toggleHideApproved(); break;
      case 't': setViewMode(state.viewMode === 'tree' ? 'flat' : 'tree'); break;
      case 'c': toggleCollapse(state.files[state.activeIndex]?.el); break;
      case 'G': jumpTo(state.files.length - 1); break;
      case 'g':
        if (gPending) { jumpTo(0); gPending = false; }
        else { gPending = true; setTimeout(() => (gPending = false), 500); }
        break;
      case '/':
        e.preventDefault();
        document.getElementById('prdp-filter')?.focus();
        break;
      case 's': toggleSidebar(); break;
      case '?': toggleHelp(); break;
      case 'Escape': toggleHelp(false); break;
      default: return;
    }
  }

  function trackActiveByScroll() {
    if (Date.now() < scrollLockUntil) return;
    const y = window.scrollY + 120;
    let best = 0;
    for (let i = 0; i < state.files.length; i++) {
      const top = state.files[i].el.getBoundingClientRect().top + window.scrollY;
      if (top <= y) best = i;
      else break;
    }
    if (best !== state.activeIndex) {
      state.activeIndex = best;
      renderList();
    }
  }

  async function init() {
    if (!isFilesPage()) return;
    state.prKey = getPRKey();
    await loadApproved();
    state.files = collectFiles();
    if (!state.files.length) return;
    ensureRoot();
    syncControlsToState();
    applyPushClass();
    autoCollapseGenerated();
    injectInlineApproveButtons();
    renderList();
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', throttle(trackActiveByScroll, 100), { passive: true });
  }

  function throttle(fn, ms) {
    let last = 0, t;
    return (...args) => {
      const now = Date.now();
      const remaining = ms - (now - last);
      if (remaining <= 0) { last = now; fn(...args); }
      else { clearTimeout(t); t = setTimeout(() => { last = Date.now(); fn(...args); }, remaining); }
    };
  }

  let lastUrl = location.href;
  const refreshFiles = throttle(() => {
    if (!isFilesPage()) return;
    const fresh = collectFiles();
    if (fresh.length === 0) return;
    if (fresh.length !== state.files.length) {
      state.files = fresh;
      ensureRoot();
      syncControlsToState();
      autoCollapseGenerated();
      injectInlineApproveButtons();
      renderList();
    }
  }, 400);

  const obs = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      document.getElementById('prdp-root')?.remove();
      state.files = [];
      setTimeout(init, 600);
      return;
    }
    refreshFiles();
  });
  obs.observe(document.body, { childList: true, subtree: true });

  init();
})();
