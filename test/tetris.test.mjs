import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs the game's own <script> in Node with a stubbed DOM, so its logic can be tested directly.
function load() {
  const html = readFileSync(new URL('../examples/tetris.html', import.meta.url), 'utf8');
  const src = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const stub = new Proxy(function () {}, {
    get: (_, k) => (k === Symbol.toPrimitive ? () => 0 : stub), set: () => true, apply: () => stub, construct: () => stub,
  });
  const handlers = {};
  const sandbox = {
    document: stub, matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, performance: { now: () => 0 },
    addEventListener: (type, fn) => { handlers[type] = fn; }, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
  };
  const game = vm.runInNewContext(src + `
;({ W, H, SHAPES, rotate, collides, merge, clearLines, bagOf, reset, spawn, lock, turn, drop, down, move, act, frame,
  get board() { return board; }, set board(v) { board = v; }, get cur() { return cur; }, set cur(v) { cur = v; },
  get score() { return score; }, get lines() { return lines; }, set lines(v) { lines = v; },
  get level() { return level; }, get dead() { return dead; } })`, sandbox);
  return { game, handlers };
}

const emptyBoard = g => Array.from({ length: g.H }, () => Array(g.W).fill(0));
const key = (handlers, k, repeat = false) => handlers.keydown({ key: k, repeat, preventDefault() {} });

test('every piece has 4 cells and returns to itself after four turns', () => {
  const { game: g } = load();
  assert.equal(g.SHAPES.length, 7);
  for (const m of g.SHAPES) {
    assert.equal(m.flat().filter(Boolean).length, 4);
    assert.deepEqual([1, 2, 3, 4].reduce(x => g.rotate(x), m), m);
  }
});

test('collisions: walls, floor and locked blocks, but not above the top', () => {
  const { game: g } = load();
  const b = emptyBoard(g), o = g.SHAPES[1];
  assert.equal(g.collides(b, o, 0, 0), false);
  assert.equal(g.collides(b, o, -1, 0), true, 'left wall');
  assert.equal(g.collides(b, o, g.W - 1, 0), true, 'right wall');
  assert.equal(g.collides(b, o, 4, g.H - 1), true, 'floor');
  assert.equal(g.collides(b, o, 4, -1), false, 'partly above the top is fine');
  b[5][4] = 3;
  assert.equal(g.collides(b, o, 4, 4), true, 'locked block');
  assert.equal(g.collides(b, o, 6, 4), false);
});

test('the 7-bag deals every piece once per seven', () => {
  const { game: g } = load();
  g.reset();
  const seen = [g.cur.c];
  for (let i = 0; i < 69; i++) { g.board = emptyBoard(g); g.spawn(); seen.push(g.cur.c); }
  for (let i = 0; i < 70; i += 7) assert.deepEqual([...seen.slice(i, i + 7)].sort(), [0, 1, 2, 3, 4, 5, 6], `bag at ${i}`);
});

test('clearing lines: adjacent, separated, and everything above shifts down', () => {
  const { game: g } = load();
  const b = emptyBoard(g);
  b[19].fill(1); b[18].fill(2); b[17][3] = 5; b[16][0] = 6;
  assert.equal(g.clearLines(b), 2);
  assert.equal(b[19][3], 5, 'row 17 fell to the bottom');
  assert.equal(b[18][0], 6, 'row 16 fell one row less');
  assert.equal(b.length, g.H);
  assert.ok(b[0].every(v => v === 0) && b[1].every(v => v === 0));

  const c = emptyBoard(g);
  c[19].fill(1); c[17].fill(1); c[18][4] = 7;
  assert.equal(g.clearLines(c), 2);
  assert.equal(c[19][4], 7, 'the partial row between them survives');
  assert.equal(c.flat().filter(Boolean).length, 1);
});

