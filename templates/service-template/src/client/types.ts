export interface ClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface ExampleResponse {
  message: string;
}