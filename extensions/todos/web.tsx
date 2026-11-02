import { ListTodoIcon } from 'lucide-react'
import { defineWebExtension, provide } from '@/sdk'
import { Waiting } from '../sidebar/ui.tsx'
import { TodoCall } from './call.tsx'
import { Todos } from './panel.tsx'
import { useOpenForUser, WaitingOnYou } from './waiting.tsx'

export default defineWebExtension({
  tools: { todo: TodoCall },
  // @ultimate's changed-list reminder is model context, not something to read in the transcript.
  entries: { 'todos.note': () => null },
  panels: [{ id: 'todos', title: 'To-dos', icon: ListTodoIcon, component: Todos, order: 0 }],
  // Shown only while something waits on the user, so it stays on a phone's line too.
  slots: { 'statusline.right': [{ component: WaitingOnYou, phone: true, order: -3 }] },
  provides: [provide(Waiting, useOpenForUser)],
  commands: [
    {
      id: 'todos.open',
      title: 'Show to-dos',
      run: (context) => context.openPanel('todos'),
    },
  ],
})
