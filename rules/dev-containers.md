# Dev containers

Applies when building, testing, or running a project's code.

## Prefer the project's dev container

If a project publishes a dev container (a `.devcontainer/` config, or an image its contributor docs point to), build and test inside it. Don't install or configure toolchains on the host for that project.

- The container pins the toolchain the project supports, and the host stays clean. It isn't CI: check the image's build flags before treating a result as what CI would see.
- Drive it from the shell with the container CLI: Podman first, then Docker. Don't depend on an editor's dev container integration.
- Bind-mount the checkout, so edits and `git` stay on the host. Keep build output in a named volume.
- Prebuilt images often ship a warm build cache. Configure with the same flags, paths, and interpreter the image used, or the cache is thrown away. Check the image's build script before choosing flags.
- Keep credentials on the host. Don't mount `~/.ssh`, tokens, or other secrets into the container. Run `git push`, `gh`, and other tools that talk to GitHub on the host.
- Pulling an image is a download. Name the image and its size, and ask first when it's large.
- Never remove volumes or images without asking. They may hold build caches that take a long time to rebuild.

## When to build on the host

Fall back to a host build only when I ask, or when the container can't do the job, for example a macOS-only bug or no container engine. Say when you fall back and why.

A project skill or org rule can add specifics, such as the `nodejs-contribute` skill's `devc.sh` for `nodejs/node`.
