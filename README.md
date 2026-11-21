# sokoban-solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Ger-Wer/sokoban-solver/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Ger-Wer/sokoban-solver/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for make.fun's "Build the best Sokoban solver, 21 November 2026" bounty ($100 in USDC). It answers every level of a set in as few pushes as possible — the push-optimal count, P*, on every level it has met.

## What it does

`main.ts` is the whole entry: it reads `/input/<id>/level.txt` (XSB) for the set's 5 levels and writes `/output/<id>/solution.txt`, the player's moves in LURD. It runs on Node 22 with only the standard library, no network, no clock, no randomness — two runs write byte-identical files.

## How it works

Every level this competition draws is a hallway with one to four rooms off it, each room holding 3 or 4 boxes and as many goals, and a box pushed out of a room can never come back. So the rooms are independent problems joined only by the player's walk, and the level's push-optimal count is the sum of the rooms' optima. The solver splits a level into rooms and solves each room push-optimally, then stitches the rooms' move strings together with the walks between them.

A room is solved by A* over pushes: a state is the boxes' squares plus the player's reachable region, every push costs 1, and the estimate is the cheapest assignment of boxes to goals (Hungarian, over at most 4! matchings) on walking distances that ignore the other boxes — an admissible estimate, so the first solved state met is push-optimal. Two deadlocks are pruned, both safe: a box on a dead square (one from which no push, ignoring the other boxes, can ever reach a goal) and a frozen 2x2 block of walls and boxes holding a box off its goal. If A* gives up on a room, plain breadth-first search over pushes is tried, then the rooms in a different order.

## Results on the practice set

| level | boxes | P* | pushes | points |
|-------|-------|----|--------|--------|
| i001 | 3 | 13 | 13 | 1,000 |
| i002 | 4 | 16 | 16 | 1,000 |
| i003 | 8 | 29 | 29 | 1,000 |
| i004 | 12 | 47 | 47 | 1,000 |
| i005 | 16 | 60 | 60 | 1,000 |

Score **1,000,000** (the maximum), in about 0.4 s for the whole set. The house baseline, make.fun's own plain-astar 1.0.0, scores 200,000 on the same set — it solves only i001 and gives up on the rest. Three further sets drawn fresh from the kit's generator (unseen levels, same generator) also score 1,000,000 each.

## Run it locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Or grade it exactly as the server does, from the unpacked kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repository> --driver docker
```

## License

MIT — see [LICENSE](LICENSE).
