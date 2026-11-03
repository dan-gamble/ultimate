/** MCP in the browser: each configured server's connection state, and the action that connects one again. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** One server from `mcpServers` in user or project settings, as the `mcp` tool sees it now. */
export type McpServerStatus = {
  name: string
  /** Which settings file it comes from; a project entry replaces a user one of the same name. */
  source: 'user' | 'project'
  transport: 'stdio' | 'http'
  /** `signin`: an OAuth server that waits for the user to sign in; it never opens a browser by itself. */
  state: 'connecting' | 'connected' | 'failed' | 'signin'
  /** How many tools it offers, once connected. */
  tools?: number
  error?: string
  /** The `${NAME}` secret its last connect could not find, until it connects again. */
  missing?: string
  /** When the next attempt runs (ms), while it is failed. */
  retryAt?: number
  /** Set when it signs in with OAuth (an HTTP server without an `Authorization` header). */
  oauth?: {
    /** Credentials are stored for it. */
    signedIn: boolean
    /** While a sign-in runs: its authorization page, once known. */
    signingIn?: { url?: string }
  }
}

/** No arguments → every configured server's state, in settings order. */
export const StatusAction = actionRef<null, McpServerStatus[]>('mcp', 'status')
/** `{ name }` → connects that server again now, and returns every server's state once it is connected or failed. */
export const ReconnectAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'reconnect')
/**
 * `{ name }` → starts signing in to an OAuth server and returns every server's state once its authorization page is
 * known (or the sign-in ended without one). User only.
 */
export const SignInAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'signIn')
/** `{ name, url }` → finishes the running sign-in with the redirect URL pasted from the browser. User only. */
export const PasteAction = actionRef<{ name: string; url: string }, null>('mcp', 'paste')
/** `{ name }` → stops the running sign-in. User only. */
export const CancelSignInAction = actionRef<{ name: string }, null>('mcp', 'cancelSignIn')
/** `{ name }` → removes its stored credentials in every Ultimate process and returns every server's state. User only. */
export const SignOutAction = actionRef<{ name: string }, McpServerStatus[]>('mcp', 'signOut')
