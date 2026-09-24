// ============================================================================
// Session/introspection tools that report on the connector's own state rather
// than on PixInsight content: what installation the connector is pointed at.
// `workspace_info`, `set_workspace`, `resume_bridge` and `list_packs` are
// defined by src/server.mjs itself instead, since each needs closure access to
// server-owned state (the workspace and why it may be unusable; the lazy
// bridge instance; the packs loaded at startup) rather than the generic Pack
// API v1 `api` abstraction every other tool goes through unmodified.
//
// pixinsight_info deliberately reports platform-derived info only, never live
// process status (running/startedAt/memoryMB) — `api` (src/api.mjs's
// buildApi()) is the exact same object a pack tool receives, and a pack has
// no more access to live process status than this tool does; giving this one
// core tool a probe the Pack API v1 contract doesn't expose would be the
// "pack that works today becomes a core tool that silently doesn't tomorrow"
// divergence the architecture explicitly guards against. Live process status
// remains available via `doctor` (already fuller there: PID, uptime, memory
// warnings).
// ============================================================================

const pixinsightInfo = {
  name: 'pixinsight_info',
  description: 'Report the resolved PixInsight installation paths for this platform and the connector version. Read-only. For live process status, use the doctor command.',
  inputSchema: { type: 'object', properties: {} },
  async handler(api, _input) {
    // PixInsight was not found when the server started: say so, as an error, rather than report
    // a set of empty paths as if they were an install.
    if (api.platform.error) {
      return { isError: true, text: JSON.stringify({ error: api.platform.error, connectorVersion: api.connectorVersion }, null, 2) };
    }
    const { piBin, imageSolverPath, filterDbPath, whiteRefPath, settingsPath, verified } = api.platform;
    return {
      text: JSON.stringify(
        {
          piBin,
          imageSolverPath,
          filterDbPath,
          whiteRefPath,
          settingsPath,
          verified,
          connectorVersion: api.connectorVersion,
        },
        null,
        2
      ),
    };
  },
};

export const tools = [pixinsightInfo];
