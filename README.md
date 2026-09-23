# LOW PASS

A desktop browser bombing-accuracy game. The computer flies the original Kestrel
fighter-bomber through a rolling valley; you time one bomb per target. Built with
TypeScript, Babylon.js/WebGL2, and Vite. No gameplay server or account is required.

## License

Original code, documentation, artwork, models (including `art/kestrel.blend`),
and synthesized audio are licensed under the [MIT License](LICENSE).
Copyright (c) 2026 Ade Bateman.

Third-party materials retain their own licenses: ambientCG terrain textures are
CC0-1.0, and Babylon.js is Apache-2.0. See
[asset notices](public/assets/credits.txt) and the
[asset manifest](public/assets/manifest.json) for attribution and provenance.
Production builds include the MIT, Babylon.js and Node middleware dependency
license texts under `/licenses/`.
The application container also includes the Node.js license and bundled notices
at that path.

## Run locally

Use Node.js 24 LTS and npm:

```sh
npm ci
npm run dev
```

Open the URL printed by Vite. For the optimized production build:

```sh
npm run build
npm run preview
```

The browser needs WebGL2 and graphics acceleration. Start the flight to unlock
audio. Failed essential assets or a lost graphics context display a reload screen.

### Node application server

The Node 24 server serves the production build. Fully loaded single-player play
remains client-side, and the build also works with other static hosts. Multiplayer
endpoints support opt-in private rooms, authenticated signaling and temporary
TURN credentials. The normal entry remains solo-only; a separate local
multiplayer application preview is described below. It is not a finished release.
Shared Zod protocol modules compile under `dist-server/shared`; the executable
is `dist-server/server/index.js`. Neither directory is inside the HTTP asset root.

```sh
npm run build
npm run build:server
npm run start:server
```

It serves the built `dist` directory at `127.0.0.1:8080` using Express 5 and
compression middleware. The default build root is relative to the compiled
server, independent of the launch directory. `/healthz` returns `ok`.
`GET /livez` reports process health;
`GET /readyz` reports HTTP-service readiness, **not multiplayer availability**.
`GET /api/multiplayer/readyz` separately reports multiplayer configuration failures
with 503 while the HTTP service remains available. Intentionally disabled
multiplayer returns 200 with `multiplayer: false`.
`GET /api/multiplayer/capabilities` returns
`{"multiplayer":false,"reason":"not_implemented"}`. Responses are uncached JSON;
unknown routes and disabled multiplayer endpoints return 404 with no HTML
fallback. `/signal` accepts only enabled WebSocket upgrades, not ordinary HTTP
requests. Static delivery supports HEAD, validators, ranges and compression;
only hashed JS/CSS is immutable, while other assets revalidate. SIGTERM and
SIGINT stop accepting connections, drain requests, then close remaining HTTP
connections at the shutdown deadline with a warning.

| Environment variable | Default | Accepted values |
| --- | --- | --- |
| `LOW_PASS_SERVICE_PORT` | `8080` | Integer 1-65535; keep 8080 in the container |
| `LOW_PASS_SERVICE_HOST` | `127.0.0.1` | IP address; container explicitly uses `0.0.0.0` |
| `LOW_PASS_STATIC_ROOT` | sibling `dist` | Absolute built-asset directory; symlinks are rejected |
| `LOW_PASS_SHUTDOWN_TIMEOUT_MS` | `5000` | Integer 1-30000 |
| `LOW_PASS_MULTIPLAYER_ENABLED` | `false` | `false`, or `true` to enable the private-room preparation API with all settings below |
| `LOW_PASS_PUBLIC_ORIGIN` | unset | Canonical HTTPS origin; HTTP loopback is allowed for local tests |
| `LOW_PASS_TRUSTED_PROXY_CIDRS` | unset | Comma-separated explicit IP/CIDR ranges for the immediate proxy and trusted upstream proxies; universal `/0` ranges are rejected |
| `LOW_PASS_HOSTING_CODE_FILE` | unset | Absolute private file outside the HTTP root; 32-256 printable ASCII characters, optionally followed by one newline |
| `LOW_PASS_TURN_URLS` | unset | Comma-separated explicit ICE URLs (up to eight), including at least one TURN URL; see below |
| `LOW_PASS_TURN_SECRET_FILE` | unset | Absolute private file containing the same shared secret as coturn; 32-4096 printable non-space ASCII characters, optionally followed by one newline |

Invalid core listener/shutdown configuration exits with code 78. An unsupported
multiplayer flag is logged explicitly without echoing its value; capabilities
report `configuration_error` and multiplayer readiness becomes 503 without
taking down the application service. No secrets are needed for default solo-only serving.
The former private 8081 listener has been removed; this is a single listener.
Missing/unreadable build output is fatal. Keep the build directory immutable
while serving it; replace the container for releases rather than editing files.
`npm run test:server` exercises real local HTTP and independently compiled ESM
startup/shutdown; these tests are also included in `npm test`.

### Private room service (preparation only)

Deployment remains owned by the separate Ansible repository. The current
deployment can keep `LOW_PASS_MULTIPLAYER_ENABLED=false`; nothing needs enabling
for solo play or the local combat preview.

The confirmed production path is Cloudflare -> Traefik -> Node, with Node
unpublished on the `proxynet` Docker network. Traefik trusts Cloudflare's proxy
addresses and has `forwardedHeaders.insecure=false`. Configure the application's
allowlist with the actual trusted Traefik addresses/dedicated network and the
trusted Cloudflare ranges; a Docker network name is not an IP range. Do not
substitute all private networks or a fixed total hop count.

Room requests require a trusted immediate peer and a valid `X-Forwarded-For`
chain. The application walks from the proxy side to the nearest untrusted
address, ignoring spoofed prefixes and `CF-Connecting-IP`. It does not enable
unrestricted Express `trust proxy`. Direct Internet access to Node must remain
blocked. Cloudflare does not need to be disabled.

When explicitly enabled and configured, the following **POST-only** endpoints
accept bounded JSON and the exact configured `Origin`. Credentials never belong
in URLs; member operations use `Authorization: Bearer <capability>`.

| Endpoint under `/api/multiplayer/` | Purpose |
| --- | --- |
| `host-authorizations` | Verify the separately shared hosting access code; issue a one-use, source-bound grant |
| `rooms` | Consume that grant; create a room, host capability and separate `ABCD-EFGH` invitation |
| `join` | Atomically reserve the guest slot using an invitation; issue a distinct guest capability |
| `room/status` | Read the caller's own room and server-assigned role |
| `room/admission` | Host approves or denies the identified pending guest |
| `room/invitation` | Host revokes/rotates an invitation before admission |
| `room/leave` | Cancel pending participation or close an admitted room; no replacement player or host migration |
| `room/ice` | Obtain temporary relay credentials for an admitted member; unavailable unless TURN is configured |

Default bounds: 16 rooms, two rooms per source, 64 host grants, one guest per
room, 60-second grants/pending admissions, five-minute invitations, 15-minute
authenticated idle leases and an eight-hour absolute room lifetime. These room
cleanup leases do **not** replace signaling's 15-second connection-recovery rule.
Authentication, joining, room creation, member operations and global traffic
have bounded rate limits; capacity/rate/expiry failures are explicit. Credentials
and access codes must be excluded from proxy request-body/header logs.

Capabilities report `rooms: true` and `signaling: true` only for healthy configured
services, while `multiplayer` remains `false`. Invalid optional settings or room
maintenance failure leave static serving healthy. A declared secret file
mistakenly placed in the static root is excluded from HTTP delivery, and room
activation is rejected. No hosting code is supplied in the repository.

### Authenticated signaling (preparation only)

The same listener accepts WebSocket upgrades at `/signal` when rooms are enabled.
The upgrade requires the exact configured Origin and validated proxy chain.
Authenticate within five seconds using a first JSON frame
`{ "type": "auth", "version": 1, "capability": "<member capability>" }`;
never put capabilities in the URL or a WebSocket subprotocol.

Only admitted members can negotiate. Roles and the destination are derived from
room membership: the host sends offers, the guest answers, and either can send
ICE candidates to the other member of that room. Strict schemas reject additional
routing/role fields. Generations start at one, increase with each host offer, and
must match on answers/candidates. A pending offer cannot be overwritten.
Reconnection retains the generation counter but requires a fresh offer.

