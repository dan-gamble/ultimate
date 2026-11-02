import { CircleDotIcon } from 'lucide-react'
import { useDocOf, useUltimate } from '@/sdk'
import { MessagesDoc, emptyMessages, waitingOnUser } from '../messages/ui.tsx'
import { TodosDoc } from './refs.ts'

/** How many of the user's own to-dos are open: the sidebar's `Waiting` point adds them to questions. */
export function useOpenForUser() {
  return (useDocOf(1, TodosDoc)?.items ?? []).filter(
    (todo) => todo.owner === 'user' && todo.done === undefined,
  ).length
}

/**
 * "● N waiting on you" on the status line, on every surface, while a question or one of the user's to-dos is open;
 * nothing otherwise. A click opens the To-dos tab, which lists them.
 */
export function WaitingOnYou() {
  const count = waitingOnUser(useDocOf(1, MessagesDoc) ?? emptyMessages) + useOpenForUser()
  const { openPanel } = useUltimate()
  if (!count) return null
  return (
    <button
      className="-mx-1 flex cursor-pointer items-center gap-1.5 rounded-sm px-1 text-amber-700 transition-colors hover:bg-accent dark:text-amber-300"
      data-waiting-on-you={count}
      onClick={() => openPanel('todos')}
      title="Show what waits on you in To-dos"
      type="button"
    >
      <CircleDotIcon className="size-3" />
      {count}
      <span className="max-md:hidden">waiting on you</span>
    </button>
  )
}
