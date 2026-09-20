# G0: application container checkpoint

This is the first deployable **single-player-compatible preparation** for
multiplayer, not a multiplayer release. One Node 24 process now serves the built
game through Express 5 and compression; Nginx and s6 have been removed.
There are no rooms, host access
codes, invitations, WebRTC sessions or TURN credential issuance in the application
yet. The separately managed coturn server is described under integration status below.

The implementation branch is `feat/two-player-multiplayer`. Deployment remains
owned by Ansible in the separate repository. These are handoff instructions,
not instructions for the implementation agent to deploy or publish anything.

**Reported deployment status (2026-09-20):** the user set
`LOW_PASS_MULTIPLAYER_ENABLED=false` but did not update the application image.
That environment change alone does not install this checkpoint's Node-only
runtime. The next deployment must use a new image built from
`feat/two-player-multiplayer`, through the approved artifact/publication workflow.
Keep the flag false. The existing published image is not updated merely because
this branch has local commits.

## Container contract

| Surface | G0 behavior |
| --- | --- |
| Image identity | Keep `ghcr.io/adrianba/low-pass`; use a separately identified checkpoint tag/digest, not an implicit overwrite of `latest`. |
| Public application port | Still `8080`, served by Node 24 on `0.0.0.0`. |
| Service listener | One listener for static files and API. The former private 8081 listener is removed. |
| User | `101:101`, as with the previous unprivileged Nginx image. |
| Hardening | Read-only root, `cap_drop: [ALL]`, `no-new-privileges:true`, writable `/tmp` tmpfs. No new capabilities or writable mounts. |
| Tmpfs | `noexec,nosuid,nodev` is supported; there are no writable supervision files or executable scripts. |
| PID 1 | Node directly; no npm, shell supervisor, Nginx or s6. |
| Runtime layout | `/opt/low-pass/dist` is the HTTP root; sibling `dist-server` and `node_modules` are not served. |
| Stop signal and grace | `SIGTERM` to PID 1; allow 45 seconds, also set in `compose.yaml`. |
| Secrets and volumes | None required at G0. No database, persistent server data or TURN certificate mounts. |
| Game origin | Preserve `https://low-pass.biggsea.us` and the existing Traefik HTTP route to port 8080. No DNS, firewall or TLS routing changes for G0. |
| Activation | Multiplayer is unavailable in this build; only absent or literal `false` is accepted for `LOW_PASS_MULTIPLAYER_ENABLED`. |

**Entrypoint compatibility matters:** the exec-form entrypoint is
`node /opt/low-pass/dist-server/index.js`. Additional arguments fail with exit
code 64. Old Nginx hooks, templates and `/usr/share/nginx/html` mounts no longer
apply. If Ansible adds hooks, mounts, a custom command or a different user,
review those differences before replacement.

The only deployment change required by the checked-in Compose configuration is
the longer stop grace. Existing `/tmp` is sufficient, including when mounted
`noexec`. Node runs without root. Container replacement is not promised
to be zero-downtime; an already-loaded solo page runs in its browser, but asset
loading or refresh during replacement can fail.

## Configuration and health

| Variable | G0 default | Container constraint |
| --- | --- | --- |
| `LOW_PASS_MULTIPLAYER_ENABLED` | `false` | Leave unset or set exactly `false`; other values log a configuration error and make multiplayer readiness 503 without stopping the application service. |
| `LOW_PASS_SERVICE_PORT` | `8080` | Integer 1-65535. Keep 8080 for the existing publishing/Traefik contract. |
| `LOW_PASS_SERVICE_HOST` | `0.0.0.0` | IP address. Standalone default is loopback; the image explicitly binds all IPv4 interfaces. |
| `LOW_PASS_STATIC_ROOT` | `/opt/low-pass/dist` | Absolute built-asset root, validated at startup. Keep immutable; symlinks/special files are rejected. |
| `LOW_PASS_SHUTDOWN_TIMEOUT_MS` | `5000` | Integer 1-30000; Node drains HTTP until this deadline, then warns and closes remaining connections. |

Invalid listener/shutdown configuration or missing/unreadable build output
exits with code 78 without echoing supplied settings. Bind failures are fatal.
An incorrect core setting prevents the whole application from starting; correct
it rather than relying on a restart loop. Optional multiplayer errors are
different: they are logged once and leave solo serving healthy.

| Request on application port 8080 | Expected response |
| --- | --- |
| `GET /healthz` | `200`, `ok` followed by newline. Application availability; the Node-based Docker probe uses this. |
| `GET /livez`, `GET /readyz` | `200` JSON application liveness/readiness; not playable-multiplayer checks. |
| `GET /` | Existing single-player HTML, `Cache-Control: no-cache`. |
| Hashed JS/CSS | Existing immutable cache policy. |
| Unversioned assets | Existing revalidation policy; GLB keeps its binary glTF MIME type. |
| Missing asset | `404`, never an HTML application fallback. |
| `GET /api/multiplayer/readyz` | `200`, `{"status":"ready","multiplayer":false}` when Node is reachable. |
| `GET /api/multiplayer/capabilities` | `200`, `{"multiplayer":false,"reason":"not_implemented"}`. |
| Room endpoints or `/signal` | `404` while Node is up; not dummy success responses. |
| Invalid multiplayer configuration | Application health and static serving remain available; multiplayer readiness is `503`, capabilities report `configuration_error`, and an explicit error is logged. |
| Node down | All new HTTP requests fail until the process/container recovers. Fully loaded solo gameplay remains browser-side. |

