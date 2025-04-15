/**
 * Jest setup file to mock Cloudflare Worker environment
 */

// Mock global fetch
global.fetch = jest.fn();

// Mock Cloudflare Worker environment
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

global.Request = class Request {
  constructor(url, init) {
    this.url = url;
    this.method = init?.method || 'GET';
    this.headers = new Headers(init?.headers || {});
    this.body = init?.body || null;
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
      Object.entries(init).forEach(([key, value]) => {
        this.headers[key.toLowerCase()] = value;
      });
    }
  }

  get(name) {
    return this.headers[name.toLowerCase()];
  }

  set(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  has(name) {
    return name.toLowerCase() in this.headers;
  }

  append(name, value) {
    const key = name.toLowerCase();
    this.headers[key] = this.has(key) ? `${this.get(key)}, ${value}` : value;
  }

  delete(name) {
    delete this.headers[name.toLowerCase()];
  }

  forEach(callback) {
    Object.entries(this.headers).forEach(([key, value]) => {
      callback(value, key, this);
    });
  }
};

// Mock console methods if needed
global.console.debug = jest.fn();