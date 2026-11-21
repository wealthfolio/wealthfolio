# Request timeouts

The checked-in [timeout policy](../../config/timeouts.json) is the source for
the web server, the web client, and Tauri on macOS, Windows, Linux, iOS, and
Android. Changes require rebuilding the application; this file is not read from
the installation's data directory.

| Operation                                                   | Web server   | Client, all platforms | Proxy allowance |
| ----------------------------------------------------------- | ------------ | --------------------- | --------------- |
| Routine API calls                                           | 45 sec       | 60 sec                | 75 sec          |
| Heavy financial operations / backup management              | 4 min 30 sec | 5 min                 | 5 min 30 sec    |
| CSV parsing                                                 | 4 min 30 sec | 5 min                 | 5 min 30 sec    |
| Asset preview, per batch                                    | 9 min        | 10 min                | 11 min          |
| Activity/transaction validation                             | 9 min        | 10 min                | 11 min          |
| Holdings validation                                         | 9 min        | 10 min                | 11 min          |
| Final activity/holdings import                              | 4 min 30 sec | 5 min                 | 5 min 30 sec    |
| Backup capture, snapshot generation, pairing, backup export | 31 min       | 32 min                | 33 min          |

The policy lists command names and route families explicitly. Heavy families
conservatively retain the previous five-minute client budget, including
holdings, valuations, performance, goals, asset/activity operations, market
data, and allocation calculations. Routine calls such as accounts and settings
use one minute. Import validation and transfer rules take precedence over heavy
families. The API's alternate account/scoped query URLs use the same family
budget.

Manually triggered device-sync cycles, team-sync resets, and legacy
classification migration retain five-minute client budgets. These requests
perform work inline (a sync cycle can also wait for an active background cycle),
so their server and proxy allowances use the heavy profile.

Budgets apply to each request, not to the entire import or a background job.
Native Tauri calls bypass the HTTP server and proxy. The native client timer
does not cancel a Rust command. Aborting a web request does not prove server
work was cancelled or a transaction rolled back. Check the outcome of a final
import before retrying it; previews are read-only and support manual retry.

Built-in market-data providers use a five-second connection limit and a
thirty-second total HTTP limit. Custom-provider settings remain independent.
Supplementary exchange searches retain their two-second budget, including
rate-limit waiting. Provider selection and rate limits are unchanged. Underlying
snapshot/backup transfers retain their fifteen-minute limits.

## Native operations

Native app installation uses the 32-minute transfer budget. Desktop text/binary
save commands and desktop data export include a native dialog in the Rust call;
they use admitted IPC without a frontend deadline so user interaction can
finish. Mobile data-export preparation and pending text/binary export writes
retain a five-minute deadline. The subsequent iOS/Android picker has no command
timer. Cloud-backup management uses five minutes on both clients, with the heavy
server deadline, because setup/recovery can involve multiple cloud requests.

The remaining native-only routine calls intentionally use one minute: local MCP
settings, tokens, audit operations and listener start/stop; local sync crypto
primitives; platform/startup metadata, discarding staged restore entries, and
opening the backup folder. `profile_transfer_file` applies its one-minute budget
to each bounded 1 MiB read/write or path/cleanup call, not the whole file copy.
Profile admission and error sanitization still apply to untimed dialog commands.

## Server overrides

Leave `WF_REQUEST_TIMEOUT_MS` empty or unset to use the matrix. Docker Compose
and the standalone server use the same defaults. The legacy variable overrides
only routine requests; heavy, import, and transfer routes use their own budgets.
Invalid, empty, and zero values fall back to the shared default.

Existing explicit overrides are retained. An override of 60000 ms or more can
outlast the routine client timer and lose the server-error margin. Remove the
override to adopt the production matrix.

Profile startup/lock requests retain their existing dedicated client handling.
Streaming responses and native file-picker interaction are outside the ordinary
command deadline. The server middleware bounds response preparation, not the
lifetime of an SSE connection or a response body already being streamed.

## Reverse proxy

The app cannot configure an external proxy. Apply the allowance for each route
to every proxy/load balancer between the browser and the server. A hosted proxy
with a shorter maximum deadline can still interrupt a synchronous import.

For NGINX, generate API location blocks directly from the shared policy:

```sh
node scripts/print-timeout-proxy.mjs > wealthfolio-api-timeouts.conf
```

Include that file in your existing `server` block. Define the upstream in the
`http` context using the address reachable from your proxy, for example:

```nginx
upstream wealthfolio_backend {
    server wealthfolio:8088;
}
```

Replace overlapping API location blocks when adopting the generated ones;
earlier regex locations or a `^~ /api/` block can take precedence. Keep your
existing TLS, frontend/static-file, authentication, streaming, and request-size
configuration. Preserve `client_max_body_size` from old locations by moving it
to the `server` context or carrying it into the new locations. NGINX's default
is 1 MiB, while the server accepts activity-import bodies up to 64 MiB;
`client_max_body_size 64m;` allows that activity-import limit. Retain any larger
limits needed for backup uploads and any stricter endpoint-specific limits. See
the
[NGINX body-size documentation](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).
For SSE/AI routes, retain response buffering disabled in the applicable server
or location configuration.

NGINX's `proxy_read_timeout` is an inactivity limit between upstream reads, not
a total response deadline. The application server enforces the request deadline.
See the
[NGINX proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_read_timeout).