test('scoring, level-ups and game over', () => {
  for (const [n, points] of [[1, 100], [2, 300], [3, 500], [4, 800]]) {
    const { game: g } = load();
    g.reset();
    g.board = emptyBoard(g);
    for (let y = 16; y < 20; y++) {
      for (let x = 1; x < g.W; x++) g.board[y][x] = y >= 20 - n || x < 4 ? 1 : 0; // bottom n rows: full but for column 0
    }
    g.cur = { c: 0, m: g.rotate(g.SHAPES[0]), x: 0, y: 16 }; // a vertical I dropped into column 0
    g.lock();
    assert.equal(g.lines, n, `${n} lines`);
    assert.equal(g.score, points, `${n} lines score`);
  }
  const { game: g } = load();
  g.reset(); g.lines = 9;
  g.board = emptyBoard(g);
  g.board[19].fill(1); g.board[19][0] = 0;
  g.cur = { c: 0, m: g.rotate(g.SHAPES[0]), x: 0, y: 16 };
  g.lock();
  assert.deepEqual([g.lines, g.level], [10, 2], 'level 2 after ten lines');

  g.board = emptyBoard(g);
  g.board[0].fill(1); g.board[1].fill(1);
  g.spawn();
  assert.equal(g.dead, true, 'blocked spawn is game over');
  g.act('left'); // any action restarts
  assert.deepEqual([g.dead, g.score, g.lines, g.level], [false, 0, 0, 1]);
});

test('hard drop lands on the floor and scores two points per row', () => {
  const { game: g } = load();
  g.reset();
  g.board = emptyBoard(g);
  g.cur = { c: 1, m: g.SHAPES[1], x: 4, y: 0 };
  g.drop();
  assert.equal(g.board[19][4] && g.board[19][5] && g.board[18][4] && g.board[18][5], 2, 'O piece fills the bottom two rows');
  assert.equal(g.score, 2 * 18);
  assert.ok(!g.dead && g.cur.y === 0, 'next piece spawned at the top');
});

test('turning kicks off walls, including an I piece standing against the right wall', () => {
  const { game: g } = load();
  g.reset();
  g.board = emptyBoard(g);
  g.cur = { c: 0, m: g.rotate(g.SHAPES[0]), x: g.W - 1, y: 5 };
  g.turn();
  assert.equal(g.cur.m[0].length, 4, 'now horizontal');
  assert.ok(!g.collides(g.board, g.cur.m, g.cur.x, g.cur.y) && g.cur.x + 3 < g.W);
});

test('gravity: an untouched game falls, locks, stacks and ends without errors', () => {
  const { game: g } = load();
  g.reset();
  const y0 = g.cur.y;
  for (let t = 1; t <= 9; t++) g.frame(t * 100);
  assert.equal(g.cur.y, y0 + 1, 'fell one row after 800 ms');
  for (let t = 10; t <= 20000 && !g.dead; t++) g.frame(t * 100);
  assert.equal(g.dead, true, 'the stack eventually reaches the top');
});

test('keyboard: move, rotate, drop, ignore held keys, restart after game over', () => {
  const { game: g, handlers } = load();
  g.reset();
  g.board = emptyBoard(g);
  g.cur = { c: 2, m: g.SHAPES[2], x: 4, y: 0 };
  key(handlers, 'ArrowLeft');
  assert.equal(g.cur.x, 3);
  key(handlers, 'd'); key(handlers, 'd');
  assert.equal(g.cur.x, 5);
  key(handlers, 'ArrowUp');
  assert.equal(g.cur.m.length, 3, 'rotated to a 3-tall piece');
  const before = g.score;
  key(handlers, ' ', true);
  assert.equal(g.score, before, 'a held space does not keep dropping');
  key(handlers, ' ');
  assert.ok(g.score > before);
  key(handlers, 'q');
  assert.ok(!g.dead, 'unknown keys do nothing while playing');
  g.board[0].fill(1); g.board[1].fill(1); g.spawn();
  assert.equal(g.dead, true);
  key(handlers, 'q');
  assert.equal(g.dead, false, 'any key restarts');
});
