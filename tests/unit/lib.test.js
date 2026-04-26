import { describe, it, expect } from 'vitest';
import lib from './_loadLib.js';

const {
  isGenerated,
  isTest,
  fileWeight,
  complexityScore,
  parseStats,
  parseDiffstat,
  getPRKeyFromPath,
  isFilesPath,
  buildTree,
  flattenChains
} = lib;

describe('isGenerated', () => {
  it.each([
    ['package-lock.json', true],
    ['yarn.lock', true],
    ['pnpm-lock.yaml', true],
    ['Cargo.lock', true],
    ['Gemfile.lock', true],
    ['go.sum', true],
    ['src/__snapshots__/Foo.test.js.snap', true],
    ['app/foo.min.js', true],
    ['app/foo.min.css', true],
    ['dist/main.js', true],
    ['build/index.html', true],
    ['.next/server.js', true],
    ['proto/user_pb.go', true],
    ['types/api.generated.ts', true],
    ['src/foo.ts', false],
    ['README.md', false],
    ['package.json', false],
    ['app/utils/lockfile.helper.js', false]
  ])('%s -> %s', (path, expected) => {
    expect(isGenerated(path)).toBe(expected);
  });
});

describe('isTest', () => {
  it.each([
    ['src/foo.test.ts', true],
    ['src/foo.spec.js', true],
    ['src/__tests__/foo.js', true],
    ['internal/handler_test.go', true],
    ['spec/user_spec.rb', true],
    ['src/foo.ts', false],
    ['src/test-utils.ts', false]
  ])('%s -> %s', (path, expected) => {
    expect(isTest(path)).toBe(expected);
  });
});

describe('fileWeight', () => {
  it('weights generated files near zero', () => {
    expect(fileWeight('yarn.lock')).toBe(0.05);
  });
  it('weights tests at 0.4', () => {
    expect(fileWeight('foo.test.ts')).toBe(0.4);
  });
  it('weights docs/config at 0.5', () => {
    expect(fileWeight('README.md')).toBe(0.5);
    expect(fileWeight('config.yml')).toBe(0.5);
    expect(fileWeight('package.json')).toBe(0.5);
  });
  it('weights regular code at 1', () => {
    expect(fileWeight('src/feature.ts')).toBe(1);
  });
  it('prioritizes generated over test', () => {
    expect(fileWeight('dist/foo.test.js')).toBe(0.05);
  });
});

describe('complexityScore', () => {
  it('multiplies churn by weight', () => {
    expect(complexityScore(80, 20, 'src/feature.ts')).toBe(100);
    expect(complexityScore(80, 20, 'foo.test.ts')).toBe(40);
    expect(complexityScore(800, 200, 'yarn.lock')).toBe(50);
  });
  it('handles zero churn', () => {
    expect(complexityScore(0, 0, 'a.ts')).toBe(0);
  });
  it('treats undefined as 0', () => {
    expect(complexityScore(undefined, undefined, 'a.ts')).toBe(0);
  });
});

describe('parseStats', () => {
  it.each([
    ['7 additions, 3 deletions', 7, 3],
    ['+7 −3', 7, 3],
    ['+7\n   −3', 7, 3],
    ['+ 12 - 5', 12, 5],
    ['', 0, 0],
    ['No changes', 0, 0],
    ['+99 additions and 1 deletion', 99, 1]
  ])('parses %j', (input, a, r) => {
    expect(parseStats(input)).toEqual({ added: a, removed: r });
  });

  it('handles unicode minus', () => {
    expect(parseStats('+10 \u22125').removed).toBe(5);
  });

  it('handles ascii hyphen-minus', () => {
    expect(parseStats('+10 -5').removed).toBe(5);
  });
});

describe('parseDiffstat (multi-format)', () => {
  it('parses aria-label format (legacy GitHub)', () => {
    expect(parseDiffstat({ ariaLabel: '7 additions, 3 deletions' })).toEqual({ added: 7, removed: 3 });
  });

  it('parses +N -N text format (synthetic fixtures)', () => {
    expect(parseDiffstat({ text: '+80 −20' })).toEqual({ added: 80, removed: 20 });
  });

  it('estimates from total + block ratio (modern GitHub)', () => {
    // total 10, 3 added blocks vs 1 deleted → 7.5 → 8 added, 2 removed
    expect(parseDiffstat({
      text: '10',
      addedBlocks: 3,
      deletedBlocks: 1
    })).toEqual({ added: 8, removed: 2 });
  });

  it('handles all-added block ratio', () => {
    expect(parseDiffstat({
      text: '50',
      addedBlocks: 5,
      deletedBlocks: 0
    })).toEqual({ added: 50, removed: 0 });
  });

  it('handles all-deleted block ratio', () => {
    expect(parseDiffstat({
      text: '20',
      addedBlocks: 0,
      deletedBlocks: 4
    })).toEqual({ added: 0, removed: 20 });
  });

  it('prefers aria-label over block estimation', () => {
    expect(parseDiffstat({
      ariaLabel: '100 additions and 50 deletions',
      text: '150',
      addedBlocks: 1,
      deletedBlocks: 4
    })).toEqual({ added: 100, removed: 50 });
  });

  it('returns zeros when nothing usable', () => {
    expect(parseDiffstat({ text: 'foo bar', addedBlocks: 0, deletedBlocks: 0 })).toEqual({ added: 0, removed: 0 });
    expect(parseDiffstat({})).toEqual({ added: 0, removed: 0 });
  });

  it('parses modern "Lines changed: N addition & M deletions" sr-only text', () => {
    expect(parseDiffstat({ text: 'Lines changed: 1 addition & 1 deletion' })).toEqual({ added: 1, removed: 1 });
    expect(parseDiffstat({ text: 'Lines changed: 247 additions & 18 deletions' })).toEqual({ added: 247, removed: 18 });
  });

  it('parses combined +N -N visible-span text', () => {
    // From content.js: passes "+5 -3" combining fgColor-success/danger spans
    expect(parseDiffstat({ text: '+5 -3' })).toEqual({ added: 5, removed: 3 });
    expect(parseDiffstat({ text: '+1 -1' })).toEqual({ added: 1, removed: 1 });
  });
});

