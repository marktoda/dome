export type FixtureFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type ControlledResponse = Readonly<{
  response: Response;
  abort: () => void;
}>;

export async function fetchTextWithin(
  operation: string,
  milliseconds: number,
  url: string,
  init: RequestInit,
  diagnostic?: (() => string) | undefined,
  fetchImpl: FixtureFetch = fetch,
): Promise<Readonly<{ response: Response; text: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("fixture-request-timeout"), milliseconds);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return Object.freeze({ response, text: await response.text() });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    const detail = diagnostic?.();
    throw new Error(
      `${operation} exceeded ${milliseconds}ms${detail === undefined ? "" : ` (${detail})`}`,
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchResponseWithin(
  operation: string,
  milliseconds: number,
  url: string,
  init: RequestInit,
  fetchImpl: FixtureFetch = fetch,
): Promise<ControlledResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("fixture-header-timeout"), milliseconds);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    return Object.freeze({
      response,
      abort: () => controller.abort("product-fixture-cleanup"),
    });
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw new Error(`${operation} exceeded ${milliseconds}ms`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

export async function readControlledResponseText(
  controlled: ControlledResponse,
  milliseconds: number,
  operation: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      controlled.response.text(),
      new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          controlled.abort();
          reject(new Error(`${operation} exceeded ${milliseconds}ms`));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchBodiesWithin<
  const Requests extends ReadonlyArray<Readonly<{ url: string; init: RequestInit }>>,
>(
  operation: string,
  milliseconds: number,
  requests: Requests,
  fetchImpl: FixtureFetch = fetch,
): Promise<{ readonly [Index in keyof Requests]: Readonly<{
  response: Response;
  text: string;
}> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("fixture-bodies-timeout"), milliseconds);
  try {
    return await Promise.all(requests.map(async ({ url, init }) => {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      return Object.freeze({ response, text: await response.text() });
    })) as { readonly [Index in keyof Requests]: Readonly<{
      response: Response;
      text: string;
    }> };
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    throw new Error(`${operation} exceeded ${milliseconds}ms`, { cause: error });
  } finally {
    clearTimeout(timer);
    controller.abort("product-fixture-operation-complete");
  }
}

export async function pollJsonWithin<T>(input: Readonly<{
  operation: string;
  totalMs: number;
  requestMs: number;
  url: string;
  init: RequestInit;
  accept: (value: T) => boolean;
  fetchImpl?: FixtureFetch;
}>): Promise<void> {
  const deadline = Date.now() + input.totalMs;
  while (Date.now() < deadline) {
    const response = await fetchTextWithin(
      input.operation,
      Math.min(input.requestMs, Math.max(1, deadline - Date.now())),
      input.url,
      input.init,
      undefined,
      input.fetchImpl,
    );
    if (input.accept(JSON.parse(response.text) as T)) return;
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${input.operation} was not satisfied within ${input.totalMs}ms`);
}
