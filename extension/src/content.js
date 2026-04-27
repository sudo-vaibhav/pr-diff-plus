(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const LIB = globalThis.PRDP_LIB ?? (typeof window !== 'undefined' ? window.PRDP_LIB : undefined);
  if (!LIB) { console.error('[PRDP] lib.js not loaded'); return; }
  const {
    isGenerated, isTest, complexityScore, parseStats, parseDiffstat,
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

  // Find the file-card container for a given anchor element. Handles three
  // GitHub PR layouts:
  //   1. Legacy: <copilot-diff-entry> wrapping a .file.js-file
  //   2. Mid:    .file.js-file (no wrapper)
  //   3. Modern: .PullRequestDiffsList-module__diffEntry__* (Primer React)
  function findFileCard(el) {
    return el.closest(
      'copilot-diff-entry, .file.js-file, ' +
      '[class*="PullRequestDiffsList-module__diffEntry"], ' +
      '[class*="Diff-module__diffTargetable"]'
    ) || el;
  }

  // Collect every file in the PR from GitHub's native left tree, regardless of
  // whether the diff card has been lazy-rendered yet. Each leaf treeitem has
  // an <a href="#diff-..."> anchor; walk up to the nearest ancestor [id] to
  // build a full path.
  function collectFromTree() {
    const out = [];
    const leafSel = '[role="treeitem"][class*="DiffFileTree-module__file-tree-row"], ' +
                    '[role="treeitem"].PRIVATE_TreeView-item.DiffFileTree-module__file-tree-row';
    const leaves = document.querySelectorAll(leafSel);
    leaves.forEach(li => {
      const link = li.querySelector('a[href^="#diff-"]');
      const m = link?.getAttribute('href')?.match(/^#(diff-[a-f0-9]+)/);
      if (!m) return;
      const anchor = m[1];
      const filename = (link.textContent || '').replace(/[\u200E\u200F]/g, '').trim();
      // Walk up to the closest ancestor treeitem with an [id] (folder path).
      let parent = li.parentElement?.closest('[role="treeitem"][id]');
      const folder = parent?.id || '';
      const path = folder ? `${folder}/${filename}` : filename;
      out.push({ anchor, path, fromTree: true });
    });
    return out;
  }

  function collectFiles() {
    const out = [];
    const seenCards = new Set();
    const seenPaths = new Set();

    // Pick the best-fitting candidate set per layout (don't mix legacy + modern).
    let candidates = [...document.querySelectorAll('copilot-diff-entry')];
    if (candidates.length === 0) {
      candidates = [...document.querySelectorAll('.file.js-file')];
    }
    if (candidates.length === 0) {
      candidates = [...document.querySelectorAll('[class*="PullRequestDiffsList-module__diffEntry"]')];
    }
    if (candidates.length === 0) {
      // Modern fallback: walk up from each unique data-file-path button.
      document.querySelectorAll('[data-file-path]').forEach(b => {
        const p = b.getAttribute('data-file-path');
        if (!p || seenPaths.has(p)) return;
        seenPaths.add(p);
        const card = findFileCard(b);
        if (card) candidates.push(card);
      });
    }

    for (const raw of candidates) {
      const card = findFileCard(raw);
      if (seenCards.has(card)) continue;
      seenCards.add(card);

      // Path resolution priority:
      //   1. data-file-path on wrapper or any inner button (legacy + modern w/ rendered header)
      //   2. title attr on legacy file-info link
      //   3. textContent of the modern <a href="#diff-..."><code>...</code></a> link,
      //      stripped of LTR/RTL invisible marks (U+200E / U+200F) GitHub wraps it in
      const pathBtn = card.querySelector('[data-file-path]');
      const titleEl = card.querySelector('.file-info a[title], a.Link--primary[title], [data-path]');
      const hashLink = card.querySelector('a[href^="#diff-"]');
      const hashLinkText = hashLink?.textContent?.replace(/[\u200E\u200F]/g, '').trim();
      const path =
        raw.getAttribute?.('data-file-path') ||
        pathBtn?.getAttribute('data-file-path') ||
        titleEl?.getAttribute('title') ||
        titleEl?.getAttribute('data-path') ||
        titleEl?.textContent?.trim() ||
        hashLinkText ||
        `file-${out.length}`;

      // Anchor: legacy [id^="diff-"], else hash from href
      const anchorEl = [...card.querySelectorAll('[id^="diff-"]')]
        .find(a => /^diff-[a-f0-9]+$/.test(a.id))
        || (/^diff-[a-f0-9]+$/.test(card.id) ? card : null);
      let anchor = anchorEl?.id || card.id || '';
      if (!anchor) {
        const m = hashLink?.getAttribute('href')?.match(/^#(diff-[a-f0-9]+)/);
        if (m) anchor = m[1];
      }

      // Stats sources, in priority order:
      //   1. Modern: .sr-only text "Lines changed: N additions & M deletions"
      //   2. Modern: visible +N / -N spans (fgColor-success/danger + text-bold)
      //   3. Legacy: .diffstat aria-label or text content
      //   4. Block-ratio fallback (modern unstyled or partial render)
      const srOnlyText = [...card.querySelectorAll('.sr-only')]
        .map(e => e.textContent || '')
        .find(t => /lines changed/i.test(t)) || '';
      const plusText  = card.querySelector('[class*="fgColor-success"][class*="text-bold"]')?.textContent || '';
      const minusText = card.querySelector('[class*="fgColor-danger"][class*="text-bold"]')?.textContent || '';
      const legacyStats = card.querySelector('.diffstat, [data-testid="file-diffstat"]');
      const addedBlocks =
        card.querySelectorAll('.diffstat-block-added').length +
        card.querySelectorAll('[data-testid="addition diffstat"]').length;
      const deletedBlocks =
        card.querySelectorAll('.diffstat-block-deleted').length +
        card.querySelectorAll('[data-testid="deletion diffstat"]').length;

      const spansText = (plusText || minusText) ? `${plusText} ${minusText}`.trim() : '';
      const { added, removed } = parseDiffstat({
        text: srOnlyText || spansText || legacyStats?.textContent || '',
        ariaLabel: legacyStats?.getAttribute('aria-label') || '',
        addedBlocks,
        deletedBlocks
      });

      out.push({
        el: card,
        path,
        anchor,
        added,
        removed,
        score: complexityScore(added, removed, path),
        generated: isGenerated(path),
        test: isTest(path)
      });
    }

    // Merge in tree-only entries (files whose diff cards haven't lazy-loaded
    // yet). These get filename + 0 stats; refreshFiles upgrades them with
    // real data once their cards render.
    const haveAnchor = new Set(out.map(f => f.anchor).filter(Boolean));
    for (const t of collectFromTree()) {
      if (haveAnchor.has(t.anchor)) continue;
      out.push({
        el: null,
        path: t.path,
        anchor: t.anchor,
        added: 0,
        removed: 0,
        score: 0,
        generated: isGenerated(t.path),
        test: isTest(t.path),
        fromTree: true
      });
    }
    return out;
  }

  // For files whose diff cards are rendered, read GitHub's native "Viewed"
  // button state and seed our approved set with anchors that were already
  // marked viewed before our extension ran.
  function syncApprovedFromNative() {
    let added = 0;
    for (const f of state.files) {
      if (!f.el) continue;
      if (state.approved.has(f.anchor)) continue;
      const nativeBtn = f.el.querySelector(
        'button[aria-label="Viewed"], button[aria-label="Mark as viewed"], button[aria-label*="viewed" i]'
      );
      const nativeInput = f.el.querySelector('input[name="viewed"], input.js-reviewed-checkbox');
      const isOn =
        (nativeBtn && nativeBtn.getAttribute('aria-pressed') === 'true') ||
        (nativeInput && nativeInput.checked);
      if (isOn) {
        state.approved.add(f.anchor);
        added++;
      }
    }
    if (added > 0) {
      saveApproved();
      refreshInlineApproveButtons();
    }
    return added;
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
    applyNativeTreeHide();
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
    if (f.el) {
      f.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (f.anchor) {
      // Tree-only entry — diff card not yet rendered. Hash navigation kicks
      // GitHub's virtualized tree to scroll & lazy-render the target diff.
      location.hash = f.anchor;
    }
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

    // Mirror native "Viewed" toggle. Three layouts to consider:
    //   1. Legacy:  <input name="viewed">                       (checkbox)
    //   2. Mid:     <input class="js-reviewed-checkbox">        (checkbox)
    //   3. Modern:  <button aria-label="Viewed" or "Mark as viewed">   (toggle button)
    const nativeInput = f.el.querySelector('input[name="viewed"], input.js-reviewed-checkbox');
    if (nativeInput) {
      const want = state.approved.has(f.anchor);
      if (nativeInput.checked !== want) nativeInput.click();
      return;
    }
    const nativeBtn = f.el.querySelector(
      'button[aria-label="Viewed"], button[aria-label="Mark as viewed"], button[aria-label*="viewed" i]'
    );
    if (nativeBtn) {
      // aria-label stays "Viewed" in both states — the action, not the state.
      // Real state is on aria-pressed (Primer toggle convention). Class also
      // gets a "viewed" suffix when on (MarkAsViewedButton-module__viewed__*),
      // but aria-pressed is the standard.
      const isOn = nativeBtn.getAttribute('aria-pressed') === 'true';
      const want = state.approved.has(f.anchor);
      if (isOn !== want) nativeBtn.click();
    }
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
      if (!f.el) return; // tree-only entry, no diff card rendered yet
      const header =
        f.el.querySelector('.file-header, .file-info') ||
        f.el.querySelector('[class*="DiffFileHeader-module__diff-file-header"]') ||
        f.el.querySelector('[class*="DiffFileHeader"]') ||
        f.el.querySelector('[class*="Diff-module__diffHeaderWrapper"]');
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

  // Hide GitHub's native left-side file tree entries for files we've marked
  // approved (when state.hideApproved is on). Modern PR UI uses #pr-file-tree
  // with [role="treeitem"] descendants. Path is on inner [data-file-path].
  function applyNativeTreeHide() {
    const approvedPaths = new Set(
      state.files
        .filter(f => state.approved.has(f.anchor))
        .map(f => f.path)
    );
    const tree =
      document.querySelector('#pr-file-tree') ||
      document.querySelector('[aria-label*="Files changed" i] [role="tree"]') ||
      document.querySelector('file-tree');
    if (!tree) return;

    tree.querySelectorAll('[role="treeitem"]').forEach(item => {
      const pathEl = item.querySelector('[data-file-path]') ||
                     (item.hasAttribute('data-file-path') ? item : null);
      if (!pathEl) return;
      const path = pathEl.getAttribute('data-file-path');
      const shouldHide = state.hideApproved && approvedPaths.has(path);
      if (shouldHide) {
        item.setAttribute('data-prdp-hidden', '1');
        item.style.display = 'none';
      } else if (item.hasAttribute('data-prdp-hidden')) {
        item.removeAttribute('data-prdp-hidden');
        item.style.display = '';
      }
    });
  }

  function autoCollapseGenerated() {
    for (const f of state.files) {
      if (!f.generated) continue;
      if (!f.el) continue; // tree-only; nothing to collapse yet
      const body =
        f.el.querySelector('.js-file-content, .Box-body') ||
        f.el.querySelector('[class*="DiffContent"], [class*="diff-table"]');
      if (body && !body.hasAttribute('data-prdp-collapsed')) {
        body.setAttribute('data-prdp-collapsed', '1');
        body.style.display = 'none';
        const header =
          f.el.querySelector('.file-header, .file-info') ||
          f.el.querySelector('[class*="DiffFileHeader"]');
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
    syncApprovedFromNative();
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

    // Compare by anchor set + el-presence to detect both new files AND
    // tree-only entries that just got their diff card rendered.
    const renderedSig = (arr) =>
      arr.map(f => f.anchor + (f.el ? '+' : '-')).sort().join('|');
    if (renderedSig(fresh) !== renderedSig(state.files)) {
      state.files = fresh;
      ensureRoot();
      syncControlsToState();
      syncApprovedFromNative();
      autoCollapseGenerated();
      renderList();
    }
    injectInlineApproveButtons();
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
