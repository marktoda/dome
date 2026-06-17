/// <reference lib="webworker" />
const CACHE = "dome-shell-v1";
self.addEventListener("install", (e) => { (e as ExtendableEvent).waitUntil(caches.open(CACHE).then(() => undefined)); });
self.addEventListener("fetch", () => { /* network-first; shell cached by the browser. v1: no-op passthrough. */ });
export {};
