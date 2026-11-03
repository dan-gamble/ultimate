/**
 * OAuth sign-in for MCP servers over HTTP.
 *
 * Connections never open a browser on their own. They send the stored access token and refresh it when it is about to
 * expire or after a 401; when that is not possible they fail with `McpOAuthAuthorizationRequiredError`, and the user
 * signs in from the mcp popover: the authorization code flow (PKCE, the configured client or dynamic client
 * registration) against a loopback callback, or the redirect URL pasted back from a browser on another machine.
 *
 * Every Ultimate process of the user shares the credentials in `~/.ultimate/mcp-auth.json`, keyed by server name and
 * URL; a lock per server keeps two processes from refreshing at once, since many servers rotate refresh tokens.
 *
 * Pi upstream: @earendil-works/pi-coding-agent@1.5.0 src/extensions/mcp/oauth.ts — adapted, not exported: an async
 * file store and no Client ID Metadata Document (pi.dev's documents name the client pi). Drop when Pi exports
 * McpOAuthCredentialStore, createMcpAuthProvider and signInMcpServer.
 */
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { oauthErrorHtml, oauthSuccessHtml } from '@earendil-works/pi-ai/utils/oauth-page'
import type { AuthProvider, McpFetch } from '@earendil-works/pi-mcp'
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  OAuthCallbackServer,
  parseWwwAuthenticate,
  stepUpScope,
} from '@earendil-works/pi-mcp/oauth'
import type {
  McpOAuthState,
  McpOAuthStateStore,
  OAuthChallenge,
  OAuthClientInformationMixed,
} from '@earendil-works/pi-mcp/oauth'
import lockfile from 'proper-lockfile'
import { readJson, writeJson } from '../../lib/json-file.ts'

/** A server's `oauth` settings, its client secret already resolved. */
export type OAuthSettings = {
  clientId?: string
  clientSecret?: string
  callbackPort?: number
  /** A loopback redirect URI, sent exactly as written when it has a port. */
  callbackUrl?: string
  /** Scopes to request, separated by spaces. */
  scope?: string
}

const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/callback'
/** Redirect URI for refreshes when none is stored. Refreshing never redirects the user. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000
/** Bounds each request to the authorization server, so an unresponsive one cannot hold the refresh lock. */
const OAUTH_REQUEST_TIMEOUT_MS = 15_000
/** A lock its holder stopped renewing (the process was killed) is taken over after this. */
const LOCK_STALE_MS = 20_000
/** How long to wait for another process's lock: longer than a stale lock lives. */
const LOCK_WAIT_MS = 25_000
const LOCK_RETRY_MS = 100

export const authFile = (userHome: string) => join(userHome, '.ultimate/mcp-auth.json')

/** Runs `fn` while holding the lock on `path`, which other Ultimate processes take too. */
async function withLock<T>(path: string, fn: () => Promise<T>) {
  const release = await lockfile.lock(path, {
    realpath: false,
    stale: LOCK_STALE_MS,
    retries: {
      retries: LOCK_WAIT_MS / LOCK_RETRY_MS,
      factor: 1,
      minTimeout: LOCK_RETRY_MS,
      maxTimeout: LOCK_RETRY_MS,
    },
    // The default throws from a timer. A lost lock at worst lets two writes or refreshes overlap.
    onCompromised: () => {},
  })
  try {
    return await fn()
  } finally {
    // The lock is gone either way: released, or stale and taken over by another process.
    await release().catch(() => undefined)
  }
}

/** One server's OAuth state in the shared file, and the lock that serializes its refreshes across processes. */
export type ServerStore = McpOAuthStateStore & {
  load(): Promise<McpOAuthState | undefined>
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>
  /** Whether credentials were stored; removes them. */
  remove(): Promise<boolean>
}

