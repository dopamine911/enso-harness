import { type Static, Type } from 'typebox'
import { closedObject, NonEmptyString } from './closed-schema.ts'

/**
 * Providers in Settings (#904): which providers pi knows that you can use or have set up, logging
 * in and out of them from the page, and hiding one from the model picker.
 *
 * ⚠ NO CREDENTIAL CROSSES THIS WIRE. A provider says HOW it is authenticated (`via`), never with
 * what: an API key typed into the page goes once, in the login request's body, straight to pi's
 * credential store (`AuthStorage`, pi's own `auth.json`), and nothing here — no listing, no login
 * state, no refusal — repeats it. The page only ever says "a key is set".
 */

/**
 * How a provider is authenticated now: a stored API key, a stored subscription login (OAuth), or
 * something pi reads from the environment (a variable, a cloud profile). Never the value.
 *
 * @group Providers
 */
export const EnsoProviderAuth = Type.Union([
  Type.Literal('api-key'),
  Type.Literal('subscription'),
  Type.Literal('environment'),
])
/** @group Providers */
export type EnsoProviderAuth = Static<typeof EnsoProviderAuth>

/** A provider's id, pi's readable name (`Provider.name`), and its ways in. */
const providerWays = {
  id: NonEmptyString,
  name: Type.String(),
  offersOAuth: Type.Boolean(),
  offersApiKey: Type.Boolean(),
}

/**
 * One provider as Settings lists it.
 *
 * @group Providers
 */
export const EnsoProvider = closedObject({
  ...providerWays,
  loggedIn: Type.Boolean(),
  /** How it is logged in; absent when it is not. */
  via: Type.Optional(EnsoProviderAuth),
  /** A credential pi stored, which Log out removes — what is in the environment is not pi's to remove. */
  stored: Type.Boolean(),
  /** An account slot an extension registered (pi-multi-account's `*-account-2`, …). */
  accountSlot: Type.Boolean(),
  /** Kept out of the model picker (`models.hiddenProviders`), still logged in. */
  hidden: Type.Boolean(),
  /** Its models: the option id (`provider/id`) and the name. */
  models: Type.Array(closedObject({ id: NonEmptyString, name: Type.String() })),
})
/** @group Providers */
export type EnsoProvider = Static<typeof EnsoProvider>

/**
 * A provider nobody has set up, reachable through "Add a provider": one of pi's built-ins with no
 * credential (#904), not listed until added.
 *
 * @group Providers
 */
export const EnsoAddableProvider = closedObject(providerWays)
/** @group Providers */
export type EnsoAddableProvider = Static<typeof EnsoAddableProvider>

/**
 * A way into a provider: an API key, or a subscription (pi's OAuth login).
 *
 * @group Providers
 */
export const EnsoProviderAuthType = Type.Union([Type.Literal('api_key'), Type.Literal('oauth')])

/**
 * A question a login asks the person (pi's `AuthPrompt`, in our words): plain text, a secret (a
 * password field), one of `options`, or the code a browser login shows — with the login page as
 * `link`. The answer goes back once to `POST /api/providers/login/answer`.
 *
 * @group Providers
 */
export const EnsoProviderLoginQuestion = closedObject({
  id: NonEmptyString,
  kind: Type.Union([Type.Literal('text'), Type.Literal('secret'), Type.Literal('select'), Type.Literal('code')]),
  message: Type.String(),
  placeholder: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(closedObject({ id: NonEmptyString, label: Type.String() }))),
  link: Type.Optional(closedObject({ url: Type.String(), label: Type.String() })),
})
/** @group Providers */
export type EnsoProviderLoginQuestion = Static<typeof EnsoProviderLoginQuestion>

/**
 * A login started from Settings, as it goes: what it has said (a login page to open, a device code,
 * progress), the question it waits on, and how it ended — `failed` with pi's reason, any secret it
 * was given removed from it.
 *
 * @group Providers
 */
export const EnsoProviderLogin = closedObject({
  id: NonEmptyString,
  provider: NonEmptyString,
  providerName: Type.String(),
  authType: EnsoProviderAuthType,
  status: Type.Union([
    Type.Literal('running'),
    Type.Literal('done'),
    Type.Literal('failed'),
    Type.Literal('cancelled'),
  ]),
  notices: Type.Array(Type.String()),
  question: Type.Optional(EnsoProviderLoginQuestion),
  reason: Type.Optional(Type.String()),
})
/** @group Providers */
export type EnsoProviderLogin = Static<typeof EnsoProviderLogin>

/**
 * `GET /api/providers` (#904): the providers set up or registered, the ones that can be added, and
 * the login running from Settings, if one is.
 *
 * @group Providers
 */
export const EnsoProvidersListing = closedObject({
  providers: Type.Array(EnsoProvider),
  addable: Type.Array(EnsoAddableProvider),
  login: Type.Optional(EnsoProviderLogin),
})
/** @group Providers */
export type EnsoProvidersListing = Static<typeof EnsoProvidersListing>

/**
 * `POST /api/providers/login` (#904): start a login. `apiKey`, for an API-key login only, answers
 * the key prompt pi asks — sent once, in this body, and never repeated by any answer.
 *
 * @group Providers
 */
export const EnsoProviderLoginRequest = closedObject({
  provider: NonEmptyString,
  authType: EnsoProviderAuthType,
  apiKey: Type.Optional(NonEmptyString),
})
/** @group Providers */
export type EnsoProviderLoginRequest = Static<typeof EnsoProviderLoginRequest>

/**
 * `POST /api/providers/login/answer` (#904): the answer to the login's open question.
 *
 * @group Providers
 */
export const EnsoProviderLoginAnswer = closedObject({ questionId: NonEmptyString, value: NonEmptyString })
/** @group Providers */
export type EnsoProviderLoginAnswer = Static<typeof EnsoProviderLoginAnswer>

/**
 * `POST /api/providers/logout` (#904): remove the provider's stored credential.
 *
 * @group Providers
 */
export const EnsoProviderLogoutRequest = closedObject({ provider: NonEmptyString })