Bounds include 48 sockets, 16 awaiting authentication, 16 KiB wire frames, 64 KiB
outgoing buffering and 128 candidates per participant/generation. Compression is
disabled; upgrade and message traffic have global/source/member/room rate limits.
Server heartbeats run every five seconds. After a detected disconnection, the
same capability can reconnect for 15 seconds; expiry closes an admitted room.
Pending guests that are denied or revoked cannot reconnect. Closure, overload,
authentication and negotiation failures are explicit. Logs contain no SDP, ICE
addresses or credentials. Service shutdown also closes upgraded sockets.

Server and native-browser checks cover signaling messages. The separate native
peer adapter is described below; relay allocations, connection UI, fair remote
release settlement and two-computer Edge/TURN acceptance remain later milestones.

### Temporary TURN credentials (application integration only)

Coturn remains independently managed by Ansible. Configure **both** TURN settings
above to enable issuance; omitting both leaves room/signaling preparation usable
with `turn: false` in capabilities. Supplying only one or invalid settings reports
a multiplayer configuration error without breaking solo/static serving.
Nothing contacts coturn during application startup or credential issuance.

Use the operator-confirmed addresses, not guessed public ports:
`stun:<host>:<port>`, `turn:<host>:<port>?transport=udp`,
`turn:<host>:<port>?transport=tcp`, or `turns:<host>:<port>?transport=tcp`.
Bracket IPv6 addresses. Ports and TURN transports are mandatory; embedded
credentials, URL paths/fragments, unsupported schemes and duplicate URLs are
rejected. No default external STUN service is used.

The operator-provided coturn task publishes 3478/UDP, 3478/TCP and 5349/TCP
at `turn.low-pass.biggsea.us`, plus a configured UDP relay-port range, with
Traefik disabled for coturn. Its configuration enables shared-secret
authentication and disables standalone STUN (`no-stun`). Use TURN-only URLs:

```text
LOW_PASS_TURN_URLS=turn:turn.low-pass.biggsea.us:3478?transport=udp,turn:turn.low-pass.biggsea.us:3478?transport=tcp,turns:turn.low-pass.biggsea.us:5349?transport=tcp
```

These URLs describe the intended listeners, not verified connectivity. Docker
port publication alone does not establish public DNS, firewall reachability or
TLS certificate validity. `no-tcp-relay` disables TCP relay allocations, not
TCP/TLS client connections to TURN; those two client URLs remain applicable.
The UDP relay-port range is
allocated by coturn; it is not listed in browser ICE URLs. Live local diagnostics
now reach this hostname for authenticated UDP and TCP relay traffic, independently
of the game website's HTTP proxy.

Mount the existing coturn shared secret read-only outside the asset root. The
issuer uses its REST format: Unix-expiry-prefixed opaque participant username
and Base64 HMAC-SHA1 password. Only temporary passwords reach the browser;
neither the hosting access code nor coturn's permanent key does. Exclude request
authorization, response bodies and credential-bearing diagnostics from logs.

The application-side file convention is `/run/secrets/low-pass-turn-secret`.
Set `LOW_PASS_TURN_SECRET_FILE` to that path; do not put the secret value in an
environment variable or `.env`. Ansible should render a separate host file
containing only the existing `coturn_auth_secret` value from its protected secret
store (such as Ansible Vault), using `no_log: true` and `diff: false`. Bind-mount
that file read-only at the convention above, readable by the application's
UID/GID `101:101` (for example, file owner `101:101`, mode `0400`).
Do not mount an encrypted Vault document, the coturn configuration or its TLS
private key into the application. Recreate Low Pass when the secret file changes
and coordinate rotation with coturn. This is an application integration contract,
not an Ansible deployment performed by this repository.

For project-local testing, keep the raw secret in `./.secret/turn-secret`.
The `.secret/` directory is excluded from Git and Docker build contexts. Bind-mount
that file read-only at `/run/secrets/low-pass-turn-secret`; the environment
variable remains the container path above, not the secret value. Keep the host
file's permissions restricted while allowing the container's UID 101 to read it.
Never copy the directory into an image or publish it with test artifacts.

Credentials last at most ten minutes, bounded by the remaining room lease.
Clients receive server time, expiry and a relative refresh delay (normally five
minutes); schedule refresh with a monotonic browser clock rather than assuming
its wall clock agrees with the server. Repeated early requests reuse the current
credential. Closed/revoked rooms cannot refresh, but **already issued credentials
remain usable until expiry**; the application cannot instantly revoke coturn
allocations. Coturn's own allocation/bandwidth quotas remain operator-owned.
The issuer caps its cache at two entries per allowed room and rate-limits requests
globally and per source/room/member. Large detected wall-clock jumps disable
issuance explicitly until restart; synchronize the application and relay clocks.
Key rotation requires coordinated operator updates/restart; this process reads
its key at startup and does not watch or rewrite secret files.

Local tests use dummy keys and verify issuance, refresh and browser configuration
acceptance. Subsequent opt-in diagnostics established deployed UDP/TCP/TLS relay
use; two-computer Windows Edge and long-match acceptance remain incomplete.
Ansible owns preparing and mounting the separate
application secret file; coturn's existing `/run/secrets/turnserver.conf` mount
does not supply it to Low Pass.

The supplied relay limits are four allocations per user, 16 allocations total,
256 KiB/s per session and 4 MiB/s aggregate (input/output accounted separately).
Allocation counts are not match counts: candidate gathering and recovery can use
multiple allocations. Large-plan transfer, competing control traffic, recovery
and matches lasting beyond ten minutes need real-relay acceptance under these
limits. The 600-second maximum allocation lifetime is a refresh interval limit,
not an absolute match-duration limit or a substitute for REST credential expiry.

### Native peer transport (opt-in development integration)

`RtcPeer` implements the common transport interface using native browser WebRTC:
host-authored offers, guest answers and generation-tagged trickle ICE. Candidates
wait for remote SDP, and outgoing SDP precedes its candidates. Each instance owns
one connection/generation; after connection loss, the future recovery controller
must establish a new peer/epoch and checkpoint rather than resume stale channels.

DTLS fingerprints come from authenticated, room-bound signaling. Before exposing
application data, peers exchange and validate the expected session, epoch, role,
compatibility hashes and viewport on the connected control channel. Reliable
ordered control carries commands/events/transfers; unordered, zero-retry state
carries disposable snapshots and clock probes. Cross-channel traffic that beats
the hello is bounded and held until compatibility is verified.

Wire messages remain at most 16 KiB. Each channel has a 64 KiB send watermark;
bulk chunks stop at 32 KiB, preserving control-buffer space for small messages.
Bulk chunks are additionally paced at 160 KiB/s of encoded wire bytes, with at
most a 16 KiB idle burst. Commands and probes are not paced. This deliberately
applies to direct connections too; it avoids route-dependent scheduling and
leaves headroom under the deployed coturn 256 KiB/s per-session limit.
The adapter reports backpressure instead of accumulating an outgoing queue.
It bounds received events and ICE/negotiation queues, rejects unexpected channel
modes, and disposes timers/handlers/channels on closure. Diagnostics expose only
candidate categories, transport type and RTT, never addresses, SDP or credentials.

The local browser fixture connects two isolated identities through the actual
authenticated signaling service, sends a complete hash-verified Canyon plan
over native data channels, exchanges command/state traffic and recreates the
connection in a new epoch. It also rejects mismatched builds and proves that
test-only relay policy cannot fall back to a direct connection when no relay is
available. This is **local Chromium**, not two-computer Edge or real TURN
acceptance, and not a complete recovery/game controller. Its compatibility hashes
are fixture values; the separate room preview below now uses real build identity
and lobby readiness. Clock synchronization, fair release settlement and multiplayer
records remain unwired.

### Building a connection-service checkpoint

The room, signaling and optional credential services ship in the existing
application image; there is no second application listener or coturn image here.
To build a local artifact without publishing or deploying:

```sh
docker build -t low-pass:connection-checkpoint .
docker image inspect low-pass:connection-checkpoint --format '{{.Id}} {{.Architecture}}'
```

