# G0: application container checkpoint

The intermediate Node service also serves the built game with Express 5 and
compression at its private listener. It uses `LOW_PASS_STATIC_ROOT` set to
`/usr/share/nginx/html`; production middleware dependencies live outside that
HTTP root. Nginx remains the public listener until the next container cutover.
Middleware dependency license texts are included under `/licenses/runtime-*`.

This is the first deployable **single-player-compatible preparation** for
multiplayer, not a multiplayer release. It adds an optional Node HTTP service
beside Nginx in the existing application image. There are no rooms, host access
codes, invitations, WebRTC sessions or TURN credential issuance in the application
yet. The separately managed coturn server is described under integration status below.

The implementation branch is `feat/two-player-multiplayer`. Deployment remains
owned by Ansible in the separate repository. These are handoff instructions,
not instructions for the implementation agent to deploy or publish anything.

**Reported deployment status (2026-09-20):** the user set
`LOW_PASS_MULTIPLAYER_ENABLED=false` but did not update the application image.
That environment change alone does not install this checkpoint's Nginx/Node
runtime. The next deployment must use a new image built from
`feat/two-player-multiplayer`, through the approved artifact/publication workflow.
Keep the flag false. The existing published image is not updated merely because
this branch has local commits.

## Container contract

| Surface | G0 behavior |
| --- | --- |
| Image identity | Keep `ghcr.io/adrianba/low-pass`; use a separately identified checkpoint tag/digest, not an implicit overwrite of `latest`. |
| Public application port | Still `8080`, served by Nginx. |
| Service listener | Node 24, `127.0.0.1:8081` inside the same container. Do not publish 8081. |
| User | `101:101`, as with the previous unprivileged Nginx image. |
| Hardening | Read-only root, `cap_drop: [ALL]`, `no-new-privileges:true`, writable `/tmp` tmpfs. No new capabilities or writable mounts. |
| Tmpfs | `noexec,nosuid,nodev` is supported. Executable service scripts remain under immutable `/etc/low-pass`; only supervision state and Nginx temporary files live in `/tmp`. |
| PID 1 | Alpine-packaged s6; no privileged init system or s6-overlay. |
| Stop signal and grace | `SIGTERM` to PID 1; allow 45 seconds, also set in `compose.yaml`. |
| Secrets and volumes | None required at G0. No database, persistent server data or TURN certificate mounts. |
| Game origin | Preserve `https://low-pass.biggsea.us` and the existing Traefik HTTP route to Nginx. No DNS, firewall or TLS routing changes for G0. |
| Activation | Multiplayer is unavailable in this build; only absent or literal `false` is accepted for `LOW_PASS_MULTIPLAYER_ENABLED`. |

**Entrypoint compatibility matters:** the image now starts `/etc/low-pass/entrypoint`
and s6 instead of the vendor `/docker-entrypoint.sh`. Do not override its
entrypoint or command to launch only Nginx. Additional command arguments fail
explicitly. Vendor `/docker-entrypoint.d` hooks and automatic Nginx environment
template expansion are not run. The repository's existing configuration does
not need them; if the Ansible deployment adds hooks, template mounts, a custom
command or a different user, review that difference before replacement.

The only deployment change required by the checked-in Compose configuration is
the longer stop grace. Existing `/tmp` is sufficient, including when mounted
`noexec`. Both services run without root. Container replacement is not promised
to be zero-downtime; an already-loaded solo page runs in its browser, but asset
loading or refresh during replacement can fail.

## Configuration and health

| Variable | G0 default | Container constraint |
| --- | --- | --- |
| `LOW_PASS_MULTIPLAYER_ENABLED` | `false` | Leave unset or set exactly `false`; other values log a configuration error and make multiplayer readiness 503 without stopping the application service. |
| `LOW_PASS_SERVICE_PORT` | `8081` | Leave unset or set exactly `8081`. Other values conflict with the fixed internal Nginx upstream and are rejected. |
| `LOW_PASS_SHUTDOWN_TIMEOUT_MS` | `5000` | Integer 1-30000; Node drains HTTP until this deadline, then warns and closes remaining connections. |

Standalone Node development allows a different loopback port, but the container
does not. Core listener/shutdown configuration errors use exit code 78. They are logged without echoing
the supplied value, then the supervisor leaves Node down rather than repeatedly
restarting invalid configuration. Correct container configuration and restart it.

