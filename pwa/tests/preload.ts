import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { IDBFactory } from "fake-indexeddb";
GlobalRegistrator.register({ url: "http://localhost/" });
globalThis.indexedDB = new IDBFactory();