export function serverStore(userHome: string, name: string, serverUrl: string): ServerStore {
  const path = authFile(userHome)
  const key = `${name}|${new URL(serverUrl).href}`
  const change = <T>(fn: (states: Record<string, McpOAuthState>) => T) =>
    withLock(path, async () => {
      await mkdir(join(userHome, '.ultimate'), { recursive: true, mode: 0o700 })
      const states = await readJson<Record<string, McpOAuthState>>(path, {})
      const result = fn(states)
      await writeJson(path, states, { mode: 0o600 })
      return result
    })
  return {
    load: async () => (await readJson<Record<string, McpOAuthState>>(path, {}))[key],
    save: (state) =>
      change((states) => {
        states[key] = state
      }),
    remove: () =>
      change((states) => {
        const stored = key in states
        delete states[key]
        return stored
      }),
    withRefreshLock: async (fn) => {
      await mkdir(join(userHome, '.ultimate'), { recursive: true, mode: 0o700 })
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 16)
      return withLock(join(userHome, `.ultimate/.mcp-auth-refresh-${hash}`), fn)
    },
  }
}

const LOOPBACK = ['localhost', '127.0.0.1', '::1']

function callbackSettings(settings: OAuthSettings) {
  const url = new URL(settings.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`)
  const address = url.hostname.replace(/^\[|\]$/g, '')
  // A redirect URI that is not on this machine (an app that only accepts https) is never called back: the user pastes
  // the URL the browser ends on. The callback server still listens, on any free loopback port.
  if (!LOOPBACK.includes(address))
    return {
      host: CALLBACK_HOST,
      redirectHost: CALLBACK_HOST,
      port: undefined,
      path: url.pathname,
      fixedRedirectUrl: url.href,
    }
  const port = url.port ? Number(url.port) : settings.callbackPort
  let fixedRedirectUrl: string | undefined
  // A configured URI with a port is sent exactly as written, since servers compare it as a string.
  if (url.port) fixedRedirectUrl = settings.callbackUrl
  else if (port !== undefined) {
    url.port = String(port)
    fixedRedirectUrl = url.href
  }
  return {
    // `localhost` is served on 127.0.0.1; browsers fall back to it when ::1 refuses.
    host: address === 'localhost' ? CALLBACK_HOST : address,
    redirectHost: address,
    port,
    path: url.pathname,
    fixedRedirectUrl,
  }
}

/** Scopes of both lists, each once. */
function mergeScopes(...scopes: (string | undefined)[]) {
  const merged = [...new Set(scopes.flatMap((scope) => scope?.split(/\s+/).filter(Boolean) ?? []))]
  return merged.length > 0 ? merged.join(' ') : undefined
}

/** `fetch` with `OAUTH_REQUEST_TIMEOUT_MS` per request, on top of the request's own signal. */
function timedFetch(fetch: McpFetch = globalThis.fetch): McpFetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS)
    return fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    })
  }
}

const registeredRedirectUrls = (client: OAuthClientInformationMixed | undefined) =>
  client && 'redirect_uris' in client ? client.redirect_uris : []

const provider = (
  serverUrl: string,
  store: McpOAuthStateStore,
  settings: OAuthSettings,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
) =>
  new McpOAuthProvider({
    serverUrl,
    redirectUrl,
    clientMetadata: { client_name: 'Ultimate' },
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    store,
    onRedirect,
  })

export type McpAuthProvider = AuthProvider & {
  /** Resolves when no refresh is running, so closing does not drop rotated tokens before they are saved. */
  settled(): Promise<void>
}

/**
 * Sends the stored access token and refreshes it when it is about to expire or after a 401. Throws
 * `McpOAuthAuthorizationRequiredError` when the user has to sign in, including when the server asks for more scope.
 * `onChallenge` receives the server's `WWW-Authenticate` challenge, for the sign-in. `settings` runs only when a
 * refresh needs it, so a missing client secret fails the refresh, not the connection.
 *
 * Requests in this process share one refresh, and other processes wait on the store's refresh lock, held from reading
 * the tokens to saving new ones. Tokens that changed meanwhile (another process refreshed them, or the user signed in)
 * are used without refreshing.
 */
export function authProvider(options: {
  serverUrl: string
  store: ServerStore
  settings: () => Promise<OAuthSettings>
  onChallenge: (challenge: OAuthChallenge) => void
}): McpAuthProvider {
  const { serverUrl, store } = options
  let refreshing: Promise<void> | undefined
  /** Replace `staleToken`, the access token that expired or was rejected. */
  const refresh = (
    staleToken: string | undefined,
    fetch: McpFetch = globalThis.fetch,
    challenge?: OAuthChallenge,
  ) => {
    refreshing ??= store
      .withRefreshLock(async () => {
        const state = await store.load()
        if (state?.tokens?.access_token !== staleToken) return
        if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError()
        const settings = await options.settings()
        const redirectUrl =
          callbackSettings(settings).fixedRedirectUrl ??
          registeredRedirectUrls(state.clientInformation)[0] ??
          FALLBACK_REDIRECT_URL
        // Not cancellable: a refresh the server answered may have rotated the refresh token, so its answer must be saved.
        const result = await authorizeMcp(
          provider(serverUrl, store, settings, redirectUrl, () => {}),
          {
            serverUrl,
            resourceMetadataUrl: challenge?.resourceMetadataUrl,
            scope: challenge?.scope,
            fetch: timedFetch(fetch),
          },
        )
        if (result === 'REDIRECT') throw new McpOAuthAuthorizationRequiredError()
      })
      .finally(() => {
        refreshing = undefined
      })
    return refreshing
  }
  return {
    token: async () => {
      // A failed refresh is the caller's to report; this request goes out with what is stored now.
      await refreshing?.catch(() => undefined)
      const state = await store.load()
      const token = state?.tokens?.access_token
      const expired =
        state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now()
      if (!expired || !state?.tokens?.refresh_token) return token
      // A failed refresh falls through: the request goes out with the old token and a 401 decides what happens.
      await refresh(token).catch(() => undefined)
      return (await store.load())?.tokens?.access_token
    },
    onUnauthorized: async (context) => {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'))
      options.onChallenge(challenge)
      // A refresh keeps the granted scope, so more scope needs a new sign-in.
      if (challenge.error === 'insufficient_scope') throw new McpOAuthAuthorizationRequiredError()
      await refresh(context.token, context.fetch, challenge)
    },
    settled: async () => {
      // Only waits; the refresh reported its own failure to the request that started it.
      await refreshing?.catch(() => undefined)
    },
  }
}

export class SignInCancelled extends Error {
  constructor() {
    super('Sign-in cancelled')
  }
}

/** The authorization response in a redirect URL pasted from the browser's address bar. */
function responseFromRedirectUrl(input: string, state: string, redirectUrl: URL) {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Expected the full redirect URL from the browser address bar')
  }
  // A server-specific redirect URI tells authorization servers apart, so it must match exactly.
  if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname)
    throw new Error("The redirect URL does not match this sign-in's redirect URI")
  const error = url.searchParams.get('error')
  if (error) throw new Error(url.searchParams.get('error_description') ?? error)
  if (url.searchParams.get('state') !== state)
    throw new Error('The redirect URL belongs to a different sign-in')
  const code = url.searchParams.get('code')
  if (!code) throw new Error('The redirect URL does not contain an authorization code')
  return { code, iss: url.searchParams.get('iss') ?? undefined }
}

/** Listen on `port`, or on a free port when it is taken and not `required`. */
async function listen(settings: ReturnType<typeof callbackSettings>, port: number | undefined) {
  const options = {
    host: settings.host,
    redirectHost: settings.redirectHost,
    path: settings.path,
    renderPage: (page: { ok: true } | { ok: false; message: string; details?: string }) =>
      page.ok
        ? oauthSuccessHtml('Signed in to the MCP server. You may now close this page.')
        : oauthErrorHtml(page.message, page.details),
  }
  try {
    return await OAuthCallbackServer.listen({ ...options, port: port ?? 0 })
  } catch (error) {
    if (settings.port !== undefined || port === undefined) throw error
    return OAuthCallbackServer.listen(options)
  }
}

/**
 * Sign in to an MCP server: with the stored refresh token when possible, otherwise through the browser. `show`
 * receives the authorization URL; `pasted` resolves with the redirect URL the user pasted, for a browser that cannot
 * reach the loopback callback, whichever arrives first. Aborting `signal` stops it with `SignInCancelled`.
 */
export async function signIn(options: {
  serverUrl: string
  store: ServerStore
  settings: OAuthSettings
  challenge?: OAuthChallenge
  show(url: URL): void
  pasted: Promise<string>
  signal: AbortSignal
}) {
  const { serverUrl, store, settings, signal } = options
  if (signal.aborted) throw new SignInCancelled()
  const stored = await store.load()
  const stepUp = options.challenge?.error === 'insufficient_scope'
  const callbackOptions = callbackSettings(settings)
  // Reuse the port of the registered redirect URI so the registered client stays valid.
  const registered = registeredRedirectUrls(stored?.clientInformation)[0]
  const callback = await listen(
    callbackOptions,
    callbackOptions.port ??
      (registered ? Number(new URL(registered).port) || undefined : undefined),
  )
  const redirectUrl = callbackOptions.fixedRedirectUrl ?? callback.redirectUrl
  try {
    if (stored) {
      const next = { ...stored }
      // Every sign-in gets a fresh `state` parameter.
      delete next.oauthState
      // A registered client cannot use another redirect URI, and its tokens belong to it.
      if (
        !settings.clientId &&
        !registeredRedirectUrls(stored.clientInformation).includes(redirectUrl)
      ) {
        delete next.clientInformation
        delete next.tokens
        delete next.tokensExpireAt
      }
      await store.save(next)
    }
    let authorizationUrl: URL | undefined
    const oauth = provider(serverUrl, store, settings, redirectUrl, (url) => {
      authorizationUrl = url
    })
    const flow = {
      serverUrl,
      fetch: timedFetch(),
      signal,
      resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
      // More scope comes on top of the configured scope and, since the challenge may list only the missing scopes,
      // on top of the scope granted so far.
      scope: mergeScopes(
        settings.scope,
        stepUp
          ? stepUpScope(stored?.tokens?.scope, options.challenge?.scope)
          : options.challenge?.scope,
      ),
    }
    // A refresh keeps the granted scope; a server asking for more needs the browser flow.
    if ((await authorizeMcp(oauth, { ...flow, skipRefresh: stepUp })) === 'AUTHORIZED') return
    if (!authorizationUrl) throw new Error('OAuth flow did not produce an authorization URL')
    const state = await oauth.state()
    // The flow picks the redirect URI, which may be specific to the MCP server.
    const expected = new URL(authorizationUrl.searchParams.get('redirect_uri') ?? redirectUrl)
    options.show(authorizationUrl)
    const cancelled = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(new SignInCancelled())
      signal.addEventListener('abort', () => reject(new SignInCancelled()), { once: true })
    })
    const fromBrowser = callback.waitForCallback(state, expected.pathname)
    const fromUser = options.pasted.then((input) => responseFromRedirectUrl(input, state, expected))
    for (const side of [fromBrowser, fromUser, cancelled])
      side.catch(() => {
        // The losing sides reject once the callback server closes or the sign-in ends; the race reports the winner.
      })
    const { code, iss } = await Promise.race([fromBrowser, fromUser, cancelled])
    await authorizeMcp(oauth, { ...flow, authorizationCode: code, iss })
  } catch (error) {
    // Aborted requests fail with the signal's reason; report them as the cancellation they are.
    if (signal.aborted) throw new SignInCancelled()
    throw error
  } finally {
    await callback.close()
  }
}