| Request on application port 8080 | Expected response |
| --- | --- |
| `GET /healthz` | `200`, `ok` followed by newline. Static availability; the Docker health check uses this. |
| `GET /` | Existing single-player HTML, `Cache-Control: no-cache`. |
| Hashed JS/CSS | Existing immutable cache policy. |
| Unversioned assets | Existing revalidation policy; GLB keeps its binary glTF MIME type. |
| Missing asset | `404`, never an HTML application fallback. |
| `GET /api/multiplayer/readyz` | `200`, `{"status":"ready","multiplayer":false}` when Node is reachable. |
| `GET /api/multiplayer/capabilities` | `200`, `{"multiplayer":false,"reason":"not_implemented"}`. |
| Room endpoints or `/signal` | `404` while Node is up; not dummy success responses. |
| Invalid multiplayer configuration | Application health and static serving remain available; multiplayer readiness is `503`, capabilities report `configuration_error`, and an explicit error is logged. |
| Node down | API and signal proxy requests fail explicitly, normally `502`; `/` and `/healthz` remain available. A hung upstream can produce `504`. |

API/signal responses use `no-store`. Nginx retains the local-only CSP, disables
access logs on those routes, limits their request bodies to 16 KiB and uses
bounded upstream timeouts. No credentials should be put in URL queries. The
`/signal` proxy supports HTTP/1.1 WebSocket upgrades, but the real service does
not accept upgrades yet. The isolated test fixture verifies actual upgrade and
bidirectional frames; it is not shipped in the application runtime.

Do not interpret static Docker health as Node readiness, and do not interpret
Node readiness as multiplayer availability. Monitor these separately when the
service becomes operational in later checkpoints. There is no health-triggered
automatic restart of an unresponsive but still-running Node process at G0.

## Supervision and failure behavior

s6 runs one supervisor each for Nginx and Node. It reaps adopted children as PID
1 and restarts unexpectedly exited services. Without a readiness notification
protocol, s6 waits at least one second before each crash restart. This is
rate-bounded restarting, **not exponential backoff or a finite retry budget**.
Invalid core Node configuration instead stops automatic restarts as described
above; optional multiplayer configuration errors do not terminate Node.

On container SIGTERM, s6 stops both services and waits for them. Nginx receives
SIGQUIT for graceful worker shutdown, with a seven-second forced-stop deadline.
Node receives SIGTERM and uses its configured drain deadline; s6 provides a
35-second final safeguard. A crashed Nginx master's process group is cleaned up
using the group ID supplied by s6 to its finish hook. This prevents orphaned
workers from retaining the listening socket and blocking a replacement master.
The image requires s6 2.15 or later for the tested service-directory contract.

The retained rootless Nginx base and Node 24 base are pinned by multi-platform
image digest in `Dockerfile`. Updating either pin or the Alpine packages requires
rerunning the container checks. Package repositories can change, so a source
revision alone is not a byte-for-byte image digest: preserve the exact image
artifact/digest that is accepted. Runtime notices for Node, Nginx, s6, skalibs and
execline are served under `/licenses/`, alongside the existing game/Babylon notices.

Official supervision references:
[s6 service directories](https://skarnet.org/software/s6/servicedir.html),
[s6-supervise](https://skarnet.org/software/s6/s6-supervise.html) and
[s6-svscan](https://skarnet.org/software/s6/s6-svscan.html).

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
invalid configuration, Node isolation/restarts, Nginx master crashes and worker
cleanup, container restart, orderly shutdown and WebSocket proxy frames. They
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

## G0 acceptance and rollback

The user deploys the intermediate image through Ansible and supplies:

1. **Artifact and configuration:** source SHA, image ID/digest and `linux/amd64`
   architecture, effective user/mount/security settings, 45-second stop grace,
   and confirmation that no old entrypoint/template customization was lost.
2. **HTTP behavior:** unchanged HTTPS origin and assets/cache/404/CSP behavior;
   static `/healthz` and separate Node readiness; disabled capabilities response.
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

**G0 still concerns the application container:** confirm the Nginx/Node image is
deployed on the intended architecture, both health endpoints work, and actual
Windows Edge solo play, existing records/settings and restart behavior remain
intact. Coturn deployment alone does not establish those results.

Once G0 is approved, the next work is the local paired-flight prototype.
TURN connection details are needed before the later networking work, not to
begin that local prototype. Authenticated relay allocations and bidirectional
data between real Windows Edge clients remain **G2**, not an inferred result
of the server's deployment.
