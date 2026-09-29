# Sessions and projects

## What it shows

A project is a folder pi works in. The rail lists your projects, and each project's threads under it. A new thread asks how to start: which model, how much effort, which permission mode, and the first prompt. They are applied together when you start.

A thread you ran before is still there after a restart. Until you run it again it is *cold*: Enso reads it from pi's session file, and nothing is running.

## How to open it

- The folder you ran `bun run dev` in is always a project.
- **Add project** in the rail adds another folder. The folder must be inside a root your config declares, in `ENSO_HOME/config.json`:

  ```json
  { "projects": { "roots": ["~/code"] } }
  ```

  With no roots declared, the launch folder is the only project.
- **New Thread**, or the **+** beside a project, opens **Start a session**.
- Click a thread in the rail to open it. A cold thread opens from its file straight away.

## What it looks like

![The Start a session dialog](./images/sessions-start.png)

1. **Model**: the models your login gives you. **filter models…** narrows the list. (The screenshots use a scripted stand-in, listed as `demo`.)
2. **Effort**: the thinking levels this model offers.
3. **Mode**: what pi may do without asking. See [Permission modes](./permission-modes.md).
4. **Prompt**: the first message. Enter starts the session, Shift+Enter adds a line.

![A cold thread, opened from the rail](./images/sessions-cold-thread.png)

1. The project, with its threads under it.
2. A stored thread. Hover it to see when it last ran.
3. **Add project**.
4. The model the thread last ran on, marked `model (recorded):` because nothing is running yet.

## What to look for

Nothing in the dialog changes anything until you press **Start session**. Then the model, the effort and the mode are sent in one request, in that order. If one of them is refused, the dialog stays open and says which one, and the prompt is not sent. So you never get a session that runs your prompt on the wrong model.

The thread above was opened after a restart of the app, so it is cold. Its last run was on `claude-opus-4-1`, which the composer shows as `model (recorded):`. The thinking selector is hidden, because there is no live session to change. Sending a prompt starts the session again under the same id, and the chip becomes the live model.

If a thread's last run was cut off before pi answered, the thread shows a notice with a **Continue** button. Continue picks up from the stored state without a new message. See [Forks and lineage](./lineage.md), which also covers what a thread records about the conditions it ran under.

## What it doesn't do

- A project must be strictly inside a declared root. Hidden folders, and links that lead out of a root, are not offered.
- Removing a project only forgets the registration. Its threads stay on disk, and come back if you add the folder again.
- A thread is stored once pi has answered at least once. A thread closed before its first reply is not kept.

## Go deeper

- [Resume](../flows/resume.md): how a stored thread is opened again, and what a cold thread can and can't do.
- [Thread runtime seam](../seams/thread-runtime.md) and [Storage seam](../seams/storage.md).
- [Environment and configuration](../reference/env-and-config.md): `projects.roots` and the rest of `config.json`.