Record the source commit and image ID together. A local build uses the builder's
architecture; do not transfer an ARM64 image to the production AMD64 host.
If an offline artifact is needed on a matching host, `docker image save` can
export that tag to an operator-selected location outside the repository.
GitHub's existing main-only workflow remains the publication path, requiring
separate merge/push approval. These commands do not update the live deployment.

Ansible owns the actual image selection, trusted CIDR values, secret mounts and
environment settings. Keep the current origin, Traefik-only port 8080,
read-only/non-root hardening and healthcheck. `/healthz` proves application
health; `turn: true` in capabilities proves issuer configuration, **not coturn
reachability**. Multiplayer still reports `false` until later UI/game integration.
Ansible must supply the private key file described above; no secret value is
needed in chat. The certificate blocker described below is now resolved;
latency, recovery and browser acceptance remain separate gates.

### Local connectivity diagnostic

The separate test-only page exercises real hosting, joining, admission,
signaling, temporary credentials and native peer data. It does not start a
multiplayer game or write browser records. Use two browser sessions, select a
transport in each, create/join a room, admit the guest, and connect both sides.
The host can send one complete Canyon plan; both peers exchange commands and
ongoing ping/pong probes. Reports contain candidate categories, numeric ICE
errors, handshake state, RTT and verified payload hashes, never credentials,
SDP or candidate addresses.

The ignored `./.secret/turn-secret` supplies the existing relay key. Generate a
separate local hosting code **once**, without printing it:

```sh
node --input-type=module -e 'import {randomBytes} from "node:crypto"; import {writeFileSync} from "node:fs"; writeFileSync(".secret/hosting-code",randomBytes(32).toString("base64url")+"\n",{mode:0o600,flag:"wx"});'
npm run build:connectivity-preview
docker build -t low-pass:connectivity-checkpoint .
node scripts/run-connectivity-backend.mjs
```

The launcher reads neither secret into its output: it passes read-only file
mounts to the application. For this **local-only harness**, the container runs as
the invoking non-root UID/GID so the user's files can remain owner-only `0600`
inside a `0700` directory. The production image's default `101:101` is unchanged.
The application binds an ephemeral loopback host port. In another terminal,
read that port with `docker port low-pass-connectivity-local 8080/tcp`, then run:

```sh
CONNECTIVITY_UPSTREAM_PORT=<published-port> node scripts/connectivity-proxy.mjs
```

This loopback-only fixture proxy supplies a synthetic, fixed client identity to
exercise the explicit proxy boundary; it is not production proxy configuration.
It serves `http://localhost:8080/connectivity.html`. Enter the local hosting code
from `.secret/hosting-code`, **not the TURN key**. Existing formation/combat
artifacts are mounted too when present. Stop only the previous local listener
after the replacement backend is ready; do not stop unrelated containers.

`CONNECTIVITY_FIXTURE_DIR` can point to a stable copy of the two generated
diagnostic files outside the repository, and `CONNECTIVITY_BACKEND_PORT` can
pin the backend's loopback port. Keep live mounts out of any Playwright output
directory that a later run will clear.

Ordinary diagnostic tests use local peers/dummy keys. Real relay tests are
explicitly opt-in, with traces, screenshots and video disabled for that spec:

```sh
LOW_PASS_LIVE_TURN=1 npx playwright test --project=chromium \
  tests/e2e/connectivity.spec.ts -g 'opt-in deployed TURN' \
  --output /path/to/private-test-artifacts
```

To exercise the already running page instead, also set
`TEST_URL=http://localhost:8080` and
`CONNECTIVITY_URL=http://localhost:8080/connectivity.html`.
Tests reading the private local hosting code accept only the expected loopback
preview URL, not a remote origin.
Only redacted summaries are retained. Do not enable network traces/HAR capture
for live credential responses. A failed transport remains a failed test.

**Observed 2026-09-22:** direct connectivity and forced relay-to-relay UDP/TCP
exchanged commands and a hash-verified 1,191,173-byte Canyon payload. Automatic
mode chose the direct path, so that result alone is not relay evidence. TCP had
one connection timeout between successful runs; three subsequent attempts passed,
so repeatability is not yet established. During bulk transfer, probes still
experienced substantial delays after prioritization and send-time stamping;
this is not gameplay latency acceptance or a performance benchmark.

**Certificate retest, 2026-09-22:** the operator replaced the staging certificate.
Normal OpenSSL chain/hostname verification now succeeds for
`turn.low-pass.biggsea.us`, negotiating TLS 1.3. All four mounted Chromium cases
passed: automatic mode selected direct, and forced UDP, TCP and TLS selected
relay candidates at both ends with the expected relay transport. Each transferred
the verified Canyon payload and exchanged commands/probes both ways. Certificate
checks were not bypassed. No TCP connection timeout occurred in this batch; the
earlier intermittent failure remains part of the record.

Bulk-load application-probe maxima in this retest were approximately 2.31 seconds
(UDP), 1.18 seconds (TCP) and 1.57 seconds (TLS), despite selected ICE-pair RTTs
around 17-19 ms. Connectivity is established, but bulk scheduling/pacing still
needed work before gameplay latency acceptance.
Two-computer Edge, long-match refresh and full-match acceptance remain outstanding.

**Pacing checkpoint:** a subsequent fresh-source Chromium batch passed forced
UDP, TCP and TLS with the bounded pacer. Peak application-probe RTTs were 56.1 ms,
49.3 ms and 49.9 ms respectively. The same uncompressed 1,191,173-byte Canyon
payload was hash-verified after 9.81-9.84 seconds from its received offer.
This resolves the reproduced bulk-interference problem in that batch, not the
earlier intermittent TCP negotiation failure or arbitrary Internet congestion.
A second batch against the actual mounted page also passed direct/UDP/TCP/TLS;
its relay maxima were 54.6/433.5/60.3 ms. The isolated TCP probe spike remains
visible in the evidence; the improvement is not a promise of sub-60 ms latency.
The live diagnostic has a 500 ms probe regression ceiling; it is not the game's
eventual supported-latency or scoring-fairness envelope.

Fifteen sequential plans per terrain, through the speed cap, retain every numeric
value. Accounting for actual base64 chunks and worst-case envelope lengths,
the longest ideal paced transfers are 8.734 seconds (Valley/Desert) and 13.633
seconds (Canyon). Compared with the **preceding** encounter's lookahead interval,
minimum headroom is 7.766 and 2.758 seconds respectively. These are ideal wire
budgets, not measured worst-case delivery guarantees: timer/CPU delay, loss,
other events and congestion consume the margin. The later game controller must
wait for verified initial plans and pause at readiness barriers rather than let
missing plans consume a player's opportunity. No compression, quantization,
flight-spacing, release-window or scoring change was needed.

### Private-room controls checkpoint

Reusable host controls now cover hosting-code entry, invitation expiry/copying,
clipboard-denied manual copying, admission/decline, replacement invitations,
refresh errors, and closing a room. The hosting input is cleared on submission
and cancellation; capabilities remain in memory and never enter DOM state,
URLs or browser storage. A bounded typed HTTP client is shared with the
connectivity diagnostic. It validates responses, uses no-store/same-origin
requests without cookies or redirects, and never automatically retries mutations.

Canceling a creation waits for its bounded outstanding response and closes any
returned room. If the response is lost, the UI reports the uncertainty rather
than claiming cleanup; server expiry remains the fallback. Polls are serialized,
stale responses cannot undo admission, and a failed poll requires an explicit
refresh instead of repeatedly consuming service limits.

Guest controls now accept a typed invitation or a fragment-based join link.
The fragment is removed from the address/history entry immediately; the guest
still explicitly asks to join. Pending, declined, expired, replaced, full and
closed-room states have clear messages. A canceled late successful join releases
its reserved slot; an admitted guest leaving closes the room for both players.
Host and guest reuse one role-checked membership lifecycle, and neither writes
solo records or settings. Share links contain the invitation only, not query
parameters, hosting codes or membership credentials.

These controls are not yet integrated into the game menu or a playable lobby.
To add their separate local preview to the existing diagnostic launcher:

```sh
npm run build:room-controls
# Start/restart only the local diagnostic backend using its existing launch command.
```

The launcher optionally mounts the generated `test-results/room-controls` files
at `/room-controls.html`. `ROOM_CONTROLS_DIR` can select a stable copy outside
test output directories. Use the separate local hosting code, never the TURN key.
The preview clearly labels its incomplete gameplay integration and does not
change solo records, settings, terrain or the approved aircraft formation.
Choose **Host** or **Join** in the preview. Both browser sessions must reach the
same local service; a `localhost` link does not by itself connect another computer.

