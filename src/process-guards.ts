/**
 * Process-level unhandled-rejection guard.
 *
 * Catches unhandled Promise rejections that would otherwise terminate the
 * Node process. Node 24+ defaults `--unhandled-rejections=throw`, which is
 * fatal — any awaitable that no caller ends up awaiting becomes a SIGABRT.
 *
 * The frequent offender on the XMPP path is `@xmpp/events/lib/promise.js`
 * timing out an IQ wait whose caller is no longer interested. The pattern:
 *
 *   function promise(...) {
 *     return new Promise((resolve, reject) => {
 *       setTimeout(() => reject(new TimeoutError()), timeout);
 *       ...
 *     });
 *   }
 *
 * When the stream goes down mid-IQ or a peer never responds, the timer
 * fires and `reject(...)` produces an unhandled rejection that crashes
 * the gateway. The companion guard in {@link ./omemo/store.ts} catches
 * the same class of issue, but it installs LAZILY when OMEMO first
 * loads — too late for the connection-setup window. If the very first
 * XMPP connect fails before OMEMO init (which is exactly what happened
 * to Pierce on 2026-05-31 19:46:00), the curve25519 guard isn't yet in
 * place and the process dies. Pre-installing here at channel-module-
 * load time covers that window.
 *
 * Coexists with the curve25519 guard cleanly: Node invokes all
 * `unhandledRejection` handlers, so both log; the prefixes make them
 * easy to tell apart in triage. The curve25519 guard ALSO removes the
 * wasm runtime's `process.abort()` handler, which we still need —
 * don't delete or replace that one.
 *
 * Deliberately does NOT catch `uncaughtException`: synchronous throws
 * are often genuine corruption (memory, file-handle leak, etc.) that
 * should surface as a crash so they can be triaged. Promise rejections
 * are dramatically more often "fire-and-forget background work timed
 * out" — different signal-to-noise ratio.
 */

let installed = false;

export function installProcessGuards(): void {
  if (installed) return;
  installed = true;

  process.on("unhandledRejection", (reason) => {
    const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
    // console.error so it shows up in the gateway's systemd journal at
    // stderr level regardless of whatever logger the plugin layer happens
    // to have configured at the moment the rejection fires.
    console.error(`[xmpp:process-guard] swallowed unhandled rejection: ${detail}`);
  });
}

// Install on module load so it's in place before any XMPP connection attempt.
installProcessGuards();
