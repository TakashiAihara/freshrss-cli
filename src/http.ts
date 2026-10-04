// Orval's fetch mutator: every generated call goes through here, so the base URL and the Authorization header are
// set in one place and the generated code stays untouched.
type Session = { base: string; auth?: string };

let session: Session | undefined;

export const configure = (next: Session): void => {
  session = next;
};

export const customFetch = async <T>(path: string, init: RequestInit): Promise<T> => {
  if (!session) throw new Error("freshrss: client used before configure()");

  const headers = new Headers(init.headers);
  if (session.auth) headers.set("Authorization", `GoogleLogin auth=${session.auth}`);

  const res = await fetch(`${session.base}/api/greader.php${path}`, { ...init, headers });
  const text = await res.text();
  // FreshRSS answers errors as text/plain even on JSON endpoints, so parse by content type, not by the operation.
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const data = isJson && text !== "" ? JSON.parse(text) : text;

  return { data, status: res.status, headers: res.headers } as T;
};
