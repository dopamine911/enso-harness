# The Dogfood Arena in a container (#676): Enso's stack, the recorder, Chromium and the agent
# runner in one image, so a run touches nothing of the host but its run directory, and its model
# credential is the one injected into the `enso-arena-credentials` volume — never the host's login.
#
#   bun run arena container build
#   bun run arena container credential --api-key-stdin < key.txt
#   bun run arena container start --agent anthropic/claude-sonnet-5-5 --scenario iterate
#
# The Playwright image carries the Chromium the arena's @playwright/test 1.63.0 drives, at
# /ms-playwright; it must move with that version. Both images are pinned by digest (PR #678 review):
# a republished tag cannot change what a run ran on.
FROM mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27

# bun as the repository pins it; git (the project is a repository, and the run's build record reads
# git); python3 with venv and pip (the scenarios' agents build Python CLIs as often as web pages, and
# an arena run found `python -m venv` failing for want of ensurepip).
COPY --from=oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git python3 python-is-python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

# ⚠ The image's user takes the HOST's uid and gid (PR #678 review): the runs directory is a bind
# mount, which keeps host ownership on native Linux Docker, so a container user of any other uid
# could not write a run. `arena container build` passes the building user's ids; the base image's
# pwuser is 1001, which matched nobody here (Docker Desktop maps ownership, and hid it).
ARG ARENA_UID=1000
ARG ARENA_GID=1000
RUN groupmod --non-unique --gid "$ARENA_GID" pwuser \
  && usermod --non-unique --uid "$ARENA_UID" --gid "$ARENA_GID" pwuser \
  && chown -R pwuser:pwuser /home/pwuser

# pwuser owns the repository and its Enso home. The credentials directory is created here so a
# fresh named volume mounted over it is pwuser's too.
USER pwuser
ENV HOME=/home/pwuser
RUN mkdir -p /home/pwuser/.enso/pi-agent \
  && git config --global user.name "Enso Arena" \
  && git config --global user.email "arena@enso.invalid" \
  && git config --global init.defaultBranch main \
  && git config --global --add safe.directory /app

WORKDIR /app
COPY --chown=pwuser:pwuser . .
RUN bun install --frozen-lockfile

ENTRYPOINT ["bun", "run", "arena"]
