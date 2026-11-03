import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PlugIcon,
  RefreshCwIcon,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  api,
  cn,
  defineWebExtension,
  errorMessage,
  events,
  provide,
  useAction,
  useCopy,
  useEvent,
  useNow,
  useSystem,
} from '@/sdk'
import { ExtensionDetails } from '../onboarding/ui.tsx'
import {
  CancelSignInAction,
  PasteAction,
  ReconnectAction,
  SignInAction,
  SignOutAction,
  StatusAction,
} from './refs.ts'
import type { McpServerStatus } from './refs.ts'

/**
 * Every server's state, read again every few seconds while one is connecting, just after the next retry of a failed
 * one, when the server facet reinstalls (a saved `mcpServers`), and every minute otherwise.
 */
function useServers(enabled = true) {
  const status = useAction(StatusAction, null, { enabled, onError: () => {} })
  const loadedAt = useSystem()?.extensions.find((extension) => extension.name === 'mcp')?.server
    ?.loadedAt
  const seen = useRef(loadedAt)
  const settling =
    status.data?.some((server) => server.state === 'connecting' || server.oauth?.signingIn) ?? false
  const now = useNow(settling ? 2_000 : 60_000)
  const retry = Math.min(...(status.data ?? []).map((server) => server.retryAt ?? Infinity))
  const { refetch } = status
  // A saved secret reconnects the servers missing it on the server; the list shows them connecting.
  useEvent('secrets:changed', () => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (enabled) void setTimeout(() => void refetch(), 400)
  })
  useEffect(() => {
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (enabled) void refetch()
  }, [enabled, now, refetch])
  // Saving settings reinstalls the facet with the new list of servers.
  useEffect(() => {
    if (loadedAt === seen.current) return
    seen.current = loadedAt
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    if (enabled) void refetch()
  }, [enabled, loadedAt, refetch])
  useEffect(() => {
    if (!enabled || retry === Infinity) return undefined
    // oxlint-disable-next-line typescript/no-floating-promises -- useAction reports failures and resolves undefined rather than rejecting.
    const timer = setTimeout(() => void refetch(), Math.max(0, retry - Date.now()) + 500)
    return () => clearTimeout(timer)
  }, [enabled, retry, refetch])
  return status
}

const tone: Record<McpServerStatus['state'], string> = {
  connected: 'bg-success',
  connecting: 'bg-muted-foreground/50',
  failed: 'bg-error',
  signin: 'bg-warning',
}

const smallButton = 'h-6 gap-1.5 px-2 font-mono text-[11px]'

/**
 * A running sign-in: its authorization page to open, and a field for the URL the browser ends on, for a browser on
 * another machine that cannot reach this one's callback.
 */
function SigningIn({ name, url, onChanged }: { name: string; url: string; onChanged: () => void }) {
  const { copied, copy } = useCopy()
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const submit = () => {
    if (!value.trim() || sending) return
    setSending(true)
    setError(undefined)
    api.action(PasteAction, { name, url: value.trim() }).then(onChanged, (failure: unknown) => {
      setSending(false)
      setError(errorMessage(failure))
    })
  }
  return (
    <div className="mt-1.5 ml-3.5 flex flex-col gap-1.5" data-mcp-signin={name}>
      <div className="flex gap-1.5">
        <Button asChild className={smallButton} size="sm">
          <a href={url} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-3" />
            Open sign-in page
          </a>
        </Button>
        <Button className={smallButton} onClick={() => copy(url)} size="sm" variant="outline">
          {copied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
          {copied ? 'Copied' : 'Copy URL'}
        </Button>
        <Button
          className={cn(smallButton, 'ml-auto text-muted-foreground')}
          onClick={() =>
            void api
              .action(CancelSignInAction, { name })
              .catch(() => {
                // The sign-in may have just ended; the refreshed row shows what happened.
              })
              .then(onChanged)
          }
          size="sm"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <p className="font-sans text-[11px] leading-snug text-muted-foreground">
        Page didn't load after approving? Paste its address:
      </p>
      <div className="flex gap-1.5">
        <input
          autoComplete="off"
          className="h-6 min-w-0 flex-1 rounded-sm border border-input bg-transparent px-1.5 text-[11px] outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring"
          data-1p-ignore
          data-lpignore="true"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
            event.preventDefault()
            submit()
          }}
          placeholder="http://127.0.0.1:…/callback?code=…"
          spellCheck={false}
          value={value}
        />
        <Button
          className={smallButton}
          disabled={!value.trim() || sending}
          onClick={submit}
          size="sm"
        >
          {sending ? <LoaderCircleIcon className="size-3 animate-spin" /> : 'Continue'}
        </Button>
      </div>
      {error && <p className="text-[11px] text-error/85">{error}</p>}
    </div>
  )
}

