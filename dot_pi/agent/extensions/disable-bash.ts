import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

function disableBash(pi: ExtensionAPI, ctx?: ExtensionContext) {
  const active = pi.getActiveTools();
  if (!active.includes("bash")) return false;

  pi.setActiveTools(active.filter((name) => name !== "bash"));
  ctx?.ui.notify("Disabled built-in bash tool for this session", "info");
  return true;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    disableBash(pi, ctx.hasUI ? ctx : undefined);
  });

  pi.registerCommand("bash:disable", {
    description: "Disable the bash tool for the current session",
    handler: async (_args, ctx) => {
      if (!disableBash(pi, ctx)) {
        ctx.ui.notify("bash tool is already disabled", "info");
      }
    },
  });

  pi.registerCommand("bash:enable", {
    description: "Re-enable the bash tool for the current session",
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools();
      if (active.includes("bash")) {
        ctx.ui.notify("bash tool is already enabled", "info");
        return;
      }

      pi.setActiveTools([...active, "bash"]);
      ctx.ui.notify("Enabled bash tool for this session", "warning");
    },
  });
}
