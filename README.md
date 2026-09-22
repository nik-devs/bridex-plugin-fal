# bridex-plugin-fal

Any [fal.ai](https://fal.ai) model for Bridex agents — video, image, audio,
music, whatever the catalog carries — straight through fal's queue API. No MCP
wrapper, no marketplace policy layer deciding which tools exist: an agent
searches the catalog, reads the endpoint's input schema (both free), uploads
sources to the fal CDN, runs, and gets the outputs saved into its task's
artifacts with provenance and a cost estimate.

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog, or the operator
MCP `plugin_admin install fal`), then set the key:

- **Settings → Integrations → fal.ai key** (`FAL_KEY`, format `key_id:key_secret`,
  create at fal.ai/dashboard/keys). Read per call — no restart needed.

Optional `bridex.yaml`:

```yaml
plugins:
  fal:
    config:
      api_key: ${FAL_KEY}      # default
      default_wait_s: 600      # how long fal_run waits before handing back a request_id
```

## Tools

| Tool | Cost | What |
|---|---|---|
| `fal_models` | free | search the catalog by text / category → endpoint ids |
| `fal_schema` | free | input + output schema of one endpoint (names, enums, defaults, required) |
| `fal_upload` | free | local file (artifacts/… or workspace path) → CDN URL for `image_url`/`video_url`/`audio_url` inputs (≤ 90 MB) |
| `fal_run` | **paid** | submit to the queue, wait (default 3 min), download outputs into `artifacts/<task>/`, record the spend. The request is tracked in the instance DB from the first second: if the run dies or the wait runs out, the plugin's watcher finishes it and **wakes the agent** in the session it came from — a server restart loses neither the request nor the money |
| `fal_result` | — | status / result of a request that outlived the wait; downloads outputs the same way |
| `fal_cancel` | — | cancel a queued request that has not started |

Outputs are named `<endpoint-slug>-<request8>.<ext>` inside the task's
artifact folder (or `artifacts/fal/` outside a task), carry a sidecar with the
endpoint, request id and note, and are mirrored to the instance's cloud bucket
when one is configured. Spend is estimated through fal's pricing API and lands
in the dashboard usage charts under kind `fal`.

## Why kind: integration

The plugin writes into workspace artifacts, stamps provenance and records
usage — in-process facilities. A catalog plugin of kind `tool` runs
out-of-process with flat schemas and no artifact access, so this one must
stay `integration`.
