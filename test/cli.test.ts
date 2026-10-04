import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli, type Env, FEED_ITEMS, ok, start, stopAll, USER } from "./env";
import pkg from "../package.json";

type Sub = { id: string; title: string; url: string; categories: { id: string; label: string }[] };
type Item = { id: string; title: string; categories: string[]; origin: { streamId: string } };
type Page = { items: Item[]; continuation?: string };
type Tag = { id: string; type?: string };

let env: Env;
let feedId: string;

const subs = async (): Promise<Sub[]> => ok<Sub[]>(await cli(env, ["subs", "list"]));
const entries = async (...args: string[]): Promise<Page> =>
  ok<Page>(await cli(env, ["entries", ...args]));
const titles = (p: Page): string[] => p.items.map((i) => i.title).sort();

beforeAll(async () => {
  env = await start();
}, 120_000);

afterAll(async () => {
  await stopAll();
});

describe("configuration", () => {
  test("a missing API password is a usage error (exit 2) and names the variable", async () => {
    const r = await cli(env, ["user"], { vars: { FRESHRSS_API_PASSWORD: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("FRESHRSS_API_PASSWORD");
  });

  test("a missing URL is a usage error (exit 2)", async () => {
    const r = await cli(env, ["user"], { vars: { FRESHRSS_URL: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("FRESHRSS_URL");
  });

  test("--url and --user override the environment", async () => {
    const r = await cli(env, ["--url", env.base, "--user", USER, "user"], {
      vars: { FRESHRSS_URL: "http://127.0.0.1:1", FRESHRSS_USER: "nobody" },
    });
    expect(ok<{ userName: string }>(r).userName).toBe(USER);
  });

  test("a wrong API password is a server refusal (exit 1)", async () => {
    const r = await cli(env, ["user"], { vars: { FRESHRSS_API_PASSWORD: "wrong" } });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("HTTP 401");
  });
});

describe("reading and writing one user's data", () => {
  test("user prints the authenticated user", async () => {
    expect(ok<{ userName: string }>(await cli(env, ["user"])).userName).toBe(USER);
  });

  test("subs add subscribes, files the feed in the category and prints the new subscription", async () => {
    const added = ok<Sub>(
      await cli(env, ["subs", "add", env.feedUrl, "--title", "Local", "--category", "News"]),
    );
    expect(added.id).toMatch(/^feed\/\d+$/);
    expect(added.title).toBe("Local");
    expect(added.categories[0]?.label).toBe("News");
    feedId = added.id.slice("feed/".length);

    const listed = await subs();
    expect(listed.map((s) => s.id)).toEqual([added.id]);
  });

  test("subs add accepts the url in its feed/ form", async () => {
    const other = env.feedUrl.replace("feed.xml", "other.xml");
    const added = ok<Sub>(await cli(env, ["subs", "add", `feed/${other}`]));
    expect(added.url).toBe(other);
    ok(await cli(env, ["subs", "rm", added.id]));
  });

  test("subs add of an unreachable URL fails with exit 1", async () => {
    const r = await cli(env, ["subs", "add", "http://127.0.0.1:1/none.xml"]);
    expect(r.code).toBe(1);
    expect((await subs()).length).toBe(1);
  });

  test("unread counts every item of the new feed", async () => {
    const u = ok<{ max: number; unreadcounts: { id: string; count: number }[] }>(
      await cli(env, ["unread"]),
    );
    expect(u.max).toBe(3);
    expect(u.unreadcounts.find((c) => c.id === `feed/${feedId}`)?.count).toBe(3);
  });

  test("entries --feed lists the feed's items with their titles", async () => {
    const p = await entries("--feed", feedId);
    expect(titles(p)).toEqual(FEED_ITEMS.map((i) => i.title).sort());
    expect(p.continuation).toBeUndefined();
  });

  test("entries -n pages and --all follows continuations to the end", async () => {
    const first = await entries("--feed", feedId, "-n", "2");
    expect(first.items.length).toBe(2);
    expect(first.continuation).toBeString();

    const second = await entries("--feed", feedId, "-n", "2", "-c", first.continuation ?? "");
    expect(second.items.length).toBe(1);

    const all = await entries("--feed", feedId, "-n", "2", "--all");
    expect(titles(all)).toEqual(FEED_ITEMS.map((i) => i.title).sort());
    expect(all.continuation).toBeUndefined();
  });

  test("entries --oldest returns the oldest item first", async () => {
    expect((await entries("--feed", feedId, "--oldest", "-n", "1")).items[0]?.title).toBe("First");
    expect((await entries("--feed", feedId, "-n", "1")).items[0]?.title).toBe("Third");
  });

  test("entries --since a future time returns nothing", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await entries("--feed", feedId, "--since", future)).items).toEqual([]);
  });

  test("ids lists decimal ids and get fetches them", async () => {
    const r = ok<{ ids: string[] }>(await cli(env, ["ids", "--feed", feedId]));
    expect(r.ids.length).toBe(3);
    for (const id of r.ids) expect(id).toMatch(/^\d+$/);

    const got = ok<Page>(await cli(env, ["get", ...r.ids.slice(0, 2)]));
    expect(got.items.length).toBe(2);
  });

  test("get takes the long id form that entries prints", async () => {
    const [one] = (await entries("--feed", feedId, "-n", "1")).items;
    if (!one) throw new Error("no item");
    expect(one.id).toMatch(/^tag:google\.com,2005:reader\/item\/[0-9a-f]{16}$/);
    expect(ok<Page>(await cli(env, ["get", one.id])).items.map((i) => i.title)).toEqual([
      one.title,
    ]);
  });

  test("entries --until a past time returns nothing, a future time returns everything", async () => {
    // The bound is on the publication and the last change; the items changed when they were added, minutes ago.
    expect((await entries("--feed", feedId, "--until", "2026-01-05")).items).toEqual([]);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await entries("--feed", feedId, "--until", future)).items.length).toBe(3);
  });

  test("--stream takes a stream id as is, including the read and unread states", async () => {
    expect((await entries("--stream", `feed/${feedId}`)).items.length).toBe(3);
    expect((await entries("--stream", "user/-/state/com.google/unread")).items.length).toBe(3);
    expect((await entries("--stream", "user/-/state/com.google/read")).items).toEqual([]);
  });

  test("mark read / unread changes what --unread returns, with either id form", async () => {
    const [one] = (await entries("--feed", feedId, "--oldest", "-n", "1")).items;
    if (!one) throw new Error("no item");

    ok(await cli(env, ["mark", "read", one.id]));
    expect(titles(await entries("--feed", feedId, "--unread"))).toEqual(["Second", "Third"]);
    expect(titles(await entries("--feed", feedId, "--read"))).toEqual(["First"]);

    const [decimal] = ok<{ ids: string[] }>(
      await cli(env, ["ids", "--feed", feedId, "--read"]),
    ).ids;
    ok(await cli(env, ["mark", "unread", decimal ?? ""]));
    expect((await entries("--feed", feedId, "--unread")).items.length).toBe(3);
  });

  test("mark star / unstar changes what --starred returns", async () => {
    const [one] = (await entries("--feed", feedId, "-n", "1")).items;
    if (!one) throw new Error("no item");

    ok(await cli(env, ["mark", "star", one.id]));
    expect(titles(await entries("--starred"))).toEqual(["Third"]);

    ok(await cli(env, ["mark", "unstar", one.id]));
    expect((await entries("--starred")).items).toEqual([]);
  });

  test("mark tag creates the tag, --label lists the tagged item, mark untag removes it", async () => {
    const [one] = (await entries("--feed", feedId, "-n", "1")).items;
    if (!one) throw new Error("no item");

    ok(await cli(env, ["mark", "tag", "Later", one.id]));
    const tags = ok<Tag[]>(await cli(env, ["tags", "list"]));
    expect(tags.find((t) => t.id === "user/-/label/Later")?.type).toBe("tag");
    expect(titles(await entries("--label", "Later"))).toEqual(["Third"]);

    ok(await cli(env, ["mark", "untag", "Later", one.id]));
    expect((await entries("--label", "Later")).items).toEqual([]);
  });

  test("tags rename renames a category", async () => {
    ok(await cli(env, ["tags", "rename", "News", "Daily"]));
    expect((await subs())[0]?.categories[0]?.label).toBe("Daily");
  });

  test("tags rm deletes a category and moves its feeds to the default category", async () => {
    ok(await cli(env, ["subs", "edit", feedId, "--category", "Doomed"]));
    ok(await cli(env, ["tags", "rm", "Doomed"]));
    const tags = ok<Tag[]>(await cli(env, ["tags", "list"]));
    expect(tags.some((t) => t.id === "user/-/label/Doomed")).toBe(false);
    expect((await subs())[0]?.categories[0]?.label).not.toBe("Doomed");
  });

  test("tags rm deletes a tag", async () => {
    ok(await cli(env, ["tags", "rm", "Later"]));
    const tags = ok<Tag[]>(await cli(env, ["tags", "list"]));
    expect(tags.some((t) => t.id === "user/-/label/Later")).toBe(false);
  });

  test("subs edit with neither --title nor --category is a usage error", async () => {
    expect((await cli(env, ["subs", "edit", feedId])).code).toBe(2);
  });

  test("subs edit renames the feed and moves it to another category", async () => {
    ok(await cli(env, ["subs", "edit", feedId, "--title", "Renamed", "--category", "Other"]));
    const [s] = await subs();
    expect(s?.title).toBe("Renamed");
    expect(s?.categories[0]?.label).toBe("Other");
  });

  test("mark-all-read --before a time before the items were added marks nothing", async () => {
    // The items were added when the feed was subscribed, minutes ago; their published dates are in January.
    ok(await cli(env, ["mark-all-read", `feed/${feedId}`, "--before", "2026-02-01T00:00:00Z"]));
    expect((await entries("--feed", feedId, "--unread")).items.length).toBe(3);
  });

  test("mark-all-read --before a time after the items were added marks them", async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    ok(await cli(env, ["mark-all-read", `feed/${feedId}`, "--before", tomorrow]));
    expect((await entries("--feed", feedId, "--unread")).items).toEqual([]);

    const ids = ok<{ ids: string[] }>(await cli(env, ["ids", "--feed", feedId])).ids;
    ok(await cli(env, ["mark", "unread", ...ids]));
  });

  test("mark-all-read marks every item of the stream read", async () => {
    ok(await cli(env, ["mark-all-read", `feed/${feedId}`]));
    expect((await entries("--feed", feedId, "--unread")).items).toEqual([]);
  });

  test("subs export prints OPML; subs rm unsubscribes; subs import from stdin restores it", async () => {
    const opml = await cli(env, ["subs", "export"]);
    expect(opml.code).toBe(0);
    expect(opml.stdout).toContain("<opml");
    expect(opml.stdout).toContain(env.feedUrl);

    ok(await cli(env, ["subs", "rm", feedId]));
    expect(await subs()).toEqual([]);

    ok(await cli(env, ["subs", "import", "-"], { stdin: opml.stdout }));
    expect((await subs()).map((s) => s.url)).toEqual([env.feedUrl]);
  });

  test("subs import reads a file", async () => {
    const opml = (await cli(env, ["subs", "export"])).stdout;
    const [s] = await subs();
    ok(await cli(env, ["subs", "rm", s?.id ?? ""]));

    const dir = await mkdtemp(join(tmpdir(), "freshrss-cli-test-"));
    try {
      await writeFile(join(dir, "subs.opml"), opml);
      ok(await cli(env, ["subs", "import", join(dir, "subs.opml")]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect((await subs()).map((s) => s.url)).toEqual([env.feedUrl]);
  });
});

describe("version", () => {
  test("--version prints the version without logging in", async () => {
    const r = await cli(env, ["--version"], {
      vars: { FRESHRSS_URL: undefined, FRESHRSS_API_PASSWORD: undefined },
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });
});

describe("usage errors", () => {
  test("two stream options at once are rejected (exit 2)", async () => {
    const r = await cli(env, ["entries", "--feed", "1", "--label", "x"]);
    expect(r.code).toBe(2);
  });

  test("an unknown mark action is rejected (exit 2)", async () => {
    const r = await cli(env, ["mark", "explode", "1"]);
    expect(r.code).toBe(2);
  });

  test("mark-all-read --before 1970 or earlier is rejected (exit 2): the server reads ts=0 as no bound", async () => {
    expect(
      (await cli(env, ["mark-all-read", "user/-/state/com.google/reading-list", "--before", "0"]))
        .code,
    ).toBe(2);
    expect(
      (
        await cli(env, [
          "mark-all-read",
          "user/-/state/com.google/reading-list",
          "--before",
          "1970-01-01",
        ])
      ).code,
    ).toBe(2);
  });

  test("a time that is neither ISO 8601 nor Unix seconds is rejected (exit 2)", async () => {
    const r = await cli(env, ["entries", "--since", "yesterday"]);
    expect(r.code).toBe(2);
  });
});