function Row({ server, onChanged }: { server: McpServerStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const now = useNow(1_000, server.retryAt !== undefined)
  const run = async (action: typeof ReconnectAction) => {
    setBusy(true)
    setError(undefined)
    try {
      await api.action(action, { name: server.name })
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  const reconnect = () => run(ReconnectAction)
  const signingIn = server.oauth?.signingIn
  const retry = server.retryAt && Math.max(0, Math.ceil((server.retryAt - now) / 1000))
  return (
    <li className="px-2 py-1.5" data-mcp-server={server.name} data-state={server.state}>
      <div className="flex items-center gap-2 text-[12px]">
        <span className={cn('size-1.5 shrink-0 rounded-full', tone[server.state])} />
        <span className="min-w-0 truncate text-foreground/90">{server.name}</span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground/70">
          {server.transport}
          {server.source === 'project' && ' · project'}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {server.state === 'connected'
            ? `${server.tools} ${server.tools === 1 ? 'tool' : 'tools'}`
            : signingIn
              ? 'signing in'
              : server.state === 'signin'
                ? 'needs sign-in'
                : server.state}
        </span>
        {server.oauth?.signedIn && !signingIn && (
          <button
            aria-label={`Sign out of ${server.name}`}
            className="rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(SignOutAction)}
            title="Sign out"
            type="button"
          >
            <LogOutIcon className="size-3" />
          </button>
        )}
        <button
          aria-label={`Reconnect ${server.name}`}
          className="-mr-1 rounded-sm p-0.5 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          disabled={busy || server.state === 'connecting'}
          onClick={() => void reconnect()}
          title="Reconnect"
          type="button"
        >
          {busy || server.state === 'connecting' ? (
            <LoaderCircleIcon className="size-3 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
        </button>
      </div>
      {(server.error || error) && (
        <p className="mt-0.5 line-clamp-3 pl-3.5 text-[11px] leading-snug break-words text-error/85">
          {error ?? server.error}
          {retry !== undefined && !error && (
            <span className="text-muted-foreground/70"> · retry in {retry}s</span>
          )}
        </p>
      )}
      {server.oauth && !signingIn && server.state === 'signin' && (
        <button
          className="mt-1 ml-3.5 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-foreground/90 transition-colors hover:bg-accent disabled:opacity-50"
          disabled={busy}
          onClick={() => void run(SignInAction)}
          type="button"
        >
          {busy ? 'Starting…' : 'Sign in'}
        </button>
      )}
      {signingIn?.url && <SigningIn name={server.name} onChanged={onChanged} url={signingIn.url} />}
      {server.missing && (
        <button
          className="mt-1 ml-3.5 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-foreground/90 transition-colors hover:bg-accent"
          onClick={() => events.emit('secrets:open', { name: server.missing })}
          type="button"
        >
          Add {server.missing}
        </button>
      )}
    </li>
  )
}

function Servers({ servers, onChanged }: { servers: McpServerStatus[]; onChanged: () => void }) {
  return (
    <ul className="flex flex-col font-mono">
      {servers.map((server) => (
        <Row key={server.name} onChanged={onChanged} server={server} />
      ))}
    </ul>
  )
}

/**
 * "mcp 2/3" in the status line: connected out of configured servers, red while one failed. Hidden while none is
 * configured; the popover lists each server with its state, tool count and a reconnect button.
 */
function Chip() {
  const { data: servers, refetch } = useServers()
  if (!servers?.length) return null
  const connected = servers.filter((server) => server.state === 'connected').length
  const failed = servers.some((server) => server.state === 'failed')
  const signin = servers.some((server) => server.state === 'signin')
  const refresh = () => void refetch()
  return (
    <Popover onOpenChange={(open) => open && refresh()}>
      <PopoverTrigger asChild>
        <button
          aria-label="MCP servers"
          className={cn(
            '-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground',
            failed ? 'text-error' : signin && 'text-warning',
          )}
          data-mcp={
            failed
              ? 'failed'
              : signin
                ? 'signin'
                : connected === servers.length
                  ? 'connected'
                  : 'connecting'
          }
          type="button"
        >
          <PlugIcon className="size-3" />
          mcp {connected}/{servers.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-1rem)] p-1" side="top">
        <Servers onChanged={refresh} servers={servers} />
        <p className="border-t border-border/70 px-2 pt-1.5 pb-1 font-mono text-[11px] text-muted-foreground/70">
          mcpServers in ~/.ultimate/settings.json or the project's .ultimate/settings.json
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** The server list under the mcp row of the Extensions panel. */
function useDetails(name: string) {
  const { data: servers, refetch } = useServers(name === 'mcp')
  if (name !== 'mcp') return null
  if (!servers?.length)
    return <p className="text-muted-foreground/70">no servers: add mcpServers to settings.json</p>
  return <Servers onChanged={() => void refetch()} servers={servers} />
}

export default defineWebExtension({
  slots: { 'statusline.right': [{ component: Chip, order: -2 }] },
  provides: [provide(ExtensionDetails, useDetails)],
})