describe('getPRKeyFromPath', () => {
  it.each([
    ['/vaatun/vantage/pull/1694/changes', 'vaatun/vantage#1694'],
    ['/facebook/react/pull/28000/files', 'facebook/react#28000'],
    ['/owner/repo/pull/1', 'owner/repo#1'],
    ['/owner/repo/issues/5', null],
    ['/', null]
  ])('%s -> %s', (path, expected) => {
    expect(getPRKeyFromPath(path)).toBe(expected);
  });
});

describe('isFilesPath', () => {
  it.each([
    ['/o/r/pull/1/files', true],
    ['/o/r/pull/1/changes', true],
    ['/o/r/pull/1', false],
    ['/o/r/pull/1/commits', false],
    ['/o/r/issues/1', false]
  ])('%s -> %s', (path, expected) => {
    expect(isFilesPath(path)).toBe(expected);
  });
});

describe('buildTree', () => {
  const f = (path) => ({ path, anchor: path });

  it('groups files by folder', () => {
    const tree = buildTree([f('src/a.ts'), f('src/b.ts'), f('test/x.ts')]);
    expect([...tree.children.keys()]).toEqual(['src', 'test']);
    expect(tree.children.get('src').files.map(x => x.name)).toEqual(['a.ts', 'b.ts']);
    expect(tree.children.get('test').files.map(x => x.name)).toEqual(['x.ts']);
  });

  it('handles nested folders', () => {
    const tree = buildTree([f('a/b/c/deep.ts')]);
    const a = tree.children.get('a');
    const b = a.children.get('b');
    const c = b.children.get('c');
    expect(c.files.map(x => x.name)).toEqual(['deep.ts']);
  });

  it('handles root-level files', () => {
    const tree = buildTree([f('README.md'), f('src/a.ts')]);
    expect(tree.files.map(x => x.name)).toEqual(['README.md']);
    expect(tree.children.get('src').files.map(x => x.name)).toEqual(['a.ts']);
  });

  it('sorts directories before files at each level', () => {
    const tree = buildTree([f('z.ts'), f('a/b.ts')]);
    expect([...tree.children.keys()]).toEqual(['a']);
    expect(tree.files.map(x => x.name)).toEqual(['z.ts']);
  });

  it('preserves file metadata', () => {
    const file = { path: 'src/feature.ts', anchor: 'diff-abc', score: 42 };
    const tree = buildTree([file]);
    const got = tree.children.get('src').files[0];
    expect(got.anchor).toBe('diff-abc');
    expect(got.score).toBe(42);
    expect(got.name).toBe('feature.ts');
  });

  it('passes empty input', () => {
    const tree = buildTree([]);
    expect(tree.children.size).toBe(0);
    expect(tree.files).toEqual([]);
  });
});

describe('flattenChains', () => {
  const f = (path) => ({ path, anchor: path });

  it('collapses single-child directory chains', () => {
    const tree = buildTree([f('a/b/c/file.ts')]);
    const flat = flattenChains(tree);
    // root → "a/b/c" → file
    expect(flat.children.size).toBe(1);
    const only = [...flat.children.values()][0];
    expect(only.name).toBe('a/b/c');
    expect(only.files.map(x => x.name)).toEqual(['file.ts']);
  });

  it('does not collapse when a directory has multiple children', () => {
    const tree = buildTree([f('a/b/x.ts'), f('a/c/y.ts')]);
    const flat = flattenChains(tree);
    const a = flat.children.get('a');
    expect(a.children.size).toBe(2);
    expect([...a.children.keys()]).toEqual(['b', 'c']);
  });

  it('does not collapse a directory containing files plus a child dir', () => {
    const tree = buildTree([f('a/b/x.ts'), f('a/y.ts')]);
    const flat = flattenChains(tree);
    const a = flat.children.get('a');
    expect(a.children.size).toBe(1);
    expect(a.files.map(x => x.name)).toEqual(['y.ts']);
  });
});
