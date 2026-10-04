import { afterAll, beforeAll, expect, test } from "bun:test";
import { jsonOf } from "../src/api.ts";
import { ServerError } from "../src/errors.ts";
import { configure, customFetch } from "../src/http.ts";

// A fake server for the body handling of the mutator; the real server never sends these bodies on purpose.
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (req: Request): Response => {
      const path = new URL(req.url).pathname.replace("/api/greader.php", "");
      if (path === "/broken-json")
        return new Response('{"subscriptions": [', {
          headers: { "Content-Type": "application/json" },
        });
      if (path === "/html-json")
        return new Response('{"userName":"x"}', { headers: { "Content-Type": "text/html" } });
      if (path === "/proxy-page")
        return new Response("<html>login</html>", { headers: { "Content-Type": "text/html" } });
      return new Response("OK", { headers: { "Content-Type": "text/plain" } });
    },
  });
  configure({ base: `http://127.0.0.1:${server.port}` });
});

afterAll(() => {
  server.stop(true);
});

type Envelope = { data: unknown; status: number };

test("JSON sent as text/html is parsed", async () => {
  expect((await customFetch<Envelope>("/html-json", {})).data).toEqual({ userName: "x" });
});

test("a body that looks like JSON but does not parse is an error, not text", async () => {
  expect(customFetch<Envelope>("/broken-json", {})).rejects.toThrow("malformed JSON");
});

test("plain text stays text", async () => {
  expect((await customFetch<Envelope>("/ok", {})).data).toBe("OK");
});

test("jsonOf refuses a 200 that is not JSON, such as a proxy's HTML page", async () => {
  const { data } = await customFetch<Envelope>("/proxy-page", {});
  expect(() => jsonOf(data)).toThrow(ServerError);
});
