// The plugin HQ adds to each OpenCode agent (OpenCode 2.x, as Docker Sandboxes ships it).
// OpenCode has no shell hooks, so the plugin does what Claude Code's hooks do: it follows
// the session's events inside the sandbox and posts them to HQ's /hook endpoint with the
// same event names. OpenCode can't continue a finished run from a plugin the way a Stop hook
// does, so a finished run posts "Idle" and HQ types queued messages into the terminal.

export interface OpencodePluginOptions {
  hqUrl: string; // http://host.docker.internal:<port>
  token: string;
  agentId: string;
}

export function opencodePluginSource({ hqUrl, token, agentId }: OpencodePluginOptions): string {
  const j = JSON.stringify;
  return `// Written by kh-team HQ for ${agentId} (git-excluded). Reports this agent's state to HQ.
import { Plugin } from "@opencode/plugin"

const HQ = ${j(hqUrl)}
const TOKEN = ${j(token)}
const AGENT = ${j(agentId)}

async function post(event, body = {}) {
  try {
    await fetch(\`\${HQ}/hook/\${encodeURIComponent(AGENT)}/\${event}\`, {
      method: "POST",
      headers: { Authorization: \`Bearer \${TOKEN}\`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    })
  } catch {}
}

/** The provider error that ended a run, as plain text. */
function errorText(data) {
  const e = data?.error ?? data
  return String(e?.message ?? e?.data?.message ?? JSON.stringify(e ?? "provider error")).slice(0, 300)
}

export default Plugin.define({
  id: "kh-team.hq",
  async setup(ctx) {
    const controller = new AbortController()
    void post("SessionStart")
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const data = event.data ?? {}
        switch (event.type) {
          case "session.execution.started":
            void post("UserPromptSubmit")
            break
          case "session.tool.input.started":
            void post("PreToolUse", { tool_name: data.name ?? "" })
            break
          case "session.tool.success":
          case "session.tool.failed":
            void post("PostToolUse")
            break
          case "session.step.ended":
            // What this model call cost, in USD (0 for a local model).
            if (Number(data.cost) > 0) void post("Cost", { cost: Number(data.cost) })
            break
          case "session.execution.succeeded":
            void post("Idle")
            break
          case "session.execution.failed":
            void post("StopFailure", { error: errorText(data) })
            break
          case "permission.asked":
          case "permission.v2.asked":
          case "question.asked":
          case "question.v2.asked":
            void post("Notification", { message: "OpenCode is asking you something in the terminal" })
            break
        }
      }
    })()
    return async () => {
      controller.abort()
      await post("SessionEnd")
    }
  },
})
`;
}
