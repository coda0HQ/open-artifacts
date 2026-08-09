/** Return the deepest network-cause message hidden by undici's fetch error. */
export function deepestCause(error) {
  let root = error;
  let guard = 0;
  while (root?.cause && root.cause !== root && guard++ < 10) {
    root = root.cause;
  }
  return root?.message ? root.message : String(error);
}

/**
 * @param {string} method
 * @param {string} url
 * @param {unknown} body
 * @param {string | null | undefined} token
 * @param {Record<string, string>} extraHeaders
 * @param {typeof fetch} fetchImpl
 */
export async function request(
  method,
  url,
  body,
  token = undefined,
  extraHeaders = {},
  fetchImpl = fetch,
) {
  /** @type {Record<string, string>} */
  const headers = {
    "content-type": "application/json",
    "Open-Artifacts-Protocol": "1",
    ...extraHeaders,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    throw new Error(`cannot reach ${url}: ${deepestCause(cause)}`, { cause });
  }
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text.slice(0, 200) };
  }
  return { status: response.status, json, text, headers: response.headers };
}
