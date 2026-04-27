---
name: devctl2-loopback
description: Configure, troubleshoot, and migrate devctl2 worktrees to use the loopback bind strategy (each worktree binds to a unique 127.x.x.x IP instead of cycling ports). Use when the user mentions devctl2 + loopback/IP/127.0.0.x, hits port-conflict warnings during `devctl2 setup`, asks to switch a project from port rotation to loopback addresses, or sees a "loopback alias not configured on lo0" warning on macOS.
---

# devctl2 loopback strategy

devctl2 supports two strategies for keeping multiple worktrees from clashing
when they all run the same dev servers:

| strategy   | what stays the same | what varies per worktree              |
|------------|---------------------|----------------------------------------|
| `port`     | host (`localhost`)  | the port for each app (hashed offset)  |
| `loopback` | the port            | the host (a unique `127.x.x.x` IP)     |

The loopback strategy is preferred when:
- Apps hard-code their port in URLs, OAuth callbacks, CSP, or seed data.
- Tooling (Vite HMR, Next.js, Rails) misbehaves when the port shifts.
- You want every worktree's URL to look the same to the app.

## Enabling loopback for a project

1. Edit `.devctl2rc.json` (or whichever config the project uses):

   ```json
   {
     "bindStrategy": "loopback",
     "loopback": {
       "base": "127.0.0.0",
       "prefixLength": 8,
       "exclude": ["127.0.0.1"]
     }
   }
   ```

   - `base` + `prefixLength` define the pool. Default is the full `127.0.0.0/8`.
   - `exclude` keeps `127.0.0.1` reserved for the main worktree.
   - All three loopback fields are optional; the defaults above are applied.

2. (Optional) For each app whose server needs to bind to the IP, add `hostVar`
   to its `apps.<name>` config. devctl2 will write the chosen address into
   that env var:

   ```json
   {
     "apps": {
       "api": { "envFile": "apps/api/.env", "portVar": "PORT", "hostVar": "HOST" },
       "web": { "envFile": "apps/web/.env", "portVar": "VITE_PORT", "hostVar": "HOST" }
     }
   }
   ```

   Then update each app's listener to read `HOST` (e.g. `app.listen(PORT, HOST)`,
   Vite's `server.host`). Without `hostVar` apps will keep binding to whatever
   default they used before — usually `0.0.0.0` or `localhost`, both of which
   accept connections on every 127.x.x.x address, so things still work.

3. Rerun `devctl2 setup` in each non-main worktree.

## Inspecting and fixing loopback aliases (macOS only)

`127.0.0.0/8` is fully routed on Linux, so any `127.x.x.x` works out of the box.
On macOS only `127.0.0.1` is wired up; other addresses must be aliased on `lo0`
with `sudo ifconfig lo0 alias 127.x.x.x up`.

devctl2 ships these helpers:

| command                          | what it does                                                                 |
|----------------------------------|------------------------------------------------------------------------------|
| `devctl2 loopback show`          | Print the address allocated for the current worktree and whether it is live  |
| `devctl2 loopback up [addr]`     | `sudo ifconfig lo0 alias <addr> up` (defaults to current worktree)           |
| `devctl2 loopback down [addr]`   | Remove the alias                                                             |
| `devctl2 loopback list`          | List every IPv4 address currently bound to lo0/lo                            |
| `devctl2 doctor`                 | Reports loopback availability when `bindStrategy: loopback` is set           |

Address allocation is **deterministic from the worktree path**, so the same
worktree always gets the same address. Workflow on macOS is:

```bash
devctl2 loopback up   # idempotent; re-run any time
devctl2 setup
```

If the user wants the alias to survive reboots, point them at a launchd
plist or `/etc/rc.local`-style script that runs `ifconfig lo0 alias` at boot.
Do not silently add such a file without asking.

## How it interacts with other devctl2 features

- **Caddy:** every Caddy upstream is now `<bindHost>:<port>` instead of
  `localhost:<port>`. The route also gets an `X-Bind-Host` response header.
- **`.env` files:** apps with a `hostVar` get the bind host written to that env
  var. Apps without `hostVar` are unchanged.
- **`.mcp.json`:** Spotlight MCP URL becomes `http://<bindHost>:<port>/mcp`.
- **Templates:** `{host}` is now an interpolated variable in `extraVars`,
  custom hostnames, etc. Combine with `{ports.api}` etc. as before.
- **Main branch:** always uses `localhost` regardless of strategy.

## Migrating an existing project from port to loopback

When the user asks to switch:

1. Confirm Caddy is running (`devctl2 doctor`).
2. Set `bindStrategy: "loopback"` (and any custom `loopback` settings) in the
   project's devctl2 config.
3. For each non-main worktree, run:
   ```bash
   devctl2 loopback up   # macOS only
   devctl2 setup
   ```
4. Restart the dev servers so they pick up the new `HOST` env var (only
   relevant if the app reads `HOST` and the user added `hostVar`).
5. Verify by checking `https://<branch>.<baseDomain>` and inspecting the
   `X-Bind-Host` response header.

To migrate **back** to port strategy: change `bindStrategy` to `"port"` (or
remove it; `"port"` is the default) and re-run `devctl2 setup`.

## Common pitfalls

- **macOS without alias:** `devctl2 setup` will warn but still write the
  routes — connections will fail until `devctl2 loopback up` runs.
- **App binding to `127.0.0.1` only:** Vite/Next dev servers default to
  `localhost`. Use `hostVar` to point them at the allocated IP, or change the
  server to bind `0.0.0.0`.
- **Choosing a tiny subnet:** if the user picks `127.0.0.0` with prefix
  `prefixLength: 30`, only ~2 worktrees can coexist before collisions become
  likely. Default `/8` is almost always the right answer.
- **Forgetting that `127.0.0.1` is excluded by default:** if the user wants
  the main branch to also use a synthetic alias, override `exclude: []` —
  but normally don't touch this.
