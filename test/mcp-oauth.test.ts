import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import mcp, { actions } from '../extensions/mcp/server.ts'
import type { McpServerStatus } from '../extensions/mcp/refs.ts'
import type { ExtensionHost } from '../server/extensions.ts'
import { removeTemp, temp, until } from './helpers.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close()
})

const body = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = ''
    request.on('data', (chunk) => (text += chunk))
    request.on('end', () => resolve(text))
  })
const json = (response: ServerResponse, value: unknown, status = 200) =>
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))

/**
 * An MCP server with one `echo` tool that is its own OAuth authorization server: dynamic client registration, PKCE
 * codes that the authorize endpoint hands out at once, and tokens that `expire()` invalidates for the next request.
 */
async function serve() {
  let issued = 0
  const valid = new Set<string>()
  /** Scope a `tools/call` needs; the token's granted scope by access token. */
  let needed: string | undefined
  const granted = new Map<string, string>()
  const scopes: (string | null)[] = []
  const refreshes = new Map<string, string>()
  const codes = new Set<string>()
  let origin = ''
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, origin)
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp')
      return json(response, { resource: `${origin}/mcp`, authorization_servers: [origin] })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    if (url.pathname === '/register')
      return json(response, { ...JSON.parse(await body(request)), client_id: 'client-1' }, 201)
    if (url.pathname === '/authorize') {
      scopes.push(url.searchParams.get('scope'))
      const code = `code-${codes.size}:${url.searchParams.get('scope') ?? ''}`
      codes.add(code)
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', url.searchParams.get('state')!)
      return response.writeHead(302, { location: back.href }).end()
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(await body(request))
      const grant = form.get('grant_type')
      const ok =
        grant === 'authorization_code'
          ? codes.delete(form.get('code')!)
          : refreshes.has(form.get('refresh_token')!)
      if (!ok) return json(response, { error: 'invalid_grant' }, 400)
      if (grant === 'refresh_token') refreshes.delete(form.get('refresh_token')!)
      const access = `access-${++issued}`
      const refresh = `refresh-${issued}`
      valid.add(access)
      granted.set(access, form.get('code')?.split(':')[1] ?? '')
      refreshes.set(refresh, access)
      return json(response, {
        access_token: access,
        token_type: 'Bearer',
        refresh_token: refresh,
        expires_in: 3600,
      })
    }
    if (url.pathname !== '/mcp' || request.method !== 'POST') return response.writeHead(405).end()
    const token = request.headers.authorization?.replace(/^Bearer /, '')
    if (!token || !valid.has(token))
      return response
        .writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
        })
        .end()
    const message = JSON.parse(await body(request))
    if (message.method === 'tools/call' && needed && !granted.get(token)?.includes(needed))
      return response
        .writeHead(403, {
          'www-authenticate': `Bearer error="insufficient_scope", scope="${needed}"`,
        })
        .end()
    if (message.id === undefined) return response.writeHead(202).end()
    const results: Record<string, unknown> = {
      initialize: {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' },
      },
      'tools/list': { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] },
      'tools/call': {
        content: [{ type: 'text', text: `echo: ${message.params?.arguments?.text}` }],
      },
    }
    return json(response, { jsonrpc: '2.0', id: message.id, result: results[message.method] })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return {
    url: `${origin}/mcp`,
    /** Every access token issued so far stops working. */
    expire: () => valid.clear(),
    issued: () => issued,
    /** From now on, calling a tool needs `scope`. */
    require: (scope: string) => (needed = scope),
    scopes,
  }
}

it('signs in with a pasted redirect URL, refreshes a rejected token, and signs out', async () => {
  const root = await temp()
  cleanup.push(() => removeTemp(root))
  const remote = await serve()
  await mkdir(join(root, '.ultimate'), { recursive: true })
  await writeFile(
    join(root, '.ultimate/settings.json'),
    JSON.stringify({ mcpServers: { echo: { url: remote.url } } }),
  )
  const closers: (() => Promise<void>)[] = []
  const host = {
    userHome: root,
    projectRoot: root,
    projectSettings: async () => ({}),
    onOpen: (callback: () => Promise<void>) => void callback(),
    onClose: (callback: () => Promise<void>) => closers.push(callback),
  } as unknown as ExtensionHost
  const [tool] = (await mcp(host)).tools!
  cleanup.push(async () => {
    for (const close of closers) await close()
  })
  const call = (action: string, args: unknown = { name: 'echo' }) =>
    actions[action](args as never, { host } as never) as unknown as Promise<McpServerStatus[]>
  const status = () => actions.status(null, { host } as never) as unknown as McpServerStatus[]
  const echo = () =>
    tool.execute(
      { server: 'echo', tool: 'echo', args: { text: 'hi' } },
      {} as never,
      { abortSignal: new AbortController().signal } as never,
    )

  await until(() => status()[0].state !== 'connecting')
  expect(status()[0]).toMatchObject({ state: 'signin', oauth: { signedIn: false } })

  const [started] = await call('signIn')
  const page = started.oauth?.signingIn?.url
  expect(page).toContain('/authorize')
  // The browser approves on another machine; the user pastes the address it ended on.
  const redirect = await fetch(page!, { redirect: 'manual' })
  await call('paste', { name: 'echo', url: redirect.headers.get('location') })
  await until(() => status()[0].state === 'connected')
  expect(status()[0]).toMatchObject({ tools: 1, oauth: { signedIn: true } })
  expect(await echo()).toMatchObject({ output: [{ text: 'echo: hi' }], isError: false })

  remote.expire()
  expect(await echo()).toMatchObject({ output: [{ text: 'echo: hi' }], isError: false })
  expect(remote.issued()).toBe(2)

  // A tool asking for more scope waits for a sign-in, which asks for that scope.
  remote.require('write')
  expect(await echo()).toMatchObject({ isError: true })
  expect(status()[0].state).toBe('signin')
  const [again] = await call('signIn')
  const approved = await fetch(again.oauth!.signingIn!.url!, { redirect: 'manual' })
  await call('paste', { name: 'echo', url: approved.headers.get('location') })
  await until(() => status()[0].state === 'connected')
  expect(remote.scopes.at(-1)).toBe('write')
  expect(await echo()).toMatchObject({ output: [{ text: 'echo: hi' }], isError: false })

  await call('signOut')
  expect(status()[0]).toMatchObject({ state: 'signin', oauth: { signedIn: false } })
})
