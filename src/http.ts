// Orval's fetch mutator: every generated call goes through here, so the base URL, the Authorization header and the
// timeout are set in one place and the generated code stays untouched.
type Session = { base: string; auth?: string };

// A request that has not answered by then is reported as a failure instead of leaving a script hanging. A caller
// whose request makes the server fetch feeds (subscribe, import) passes its own, longer signal.
const DEFAULT_TIMEOUT_MS = 60_000;

let session: Session | undefined;

export const configure = (next: Session): void => {
  session = next;
};

// Errors come back as text/plain even on JSON endpoints, and user-info and stream/items/ids send their JSON as
// text/html, so neither the operation nor the content type alone says what the body is. No text body the API sends
// on success starts with `{` or `[`, so one that does and does not parse is a broken response, not text.
const parseBody = (text: string, contentType: string): unknown => {
  if (!contentType.includes("json") && !/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`the server sent malformed JSON: ${text.slice(0, 200)}`);
  }
};

export const customFetch = async <T>(path: string, init: RequestInit): Promise<T> => {
  if (!session) throw new Error("freshrss: client used before configure()");

  const headers = new Headers(init.headers);
  if (session.auth) headers.set("Authorization", `GoogleLogin auth=${session.auth}`);

  const res = await fetch(`${session.base}/api/greader.php${path}`, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await res.text();
  const data = text === "" ? text : parseBody(text, res.headers.get("content-type") ?? "");

  return { data, status: res.status, headers: res.headers } as T;
};