The shared lobby model/panel now has host-only course selection, independent
assistance, graphics, mute and volume, and acknowledged participant readiness.
Course/assistance changes clear both ready flags; graphics/audio stay local.
Guest intents are bounded to one awaiting acknowledgement, unsent host state is
coalesced, and stale ready requests cannot approve a newer configuration.
Readiness starts disabled until the connection/loading owner explicitly permits
it. The UI-only fault harness verifies these rules with delay, loss and replay.

The same room preview now includes a **native lobby connection check**. After
admission, choose the intended connection mode in both windows and click
**CONNECT LOBBY** in each. Admission hides the host's now-unused invitation controls
and focuses **CONNECT LOBBY** in
both windows, bringing the next action into view without automatically connecting.
The peers compare real, portable fingerprints of client/shared source,
dependency/build inputs and actual local assets. They then verify the host's
manifest and both initial numeric course plans before enabling
ready. Terrain changes invalidate readiness and transfer a new verified course.
Mismatched builds are refused before course readiness. The diagnostic reports
only redacted connection information and bounded progress/failure codes.

To check the actual mounted lobby artifacts instead of injecting a fresh test
bundle, run the opt-in direct/UDP/TCP/TLS cases against the loopback preview:

```sh
TEST_URL=http://localhost:8080 \
ROOM_CONTROLS_URL=http://localhost:8080/room-controls.html \
LOW_PASS_LIVE_TURN=1 npx playwright test --project=chromium \
  tests/e2e/room-controls.spec.ts -g 'opt-in deployed lobby readiness' \
  --output /path/to/private-test-artifacts
```

This reads `.secret/hosting-code` internally, without printing it, and creates
four rooms (the configured per-source ten-minute allowance). Do not run another
rapid room-creation batch against the same service. Live traces stay disabled.

Direct Chromium and forced deployed UDP/TCP/TLS cases pass for this flow,
including both full Canyon plans. This remains a connection/course checkpoint,
**not game-asset prewarming, a match countdown, fair remote bomb release or a
playable multiplayer game**. Initial plan transfer takes roughly twenty seconds
at the current conservative pacing. Application probe peaks during the combined
authoring/loading relay checks reached about 0.48-0.52 seconds; these include
main-thread planning work and must not be mistaken for ICE RTT or a gameplay
latency guarantee. The isolated pacing measurements above cover a different phase.
The final mounted direct/UDP/TCP/TLS batch also passed both-plan verification
and shared readiness. Combined guest-side preflight peaks were approximately
582/542/540/539 ms respectively; no gameplay latency threshold is implied.

One readiness wait timed out during overlapping compilation/validation, before
detailed failure telemetry was retained. Isolated and concurrent follow-ups passed;
the original cause is not established. The browser check now gives negotiation
and course verification their own existing deadlines instead of combining both
under one loading wait. No simulation timing or readiness requirement was relaxed.
A later ordinary direct-connection diagnostic closed both peers before opening;
two isolated follow-ups and the complete eleven-case regression rerun passed.
Its cause is unresolved, not attributed to TURN.
Redacted diagnostic reports are now also written directly into test output files
so they survive runs using only the list reporter. Together with the earlier TCP
failure, this remains repeatability work for the actual-browser acceptance gate.

**Relay lifetime check:** the explicitly enabled TLS diagnostic stayed connected
for 21 minutes with its original peer generation, beyond both initial credential
expiries. It then fetched fresh credentials, recreated both peers in generation 2
within 15 seconds and transferred the same verified Canyon plan again. This was a
controlled reconstruction, not automatic game recovery or two-computer Edge
validation. The deployed behavior agrees with coturn's cached authenticated
session key: credential expiry limits new authentication, not the already-active
allocation. Do not force periodic ICE restarts solely because its REST timestamp
expires; obtain fresh credentials before creating replacement peers.

The long check is separate from ordinary tests and requires explicit opt-in:

```sh
LOW_PASS_LIVE_TURN=1 LOW_PASS_TURN_SOAK=1 npx playwright test \
  --project=chromium tests/e2e/connectivity.spec.ts -g 'long-lived TLS allocation' \
  --output /path/to/private-test-artifacts
```

For a two-computer Edge review, both computers must reach this same test service
using its configured origin. If they already have SSH access to the development
host, a loopback tunnel on each can preserve `http://localhost:8080` without opening
a public listener:

```sh
ssh -N -L 127.0.0.1:8080:127.0.0.1:8080 <existing-development-ssh-host>
```

Do not start that tunnel over an existing port forward or share SSH credentials.
Otherwise the operator must provide a suitable private/HTTPS test endpoint through
their infrastructure workflow. No deployment or publication is performed here.

### Timestamped release authority (not yet wired to network gameplay)

The host simulation now optionally accepts a release at its actual displayed
plan time and replays only that bomb through the same fixed-step ground/water
physics. Both roles use the same fractional-tick command convention. The ordinary
local simulation keeps its zero-grace default; flight paths and scoring windows
are unchanged.

The provisional network allowance is 750 ms, above the observed roughly 582 ms
combined preflight stalls, with a hard one-second simulation cap. This is an
initial development bound, not an accepted Internet latency guarantee. Late
commands must still name a time inside the original acquisition/cutoff window.
Timeout misses wait until the first physics boundary after cutoff plus allowance;
an expired command cannot undo a finalized result or saved elimination.
Replay retains canonical contact/result times and historical elimination poses.

`ReleaseAuthority` validates identity, role, epoch, plan and input sequence,
remembers bounded duplicate decisions, and identifies the accepted core release
event. The publishing controller must map that event to its actual wire event
sequence before sending an accepted acknowledgement. Pause freezes simulation
while already-issued inputs settle for the bounded monotonic-wall-clock interval;
resume requires a sealed new epoch. Clock anchors preserve fractional times and
exclude paused elapsed time.

Coverage includes both slots at passes 1, 13 and 15 in all terrains, delays through
750 ms, sub-millisecond release offsets, exact cutoff boundaries, completed-bomb
replay, third-miss finality, duplicate traffic and different peer clocks. These
are simulation/fault-harness results, not yet a playable native multiplayer match.

### Guest replication (not yet wired to network gameplay)

`GuestReplica` now applies verified plans, ordered reliable outcomes and complete
snapshots without generating its own course or scoring results. Snapshots carry
exact bomb integration steps, retained outcomes and monotonic input/result
watermarks. Cross-channel arrivals wait for their event and payload dependencies;
verified checkpoints can close a gap without resurrecting an eliminated player.
Plan publication requires the guest's exact hash acknowledgement before commit.

Logical outcomes and presentation snapshots are separate: an incomplete group of
combat/result events cannot become a partially updated render state. Up to 32
complete snapshots support delayed presentation, pinning their plan/effect data
until retirement. Equal-time snapshots replace one another. Verified staging,
pending controls and payload bytes remain bounded; exhaustion is an explicit
resynchronization/error condition, not silent loss of outcomes.

Peer-clock probes estimate an offset interval, including asymmetric latency,
drift and timestamp uncertainty. The provisional display clock uses a 50 ms
delay, at most 1% correction, a 100 ms resync threshold, and 500 ms freshness/
extrapolation limits. It never rewinds or advances beyond committed coverage.
These are development bounds, not latency guarantees. Application controllers,
native match startup, rendering, speculative drops, finale timing and automatic
recovery still need integration; the running lobby preview is unchanged.

Combat transfers can reference the exact verified flight tracks instead of
resending their knots. In the first three passes, complete damage/finale payloads
were about 62-64 KB; referenced payloads were 1.1-1.2 KB, each in one chunk.
All-terrain, both-slot handoffs through pass 15 preserve exact numeric data
without quantization or rerunning missile selection. Missing dependencies block
application; expanded data still counts against the cache's byte budget.
Recovery publication must retain the original formation dependencies of frozen
finales, even after those formations leave the active course.

