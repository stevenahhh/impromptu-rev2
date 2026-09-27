// Shared happy-dom registration for Bun test files.
//
// Two hard-won constraints shape this helper:
//
// 1. Never unregister and never swap the window. `unregister()` closes the happy-dom window,
//    and React's scheduler binds the global `MessageChannel` once, at first render. If a later
//    file re-registers, the window that owns that channel closes and React can no longer commit
//    — every subsequent render produces an empty <div> and every act() wait burns its full
//    timeout. One permanent window keeps the channel alive for the entire run.
// 2. Per-file isolation still matters, because real tests leave residue: documentElement.lang,
//    window.__STAGE_ORIGIN, window.opener, storage. So a "file scope" reset replaces swapping:
//    each call restores the attributes and globals the suite mutates, while the window itself
//    (and anything bound to it) survives.
//
// Bun's real platform globals are restored after registration as well — happy-dom's fetch /
// Request / Response / Headers / stream stand-ins are DOM-simulated, and tests that exercise
// real network semantics need Bun's implementations even alongside DOM suites.

import { GlobalRegistrator } from "@happy-dom/global-registrator";

const BUN_GLOBALS = [
  "fetch",
  "Request",
  "Response",
  "Headers",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
  "URLSearchParams",
  "AbortSignal",
  "AbortController",
  "FormData",
  "File",
  "Blob",
  "crypto",
  "atob",
  "btoa",
  // React's scheduler binds globalThis.MessageChannel once, at first render. happy-dom's
  // channel posts through the owning window's task manager, so it dies with that window's
  // document lifecycle and every later render becomes a silent no-op. Bun's native channel
  // has no window affinity and stays schedulable for the whole run. The same argument covers
  // the timer globals: fake-timer helpers patch globalThis anyway, so Bun's setTimeout family
  // is the safer baseline for every file in the process.
  "MessageChannel",
  "MessagePort",
  "queueMicrotask",
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
] as const;

type BunDescriptors = ReadonlyMap<string, PropertyDescriptor | undefined>;

let bunDescriptors: BunDescriptors | undefined;

function captureBunGlobals(): BunDescriptors {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const key of BUN_GLOBALS) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  }
  return descriptors;
}

function restoreBunGlobals(descriptors: BunDescriptors): void {
  for (const [key, descriptor] of descriptors) {
    if (descriptor === undefined) continue;
    Object.defineProperty(globalThis, key, descriptor);
  }
}

// Residue a previous file can leave on the shared window. Cleared at each file boundary so the
// next suite starts from the same state a fresh window would have given it.
function resetSharedWindowState(): void {
  const global = globalThis as Record<string, unknown>;
  delete global.__STAGE_ORIGIN;
  try {
    document.documentElement.lang = "en";
  } catch {
    // ignore: no document yet
  }
  try {
    (globalThis as unknown as { opener: unknown }).opener = null;
  } catch {
    // ignore: opener may be non-configurable on this window
  }
  try {
    window.localStorage?.clear();
    window.sessionStorage?.clear();
  } catch {
    // ignore: storage may be unavailable in this environment
  }
  try {
    window.history?.replaceState(null, "", "/");
  } catch {
    // ignore: history navigation may be unavailable
  }
}

export function registerDom(): void {
  bunDescriptors ??= captureBunGlobals();
  if (!GlobalRegistrator.isRegistered) {
    GlobalRegistrator.register();
    restoreBunGlobals(bunDescriptors);
  }
  resetSharedWindowState();
}
