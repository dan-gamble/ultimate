Connects the MCP servers in `mcpServers` and lets agents use their tools through one `mcp` tool; the status line shows how many are connected.

## Settings

`mcpServers` takes the same shape as Claude Desktop and Cursor, so a server's config pastes in. Put it in `~/.ultimate/settings.json`, or in a project's `.ultimate/settings.json`:

```json
{
  "mcpServers": {
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/folder"]
    },
    "my-server": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${MY_SERVER_TOKEN}" }
    }
  }
}
```

- **stdio:** `command`, optional `args`, `env` and `cwd` (default: the project root). The server inherits Ultimate's environment plus `env`.
- **Streamable HTTP:** `url` and optional `headers`. The legacy SSE transport is not supported.
- **Secrets:** `${NAME}` in `args`, `env`, `url` or `headers` is replaced by the secret `NAME` from the Secrets panel (⌘K → Secrets). Never write a token inline. Each such name is declared as a secret, so the Secrets panel lists it, set or missing, with the servers using it. A missing secret fails that server with its name and an Add button; saving it there connects the server again.
- **Precedence:** user and project servers merge by name; a project entry replaces a user entry of the same name. Project servers run commands, so they load only once the project's setup is trusted (`host.projectSettings()` is empty before).
- `"disabled": true` leaves a server out.

Saving either settings file reconnects every server.

## OAuth

An HTTP server without an `Authorization` header signs in with OAuth when it answers 401. It shows **needs sign-in** in the popover and never opens a browser by itself. **Sign in** starts the authorization code flow (PKCE, with dynamic client registration unless a client is configured) and shows the authorization page to open. The browser returns to a callback on `127.0.0.1`. If the browser is on another machine (over Tailscale, say), the page it ends on fails to load: paste its address into the field under the link. Sign out removes the stored credentials.

A server that needs a registered app takes `oauth`:

```json
{
  "mcpServers": {
    "my-server": {
      "url": "https://example.com/mcp",
      "oauth": {
        "clientId": "1234.5678",
        "clientSecret": "${MY_SERVER_CLIENT_SECRET}",
        "callbackPort": 3118,
        "scope": "read write"
      }
    }
  }
}
```

- `clientId`, and `clientSecret` for a confidential client (a `${NAME}` secret, read only when a sign-in or refresh needs it).
- `callbackPort` or `callbackUrl`: the redirect URI the app has registered. A loopback one (`http://127.0.0.1:3118/callback`) is sent exactly as written. An app that only accepts https URLs takes one that never loads; the user always pastes the address the browser ends on.
- `scope`: scopes to request, separated by spaces. A server asking for more scope (403 `insufficient_scope`) needs a new sign-in, which asks for both.

Credentials live in `~/.ultimate/mcp-auth.json` (0600), keyed by server name and URL, and every Ultimate process of the user shares them: user-level servers sign in once for all projects. A sign-in or sign-out in one process reconnects the server in the others. Access tokens are refreshed shortly before they expire and after a 401, under a lock per server so two processes never refresh the same rotating refresh token at once. A refresh that fails returns the server to needs sign-in.

## Tool

`mcp {server}` lists a server's tools with their input schemas; `mcp {server, tool, args}` calls one and returns its text and images. A result the server marks as an error comes back as a tool error. The tool's description names the configured servers, so the prompt changes only when the configuration does, however many tools they have. In codemode, `tools.mcp(...)` runs many calls and filters their results.

Every agent that inherits tools gets `mcp`, and @ultimate lists it in `agents/ultimate.md`. Agents with an explicit `tools` list add it there.

Calls are `replay: 'unsafe'`: a call interrupted by a restart is reported as interrupted, never sent again. A call times out after 10 minutes without progress from the server.

## Lifecycle

Servers connect when the server opens, each on its own: a failing one never blocks another or a turn. A failure or a dropped connection retries after 5 s, doubling up to 5 minutes. The servers close (stdio: the whole process group) when the extension reloads or Ultimate stops. A server's `tools/list_changed` notification refreshes its tool list.

## UI

The status line's `mcp 2/3` chip counts connected out of configured servers, turns red while one failed, and is hidden when none is configured. Its popover lists each server with its transport, source, state or tool count, the error and the next retry, and a reconnect button. The Extensions panel's `mcp` row lists the same servers when opened.

Actions: `status` → every server's state; `reconnect {name}` → connects one again and returns the states. User only: `signIn {name}` → starts a sign-in and returns the states once its authorization page is known; `paste {name, url}` → finishes it with the redirect URL; `cancelSignIn {name}`; `signOut {name}` → removes the credentials and returns the states.