`SessionJournal` owns the host event drain and maps accepted release IDs to
their actual reliable wire event numbers, including extra combat events. It
holds each outcome group until its effect is acknowledged and only snapshots
fully sent groups. Bounded accepted-input metadata survives rejected-command
traffic without losing a release or issuing a contradictory retry decision.
Transport backpressure does not advance publication watermarks. Controllers must
still own the transport, initial handshake, transfer scheduling and plan retirement;
this journal alone does not start a network match.

Native peers now support host-authorized game-epoch barriers on the existing
connection, independently of ICE/signaling generations. Only a successful
barrier send advances the host epoch. The guest buffers at most one next-epoch
snapshot, ping and pong until that barrier arrives; obsolete traffic is discarded
and counted rather than closing a healthy connection. Application decoding remains
strict. This is the transport prerequisite for startup/pause/recovery, not the
completed shared-pause or reconnect workflow.

An optional lobby handoff now transfers exclusive ownership of the existing
connection, unread messages, original host scheduler and hash-verified guest
plans to a match controller. It does not reroll the course or start the clock.
The controller must revalidate readiness and complete loading/countdown; a late
unready intent is preserved. The connection-check preview does not install that
handoff and therefore retains its existing behavior.

The startup handshake now acknowledges matching loaded/readiness revisions and
a provisional three-second countdown before the host advances the game epoch.
Late confirmations, send pressure or a missed start deadline cancel that attempt
rather than silently launching late. Losing readiness just as the barrier arrives
requires an immediate shared pause. The clock can anchor to the acknowledged
start time without counting the loading/countdown interval as gameplay.
Native-browser startup is exercised separately and by the opt-in application
preview below. The normal solo menu does not start this handshake.

`replicaWorldFrame` now builds the shared renderer input from complete snapshots
and verified tracks/cameras. It advances active bombs from their exact canonical
step checkpoints within the bounded presentation window, without awarding scores
or inventing impacts/wrecks. Paused frames cannot advance; eliminated aircraft
require explicit frozen combat presentation. The all-terrain scene fixture
compares host and guest aircraft, bombs, cameras and resource counts. This is
renderer integration, not a playable native network match.

The lifecycle-owned `MatchController`, `HostGame` and `GuestGame` connect
prepared lobby ownership, acknowledged countdown, reliable initial checkpoints,
rolling plan publication, release settlement and complete guest presentation.
Native Chromium fixtures run Valley and Canyon matches through both finales.
Those controller fixtures supply prepared camera views rather than a live
WebGL application. The application preview below adds real scene coverage;
shared resume/recovery and separate multiplayer persistence are connected.
This is not the two-computer Edge gameplay review checkpoint.

Rolling course selection and transfer encoding run in a bounded dedicated Web
Worker. Imported tracks and camera samples preserve the authored numbers; the
main thread never reruns candidate selection during a handoff. An unavailable
worker, missing acknowledged coverage or lost clock synchronization explicitly
holds the match rather than silently skipping simulation time.

### Local multiplayer application preview

`npm run build:multiplayer-preview` adds **`/multiplayer.html`** to the normal
build. Serve that build with the existing, privately configured local Node room
service. This command does not provision credentials, configure coturn, start a
server, or deploy anything. Do not publish this development entry. A subsequent
ordinary `npm run build` removes it; `/` has no multiplayer menu action.

The preview reuses the actual application canvas, room/admission panels and
lobby. Both players select ready, load both aircraft/terrain/effects, and complete
the acknowledged countdown. The host authors the course and outcomes; the guest
renders verified numeric plans. Both players have equally sized scores,
cumulative misses, damage/result indicators and sticky assisted labels. The HUD
and scene share an owned presentation snapshot, so an asynchronously advancing
host cannot show an outcome ahead of its drawn aircraft/effects. Your identity,
viewed aircraft, survivor spectating and release/bomb state are explicit.
After your own finale the camera follows the survivor without changing their
slot or flight path. Eliminated players cannot release bombs; both retain pause
and readiness controls. An eliminated host must keep its tab open because it
still runs the shared simulation. Once both players are out, the HUD identifies
the remaining finale rather than calling a destroyed aircraft a survivor.
Lobby-selected assistance uses canonical first ground/water contact from your
drawn pose and a projected overlay; it is hidden after release, while held and
when spectating. Water never receives an on-target indicator.
Space records the **actually drawn** flight time, not a newer controller frame.
Local release immediately removes the carried bomb and draws one speculative
trajectory, including while host work or the remote acknowledgement is pending.
It uses the same fixed-step physics and first contact as the host. Contact only
hides that speculative bomb: scores, wrecks, splashes and combat effects still
require authoritative results. Accepted state replaces the prediction; rejection
removes it, shows the reason and permits a fresh keypress if the attempt remains
legal. Key repeat never creates another drop.
Survivor and finale frames use the existing combat timeline. Leave restores the
solo menu and rendering loop without writing or clearing solo records/settings.

The lobby retains a static image while signaling and UI processing continue.
Scene prewarming draws otherwise hidden shader variants before readiness and
restores their enabled states, including on cancellation. Resizing or changing
local graphics redraws a static scene without advancing gameplay. Gameplay pumping is
independent of frame submission. A callback gap within the existing 500 ms
freshness bound is advanced in at most five 100 ms work steps; snapshots are
timestamped at the simulation state they represent, not at the end of catch-up.
Longer gaps and publication/coverage failures request a shared pause. These are safety
bounds, not a promise that a software renderer or any particular GPU can meet them.

Either player can pause with Escape or the pause button. Focus loss and viewport
changes also stop local input and request a shared pause. The host freezes its
simulation, settles already-received releases for 750 ms, publishes the remaining
outcomes, and then transfers a verified paused checkpoint in a new epoch. Both
players must explicitly confirm readiness before an acknowledged three-second
countdown; canceling readiness or losing focus cancels it. Paused wall time does
not advance bombs or finales, and held Space does not carry into resumed play.
An ahead-rendered guest can rewind only at the explicit checkpoint boundary.

Both viewports must remain within the approved 0.75-2 aspect envelope. Combat
authoring uses each aircraft's real camera pose at the narrowest supported aspect,
so the host's wider window cannot hide a guest missile launch. Resizing requires
fresh readiness; unsupported sizes disable it until corrected.

**Incomplete:** unrecoverable errors still require leaving the preview. In-flight assistance changes,
audio, results/records screens and rematch UI are subsequent steps.
This is not the full two-computer Windows Edge review checkpoint.

Confirmed eliminations are saved immediately, before their visual finales, under
`low-pass.multiplayer-records.v1`. Each browser keeps up to ten completed individual
scores and ten recent match summaries, including terrain/build/rules identity,
assistance and the opponent's known status. Pause/recovery cannot duplicate them.
An interrupted match keeps already-completed scores, but has no winner and never
adds an unfinished survivor score to the leaderboard. Reload marks a previously
active saved summary incomplete; it does not recover gameplay. Invalid stored
bytes are not overwritten, and storage failures warn while retaining session data.
The solo key and settings are never changed by this store. There is no account
synchronization or guarantee of recovering a final result that a peer never received.

A signaling-only interruption no longer destroys a healthy peer connection.
The existing flight continues with a degraded-service warning while the same
in-memory membership reconnects, within one fixed 15-second deadline. The native
game channel is not replaced by this path. Expired or changed membership fails
explicitly, without extending the deadline by starting another recovery cycle.

A failed or stale game connection freezes flight and attempts replacement using
the same in-memory room membership and refreshed ICE configuration. One fixed
15-second deadline includes credentials, retries, negotiation and restoration.
The host preserves its journal, plans, scores and bombs; it settles already
received releases within the existing 750 ms window, not the recovery deadline.
A fresh native link adopts the host's newer authority epoch, exchanges verified
cache references and restores an acknowledged paused checkpoint. Both players
must explicitly become ready again. Unconfirmed drops are reported rather than
invented. Expiry closes the candidate connection; leaving aborts credential work
and disposes late arrivals. There is no host migration or page-reload recovery.

Native Chromium matches exercise host-only, guest-only and simultaneous
replacement, then recovery while spectating and during the ended finale.
The real-canvas Valley application also exercises the reconnect card and dual
readiness. These are local direct-path checks, not full-game relay or Edge acceptance.

The application browser cases use two isolated browser processes, Low graphics
and a reduced test-only device scale for software-rendered CI. A complete Canyon
match through both finales has passed, but other runs at both higher and reduced
pixel counts hit clock/publication holds. These intermittent failures remain
unresolved; smaller test pixels are not a performance fix or Edge acceptance.
The ordinary build can
run the tests without publishing the preview HTML: the test proxy serves the
real application HTML at that path only for its two local clients.

