// Runs in the browser before any app code (Next's instrumentation-client
// convention), which is the only point early enough for this.
//
// Zod v4 compiles a fast object parser with `new Function` when it can. To
// find out whether it can, it builds one inside a try/catch the first time an
// object schema is CREATED, i.e. while `@repo/contracts` is loading. The
// production CSP has no 'unsafe-eval', so the probe is refused, Zod falls back
// to its ordinary parser and nothing breaks, but the browser still reports a
// violation. That was the "eval blocked" line on nearly every public and
// /keystone page in the CSP log (changes-62 #5). `jitless` skips the probe.
// The fallback parser is the one that was already running, so nothing changes
// except the noise.
//
// **No `import "zod"` here.** Zod's entry points re-export everything, every
// locale and the JSON Schema converter included, and this file is in every
// page's bundle. Importing `config` from it put ~370 KB of Zod on pages that
// never validate anything. Zod keeps its settings on one global object and
// ADOPTS an existing one when it loads (`globalThis.__zod_globalConfig ??=
// {}`), so setting the flag on that object first is the same as calling
// `z.config({ jitless: true })`. `zod-global-config.test.ts` fails if the
// installed Zod stops reading that key.
const zodGlobal = globalThis as { __zod_globalConfig?: { jitless?: boolean } };
(zodGlobal.__zod_globalConfig ??= {}).jitless = true;
