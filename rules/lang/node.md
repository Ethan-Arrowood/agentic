---
paths:
  - "**/package.json"
  - "**/.node-version"
  - "**/.nvmrc"
  - "**/*.{js,mjs,cjs,ts,mts,cts}"
---

# Node.js

Applies when running or working on JavaScript or TypeScript code, or anything with a `package.json`.

## Runtime version with fnm

Use [fnm](https://github.com/Schniz/fnm) for every `node`/`npm`/`npx` invocation. Don't rely on whatever `node` is on `PATH`. Agent shells may not have fnm's shell hook loaded.

If fnm isn't installed, as in Claude Code cloud sessions, say so. Use the `node` on `PATH` if it matches the version resolved below. Otherwise ask before installing anything.

Resolve the version once per session, in this order, from the project root:

1. `.node-version`, then `.nvmrc`
2. `package.json#engines.node` (a semver range: use the newest version that satisfies it)
3. `package.json#devEngines.runtime`: the entry with `"name": "node"`, which may be an object or an array
4. If none of these exist, the latest LTS: `fnm list-remote --lts | tail -1`

fnm handles 1 and 2 itself (`--resolve-engines` is on by default). It does not read `devEngines`, so handle 3 by passing the version explicitly.

Don't use the `lts-latest` alias for 4. fnm only moves it when `fnm install --lts` runs, so it is often stale. Use the explicit version from `list-remote`.

Run commands through it:

```bash
fnm exec --using=<version> node …     # explicit (needed for devEngines / LTS fallback)
fnm exec node …                        # fnm resolves from .node-version / .nvmrc / engines
```

Install a missing version with `fnm install <version>`. It only affects fnm, so you don't need to ask.

Say which version you picked and why (which file, or the LTS fallback) the first time you run Node in a session.

## System default

If `fnm default` is older than the latest LTS (`fnm list-remote --lts | tail -1`), tell me. Don't change the default without asking. If I agree, run `fnm install <version> && fnm default <version>` with that explicit version.

In most cases the project-specified Node.js version should be used even if it's not the latest LTS major. Don't automatically upgrade the Node.js version for any project. You should only be doing this step if we are in a project that is compatible with the latest LTS.
