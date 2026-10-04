// The session around the generated client: logging in, telling a refusal from a result, and the action token.
import {
  clientLogin,
  getToken,
  listSubscriptions,
  OutputParameter,
  type Subscription,
} from "./generated/greader.ts";
import { configure } from "./http.ts";
import { ServerError } from "./errors.ts";

/** The shape every generated function answers with, whatever its status. */
type Envelope = { data: unknown; status: number };

/**
 * FreshRSS refuses with a short text body, sometimes on a JSON endpoint. Every success it sends is HTTP 200, so any
 * other status is a refusal, and the server's own text is what the user needs to see.
 *
 * The type annotation on the constant is what lets `if (res.status !== 200) refusal(res)` narrow the generated
 * response union; an arrow function with an inferred `never` return would not be recognised as terminating.
 */
export const refusal: (res: Envelope) => never = (res) => {
  const body = typeof res.data === "string" ? res.data.trim() : JSON.stringify(res.data);
  throw new ServerError(
    `the server refused the request (HTTP ${res.status}): ${body === "" ? "(empty body)" : body}`,
  );
};

export type Credentials = { url: string; user: string; password: string };

/**
 * Every run logs in with ClientLogin first and hands the `Auth` value to the shared session. The value never expires,
 * but caching it would put a credential on disk to save one request of a few tens of milliseconds.
 */
export const login = async ({ url, user, password }: Credentials): Promise<void> => {
  configure({ base: url });

  const res = await clientLogin({ Email: user, Passwd: password });
  if (res.status !== 200) refusal(res);

  const auth = /^Auth=(.+)$/m.exec(res.data)?.[1]?.trim();
  if (auth === undefined || auth === "") {
    throw new ServerError(`the login answered without an Auth value: ${res.data.trim()}`);
  }
  configure({ base: url, auth });
};

let tokenValue: string | undefined;

/** Write operations need the action token: 57 characters plus a newline, fixed until the API password changes. */
export const token = async (): Promise<string> => {
  if (tokenValue === undefined) {
    const res = await getToken();
    if (res.status !== 200) refusal(res);
    tokenValue = res.data.trim();
  }
  return tokenValue;
};

/** Every feed that is not hidden. */
export const subscriptions = async (): Promise<Subscription[]> => {
  const res = await listSubscriptions({ output: OutputParameter.json });
  if (res.status !== 200) refusal(res);
  return res.data.subscriptions;
};
