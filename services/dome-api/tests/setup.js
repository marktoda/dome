/**
 * Jest setup file for Cloudflare Worker environment
 */

// Mock Cloudflare Worker environment
global.Request = class Request {};
global.Response = class Response {
  constructor(body, init) {
    this.body = body;
    this.init = init;
    this.status = init?.status || 200;
    this.statusText = init?.statusText || '';
    this.headers = new Headers(init?.headers || {});
  }

  json() {
    return Promise.resolve(JSON.parse(this.body));
  }

  text() {
    return Promise.resolve(this.body);
  }
};
global.Headers = class Headers {
  constructor(init) {
    this.headers = {};
    if (init) {
      Object.keys(init).forEach(key => {
        this.headers[key.toLowerCase()] = init[key];
      });
    }
  }

  get(name) {
    return this.headers[name.toLowerCase()];
  }

  set(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  append(name, value) {
    const key = name.toLowerCase();
    if (this.headers[key]) {
      this.headers[key] = `${this.headers[key]}, ${value}`;
    } else {
      this.headers[key] = value;
    }
  }

  delete(name) {
    delete this.headers[name.toLowerCase()];
  }

  has(name) {
    return name.toLowerCase() in this.headers;
  }
};

// Mock Cloudflare D1 Database
global.D1Database = class D1Database {
  async prepare() {
    return {
      bind: () => this,
      first: () => Promise.resolve({}),
      all: () => Promise.resolve([]),
      run: () => Promise.resolve({ success: true }),
    };
  }

  async batch() {
    return Promise.resolve([]);
  }

  async exec() {
    return Promise.resolve({ success: true });
  }
};

// Mock Cloudflare Vectorize
global.VectorizeIndex = class VectorizeIndex {
  async query() {
    return Promise.resolve({ matches: [] });
  }

  async insert() {
    return Promise.resolve({ success: true });
  }

  async upsert() {
    return Promise.resolve({ success: true });
  }

  async delete() {
    return Promise.resolve({ success: true });
  }
};

// Mock Cloudflare R2 Bucket
global.R2Bucket = class R2Bucket {
  async get() {
    return Promise.resolve(null);
  }

  async put() {
    return Promise.resolve({ success: true });
  }

  async delete() {
    return Promise.resolve({ success: true });
  }

  async list() {
    return Promise.resolve({ objects: [] });
  }
};

// Mock Cloudflare Queue
global.Queue = class Queue {
  async send() {
    return Promise.resolve({ success: true });
  }

  async sendBatch() {
    return Promise.resolve({ success: true });
  }
};