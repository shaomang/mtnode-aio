# Bundled DSH plugins (optional)

Vendored from [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite).
These are **non-core**: mount / unmount them in Settings → DSH plugins.
The settings list shows each plugin's description (package.json / preset.yml)
and purpose (comment above the cordis.yml row) in the right-hand pane.
They are not required for the engine to boot.

| Path | Upstream | Version | Default |
|---|---|---|---|
| `dsh-super-injector/` | [dsh-super-injector](https://github.com/yjh051108/dsh-super-injector) v0.3.3 release tgz | 0.3.3 | mounted |
| `router-standard/` | [dsh-router-standard](https://github.com/yjh051108/dsh-router-standard) `preset/router-standard` | 0.2.0 | mounted (MTNode-safe: no throw, keep host persona) |
| `router-spec/` | same repo `preset/router-spec` | 0.2.0 | unmounted (conflicts with router-standard) |

Both routers skip the hard throw when `pwsh`/`bash` are missing, keep
`mtnode_*` tools on the first turn, keep `deployment:persona` (canvas
guidance), and do not blank `contexts`. Assemble failures are swallowed so
the JSON-RPC child cannot be killed by a routing hook.

The injector does not `inject` `webServer` (Cordis 4 still waits on that
key even with `required: false`). It uses `ctx.get('webServer')` so HTTP
`/super-injector/api` is skipped on MTNode's JSON-RPC runtime.
`cordis.yml` must name the **file** (`lib/index.js`), not the plugin
directory — Node ESM cannot import a folder.

