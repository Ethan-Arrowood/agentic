# nodejs org

Applies to repos in the `nodejs` GitHub org (`nodejs/node`, `nodejs/undici`, …). Each repo's own `AGENTS.md`, `CONTRIBUTING.md`, and `doc/contributing/` are authoritative.

## `nodejs/node`

- **Commit trailers:** only the DCO sign-off. No `Co-Authored-By` and no `Assisted-by`:
  ```text
  Signed-off-by: Ethan Arrowood <ethan@arrowood.dev>
  ```
  The signed-off-by trailer should be generated using the `git commit -s` option, but can also be manually added depending on how the commit is being created.
- **AI disclosure goes in the PR description, not the commits.** The project's [AI use policy](https://github.com/nodejs/node/blob/main/doc/contributing/ai-guidelines.md#naming-ai-tools-in-disclosures) recommends keeping for-profit model names out of commit messages. The Posting rules' footer is the disclosure. The policy also asks what I did to verify the change, so the PR description should say that too.
- **Which `node`:** to run the project's code or tests, use the container's `out/Release/node` (`devc.sh run out/Release/node …`), not the fnm version from the Node.js runtime rule. Use fnm's Node only for tooling outside the build.
- See the `nodejs-contribute` skill for the build/test/commit/land workflow.

### Build in the devcontainer

Configure, build, and test inside the official `nodejs/devcontainer:nightly` image, through the `nodejs-contribute` skill's `devc.sh`. Don't build on the host.

- Fall back to a host build (`build-node.sh`) only when I ask, or when the container can't do the job, for example a macOS-only bug or no container engine. Say when you fall back and why.
- Keep credentials on the host. Don't mount `~/.ssh`, tokens, or other secrets into the container. Run `git push`, `gh`, `ncu-ci`, and anything else that talks to GitHub on the host.
- The container isn't CI. Its build uses `--debug-node`, so `DCHECK`s fire that CI compiles out. Check a crash against `main` in the same container before blaming a PR.
- Ask before pulling a new image (about 10 GB), and before removing containers or volumes. They hold build caches that take minutes to rebuild.
