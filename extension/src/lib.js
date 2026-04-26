// Pure helpers for PR Diff Plus. Loaded as a content script BEFORE content.js
// so PRDP_LIB is defined when content.js runs.
//
// Top-level `var` is intentional: in browser content-script sandboxes (Chrome
// + Firefox), top-level `var` declarations attach to the sandbox's global
// object, which is shared across all content scripts of the same extension.
// An IIFE that writes to `globalThis` works in Chrome but is unreliable in
// Firefox's content-script sandbox.

var PRDP_GENERATED_PATTERNS = [
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

var PRDP_TEST_RE = /(\.test\.|\.spec\.|__tests__\/|_test\.go$|_spec\.rb$)/;
var PRDP_PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(files|changes|commits))?/;

function prdp_isGenerated(path) {
  return PRDP_GENERATED_PATTERNS.some(function (re) { return re.test(path); });
}

function prdp_isTest(path) {
  return PRDP_TEST_RE.test(path);
}

function prdp_fileWeight(path) {
  if (prdp_isGenerated(path)) return 0.05;
  if (prdp_isTest(path)) return 0.4;
  if (/\.(md|txt|yml|yaml|json)$/i.test(path)) return 0.5;
  return 1;
}

function prdp_complexityScore(added, removed, path) {
  var churn = (added | 0) + (removed | 0);
  return Math.round(churn * prdp_fileWeight(path));
}

function prdp_parseStats(text) {
  var t = (text || '').replace(/\s+/g, ' ').trim();
  var addM = t.match(/(\d+)\s*addition/i) || t.match(/\+\s*(\d+)/);
  var delM = t.match(/(\d+)\s*deletion/i) || t.match(/[-\u2212]\s*(\d+)/);
  return {
    added: parseInt(addM ? addM[1] : '0', 10),
    removed: parseInt(delM ? delM[1] : '0', 10)
  };
}

function prdp_getPRKeyFromPath(pathname) {
  var m = pathname.match(PRDP_PR_PATH_RE);
  return m ? (m[1] + '/' + m[2] + '#' + m[3]) : null;
}

function prdp_isFilesPath(pathname) {
  var m = pathname.match(PRDP_PR_PATH_RE);
  return !!m && (m[4] === 'files' || m[4] === 'changes');
}

function prdp_buildTree(files) {
  var root = { name: '', dir: '', children: new Map(), files: [] };
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var parts = f.path.split('/');
    var fileName = parts.pop();
    var node = root;
    var accum = [];
    for (var j = 0; j < parts.length; j++) {
      var p = parts[j];
      accum.push(p);
      if (!node.children.has(p)) {
        node.children.set(p, { name: p, dir: accum.join('/'), children: new Map(), files: [] });
      }
      node = node.children.get(p);
    }
    var copy = Object.assign({}, f, { name: fileName });
    node.files.push(copy);
  }
  prdp_sortNode(root);
  return root;
}

function prdp_sortNode(node) {
  var entries = Array.from(node.children.entries()).sort(function (a, b) {
    return a[0].localeCompare(b[0]);
  });
  node.children = new Map(entries);
  node.children.forEach(function (child) { prdp_sortNode(child); });
  node.files.sort(function (a, b) { return a.name.localeCompare(b.name); });
}

function prdp_flattenChains(node) {
  node.children.forEach(function (child) {
    while (child.children.size === 1 && child.files.length === 0) {
      var only = Array.from(child.children.values())[0];
      child.name = child.name + '/' + only.name;
      child.dir = only.dir;
      child.children = only.children;
      child.files = only.files;
    }
    prdp_flattenChains(child);
  });
  return node;
}

// The single export the rest of the extension reads.
var PRDP_LIB = {
  GENERATED_PATTERNS: PRDP_GENERATED_PATTERNS,
  TEST_RE: PRDP_TEST_RE,
  PR_PATH_RE: PRDP_PR_PATH_RE,
  isGenerated: prdp_isGenerated,
  isTest: prdp_isTest,
  fileWeight: prdp_fileWeight,
  complexityScore: prdp_complexityScore,
  parseStats: prdp_parseStats,
  getPRKeyFromPath: prdp_getPRKeyFromPath,
  isFilesPath: prdp_isFilesPath,
  buildTree: prdp_buildTree,
  flattenChains: prdp_flattenChains
};

// Belt-and-suspenders: also pin to globalThis/window so content.js can find
// it regardless of whether the sandbox shares lexical scope with this file.
try { globalThis.PRDP_LIB = PRDP_LIB; } catch (e) {}
try { window.PRDP_LIB = PRDP_LIB; } catch (e) {}
