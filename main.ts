// sokoban-solver: a push-optimal Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// One program answers a whole set (5 levels) in one run: it reads /input/<id>/level.txt
// and writes /output/<id>/solution.txt, the player's moves in LURD.
//
// How it works
// -----------
// Every level this competition draws is a hallway with one to four rooms off it, each
// room holding 3 or 4 boxes and as many goals, and a box pushed out of a room through
// its door can never come back. So the rooms are independent problems joined only by
// the player's walk, and the level's push-optimal count is the sum of the rooms'
// optima. This solver therefore splits a level into rooms and solves each room
// push-optimally, then stitches the rooms' move strings together with the walks
// between them.
//
// A room is solved by A* over pushes: a state is the boxes' squares plus the
// player's reachable region (named by its lowest square), every push costs 1, and
// the estimate is the cheapest assignment of boxes to goals (Hungarian, by brute
// force over at most 4! matchings) on walking distances that ignore the other boxes
// — an admissible estimate, so the first solved state A* meets is push-optimal.
// Two deadlocks are pruned, both safe (neither prunes a solvable state):
//   * a box on a dead square — one from which no sequence of pushes, ignoring the
//     other boxes, can ever reach a goal (found by pulling back from the goals);
//   * a frozen 2x2 block of walls and boxes holding a box off its goal.
// If A* gives up on a room (its state budget), plain breadth-first search over
// pushes — also push-optimal, same pruning — is tried, then the rooms are tried
// in a different order. A level that still will not solve gets an empty answer
// (valid, worth no points) rather than no answer at all.
//
// Determinism: the search is budgeted by states kept, never by the clock; the
// direction order, the tie-breaks and the iteration orders are all fixed, so two
// runs on the same set write byte-identical files. Only Node's standard library
// is used, and no randomness, clock, environment or file outside /input and
// /output is read.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions: [dx, dy, step letter, push letter]. Fixed order everywhere.
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// How many states one room search may keep before it gives up. Work, never the clock.
const ASTAR_STATES = 400_000;
const BFS_STATES = 400_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (short rows and the outer frame count as walls)
  goals: number[];
  boxes: number[]; // sorted
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outer frame is wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

// The squares from which a box alone can be pushed onto some goal: pull back from
// the goals over open floor. A box on any other square is dead and pruned.
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// The squares the player reaches from `from` with `occupied` in the way, marked in
// `seen` with `stamp`; returns the lowest square reached (the region's name).
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes
// holding a box off its goal.
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// Walking distances from every square to each goal, ignoring boxes (walls only):
// dist[g][square]. Infinity where a goal cannot be walked to.
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p]! + 1;
          queue.push(q);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

// The cheapest assignment of boxes to goals on `dist` (brute force over the
// matchings: at most 4 boxes, so at most 24). Infinity when no box reaches a goal
// it must take. Admissible: each push moves one box one square.
function hungarian(boxes: number[], dist: Int32Array[]): number {
  const n = boxes.length;
  let best = Infinity;
  const assign = (p: number[]): number => {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = dist[p[i]]![boxes[i]!];
      if (d < 0) return Infinity;
      total += d;
    }
    return total;
  };
  // Every permutation of 0..n-1, in fixed order.
  const idx = Array.from({ length: n }, (_, i) => i);
  const gen = (k: number): void => {
    if (k === n) {
      const v = assign(idx);
      if (v < best) best = v;
      return;
    }
    for (let i = k; i < n; i++) {
      [idx[k], idx[i]] = [idx[i]!, idx[k]!];
      gen(k + 1);
      [idx[k], idx[i]] = [idx[i]!, idx[k]!];
    }
  };
  gen(0);
  return best;
}

// The shortest walk from `from` to `to` around walls and boxes, in lower LURD
// letters (the first direction first on ties). Throws when unreachable.
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface SearchResult {
  pushes: number;
  moves: string;
}