API/signal responses use `no-store`. Node retains the local-only CSP, nosniff and
same-origin Referrer-Policy, with no framework identification header or access
logging. API/signal bodies are bounded at 16 KiB for every content type, including
chunked requests. No credentials should be put in URL queries. The native HTTP
server supports later WebSocket integration, but production `/signal` is still
404. A test-only fixture verifies real upgrades, bidirectional frames and
shutdown on the actual application server; it is not shipped in the image.

Static delivery supports HEAD, ETag/Last-Modified, 304, byte ranges and negotiated
gzip/deflate/Brotli. Partial responses are not compressed. Only the existing
eight-character hashed JS/CSS pattern is immutable. HTML and other assets
revalidate. There is no SPA fallback, directory listing or extension lookup.
Error bytes, ETag formatting and compressed bytes need not match the old Nginx
implementation; status codes, MIME, caching and security boundaries do.

Application health is not multiplayer availability. Monitor feature readiness
separately once signaling is implemented. Docker does not automatically restart
an unhealthy/hung process merely because the HTTP health probe fails.

## Process lifecycle and failure behavior

Node is PID 1 and does not spawn application child processes. SIGTERM/SIGINT stop
accepting work and drain active requests. At the configured deadline the server
logs a warning and destroys remaining sockets, including upgraded sockets.
Repeated shutdown is idempotent. Keep the 45-second container grace, longer
than the maximum configured 30-second application deadline.

The Compose `unless-stopped` policy recovers process exits; manual Docker stops
remain stopped. There is no separate process to keep static serving alive during
a Node crash. A loaded solo page needs no backend, but refresh and new asset
requests require a healthy application. No zero-downtime replacement is promised.

The Node 24 base is pinned by multi-platform digest. Both build and production
dependency installs use the lockfile with `min-release-age=7`; personal `.npmrc`
files are excluded. Recheck the image when updating the base or dependencies.
Preserve the exact tested image ID/digest as well as its source SHA.
Game, asset, Babylon, Node and middleware license texts ship under `/licenses/`.
Nginx/s6/skalibs/execline notices are removed because those runtimes are absent.

## Build and local verification

Record the checkpoint's full Git SHA and require a clean worktree. On a Docker
host capable of building and running the intended **linux/amd64** production
image, using Node 24 for local test tooling:

```sh
REV=$(git rev-parse HEAD)
IMAGE="ghcr.io/adrianba/low-pass:g0-$REV"
npm ci
npm run test:server
npm run lint
docker build --platform linux/amd64 \
  --label "org.opencontainers.image.revision=$REV" -t "$IMAGE" .
LOW_PASS_TEST_IMAGE="$IMAGE" npm run test:container
docker image inspect "$IMAGE" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
```

The container checks use uniquely named disposable containers and ephemeral
loopback host ports. They exercise hardening, cache/asset behavior, notices,
invalid configuration, Node PID 1, Docker process-exit recovery, manual-stop
semantics, container restart, orderly shutdown and actual WebSocket frames. They
do not contact production or change host firewall rules. Unit/server tests remain
independent of Docker.

**Local implementation evidence is ARM64 only.** The implementation workstation's
Docker builder advertises only `linux/arm64`; no system emulator was installed.
Its container checks and container-backed Chromium game tests do not establish
AMD64 or Windows Edge acceptance. Build/test the intended AMD64 image as part of
the user-owned handoff; do not deploy the local ARM64 image to an AMD64 host.

For artifact transfer through the existing approved deployment workflow, an
operator can export the tested image without publishing:

```sh
docker image save "$IMAGE" -o low-pass-g0-image.tar
sha256sum low-pass-g0-image.tar
```

Import that artifact on a matching-architecture host using the normal Ansible
workflow, or use an explicitly authorized registry publication path. Keep its
checksum and image ID with the source revision. No image push, branch push,
workflow dispatch or deployment is included in this checkpoint. The existing
publication workflow remains main-only and has not been changed.

## Local Windows Edge handoff before merge

Use the exact checkpoint SHA supplied with the handoff, Node 24 LTS with current
npm, and the already-installed Windows Microsoft Edge. A local tracked-source
archive can transfer the branch without pushing it:

```sh
git archive --format=zip --output=low-pass-node-checkpoint.zip HEAD
git rev-parse HEAD
```

