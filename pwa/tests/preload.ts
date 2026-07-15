import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
GlobalRegistrator.register({ url: "http://localhost/" });
globalThis.indexedDB = new IDBFactory();
mock.module("virtual:pwa-register/react", () => ({
  useRegisterSW: () => ({
    offlineReady: [false, () => {}],
    needRefresh: [false, () => {}],
    updateServiceWorker: async () => {},
  }),
}));
