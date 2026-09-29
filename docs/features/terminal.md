# Terminal

## What it shows

`bun run enso` starts pi in your terminal with Enso loaded: the same guards, `web_fetch`, `web_search`, permission modes and logging as the web app. It is plain pi otherwise. You use pi's own interface, keys and commands.

The run is isolated from any other pi you have installed, and your secrets stay out of it.

## How to open it

```bash
bun run enso                 # interactive
bun run enso -p "hello"      # print mode: one prompt, the answer, then exit
```

Log in once, with `/login` in pi. The login is stored in `ENSO_HOME/pi-agent`, which the web app uses too, so one login serves both.

## What it looks like

The launch prints what it removed and what it started, before pi's own screen. For example:

```text
enso: secrets kept out of pi's environment (#89): ANTHROPIC_API_KEY, GITHUB_TOKEN
enso: vanilla pi 0.87.1 | agent-dir=/home/you/.enso/pi-agent | package=…/packages/harness | 12 declared resource path(s)
```

- The first line names every variable removed from pi's environment. It is printed only when there was something to remove.
- The second line names the pi version, the agent directory, the Enso package loaded, and how many resource paths that package declares. A print run adds `(print variant, no permission modes — #20)` after the package.

This page shows the launch output instead of a screenshot: after these two lines, the terminal is pi's own interface, which pi's documentation covers.

## What to look for

Isolation is three separate settings, each closing a different gap:

| Setting | What it stops |
|---|---|
| `PI_CODING_AGENT_DIR=~/.enso/pi-agent` | Your global pi packages, settings and login. This run cannot see them. |
| `--no-extensions` | pi's own discovery, which would load Enso's package a second time. |
| `--no-skills` | Skills in `~/.agents/skills/`, which the agent directory does not cover. |

Check the first line when a provider says you are not logged in. An exported `ANTHROPIC_API_KEY` does not reach pi: every variable whose name looks like a secret (`…_API_KEY`, `…_TOKEN`, `…_SECRET`, `…_PASSWORD`), and every name in `ENSO_HOME/secrets.env`, is removed. Provider logins belong in pi's own store, through `/login`.

## What it doesn't do

- Print mode has no permission modes, because there is nobody to ask. Only Enso's guards apply, and `bash` is not confined.
- It does not install pi. `pi` must be on your `PATH`, at a version Enso supports, or the launch stops and says why.
- The login here is separate from your global pi login, and expires on its own schedule.

## Go deeper

- [Boot and launchers](../flows/boot-and-launchers.md): what each launcher does, in order.
- [Provider auth and client identity](../concepts/provider-auth-and-client-identity.md): where logins live.
- [Environment and configuration](../reference/env-and-config.md): `ENSO_HOME`, `secrets.env` and the agent directory.
- [Permission modes](./permission-modes.md): why print mode leaves them out.
