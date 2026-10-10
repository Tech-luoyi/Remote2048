# ziap/2048-ai

- Source: https://github.com/ziap/2048-ai
- Pinned commit: `42c80817d49ad203d07014cc9282021851b077b7`
- License: MIT, copyright (c) 2026 Zap; see `LICENSE`.
- Vendored without modification: `src/`, `build.zig`, `LICENSE`,
  `js/worker.js`, `js/pool-worker.js`, and
  upstream `zig-out/main.wasm` (stored here as `main.wasm`).
- SHA-256 of `main.wasm`:
  `0fadf8c46e94c75212ea510d0ab2dd4d17ce85b3814c1e546841442208bd7651`

## Rebuild

Use Zig 0.16.0, as specified by upstream. In this directory:

```sh
zig build --release=fast
cp zig-out/main.wasm main.wasm
```

After rebuilding or upgrading, review upstream changes, update the recorded hash
and integration test, and run `npm test` from the project root. Zig is only
needed to rebuild the solver; installing or running this game needs no compiler.

## Integration

`js/ziap_solver.js` adapts `GameLogic.cells[x][y]` into the upstream row-major
64-bit rank board. Directions are already `up/right/down/left = 0/1/2/3`.
The original browser workers run unchanged: one search worker and N - 1 pool
workers share the compiled module and 64 MiB memory. Each pool worker's ready
handshake completes before the search worker starts. The default thread count
is `navigator.hardwareConcurrency`; the `threads` query parameter overrides it.
The adapter clamps it to 1-32 because upstream supports at most 31 pool workers.
The parent `js/solver_worker.js` handles game-state requests and fallback setup.

The upstream WASM uses adaptive depth allocation with its built-in BFS budget
of 655360. It has no millisecond-budget API; the item waits for each result
before moving without a per-search time limit. Each batch resets depth prediction
once, using the original `reset_depth`; tables and caches survive stop/start and
the end of a batch. Restarting the board or entering multiplayer releases the
workers. Results retain the original directions, including the rotating
direction on a `-1` reply. Search errors stop the item. Published upstream
native-console scores are not browser performance guarantees.

Cross-origin isolation (COOP/COEP) and a secure context are required for shared
WASM memory. The bundled Node server provides the headers; otherwise the worker
uses the existing JavaScript solver. Unsupported sizes and interference tiles
also use JS. Encoding matches upstream's 4-bit lookup: 32768 is rank 15, and
unknown values (including larger tiles and non-powers of two) are also rank 15.
The adapter never uses the game's random seed or overrides a search direction
to prioritize the goal tile. Actual moves still use GameLogic. The item keeps
the product's 15 effective moves per use and roughly 175 ms cadence; reaching
2048 automatically continues play, as upstream does.

`npm run test:solver` verifies the WASM hash, encoding, raw decision parity,
unchanged worker scripts running in real Node worker threads, shared-memory
pool operation, request serialization, and the game's batch lifecycle.
