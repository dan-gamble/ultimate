/** Instances in the browser: the preview servers started from this host, for the title bar and preview links. Browser-safe. */
import { actionRef } from '../../shared/extension-api.ts'

/** A preview server that served its UI. */
export type Preview = {
  id: string
  url: string
  /** The conversation that started it. */
  conversationId: number
  /** False once it exited or was stopped. */
  running: boolean
  /** Where the tailnet reaches it while it runs, when it publishes itself there. */
  tailnet?: string
}

/** No arguments → the previews that served their UI, running or stopped since; a failed start is not among them. */
export const ListAction = actionRef<null, Preview[]>('instance', 'list')

/** Another Ultimate project running on this machine. */
export type Project = {
  /** Its home, unique per project. */
  id: string
  name: string
  url: string
}

/** No arguments → the other projects on this machine whose server runs now. */
export const ProjectsAction = actionRef<null, Project[]>('instance', 'projects')
