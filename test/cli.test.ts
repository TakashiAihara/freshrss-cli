import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cli, type Env, FEED_ITEMS, ok, start, USER } from "./env";

type Sub = { id: string; title: string; url: string; categories: { id: string; label: string }[] };
type Item = { id: string; title: string; categories: string[]; origin: { streamId: string } };
type Page = { items: Item[]; continuation?: string };
type Tag = { id: string; type?: string };

let env: Env;
let feedId: string;

const subs = async (): Promise<Sub[]> => ok<Sub[]>(await cli(env, ["subs", "list"]));
const entries = async (...args: string[]): Promise<Page> => ok<Page>(await cli(env, ["entries", ...args]));
const titles = (p: Page): string[] => p.items.map((i) => i.title).sort();

beforeAll(async () => {
  env = await start();
}, 120_000);

afterAll(async () => {
  await env?.stop();
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
  });
});

describe("reading and writing one user's data", () => {
  test("user prints the authenticated user", async () => {
    expect(ok<{ userName: string }>(await cli(env, ["user"])).userName).toBe(USER);
  });

  test("subs add subscribes, files the feed in the category and prints the new subscription", async () => {
    const added = ok<Sub>(await cli(env, ["subs", "add", env.feedUrl, "--title", "Local", "--category", "News"]));
    expect(added.id).toMatch(/^feed\/\d+$/);
    expect(added.title).toBe("Local");
    expect(added.categories[0]?.label).toBe("News");
    feedId = added.id.slice("feed/".length);

    const listed = await subs();
    expect(listed.map((s) => s.id)).toEqual([added.id]);
  });

  test("subs add of an unreachable URL fails with exit 1", async () => {
    const r = await cli(env, ["subs", "add", "http://127.0.0.1:1/none.xml"]);
    expect(r.code).toBe(1);
    expect((await subs()).length).toBe(1);
  });

  test("unread counts every item of the new feed", async () => {
    const u = ok<{ max: number; unreadcounts: { id: string; count: number }[] }>(await cli(env, ["unread"]));
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

  test("mark read / unread changes what --unread returns, with either id form", async () => {
    const [one] = (await entries("--feed", feedId, "--oldest", "-n", "1")).items;
    if (!one) throw new Error("no item");

    ok(await cli(env, ["mark", "read", one.id]));
    expect(titles(await entries("--feed", feedId, "--unread"))).toEqual(["Second", "Third"]);
    expect(titles(await entries("--feed", feedId, "--read"))).toEqual(["First"]);

    const [decimal] = ok<{ ids: string[] }>(await cli(env, ["ids", "--feed", feedId, "--read"])).ids;
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

  test("tags rm deletes a tag", async () => {
    ok(await cli(env, ["tags", "rm", "Later"]));
    const tags = ok<Tag[]>(await cli(env, ["tags", "list"]));
    expect(tags.some((t) => t.id === "user/-/label/Later")).toBe(false);
  });

  test("subs edit renames the feed and moves it to another category", async () => {
    ok(await cli(env, ["subs", "edit", feedId, "--title", "Renamed", "--category", "Other"]));
    const [s] = await subs();
    expect(s?.title).toBe("Renamed");
    expect(s?.categories[0]?.label).toBe("Other");
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

  test("a time that is neither ISO 8601 nor Unix seconds is rejected (exit 2)", async () => {
    const r = await cli(env, ["entries", "--since", "yesterday"]);
    expect(r.code).toBe(2);
  });
});
