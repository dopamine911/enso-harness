# The Dogfood Arena in a container (#676): Enso's stack, the recorder, Chromium and the agent
# runner in one image, so a run touches nothing of the host but its run directory, and its model
# credential is the one injected into the `enso-arena-credentials` volume — never the host's login.
#
#   bun run arena container build
#   bun run arena container credential --api-key-stdin < key.txt
#   bun run arena container start --agent anthropic/claude-sonnet-5-5 --scenario iterate
#
# The Playwright image carries the Chromium the arena's @playwright/test 1.63.0 drives, at
# /ms-playwright; it must move with that version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# bun as the repository pins it; git (the project is a repository, and the run's build record reads
# git); python3 (the scenarios' agents build Python CLIs as often as web pages).
COPY --from=oven/bun:1.4.2 /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update \
  && apt-get install --yes --no-install-recommends git python3 python-is-python3 \
  && rm -rf /var/lib/apt/lists/*

# The image's user, pwuser (uid 1000), owns the repository and its Enso home. The credentials
# directory is created here so a fresh named volume mounted over it is pwuser's too.
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
