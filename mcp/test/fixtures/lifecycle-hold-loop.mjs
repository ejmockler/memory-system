// lifecycle-hold-loop.mjs — preload fixture for server-lifecycle.test.mjs.
//
// Loaded via `node --import ./test/fixtures/lifecycle-hold-loop.mjs server.js`,
// this single ref'd interval holds the event loop open, simulating any real
// subsystem (keep-alive socket, ref'd retry timer) that keeps an orphaned
// server alive. Without it, a bare idle server already exits naturally on
// stdin EOF because its event loop empties — which would make the EOF gate
// in the lifecycle test dishonest (it would pass on pre-fix code).
setInterval(() => {}, 1 << 30);
