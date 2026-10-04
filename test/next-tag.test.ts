import { expect, test } from "bun:test";
import { nextTag } from "../scripts/next-tag.ts";

test("with no release tag, the first candidate of the package version", () => {
  expect(nextTag(["", "not-a-version"], "0.1.0")).toBe("v0.1.0-rc.1");
});

test("after a candidate, the next candidate of the same version", () => {
  expect(nextTag(["v0.1.0-rc.1", "v0.1.0-rc.2"], "0.1.0")).toBe("v0.1.0-rc.3");
});

test("after a final version, the first candidate of the next patch", () => {
  expect(nextTag(["v0.1.0-rc.9", "v0.1.0"], "0.1.0")).toBe("v0.1.1-rc.1");
});

test("a package version raised above every tag starts its own candidates", () => {
  expect(nextTag(["v0.1.0", "v0.1.1-rc.3"], "0.2.0")).toBe("v0.2.0-rc.1");
});

test("a package version below the highest tag does not move the count back", () => {
  expect(nextTag(["v0.2.0-rc.4"], "0.1.0")).toBe("v0.2.0-rc.5");
});

test("versions compare by number, not as text", () => {
  expect(nextTag(["v0.9.0", "v0.10.0-rc.2"], "0.1.0")).toBe("v0.10.0-rc.3");
});