// A state's key: the region's lowest square and the boxes' squares, as digits in
// base `size` (exact while size ** (boxes + 1) stays under 2 ** 53: a room of up to
// four boxes on any board this competition draws).
function keyOf(boxes: number[], low: number, size: number): number {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

// The push-optimal solution of `level` (at most `maxStates` states kept), by A*
// over pushes with the Hungarian estimate, or null when the search gives up.
function solveAStar(level: Level, maxStates: number): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = goalDistances(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  // The states in the order found: boxes, the player's square, g, h, parent.
  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const sG: number[] = [0];
  const sH: number[] = [hungarian(level.boxes, dist)];
  const parent: number[] = [-1];
  const best = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  best.set(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;

  // A binary heap of state indices, ordered by (g + h, h, insertion order).
  const heap: number[] = [0];
  let seq = 1;
  const seqOf: number[] = [0];
  const less = (a: number, b: number): boolean => {
    const fa = sG[a]! + sH[a]!;
    const fb = sG[b]! + sH[b]!;
    if (fa !== fb) return fa < fb;
    if (sH[a] !== sH[b]) return sH[a]! < sH[b]!;
    return seqOf[a]! < seqOf[b]!;
  };
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  let found = solved(level.boxes) ? 0 : -1;
  while (heap.length > 0 && found < 0) {
    const s = heapPop();
    const g = sG[s]!;
    const boxes = sBoxes[s]!;
    // A stale heap entry: a better g for this state was found since.
    for (const b of boxes) occupied[b] = 1;
    const low = reach(level, occupied, sPlayer[s]!, seen, ++stamp, stack);
    if (best.get(keyOf(boxes, low, size)) !== s) {
      for (const b of boxes) occupied[b] = 0;
      continue;
    }
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        let h = 0;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          h = hungarian(next, dist);
          if (h !== Infinity) key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || h === Infinity) continue;
        const prevBest = best.get(key);
        if (prevBest !== undefined && sG[prevBest]! <= g + 1) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        const ns = sBoxes.length;
        best.set(key, ns);
        sBoxes.push(next!);
        sPlayer.push(b);
        sG.push(g + 1);
        sH.push(h);
        seqOf.push(seq++);
        parent.push(s);
        heapPush(ns);
        if (solved(next!)) {
          found = ns;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  return { pushes: sG[found]!, moves: reconstruct(level, sBoxes, sPlayer, parent, found) };
}

// The same search as breadth-first over pushes (also push-optimal), for the
// rooms A* gives up on.
function solveBfs(level: Level, maxStates: number): SearchResult | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (level.boxes.some((b) => !live[b])) return null;

  const sBoxes: number[][] = [level.boxes];
  const sPlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of level.boxes) occupied[b] = 1;
  index.set(keyOf(level.boxes, reach(level, occupied, level.player, seen, ++stamp, stack), size), 0);
  for (const b of level.boxes) occupied[b] = 0;
  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < sBoxes.length; head++) {
    const boxes = sBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, sPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (sBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, sBoxes.length);
        sBoxes.push(next!);
        sPlayer.push(b);
        parent.push(head);
        if (solved(next!)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;
  return { pushes: pathLength(parent, found), moves: reconstruct(level, sBoxes, sPlayer, parent, found) };
}

function pathLength(parent: number[], found: number): number {
  let n = 0;
  for (let s = found; s > 0; s = parent[s]!) n++;
  return n;
}

// The moves of a found state: walk to each push's square, then push.
function reconstruct(level: Level, sBoxes: number[][], sPlayer: number[], parent: number[], found: number): string {
  const { w } = level;
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes;
  const occupied = new Uint8Array(level.wall.length);
  for (const s of path) {
    const nextBoxes = sBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  void sPlayer;
  return moves;
}

// The square the player stands on after `moves` (LURD, the case aside) from `from`.
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
}

// A level's rooms: cut the dead squares of the player's row (the hallway: a box
// there reaches no goal) out of the floor, and each part left that holds a box is
// a room. Null when some part holds more or fewer boxes than goals, or a box
// starts in the hallway: then the level is no set of rooms.
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// One room's push-optimal solution, A* first, breadth-first as the fallback.
// `rooms` is the level's room list (one object per room); `done` the rooms
// already solved. Other rooms' boxes stand as walls — on their goals once their
// room is done — so the search never touches them.
function solveRoom(level: Level, rooms: Room[], room: Room, player: number, done: Room[]): SearchResult | null {
  const wall = level.wall.slice();
  for (const other of rooms) {
    if (other === room) continue;
    for (const b of done.includes(other) ? other.goals : other.boxes) wall[b] = 1;
  }
  const sub: Level = {
    w: level.w,
    h: level.h,
    wall,
    goals: room.goals.slice().sort((a, b) => a - b),
    boxes: room.boxes.slice().sort((a, b) => a - b),
    player,
  };
  return solveAStar(sub, ASTAR_STATES) ?? solveBfs(sub, BFS_STATES);
}

// The level solved room by room, in `order`: each room's push-optimal solution in
// turn, the other rooms' boxes standing as walls (on their goals once their room
// is done), the player walking on from where the last room left it.
function solveByRooms(level: Level, rooms: Room[], order: Room[]): SearchResult | null {
  let player = level.player;
  let pushes = 0;
  let moves = '';
  const done: Room[] = [];
  for (const room of order) {
    const solved = solveRoom(level, rooms, room, player, done);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    done.push(room);
  }
  return { pushes, moves };
}

// Every order of the rooms, the given one first, then the reverse, then the
// rest in fixed order. Small: at most four rooms.
function roomOrders(rooms: Room[]): Room[][] {
  const seen = new Set<string>();
  const orders: Room[][] = [];
  const add = (order: Room[]): void => {
    const key = order.map((r) => rooms.indexOf(r)).join(',');
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(order);
    }
  };
  add(rooms);
  add([...rooms].reverse());
  const gen = (prefix: Room[], rest: Room[]): void => {
    if (rest.length === 0) {
      add(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      gen([...prefix, rest[i]!], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  gen([], rooms);
  return orders;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms !== null) {
    for (const order of roomOrders(rooms)) {
      const solved = solveByRooms(level, rooms, order);
      if (solved !== null) return solved.moves;
    }
  }
  // No rooms, or no order of them solved: the whole level at once (only small
  // levels can go this way).
  const whole = solveAStar(level, ASTAR_STATES) ?? solveBfs(level, BFS_STATES);
  return whole === null ? '' : whole.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
