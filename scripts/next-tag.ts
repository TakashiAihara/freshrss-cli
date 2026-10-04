// Prints the tag the next automatic release gets: the next release candidate
// after the highest vX.Y.Z or vX.Y.Z-rc.N tag. Every main push is released as
// a candidate, and a final version is only ever cut by hand.

const SHAPE = /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

// major, minor, patch, rc. A final version sorts above every release candidate
// of itself, so its rc is Infinity.
type Version = [number, number, number, number];

function parse(tag: string): Version | undefined {
  const m = tag.trim().match(SHAPE);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
}

const compare = (a: Version, b: Version) => {
  for (let i = 0; i < 4; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

// `pkg` is the version in package.json. Raising it starts the candidates of that version: with no tag yet, or when it
// is above every tag, the next tag is its first candidate.
export function nextTag(tags: string[], pkg: string): string {
  const versions = tags.map(parse).filter((v): v is Version => v !== undefined);
  // As rc.0, the lowest candidate of that version: its own candidates are not below it.
  const start = parse(`v${pkg}-rc.0`);
  if (start === undefined) throw new Error(`package.json version ${pkg} is not X.Y.Z`);
  const highest = versions.reduce<Version | undefined>(
    (a, b) => (a === undefined || compare(b, a) > 0 ? b : a),
    undefined,
  );
  if (highest === undefined || compare(start, highest) > 0) return `v${pkg}-rc.1`;
  const [major, minor, patch, rc] = highest;
  return rc === Infinity
    ? `v${major}.${minor}.${patch + 1}-rc.1`
    : `v${major}.${minor}.${patch}-rc.${rc + 1}`;
}

if (import.meta.main) {
  const git = Bun.spawnSync(["git", "tag", "--list", "v*"]);
  if (git.exitCode !== 0) {
    console.error("git tag:", git.stderr.toString());
    process.exit(1);
  }
  try {
    const { version } = await import("../package.json");
    console.log(nextTag(git.stdout.toString().split("\n"), version));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
