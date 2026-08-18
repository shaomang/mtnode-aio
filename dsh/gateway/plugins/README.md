# Bundled DSH plugins (optional)

Vendored `router-standard` from [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite).
It is **non-core**: mount / unmount it in Settings → DSH plugins.
The settings list shows each plugin's description (package.json / preset.yml)
and purpose (comment above the cordis.yml row) in the right-hand pane.
It is not required for the engine to boot.

| Path | Upstream | Version | Default |
|---|---|---|---|
| `router-standard/` | [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) `preset/router-standard` | 0.2.0 | mounted (MTNode-safe: no throw, keep host persona) |

The router skips the hard throw when `pwsh`/`bash` are missing, keeps
`mtnode_*` tools on the first turn, keeps `deployment:persona` (canvas
guidance), and does not blank `contexts`. Assemble failures are swallowed so
the JSON-RPC child cannot be killed by a routing hook.

The web-oriented injector and the mutex `router-spec` preset are **not**
shipped: MTNode runs stdio JSON-RPC (no `webServer` / `/super-injector/api`),
and spec-mode routing is unused.
