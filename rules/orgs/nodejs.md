# nodejs org

Applies to repos in the `nodejs` GitHub org (`nodejs/node`, `nodejs/undici`, …). Each repo's own `AGENTS.md`, `CONTRIBUTING.md`, and `doc/contributing/` are authoritative.

## `nodejs/node`

- **Commit trailers:** use the project's DCO convention instead of the default `Co-Authored-By`. Take your tool's trailer from Per-tool settings in the Git rules, change `Co-Authored-By` to `Assisted-by`, and follow it with a sign-off. For example, in Claude Code:
  ```text
  Assisted-by: Claude <model> <noreply@anthropic.com>
  Signed-off-by: Ethan Arrowood <ethan@arrowood.dev>
  ```
  The signed-off-by trailer should be generated using the `git commit -s` option, but can also be manually added depending on how the commit is being created.
- **Which `node`:** to run the project's code or tests, use the locally built `out/Release/node`, not the fnm version from the Node.js runtime rule. Use fnm's Node only for tooling outside the build.
- See the `nodejs-contribute` skill for the build/test/commit/land workflow.
