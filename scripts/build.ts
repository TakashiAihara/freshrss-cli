import { $ } from "bun";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Builds a standalone binary for every release target and packs each one the way install.sh expects:
// dist/freshrss_<os>_<arch>.tar.gz holding freshrss, README.md and LICENSE, plus dist/checksums.txt in sha256sum
// format.
//
// Usage: bun scripts/build.ts [version]   (version defaults to "dev")

const TARGETS = [
  // baseline: the default x64 build needs AVX2, which older or emulated CPUs lack.
  { os: "linux", arch: "amd64", bun: "bun-linux-x64-baseline" },
  { os: "linux", arch: "arm64", bun: "bun-linux-arm64" },
  { os: "darwin", arch: "amd64", bun: "bun-darwin-x64-baseline" },
  { os: "darwin", arch: "arm64", bun: "bun-darwin-arm64" },
];

// The tag is vX.Y.Z; the binary reports X.Y.Z.
const version = (process.argv[2] ?? "dev").replace(/^v(?=\d)/, "");
const dist = new URL("../dist/", import.meta.url).pathname;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);

const sums: string[] = [];
for (const t of TARGETS) {
  const stage = `${dist}${t.os}_${t.arch}/`;
  mkdirSync(stage);
  await $`bun build src/cli.ts --compile --minify --target=${t.bun} --define FRESHRSS_VERSION=${JSON.stringify(version)} --outfile ${stage}freshrss`.quiet();
  await $`cp README.md LICENSE ${stage}`;
  const archive = `freshrss_${t.os}_${t.arch}.tar.gz`;
  await $`tar -czf ${dist}${archive} -C ${stage} freshrss README.md LICENSE`;
  rmSync(stage, { recursive: true });
  sums.push(
    `${createHash("sha256")
      .update(readFileSync(`${dist}${archive}`))
      .digest("hex")}  ${archive}`,
  );
  console.log(archive);
}
sums.sort((a, b) => ((a.split("  ")[1] ?? "") < (b.split("  ")[1] ?? "") ? -1 : 1));
writeFileSync(`${dist}checksums.txt`, `${sums.join("\n")}\n`);