Keep the archive out of Git and record its source SHA separately. Extract it to
a new folder on Windows; do not overwrite another worktree. From that folder,
in PowerShell:

```powershell
node --version
npm --version
npm ci --min-release-age=7
npm run build
npm run build:server
$env:LOW_PASS_MULTIPLAYER_ENABLED="false"
$env:LOW_PASS_SERVICE_HOST="127.0.0.1"
$env:LOW_PASS_SERVICE_PORT="8080"
Remove-Item Env:LOW_PASS_STATIC_ROOT -ErrorAction SilentlyContinue
npm run start:server
```

Leave the server running. In a second PowerShell window in the same folder:

```powershell
$env:TEST_URL="http://127.0.0.1:8080"
Invoke-RestMethod "$env:TEST_URL/healthz"
Invoke-RestMethod "$env:TEST_URL/api/multiplayer/readyz"
Invoke-RestMethod "$env:TEST_URL/api/multiplayer/capabilities"
npm run test:e2e -- --project=edge
```

Do not install or overwrite Edge via Playwright. This uses the real Node server,
not Vite preview. If 8080 is occupied, choose a free local port and use the same
port in both windows. Build/start failures must be resolved before browser
acceptance. Stop the server with Ctrl+C after the checks.

Record the source SHA, Windows version, Edge version (`edge://version`), Node/npm
versions, effective URL, complete test summary and any failures/traces. In a normal
Edge window, also check all terrains, assets/reticle/drop, pause/finale/restart,
and settings/completed records across reload and server restart. Keep the same
local origin and browser profile. Localhost does not share production records:
use representative local records rather than interpreting their absence as loss.
Automated contexts also do not share the normal browser profile.

This is the **pre-merge** browser gate. Actual production-origin old-record
preservation is checked separately during G0 below. No merge recommendation is
made without the Windows Edge evidence; no merge, push, publication or deployment
is authorized by these testing instructions.

## G0 acceptance and rollback

Before a merge recommendation, the user must supply actual local Windows Edge
evidence for the exact checkpoint. Merge/push/publication require separate
explicit approval. A successful AMD64 build **and smoke checks on that exact
image** are mandatory before live deployment; publication success alone is not
acceptance. Local ARM64/Chromium results cannot substitute for either gate.

After those gates, the user deploys the Node-only image through Ansible and supplies:

1. **Artifact and configuration:** source SHA, image ID/digest and `linux/amd64`
   architecture, effective user/mount/security settings, 45-second stop grace,
   and confirmation that no old entrypoint/template customization was lost.
2. **HTTP behavior:** unchanged HTTPS origin and assets/cache/404/CSP behavior;
   application `/healthz` and separate multiplayer readiness; disabled capabilities response.
3. **Windows Edge:** actual browser version and successful solo play on all three
   terrains, bomb release, pause/resume, third-miss finale and restart; existing
   local records/settings still present without clearing site data.
4. **Restart:** user-controlled container replacement/restart returns both
   health endpoints while keeping the same browser origin and completed records.
   Test intentional Node downtime only in an appropriate non-live environment.
5. **TURN integration:** the user reports the separate coturn server deployed at
   `turn.low-pass.biggsea.us`. Game-side authenticated relay connectivity remains
   the later G2 acceptance check.

The full browser suite can target the user-provisioned deployment. On an approved
Windows Edge test host, in PowerShell:

```powershell
$env:TEST_URL="https://low-pass.biggsea.us"
npm run test:e2e -- --project=edge
```

Do not install/overwrite Edge implicitly. Automated contexts are not the user's
existing browser profile, so manually verify the existing records/settings too.

Keep the previously deployed image digest and Ansible configuration for rollback.
If this checkpoint fails, redeploy that known-good image through Ansible at the
**same origin**; do not clear browser storage or introduce a new hostname/port.
G0 makes no score schema changes. A rollback can interrupt asset requests, but
completed browser records remain origin/profile-local and are not in a Docker
volume. Stop implementation at this gate until the required evidence is approved.

## Independently managed TURN integration

On 2026-09-20 the user reported coturn deployed at `turn.low-pass.biggsea.us`,
using independently developed code in the Ansible repository. Relay deployment
instructions and examples have been removed here; the old examples do not
describe or establish the live server's settings.

The game still needs the actual TURN URLs/transports, authentication contract
and a secure server-side credential integration. See the
[TURN connection contract](two-player-multiplayer-research.md#122-turn-connection-contract).
No shared secret, permanent password or certificate private key should be sent
in chat or committed to this repository.

**G0 still concerns the application container:** confirm the Node-only image is
deployed on the intended architecture, both health endpoints work, and actual
Windows Edge solo play, existing records/settings and restart behavior remain
intact. Coturn deployment alone does not establish those results.

Once G0 is approved, the next work is the local paired-flight prototype.
TURN connection details are needed before the later networking work, not to
begin that local prototype. Authenticated relay allocations and bidirectional
data between real Windows Edge clients remain **G2**, not an inferred result
of the server's deployment.