### Local formation preview (not networked)

The test-only two-aircraft preview exercises both real flight paths, cameras,
bombs and independent scores. It does not save records or implement rooms,
missile damage, elimination or a complete multiplayer match. All formation
spacing and presentation are recorded in the user-approved G1 profile v1.
Following-distance changes can be considered later; no cosmetic cue is added.

Build its separate artifacts and the normal application image:

```sh
npm run build:formation-preview
docker build -t low-pass:formation-preview .
```

After stopping your existing local preview if it occupies port 8080, run:

```sh
docker run --rm --name low-pass-formation-preview -p 8080:8080 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true --stop-timeout 45 \
  -e LOW_PASS_MULTIPLAYER_ENABLED=false \
  --mount "type=bind,src=$PWD/test-results/formation-preview/formation-preview.html,dst=/opt/low-pass/dist/formation-preview.html,readonly" \
  --mount "type=bind,src=$PWD/test-results/formation-preview/formation-preview.js,dst=/opt/low-pass/dist/formation-preview.js,readonly" \
  low-pass:formation-preview
```

Open `http://localhost:8080/formation-preview.html`. Choose a course and pass,
then **Build course**. Earlier passes are planned sequentially, including for
cap-speed previews. Select **Follower**, **Lead approach**, then **Play** to
watch the lead release; use **Replay**, either camera, and **Both results** to
inspect the paths and independent scores. Uncheck scripted drops to use Space
after clicking the canvas. Try passes 1 and 14 in each course.

