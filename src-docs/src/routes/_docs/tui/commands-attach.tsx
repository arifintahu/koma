import { createFileRoute } from '@tanstack/react-router'
import { CommandPage } from '../../../components/CommandPage'

export const Route = createFileRoute('/_docs/tui/commands-attach')({
  component: () => (
    <CommandPage
      name="/attach"
      description="Attach a screenshot image to the next message."
      details={
        <p>Not a user command, and not listed in <code className="text-koma-fg">/help</code>. It only pulls a PNG the agent already saved under <code className="text-koma-fg">.screenshoot/</code>. Paste an image with Ctrl+V.</p>
      }
    />
  ),
})
