import { basename, dirname, relative, sep as pathSeparator } from 'node:path'
import type { LoadExtensionsResult } from '@earendil-works/pi-coding-agent'
import { ENSO_NOTICE_SOURCE } from '@enso/core'

/**
 * Who said a notice (#387 gap 2). pi hands every extension the same `ctx.ui` (`runner.js`
 * `createContext`: one context per emit, its `ui` the host's one UI), so a `ui.notify` reaches the
 * host with no trace of its caller. What pi DOES know is which extension registered each handler,
 * command, tool and shortcut: the loaded `Extension`'s `path`. So the host hands each extension's
 * registrations a context whose `ui.notify` also says who is speaking — the name read off that
 * path, the extension pi loaded — through the host's `notifyFrom` (`extension-ui-context.ts`).
 *
 * Nothing is inferred from what a notice SAYS, only from which extension's code holds the context
 * it was said on — and an extension that keeps its context (pi-multi-account does, for timers)
 * keeps the tagged one. A UI without `notifyFrom` (pi's own terminal) gets the plain `notify`.
 *
 * ⚠ What stays unlabelled: a handler an extension registers AFTER loading (pi reads
 * `extension.handlers` on every `on`, and a late one is added unwrapped), and a notify made
 * through a context the extension did not receive from one of its own registrations.
 */

/** The host's own lines — its login flows, its compaction (`@enso/core`'s one word for Enso). */
export const ENSO_SENDER = ENSO_NOTICE_SOURCE

type NotifyType = 'info' | 'warning' | 'error'

/** A UI that can be told who is speaking — the host's; pi's own UIs cannot. */
interface SenderAwareUi {
  notify(message: string, type?: NotifyType): void
  notifyFrom?(sender: string, message: string, type?: NotifyType): void
}

/**
 * The name a reader knows an extension by, from the path pi loaded it from: a package's own name
 * (unscoped) for one under `node_modules/`, `Enso <name>` for one of the harness's own
 * extensions, and nothing for an inline one — the host's own factories and test probes.
 */
export function extensionSender(extensionPath: string, harnessPackageDir: string): string | undefined {
  if (extensionPath.startsWith('<inline')) return undefined
  const modulesMarker = `${pathSeparator}node_modules${pathSeparator}`
  const modules = extensionPath.lastIndexOf(modulesMarker)
  if (modules !== -1) {
    const [scopeOrName, scopedName] = extensionPath.slice(modules + modulesMarker.length).split(pathSeparator)
    return scopeOrName?.startsWith('@') === true ? scopedName : scopeOrName
  }
  const [root, name] = relative(harnessPackageDir, extensionPath).split(pathSeparator)
  if (root === 'extensions' && name !== undefined) return `${ENSO_SENDER} ${name}`
  return basename(dirname(extensionPath))
}

/** The extension context pi passes a registration — told apart from its other arguments by shape. */
function isExtensionContext(value: unknown): value is { ui: unknown } {
  return typeof value === 'object' && value !== null && 'ui' in value && 'sessionManager' in value
}

const tagged = new WeakMap<object, Map<string, object>>()

/** `ui`, but its `notify` names `sender` — one per UI and sender, so identity holds across calls. */
function uiSpeakingAs(ui: SenderAwareUi, sender: string): SenderAwareUi {
  const bySender = tagged.get(ui) ?? new Map<string, object>()
  tagged.set(ui, bySender)
  const known = bySender.get(sender)
  if (known !== undefined) return known as SenderAwareUi
  const speaking = new Proxy(ui, {
    get(target, property) {
      if (property === 'notify') {
        return (message: string, type?: NotifyType): void =>
          target.notifyFrom === undefined ? target.notify(message, type) : target.notifyFrom(sender, message, type)
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  bySender.set(sender, speaking)
  return speaking
}

/** `context`, but its `ui` speaks as `sender`; every other member is the context's own. */
function contextSpeakingAs<Context extends { ui: unknown }>(context: Context, sender: string): Context {
  return new Proxy(context, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target)
      if (property !== 'ui' || typeof value !== 'object' || value === null) return value
      return uiSpeakingAs(value as SenderAwareUi, sender)
    },
  })
}

type Registered = (...args: never[]) => unknown

/** Each wrapper remembers what it wraps, so pi's unsubscribe still finds a handler by identity. */
const originalOf = new WeakMap<Registered, Registered>()

function speakingAs<Fn extends Registered>(fn: Fn, sender: string): Fn {
  const wrapped = ((...args: unknown[]) =>
    fn(
      ...(args.map((arg) => (isExtensionContext(arg) ? contextSpeakingAs(arg, sender) : arg)) as never[]),
    )) as unknown as Fn
  originalOf.set(wrapped, fn)
  return wrapped
}

/**
 * Wrap a handler list IN PLACE. pi's `on` reads `extension.handlers` afresh on every call, and the
 * unsubscribe it returns finds its handler with `list.indexOf(registeredHandler)`: replacing the
 * list would drop later registrations, and replacing an element would make that unsubscribe a
 * silent no-op. So the elements are wrapped where they sit, and this list's `indexOf` also finds a
 * wrapper by the handler it wraps.
 */
function wrapHandlerList(list: Registered[], sender: string): void {
  for (const [position, handler] of list.entries()) list[position] = speakingAs(handler, sender)
  Object.defineProperty(list, 'indexOf', {
    configurable: true,
    writable: true,
    value: (target: Registered): number =>
      list.findIndex((handler) => handler === target || originalOf.get(handler) === target),
  })
}

/**
 * The loaded extensions, each one's registrations speaking as that extension — pi's
 * `extensionsOverride` hook, run once after loading. Same objects, edited in place.
 */
export function attributeNotices(loaded: LoadExtensionsResult, harnessPackageDir: string): LoadExtensionsResult {
  for (const extension of loaded.extensions) {
    const sender = extensionSender(extension.path, harnessPackageDir)
    if (sender === undefined) continue
    for (const list of extension.handlers.values()) wrapHandlerList(list as Registered[], sender)
    for (const [commandName, command] of extension.commands) {
      extension.commands.set(commandName, { ...command, handler: speakingAs(command.handler, sender) })
    }
    for (const [toolName, tool] of extension.tools) {
      const execute = tool.definition.execute.bind(tool.definition)
      extension.tools.set(toolName, {
        ...tool,
        definition: { ...tool.definition, execute: speakingAs(execute, sender) },
      })
    }
    for (const [shortcutKey, shortcut] of extension.shortcuts) {
      extension.shortcuts.set(shortcutKey, { ...shortcut, handler: speakingAs(shortcut.handler, sender) })
    }
  }
  return loaded
}