The prototype canvas supports aspect ratios 0.75-2.0; unsupported sizes pause
explicitly. The side panel reduces canvas width. The preview checks geometric
visibility, but the cap-speed bomb remains very small. The user reviewed this
presentation and approved keeping it unchanged. This is user acceptance, not
a universal readability guarantee. See the
[research measurements](docs/two-player-multiplayer-research.md#local-formation-measurements-and-g1-approval).

Neither the normal build nor the normal application image contains this fixture.
Keep these two files as local read-only mounts, not production assets. Playwright
clears `test-results`; rebuild the artifacts after testing and recreate the local
preview container when updating them. To test an already mounted preview:

```sh
TEST_URL=http://127.0.0.1:8080 \
FORMATION_PREVIEW_URL=http://127.0.0.1:8080/formation-preview.html \
npx playwright test --project=chromium tests/e2e/formation-preview.spec.ts
```

### Local combat preview (not networked)

The separate combat fixture adds independent damage, missiles, destruction and
survivor spectating to the approved formation. It has no networking, audio or
saved records and is excluded from normal application builds.

```sh
npm run build:combat-preview
docker build -t low-pass:combat-preview .
```

After stopping only your existing local preview if it occupies port 8080:

```sh
docker run --rm --name low-pass-combat-preview -p 8080:8080 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges:true --stop-timeout 45 \
  -e LOW_PASS_MULTIPLAYER_ENABLED=false \
  --mount "type=bind,src=$PWD/test-results/combat-preview/combat-preview.html,dst=/opt/low-pass/dist/combat-preview.html,readonly" \
  --mount "type=bind,src=$PWD/test-results/combat-preview/combat-preview.js,dst=/opt/low-pass/dist/combat-preview.js,readonly" \
  low-pass:combat-preview
```

Open `http://localhost:8080/combat-preview.html`. Select a course and scenario,
then **Build course** and **Play**. **Local pilot** selects either view; a destroyed
pilot automatically spectates the survivor. **Next pass / finish** skips ahead;
**Step 1 second** advances a paused view explicitly. Earlier passes are scripted
hits when starting above pass 1. For manual releases, choose **Manual drops**,
play and click the canvas before pressing Space. Assistance belongs only to the
selected pilot. Pause/focus loss also freezes the final destruction sequence.

Review both death orders, both views, passes 1 and 14, and the **Early lead misses /
smoke crossing** scenario. Judge smoke/explosion obstruction, target and bomb
readability, and the spectator camera switch. Spacing remains G1-approved v1.
The supported canvas aspect range is 0.75-2.0; unsupported sizes explicitly pause.

As with the formation fixture, rebuild artifacts after Playwright clears
`test-results` and recreate the container to refresh individual file mounts.
To exercise the actual mounted fixture rather than injecting current source:

```sh
TEST_URL=http://127.0.0.1:8080 COMBAT_PREVIEW_MOUNTED=1 \
npx playwright test --project=chromium tests/e2e/combat-preview.spec.ts
```

## Controls and rules

| Control | Action |
| --- | --- |
| Space | Release the single bomb during BOMB READY |
| Escape | Pause/resume |
| A | Toggle the predicted-impact marker |
| Menu controls | Terrain, graphics quality, sound, volume, records, credits |

### Terrain choice

Open **Flight Settings > Terrain** before starting a flight:

- **Green Valley** (default) keeps the original green hills, pines, and exposed rock.
- **Desert** uses warm sand, procedural wind ripples and dune-like shading, sparse
  sandstone rocks, and warm lighting. No extra assets are downloaded.
- **River Canyon** follows a much narrower green rocky gorge, with steep sides,
  flowing water, broad sweeping turns, occasional tighter S-bends, and dry flat
  target shelves on either bank. The pilot slows smoothly for tighter bends and
  accelerates for readable attacks. You still control only bomb release.

The menu previews your choice immediately and remembers it for future visits.
Terrain is fixed during a flight, including pauses and the final missile sequence;
choose again on the results screen or after ending a run and returning to the menu.
Graphics and audio settings remain adjustable while paused.

Green Valley and Desert use **identical ground geometry, collision, flight paths,
difficulty, and scoring**. Desert dunes are a surface-shading effect, not newly
raised terrain. River Canyon has its own ground/collision and flight course, but
keeps the same speed ceiling progression (350 on pass 13), target size, and scoring.
In the canyon, the ceiling, speed display, and engine sound use full 3D speed,
including dives, climbs, and jinks. Tight bends are transit sections, not blind
attack passes. Early dives take longer to respect the full-speed ceiling.
The entire target stays on dry ground. Bombs stop at their first contact with
water, bank, or wall; a river hit is one miss with a splash, not a crater.
Water animation and splashes freeze on pause. There are no aircraft crashes,
waterfalls, water physics, or additional lives.
Existing scores and settings are preserved, and all three terrains share the same top-10
leaderboard. Older saved settings default to Green Valley; an invalid terrain
choice produces a warning without discarding otherwise-valid saved records.

The aircraft automatically descends when a target becomes visible. Its bomb
inherits its movement and falls under arcade gravity. The marker forecasts that
same trajectory. Its outlined HUD reticle remains visible through the aircraft,
including when the ground circle lines up behind the fuselage. Land inside the
concentric rings to score 1-100 points based on
distance from the center. Landing outside, or not dropping before the pass ends,
adds a miss. **Three cumulative misses end the run.** Hits do not erase misses.

Speed now rises from 76 to **350**, reaching the cap on **pass 13** rather than
topping out at 142 on pass 25. Left/right jinking also increases more quickly.
Dive timing and acquisition distance adapt to the faster passes while preserving
achievable release windows.

Each new pass carries forward the current position, velocity, and acceleration
instead of resetting the heading or bank. Smooth motion curves join the next
route and start each dive from the aircraft's then-current motion; rendered
attitude is interpolated between simulation steps.

Each encounter independently chooses a **tank**, **radar station**, or **SAM
launcher**, with an equal chance of each; consecutive repeats are allowed.
The choice stays fixed for that encounter in every terrain. These original
models occupy the target center and become damaged wrecks after a successful hit.
The radar has an equipment shelter and raised dish; the wheeled launcher carries
elevated launch tubes. Both are static visual models, not active weapons systems.
The same ground-impact accuracy formula applies to every type, with no separate
armor, collision rules, or target-specific bonuses.

Successful hits occasionally prompt a surface-to-air missile flyby that misses
the aircraft. These off-site missiles are independent of the visible target type;
the model launcher does not fire, and hitting radar does not suppress missiles.
In River Canyon, all missiles rise visibly from low dry banks beside the river,
not from the canyon rim or water. Damage and final strikes approach from below;
harmless flybys can pass slightly above the aircraft after rising from the bank.
Their paths follow the winding gorge without changing interception timing.
The first two misses each cause a survivable missile hit: an impact
flash, damage status, and persistent aircraft smoke, heavier after the second hit.
Smoke uses soft, irregular alpha-blended clouds with varied sizes and slow rolling
motion, expanding and fading behind the aircraft rather than showing square sprites.
Flight and bomb controls continue normally, and later successful hits do not
repair the damage. On the third miss, a final missile intercepts the moving aircraft,
followed by a fireball, smoke, and falling debris before the results screen.
Flybys cannot cost a life; the **three-miss rule remains unchanged**. The score is
saved when the third miss occurs, before the finale, and restarting restores the
aircraft and clears all damage, smoke, and missile/explosion effects. This is fictional arcade
choreography, not a flight or weapons simulation.

Tab switching or focus loss pauses both play and the missile finale. End Run abandons a paused active run without
adding a completed score. The top 10 completed runs and settings are saved to
`localStorage`, under `low-pass.records.v1`. Any use of aim assistance during a run
marks that record assisted. Data belongs to this browser profile and origin, is
not shared with other users, and is lost when site data is cleared. Storage failures
show a warning and retain only session data.

## Docker

The current game is single-player. The
[two-player multiplayer research outline](docs/two-player-multiplayer-research.md)
documents the proposed peer-to-peer architecture, confirmed gameplay rules,
self-hosted infrastructure, and implementation/acceptance plan; it is not an
implemented feature.

```sh
docker compose up --build
```

Open <http://localhost:8080>. `docker compose down` stops this deployment.
The multi-stage image runs one unprivileged Node 24 process as PID 1, serving
assets with Express 5 and compression. There is no Nginx, s6 or internal proxy.
Multiplayer is still disabled. It needs no GPU, database, secrets, or persistent
server volume. The client performs all rendering, simulation, and audio.
Invalid multiplayer configuration does not stop asset serving. A Node crash does:
new requests fail until Docker restarts the process, but fully loaded solo play
continues in the browser. A merely unhealthy process is not automatically
restarted by Docker's restart policy.

The runtime listens on port 8080 and exposes `/healthz`. A hosting reverse proxy
should terminate HTTPS. Keep a stable public origin to retain users' local scores.
Only content-hashed JS/CSS gets immutable caching; HTML and unversioned assets
revalidate. Missing assets return 404, not an HTML fallback. All runtime assets and
dependency notices ship in the image; no external asset CDN is used.

Keep the read-only root, writable `/tmp` tmpfs (which may remain `noexec`),
dropped capabilities and no-new-privileges setting. Allow **45 seconds** for
container shutdown. The image still runs as UID/GID `101:101`. Its entrypoint
executes Node directly; do not override its command. Static assets live under
`/opt/low-pass/dist`, separate from server code and production dependencies.
`/api/multiplayer/readyz` checks optional-feature configuration separately from
application `/healthz`; it does not indicate that multiplayer is playable.
Both image dependency installs enforce `min-release-age=7`; user `.npmrc` files
are not copied into the image.

See the [G0 container handoff](docs/application-container-checkpoint.md) for
the exact configuration contract, local checks, Ansible-owned deployment
validation, architecture limitation and rollback.
The user reports coturn deployed at `turn.low-pass.biggsea.us`, using independently
developed code in the separate Ansible repository. That repository owns relay
deployment; this repository retains only the
[game-side TURN integration requirements](docs/two-player-multiplayer-research.md#122-turn-connection-contract).
The current game does not issue TURN credentials.
No branch image has been published or deployed by this implementation.

### Published container

Pushes to `main` (or a manual run on `main`) trigger
[Publish container](.github/workflows/container.yml). It builds a **linux/amd64**
image and publishes `ghcr.io/adrianba/low-pass:latest` plus an immutable-by-convention
`sha-<full-commit-SHA>` tag. The workflow uses the repository's `GITHUB_TOKEN`
with `contents: read` and `packages: write`; no personal access token is required.
An OCI source label links the image to this repository.

```sh
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges:true --stop-timeout 45 \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/adrianba/low-pass:latest
```

GHCR package visibility is configured separately from repository visibility.
Private packages require `docker login ghcr.io`; set the package to public in
its GitHub package settings to allow anonymous pulls.

Actions are pinned to the immutable commits of the latest releases verified on
2026-09-12: checkout v7.0.1, setup-buildx v4.3.0, login v4.6.0, and build-push
v7.3.0. Recheck upstream releases when updating those pins.

## Development and validation

```sh
npm test
npm run lint
npm run assets:verify
npm run build
npm run build:server
npx playwright install chromium
npm run test:e2e -- --project=chromium
```

For the isolated container lifecycle/HTTP checks (Docker required):

```sh
docker build -t low-pass:node-g0 .
npm run test:container
```

These tests create uniquely named local containers and remove them afterward;
they do not use or replace a running deployment. `LOW_PASS_TEST_IMAGE` selects a
different already-built image. They are deliberately separate from `npm test`,
so ordinary unit tests and browser builds do not require Docker.

To validate actual Microsoft Edge, use a Windows host with the latest stable Edge:

```sh
npm ci
npm run build
npm run test:e2e -- --project=edge
```

If Edge is absent, Playwright offers `npx playwright install msedge`, but it can
modify the system browser installation. Install only on an approved test host.
To run against an existing Docker deployment, set `TEST_URL` to its HTTP origin
when launching Playwright (PowerShell: `$env:TEST_URL="http://localhost:8080"`).

Automated tests cover score boundaries, ballistics/predictor equivalence, terrain
collision, seed/difficulty fairness, key gating, cumulative misses, persistence,
browser keyboard play, the visible impact reticle, missile interception/flyby
clearance, survivable damage/smoke, randomized target selection and model resets,
motion continuity, explosion cleanup, pausing
the finale, restarting, and essential asset
failures. E2E tests use the
Low preset and a smaller viewport to accommodate software-rendered CI; that is
**not** a 1080p performance benchmark.

The user has confirmed the initial game works well in Microsoft Edge. Repeat
Edge checks after gameplay/rendering changes on a real Windows machine. Record Edge version, OS, GPU/driver, resolution, quality,
median/tail frame times, and sustained-run behavior. The intended 60 FPS at 1080p
is hardware-dependent and is not guaranteed on an unknown GPU. Local Chromium
results do not establish Windows Edge acceptance.

## Assets

`art/kestrel.blend` is the editable original aircraft; `scripts/build-aircraft.py`
generates it and the runtime aircraft/bomb GLBs. The aircraft uses 6,808 triangles
and six materials. This original model avoids uncertain third-party aircraft
provenance. Small panel seams are modeled; no real service insignia are included.

Use **uv** for Python tooling. The asset command targets `/usr/bin/python3`,
matching the system Python 3.13 used by Debian's Blender 4.3 package here.
Install Blender, then run:

```sh
npm run assets:aircraft
```

For another platform or Blender distribution, select its compatible interpreter
explicitly rather than replacing Blender's standard library with a standalone
Python build. The expanded command used here is:

```sh
uv run --no-project --python /usr/bin/python3 --with numpy python scripts/export-aircraft.py
```

The launcher supplies uv's isolated NumPy environment to a factory-startup Blender
session and fails on export errors. Saved file-browser paths are made relative
to avoid embedding local home directories in the editable model.
Draco is not enabled or required; Debian Blender may print a
missing optional Draco-library notice while successfully exporting plain GLBs.

To reproduce texture optimization from the source archives linked in the manifest:

```sh
uv run scripts/optimize-textures.py /path/to/Ground037_1K-JPG.zip /path/to/Rock030_1K-JPG.zip
```

Terrain maps are freely redistributable **CC0** ambientCG Ground037 and Rock030
assets. Source URLs, creator, license, modifications, sizes, and SHA-256 checksums
are in `public/assets/manifest.json`; notices are in `public/assets/credits.txt`.
Sound, target artwork, tank/radar/SAM and missile models, procedural desert sand shading, environment lighting, and scenery
generation are original. Target models are generated locally by
`src/rendering/target-vehicle.ts`, `target-radar.ts`, and `target-sam.ts`;
`src/rendering/combat-effects.ts` generates the flying missiles and their effects.
The canyon landform, water shading, and splash geometry are original, generated
by `src/terrain/canyon-route.ts`, `src/terrain/river-canyon.ts`, and
`src/rendering/river.ts`; cliff shading reuses
the existing CC0 terrain maps without additional downloads.
The current soundscape is synthesized rather than downloaded recordings.

After intentionally regenerating/replacing approved assets:

```sh
node scripts/verify-assets.mjs --write
npm run assets:verify
```

Do not use `--write` to mask unexplained checksum changes. Preserve provenance
and check licensing before adding third-party files. Builds include Babylon.js
Apache-2.0 notices in `dist/licenses/`.

## Architecture

- `game/`: encounter planning, run state, scoring lifecycle.
- `simulation/`: engine-independent math and fixed-step ballistic prediction.
- `terrain/`: deterministic canonical triangulated surface for visuals/collision.
- `rendering/`: Babylon scene, PBR terrain blending, chunk streaming, instanced
  trees/rocks, chase camera, aircraft, targets, effects, local origin rebasing.
- `audio/`: gesture-unlocked Web Audio synthesis and voice management.
- `storage/`: validated, versioned local records with explicit failure warnings.
- `ui/`, `input/`: keyboard-accessible menus, instruments, release-key gating.

Gameplay constants and capped difficulty are in `src/config/game.ts`. Terrain
IDs and labels are in `src/config/terrain.ts`; rendering palettes and prop
selection are in `src/rendering/terrain-style.ts`. The desert PBR shader lives in
`src/rendering/desert-material.ts`, uses bounded periodic world coordinates to
stay stable across chunks/origin rebasing, and filters distant ripple detail.
Terrain materials and reflection textures are cached per scene and disposed
with it. Green Valley and River Canyon share the loaded grass/rock textures.
`src/terrain/surface.ts` owns the canonical triangle sampling and first ground/
water contact. Each Run owns a fixed surface; previews use a separate Run so
switching terrain cannot modify an active/completed flight or its saved score.
`src/game/canyon-flight.ts` joins safe shelf attack routes with the current full
motion state. Shelves exist before encounters and never move beneath bombs.
`src/terrain/canyon-route.ts` defines indexed, C2-continuous sweeping turns, local
route frames, normal-distance projection, arc-distance queries and inverses.
Banks and shelves retain their perpendicular width around corners. The tuned
route reaches approximately +/-29 degrees of heading, with turn radii down to
580 units; no hairpins or doubling back. Broader attack stretches alternate with
transit turns, and lower tiers can also use gentle bend exits.
`src/simulation/pose.ts` owns the shared pose, aircraft-local transforms, bomb
launch and render interpolation helpers; `game/run.ts` retains compatibility
exports while callers migrate. The helpers do not depend on the solo controller.
`src/rendering/aircraft-view.ts` instances the cached aircraft/bomb assets with
independent transforms and visibility. Views own their cloned nodes and shadow
registrations, while the scene owns the shared immutable geometry/materials.
Solo uses the same view; additional players do not require duplicate downloads.
`World.updateFrame` consumes an owned, deeply frozen render snapshot rather than
reading simulation state. The solo adapter preserves target identity, predicted
contact, result deduplication and acquisition rules. Existing solo combat effects
remain behind explicit hooks until independent combat timelines are introduced.
`src/simulation/flight-track.ts` separates path geometry from real traversal time.
It anticipates bends, limits acceleration, joins full motion with quintic curves,
and bounds the entire interpolated velocity curve using Bezier control hulls.
`toData()` / `fromData()` preserve the authored knots without rerunning planning.
The versioned format owns deeply frozen copies, caps tracks at 2,048 knots and
one hour, and rejects nonfinite/degenerate motion data. Consumers must still
check required coverage, whole-curve speed and terrain/camera safety for the
specific encounter; structural validation alone does not establish a fair path.
The opt-in `ChaseTimeline` precomputes world-space camera motion at the physics
step and interpolates it without render-frame history. Its acquisition checks
require an explicit viewport envelope and visibility margin; actual-view checks
report resize, camera mismatch or hidden-ring failures for later multiplayer
pause/revalidation wiring. Solo keeps its existing camera behavior. A test-only
WebGL fixture checks authored views against Babylon projection after rebasing.
The 350 ceiling applies to the actual 3D vector, not just forward velocity.
Release remains at planned time zero; acquisition, dive, cutoff and recovery have
explicit per-encounter times. HUD and audio use the same speed definition.
The bounded `canyonShelves` / `canyonCandidate` boundary separates shelf selection
from solving a specific approach. A phase offset can request distinct real
release motion to the same canonical shelf; rejected candidates carry explicit
reasons. Solo retains its original candidate order and zero-offset trajectory.
This primitive alone does not establish a synchronized or fair two-player course.
The opt-in Valley/Desert formation planner selects one target, solves a distinct
follower intercept, and authors both continuous tracks on a shared clock.
`FormationTrack` retains authored Valley attitude alongside the existing quintic
motion format; both host and imported plans must use this evaluator. Lag, path
candidates, viewport bounds and timing-adjustment allowance remain explicit
planner inputs. `src/config/multiplayer.ts` records the approved profile v1;
`planFormation` and `initialFormationPoses` apply it consistently for host-side
authoring and the local preview. Solo does not use the paired planner.
The paired Canyon planner solves both pilots against one shelf, reconciles their
entries on a shared clock, and checks whole-quintic full-3D speed and conservative
aircraft clearance through the future continuation. It retains native track
knots and acceleration-derived attitude. Bounded candidate rejection includes
complete-ring acquisition and the follower's geometric view of the lead drop;
the user approved the current on-screen presentation at G1. Damaged-view smoke
and simultaneous combat-effect obstruction still require their later effects
checks; this approval does not bypass them.
Canyon missile curves expose owned, versioned numeric data through
`CanyonMissilePlan.toData()` / `fromData()`. Import evaluates the host-selected
route-normal curve without choosing another launch site or querying terrain.
Structural validation bounds data but does not replace the author's original
launch, visibility and full-body clearance checks. This is a prerequisite for
shared combat plans, not completed effect replication.
Gradual shelf transitions leave clear sightlines to the entire scoring target.
The planner and renderer share chase-camera visibility rules, with a pre-dive
timing margin and bounded selection of a suitable upcoming shelf. The fairness
guard remains enabled; hidden targets are not accepted as playable approaches.
Canyon uses an 8-unit canonical grid (the original course retains 16); quality
settings do not alter collision. Water meshes clip the same ground triangles at
the water level. Flow uses unwrapped local route coordinates with a per-chunk
periodic offset, so ripples follow bends without UV-wrap or origin-rebase seams.
The camera trails and looks ahead along route distance. Terrain and river chunks
follow sampled route bounds rather than fixed world-x columns; the measured
Low/High turn fixtures retain fewer than 100 terrain and 32 visible water meshes.
Canonical height caching is bounded at 80,000 vertices with FIFO eviction.
Missile launches use the selected surface; the canyon finale follows a safe
curved continuation without resuming the ended game.
Custom terrain/water shader plugins use distinct cache identities, including a
separate canyon variant, so prewarming or switching themes cannot substitute the
wrong shader on a cliff face.
Fixed-seed release-window regressions compare every difficulty tier with the
original course. The winding/full-3D-speed revision measures approximately
0.73 seconds on pass 1 to 0.16 seconds on pass 13, within 15% of the earlier canyon
sample (0.67 to 0.14 seconds). Scoring and target radius have not changed.
The sequential corpus checks all tiers, narrow/wide viewports, slow/irregular
frames, both banks, safe camera clearance, and actual nominal center hits.
These are simulation timing measurements, not rendering-performance guarantees.
`src/game/targets.ts` defines target kinds and seeded selection; `planEncounter`
stores the choice once, separately from flight randomness.
`src/rendering/target-model.ts` keeps one cached model per kind and enables only
the active encounter's model, resetting damage at each new pass and restart.
The rendering quality presets alter resolution, shadow size, vegetation density, and
view distance, not the simulation or target collision surface. Terrain currently
keeps a fixed canonical mesh resolution, with bounded streaming rather than
different geometric LODs. The broad, winding open valley ensures release-only
control remains fair; adjacent hills supply visual variation.
