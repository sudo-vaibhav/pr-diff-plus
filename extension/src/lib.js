(function (root) {
  const GENERATED_PATTERNS = [
    /(^|\/)package-lock\.json$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)Cargo\.lock$/,
    /(^|\/)Gemfile\.lock$/,
    /(^|\/)poetry\.lock$/,
    /(^|\/)go\.sum$/,
    /(^|\/)composer\.lock$/,
    /\.snap$/,
    /\.min\.(js|css)$/,
    /(^|\/)dist\//,
    /(^|\/)build\//,
    /(^|\/)\.next\//,
    /\.generated\.(ts|js|tsx|jsx|go|py)$/,
    /_pb\.(js|ts|go)$/
  ];

  const TEST_RE = /(\.test\.|\.spec\.|__tests__\/|_test\.go$|_spec\.rb$)/;

  function isGenerated(path) {
    return GENERATED_PATTERNS.some(re => re.test(path));
  }

  function isTest(path) {
    return TEST_RE.test(path);
  }

  function fileWeight(path) {
    if (isGenerated(path)) return 0.05;
    if (isTest(path)) return 0.4;
    if (/\.(md|txt|yml|yaml|json)$/i.test(path)) return 0.5;
    return 1;
  }

  function complexityScore(added, removed, path) {
    const churn = (added | 0) + (removed | 0);
    return Math.round(churn * fileWeight(path));
  }

  function parseStats(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    const added = parseInt(
      t.match(/(\d+)\s*addition/i)?.[1] ??
      t.match(/\+\s*(\d+)/)?.[1] ?? '0',
      10
    );
    const removed = parseInt(
      t.match(/(\d+)\s*deletion/i)?.[1] ??
      t.match(/[-−]\s*(\d+)/)?.[1] ?? '0',
      10
    );
    return { added, removed };
  }

  const PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(files|changes|commits))?/;

  function getPRKeyFromPath(pathname) {
    const m = pathname.match(PR_PATH_RE);
    return m ? `${m[1]}/${m[2]}#${m[3]}` : null;
  }

  function isFilesPath(pathname) {
    const m = pathname.match(PR_PATH_RE);
    return !!m && (m[4] === 'files' || m[4] === 'changes');
  }

  // Build a folder tree from a flat list of {path, ...} files.
  // Returns root node: { children: Map<name, node>, files: file[], name: '' }
  // Children come before files at each level, sorted alphabetically.
  function buildTree(files) {
    const root = { name: '', dir: '', children: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      const fileName = parts.pop();
      let node = root;
      const accum = [];
      for (const p of parts) {
        accum.push(p);
        if (!node.children.has(p)) {
          node.children.set(p, { name: p, dir: accum.join('/'), children: new Map(), files: [] });
        }
        node = node.children.get(p);
      }
      node.files.push({ ...f, name: fileName });
    }
    sortNode(root);
    return root;
  }

  function sortNode(node) {
    node.children = new Map([...node.children.entries()].sort(([a], [b]) => a.localeCompare(b)));
    for (const child of node.children.values()) sortNode(child);
    node.files.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Collapse single-child directory chains: src > components > Foo.tsx → src/components/Foo.tsx
  // Never collapses the root.
  function flattenChains(node) {
    for (const child of node.children.values()) {
      while (child.children.size === 1 && child.files.length === 0) {
        const [, only] = [...child.children.entries()][0];
        child.name = `${child.name}/${only.name}`;
        child.dir = only.dir;
        child.children = only.children;
        child.files = only.files;
      }
      flattenChains(child);
    }
    return node;
  }


  root.PRDP_LIB = {
    GENERATED_PATTERNS,
    TEST_RE,
    PR_PATH_RE,
    isGenerated,
    isTest,
    fileWeight,
    complexityScore,
    parseStats,
    getPRKeyFromPath,
    isFilesPath,
    buildTree,
    flattenChains
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
