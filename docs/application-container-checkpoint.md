# G0: application container checkpoint

This is the first deployable **single-player-compatible preparation** for
multiplayer, not a multiplayer release. It adds an optional Node HTTP service
beside Nginx in the existing application image. There are no rooms, host access
codes, invitations, WebRTC sessions, TURN credentials or relay listeners yet.

The implementation branch is `feat/two-player-multiplayer`. Deployment remains
owned by Ansible in the separate repository. These are handoff instructions,
not instructions for the implementation agent to deploy or publish anything.

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
| `LOW_PASS_MULTIPLAYER_ENABLED` | `false` | Leave unset or set exactly `false`; other values permanently stop only the Node service for that container run. |
| `LOW_PASS_SERVICE_PORT` | `8081` | Leave unset or set exactly `8081`. Other values conflict with the fixed internal Nginx upstream and are rejected. |
| `LOW_PASS_SHUTDOWN_TIMEOUT_MS` | `5000` | Integer 1-30000; Node drains HTTP until this deadline, then warns and closes remaining connections. |

Standalone Node development allows a different loopback port, but the container
does not. Configuration errors use exit code 78. They are logged without echoing
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
| Node down/unconfigured | API and signal proxy requests fail explicitly, normally `502`; `/` and `/healthz` remain available. A hung upstream can produce `504`. |

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
Invalid Node configuration instead stops automatic restarts as described above.

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
5. **Coturn layout:** the user selected a separate `coturn/coturn` container.
   Provisioning and real relay connectivity remain the later G2 handoff.

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

## Selected coturn packaging: separate container

The user selected a separate container using `coturn/coturn`. See the
[Compose and abuse-prevention guide](coturn-compose.md) and its example files
for the Ansible-owned deployment. No relay has been deployed by this work.
The comparison below records the tradeoffs; it is no longer an open decision.
Both options can use the same host/public IP. Both
require authenticated temporary credentials, quotas, relay-side UDP reachability,
advertised address configuration, secret/certificate handling and later real
Edge allocation/data testing. Neither makes TURN an ordinary HTTP reverse proxy.

| Concern | Separate coturn container | Coturn bundled with Nginx and Node |
| --- | --- | --- |
| Updates/restarts | Relay can update independently; game deployments need not restart active relay allocations. | App replacement restarts relay too; plan for active connections/allocations to be interrupted. |
| Ports/routing | Additional container/service, explicit listeners and relay UDP range on the same host. | The existing application container gains all those listeners/UDP mappings; they are not avoided. |
| Secrets/certificates | Relay secrets and TURN TLS certificate mounts isolated to coturn. Node still needs authorized credential-issuing configuration. | More sensitive mounts and configuration share the application container and its process namespace. |
| Resource/failure limits | Independent memory/CPU limits, health and logging; clearer relay failure isolation. | Shared limits and failure/update fate; per-service health and least privilege must be re-proven. |
| Maintenance | An additional Ansible-managed service, but a standard relay image can track coturn separately. | One application artifact to distribute, but a larger image and more supervision, licensing and networking responsibility here. |

**Selected:** keep Nginx and Node together, with coturn in a separate container
for independent relay lifecycle and resource limits. This decision does not
waive the outstanding AMD64 deployment and Windows Edge evidence at G0.

Actual direct/relay connectivity, TURN/TLS 443 SNI routing, allocations and
bidirectional data remain **G2**, not G0 acceptance.
