# Two-player multiplayer: research and implementation outline

Research date: 2026-09-13.

Status: proposed implementation architecture, based on repository inspection,
technical references, and the product decisions confirmed below. No multiplayer
code or infrastructure has been implemented as part of this research. Proposed
budgets and prototype gates are not measured performance results.

**Implementation checkpoint:** the implementation branch now contains solo
regression fixtures and an optional, explicitly disabled Node HTTP runtime.
The Node-only serving checkpoint, replacing the unshipped Nginx/s6 approach, is documented in
[G0: application container checkpoint](application-container-checkpoint.md).
The user confirmed the Node-only application deployed and working on 2026-09-20,
satisfying G0. Subsequent local branch work adds shared pose helpers, serialized
flight tracks, authored chase timelines, independent aircraft/bomb views and a
frozen render-frame boundary with a solo adapter. These are multiplayer
foundations, not playable multiplayer. The user approved the formation preview
unchanged on 2026-09-20 (G1); real Edge networking and the complete game retain
their later gates. On 2026-09-20 the user
reported coturn deployed at `turn.low-pass.biggsea.us` using independently developed
Ansible code. Relay deployment instructions/examples have been removed here;
the remaining TURN material describes application integration and acceptance only.
The operator confirmed `use-auth-secret` and `static-auth-secret`; actual TURN
allocation and forced-relay connectivity have not yet been verified.

### Local formation measurements and G1 approval

Both opt-in paired planners are implemented on the local branch. The user
reviewed the preview and approved the current spacing and presentation:
"this is good as is" and "i like it this way". These demonstrated parameters are
now recorded as **formation profile v1** in `src/config/multiplayer.ts`.
Possible following-distance tweaks are deferred, not required before continuing.

| Prototype | Demonstration inputs | Measured course coverage |
| --- | --- | --- |
| Green Valley / Desert | Requested lag 1.5 s, at most 0.1 s additional lag, follower jink phase +0.35 radians | Three seeds, 15 sequential passes each; every difficulty tier and passes beyond the cap. The two themes use identical physics. |
| River Canyon | Lag 1.2 s, candidate phases +0.12 / -0.12 radians, entry extension at most 3 s | Two seeds, 28 sequential passes each; both shelf banks, every tier and extended cap-speed flight. |

The measured prototype viewport envelope is aspect 0.75-2.0, with a 0.1-second
complete-ring acquisition margin. Canyon also checks the projected lead-aircraft
bounds and departing bomb from 0.1 seconds before to 0.2 seconds after release,
using a 2% screen inset and canonical terrain occlusion. Geometric visibility
does **not** prove that a small bomb is readable in the actual rendered view.

The real, locally mounted Node-container preview was also exercised in Chromium
at a 1100x800 browser viewport (840x732 CSS-pixel canvas), on sequential pass 14.
Both scores reached 100, both impact events remained independent (including
simultaneous contacts), pause and camera switching preserved state, repeated
rebuilds kept scene resource counts stable, and records remained untouched.

| Follower view, 0.2 s after lead release | Lead aircraft width | Departing bomb width |
| --- | --- | --- |
| Green Valley / Desert | 15.8 CSS pixels | 1.22 CSS pixels |
| River Canyon | 20.8 CSS pixels | 1.59 CSS pixels |

The small cap-speed bomb was flagged as a readability concern during G1.
The user accepted the current presentation unchanged, rather than asking for
closer spacing or a cosmetic release cue. This does not imply universal
readability at every display size. The
[local preview instructions](../README.md#local-formation-preview-not-networked)
describe the fixture; it is not included in the production image.

Node 24 measurements, using the existing refined release-window driver over
the complete legal release intervals:

| Course | Successful-release interval | At least 95-point interval | Follower window compared with lead |
| --- | --- | --- | --- |
| Valley / Desert | 0.1522-0.7364 s | 0.00845-0.04091 s | Hit width -2.37% to +4.18%; precision width -2.35% to +4.24%. |
| Canyon | 0.1527-0.7382 s | 0.00848-0.04104 s | Hit width +0.19% to +2.17%; precision width +0.20% to +2.70%. |

These ranges combine easy and cap-speed passes; they are not one timing window
that applies to every tier. Valley widths differ from the original solo
approach by approximately -2.33% to +4.23% for hits and -2.35% to +4.25% for
precision. The observed Valley release lag was 1.5000-1.5078 seconds. Canyon
retains the native release-region knots; reconciled entries do not retime them.
Neither planner changes radius, physics, scoring, or solo play.

The Canyon sample used at most 277 knots per track and 676 clearance-proof
nodes per plan, with 5.5 seconds of authored continuation beyond the shared
handoff. The search remains explicitly bounded at 12 shelves and eight pair
candidates per shelf. Observed planning time is machine/load-dependent and is
not a frame-rate or latency guarantee.

For reproducible per-tier JSON reports, set `FORMATION_EVIDENCE_DIR` to a local
artifact directory and run:

```sh
npm test -- tests/unit/formation-valley.test.ts tests/unit/formation-canyon.test.ts
```

Generated reports are evidence artifacts, not source assets or score records.
**G1 is accepted on the user's preview review.** Retain the measured settings
without retuning. Damaged-view smoke and simultaneous effect obstruction remain
part of the later combat-effects gate; the geometry preview did not test those.
These results do not establish WebRTC/TURN connectivity or complete multiplayer
gameplay.

**Deployment ownership:** production deployment is managed by Ansible in a
different repository. This document is a research and implementation handoff,
not authorization to deploy, change Traefik/DNS/firewalls, or edit that Ansible
repository. That repository also exclusively owns coturn deployment and operation;
this repository must not infer the live relay's settings from retired examples.

**Implementation decisions confirmed after the research:** hosting requires a
separately shared access code, without accounts. Prefer evolving the existing
application image/container to run one Node server, keeping single-player
available while multiplayer is disabled or unavailable. Prove that packaging in
an early deployment checkpoint; stop for alternatives if it cannot preserve the
current deployment constraints. Coturn is independently deployed and managed.
The user handles intermediate application deployments and approves
deployment compatibility, formation fairness, real Edge connectivity, and the
complete game at explicit milestones. Implementation uses small tested local
commits, including separate commits for individual UI screens.

## 1. Executive recommendation

Use a **host-authoritative browser simulation**, connected to the other browser
through **native WebRTC data channels**. Add a small **Node.js/TypeScript
HTTPS/WebSocket signaling service** and integrate the existing **coturn service**
at **`turn.low-pass.biggsea.us`**. Preserve the game's
existing public hostname, **`low-pass.biggsea.us`**, and use its **Traefik** proxy
for HTTPS/WSS. Use only the TURN endpoints confirmed by the operator; do not
assume TURN/TLS on 443 is available because game HTTPS uses that port.

WebRTC should try a direct browser-to-browser connection first and use TURN when
direct connectivity fails. TURN relays encrypted game traffic; it does not become
the game simulation server. Both browsers continue rendering the local Babylon.js
assets. Do not stream the host's screen or send terrain meshes every frame.

**Current desktop Microsoft Edge on Windows is the primary target browser.**
Make transport, precision, visibility, and deployment decisions using actual Edge
results from the early spikes onward. Chromium is useful for automated regression,
not a substitute for Edge acceptance. Firefox/Safari/mobile compatibility is not
a first-release gate for this project.

The host selects the course, constructs both flight plans, runs authoritative bomb
physics, and publishes both players' results. The guest reconstructs the same
course and host-authored plans, predicts its own bomb release immediately, and
accepts authoritative outcomes. Independent player lifecycles let the host keep
running the shared session after its own aircraft is destroyed.

**The largest implementation risk is the paired flight planner, especially River
Canyon, not opening a peer connection.** A second independently fair path to the
same shelf target cannot be obtained by simply offsetting the existing aircraft.
Prototype this geometry locally before building the full multiplayer UI.

## 2. Confirmed requirements

These decisions were explicitly confirmed during the research.

| Area | Agreed behavior |
| --- | --- |
| Players | Exactly two people on different computers, over the internet, including different home networks. |
| Browser | Microsoft Edge is the primary browser; use the project's existing current Windows Edge target for acceptance. |
| Trust | Private play between trusted friends; no accounts, public matchmaking, or competitive anti-cheat. |
| Hosting access | Only friends with a separately shared hosting access code may create rooms. Guests join using a separate room invitation. |
| Infrastructure | Self-hosted services on `docker.circlone.net`, with one public IP and full administrative control. |
| Public deployment | Existing game hostname `low-pass.biggsea.us`; HTTPS is handled by Traefik. Preserve the current browser origin. |
| Deployment workflow | Ansible in a separate repository owns production deployment. No deployment or changes to that repository are part of this research. |
| Application packaging | One Node 24 process with Express 5 and compression, serving assets and future signaling on 8080 behind Traefik. Contain optional-feature errors; process crashes affect all new HTTP requests. Coturn is independently deployed at `turn.low-pass.biggsea.us` and managed by the separate Ansible repository. |
| Invitation | The host gives the second player a code through an outside communication channel. |
| Authority | The first browser drives the game and chooses the landscape. |
| Terrains | Green Valley, Desert, and River Canyon are all required for the first public multiplayer release. |
| Flight | Both planes remain automatically piloted. The second follows a distinct nearby trailing path of comparable difficulty. |
| Drop order | Release opportunities are independent. The second player should normally see the first drop; the windows need not be strictly non-overlapping. |
| Target | Both attack the same target and retain independent scoring opportunities. |
| Wreck | After a hit, both see the same wreck. Full scoring rings and points remain available for the second attempt. |
| Scores | Each has its own score; both see both scores. Three cumulative misses destroy that player's aircraft. |
| Survival | A surviving player continues until also destroyed. If the trailing player survives, it retains its existing path and timing rather than moving into the lead slot. |
| Spectating | The destroyed player stays connected and watches the survivor. Destruction of the host aircraft does not transfer or end hosting. |
| Winner | Highest final total wins once both are destroyed. Equal scores are a draw. |
| Pause | Either player's pause or tab switch pauses the shared game. Both confirm ready before a short resume countdown. |
| Connection loss | Allow 15 seconds for temporary network recovery. If either player cannot recover, end the shared session. |
| Host reload/close | Not recoverable in this version. No host migration or restoration after host reload. |
| Assistance | Each player chooses assistance independently; the choice is visible. Any use marks that player's completed record assisted. |
| Records | Multiplayer records are separate from single-player records. Keep already-completed individual scores after a disconnect, but mark the match incomplete and declare no winner. |

### Decisions still requiring measurement or deployment discovery

Do not silently treat these as agreed requirements:

- Formation lag, lateral separation, and acceptable differences in release-window
  width must be selected from a paired-flight prototype.
- Supported viewport/aspect-ratio bounds and a measurable definition of
  "normally see the first drop" need visual acceptance.
- The supported latency/jitter envelope, late-input allowance, heartbeat periods,
  room lifetime, resume-countdown length, and queue/packet limits need testing.
  The reconnection grace itself is fixed at the agreed 15 seconds.
- Confirm the deployed application's compatibility and the actual TURN endpoint,
  authentication and supported-network contract. Relay infrastructure details
  remain in Ansible; the game must not assume ports or transports are enabled.
- Confirm expected concurrent sessions and available bandwidth before sizing.
  No cloud price or capacity estimate is assumed here.
- Validate non-root/read-only Node serving and Docker restart behavior in the image
  on the deployed host. Actual game-side relay connectivity and operating limits
  still require validation against the independently managed service.

## 3. Findings in the current code

| Existing surface | Finding and consequence |
| --- | --- |
| `src/main.ts` | Owns one `Run`, one input gate, one camera prediction, one screen, and one completion ID. It stops ticking gameplay when that run ends. Introduce a session/controller boundary rather than adding a second `Run` beside these globals. |
| `src/config/game.ts` | Simulation uses `STEP = 1 / 120`; maximum difficulty is reached on pass 13. Do not confuse this 120 Hz physics step with the network snapshot rate. |
| `src/game/run.ts` | `Run` combines encounter scheduling, flight, one bomb, scores, misses, assistance, and completion. `finish()` and `tick()` advance a single player's encounter based partly on resolution timing. Shared encounters must not advance according to whichever player's result arrives first. |
| `Run.seeTarget()` and `World.targetVisible()` | Visibility currently comes from the rendered camera and starts the valley dive. It also enforces an important fairness guard. Two independently running copies can diverge just because their camera/frame timing differs. |
| `src/terrain/surface.ts` | The course surface is selected by terrain theme and uses canonical ground/water contact. The current surface objects are shared, with terrain geometry defined by code; the run seed is not a universal terrain seed. |
| `src/terrain/river-canyon.ts` | Canyon shelves and route-relative terrain are procedural and already fixed before an encounter. Keep this stability. Do not generate a new shelf by modifying terrain when the follower approaches. |
| `src/game/canyon-flight.ts` | Selects a shelf, solves a release intercept, constructs a `FlightTrack`, and checks speed, clearance, and visibility. Paired planning must solve and validate two tracks against one target, not invoke this independently and hope the targets match. |
| `src/simulation/flight-track.ts` | Contains useful time-indexed knots and full `Pose` interpolation. These provide a starting point for a serializable plan. The current class has methods and constructor-generated state, so it is not a wire protocol by itself. |
| `src/rendering/world.ts` | Has one aircraft, carried bomb, falling bomb, target, impact mark, encounter/result ID, and `CombatEffects`. Its update method also starts gameplay-related missile choreography. Replace singleton entity presentation with explicitly identified player/encounter views. |
| `src/rendering/combat-effects.ts` | Selects missile/finale plans using a `Run` and a camera snapshot and advances their timing locally. Two renderers must not independently choose different missile paths for the same event. |
| `src/storage/records.ts` | Validates and deduplicates completed local records under `low-pass.records.v1`. Keep that key and its single-player data unchanged. |
| `server/`, `Dockerfile`, `compose.yaml` | Node-only serving now replaces the original static Nginx image on port 8080. CSP allows `connect-src 'self'`; new WebSocket endpoints need explicit deployment review. |
| `tests/unit/`, `tests/e2e/` | Existing physics, flight, canyon, lifecycle, and Playwright coverage can be extended rather than replaced. Current e2e assertions expect no external HTTP requests. |

Important implications:

1. **Sending only the existing run seed is insufficient.** Theme/build identity,
   encounter selection, acquisition timing, and the two flight plans must agree.
2. **Duplicating `Run` is insufficient.** Its scheduling and completion semantics
   are inherently single-player.
3. **Sharing the host camera is wrong.** Each player needs its own chase camera,
   local quality/audio settings, and local predicted-impact HUD.
4. **A render-origin offset is not world state.** Transmit world coordinates;
   each browser rebases around its own camera independently.

## 4. Transport and technology selection

### 4.1 Options

| Option | Advantages | Costs and limitations | Recommendation |
| --- | --- | --- | --- |
| Native `RTCPeerConnection` / `RTCDataChannel` + custom signaling + coturn | Direct connection when possible; reliable and partially reliable channels; no client networking dependency; full control over reconnection and diagnostics. | Must implement signaling, ICE state handling, room security, and channel flow control. TURN still needed for useful internet coverage. | Preferred production approach. |
| PeerJS client + self-hosted PeerServer + coturn | Convenient peer IDs and data-connection API; reduces initial WebRTC boilerplate. | Does not replace TURN, invitation authorization, game synchronization, or game-specific reconnect logic. Adds client/server dependencies and wrapper behavior to debug. | Reasonable spike alternative if native connection code proves disproportionately costly. |
| `simple-peer` + custom signaling + coturn | Smaller abstraction around WebRTC connections and data. | Still needs the same server infrastructure; verify current maintenance, TypeScript support, and browser bundle behavior before adoption. | No clear advantage for this narrow two-role protocol over native APIs. |
| Browser WebSocket to a server relay, with host still authoritative | Simplest network traversal through existing HTTPS infrastructure; easy inspection and operations. | All traffic traverses the VPS, and TCP delivery can delay fresh state behind missing data. Not P2P. | Useful comparison spike and a possible later explicitly selected fallback; not the default implementation. |
| Dedicated authoritative game server | Survives a browser host closing and offers a stronger trust boundary. | Changes the requested host model, adds server simulation/cost, and still requires client prediction. | Not justified by confirmed requirements. |
| WebTransport | Client/server streams and datagrams can suit some games. | It connects browsers to servers, not directly to another browser; adds infrastructure without meeting the P2P preference. | Do not use for this design. |
| Manual exchange of SDP files/text, without signaling | Can avoid running a signaling service in a technical demonstration. | Large offer/answer payloads, changing ICE candidates, awkward restarts, and no practical short-code lookup. Does not eliminate TURN. | Do not use for the intended experience. |

PeerServer explicitly documents that it does not proxy gameplay data [S9].
The reviewed PeerJS implementation maps its `reliable` option to channel
ordering, without setting a retransmission limit in that call [S22]. Therefore,
do not assume a wrapper option named `reliable: false` means the same thing as
native `maxRetransmits: 0`. Both wrappers still require application-specific
recovery. Review the pinned release rather than assuming default-branch behavior
matches every published package.

For two players sending modest state, an SFU/media server, video streaming
stack, full multiplayer engine, Redis cluster, database, and Kubernetes are not
necessary. Keep the first service instance small and explicit.

This is data-only WebRTC: no `getUserMedia()`, microphone, camera capture, or
media permission prompt is needed. Continue using a user gesture to unlock the
existing Web Audio game sounds. Data-channel behavior and encryption are
documented in [S4]. WebTransport's documented browser-to-server topology [S11],
not a lack of interest in Edge support, is why it is not the P2P recommendation.

### 4.2 Recommended dependencies

| Layer | Technology/library | Intended use |
| --- | --- | --- |
| Browser transport | Native WebRTC, WebSocket, Web Crypto, and monotonic timing APIs | Peer transport, signaling, secure random IDs, and clock estimation. No Node networking library in the browser. |
| Signaling runtime | Node.js 24 LTS, TypeScript | Small separately built service; Node becomes an optional production service for multiplayer, not part of static asset rendering. |
| Signaling WebSocket | `ws` plus its TypeScript types as needed | Server-side WebSocket upgrades, bounded messages, heartbeat, and two-member room routing. Use native browser WebSocket on clients. |
| HTTP server | Initially Node `node:http` behind the existing TLS proxy | Health/readiness and a small room API. Avoid introducing a framework solely for a few endpoints. |
| Protocol validation | Zod | Runtime validation and inferred TypeScript types for signaling, gameplay messages, and persistent multiplayer records. Compile-time interfaces alone do not validate peer input. |
| Traversal/relay | coturn | STUN and authenticated TURN, with short-lived credentials issued by the signaling service. |
| Deployment | Existing Ansible deployment, Docker, and Traefik | Use the Node-only application image and integrate the independently managed TURN service. Relay deployment configuration stays in Ansible. |
| Unit/integration tests | Existing Vitest | State machines, planner fairness, serialization, fake transports, service room tests, and resource limits. |
| Browser tests | Existing Playwright, Chromium and Windows Edge | Two isolated browsers/contexts, real ICE paths, visible formation, reconnect and lifecycle tests. |

`ws` [S2], Zod [S3],
[PeerJS](https://github.com/peers/peerjs/blob/master/LICENSE),
[PeerServer](https://github.com/peers/peerjs-server/blob/master/LICENSE), and
[`simple-peer`](https://github.com/feross/simple-peer/blob/master/LICENSE) use MIT
licenses; coturn uses a BSD-style license [S21]. Verify the exact pinned release's
license and transitive notices before
installation. Pin selected versions and container digests during implementation;
this outline intentionally does not invent future version numbers.

A MessagePack library, worker-based planner, framework, or metrics SDK should be
added only after measurements show a concrete need. Start with compact validated
JSON control messages and full small snapshots; use chunked plan transfer.

## 5. Connection and invitation design

### 5.1 Topology

```text
                 low-pass.biggsea.us
                 on docker.circlone.net
               +---------------------------+
               | Traefik TLS proxy         |
               | / -> Node assets          |
               | Express + compression     |
               | /api/*, /signal -> Node   |
               +-------------+-------------+
                             |
                    room membership,
                    offer/answer, ICE,
                    reconnect coordination
                     /                 \
             host browser           guest browser
             authoritative          replicated/predicted
                     \                 /
                      === WebRTC =====
                        direct if possible
                              OR
                      encrypted via coturn
```

The HTTPS proxy is not the TURN relay. TURN has its own network listeners and
relay ports.

### 5.2 Room flow

1. Host chooses **Two players > Host**. Create a cryptographically random internal
   room ID, private host capability, and separate shareable invitation code.
2. Show a readable, case-insensitive code with copy support, expiry information,
   and an optional copyable join link. A proposed format is eight unambiguous
   base32 characters grouped `ABCD-EFGH`; this is about 40 bits, so online rate
   limits and short validity remain necessary. Put a join-link invitation in
   the URL fragment, not a logged query string, and remove it from the visible
   address once consumed.
3. Guest enters the code on the same game origin. The service validates it,
   reserves the second slot atomically, and gives that guest its own unguessable
   reconnect capability. The code is not the host/reconnect credential.
4. Host sees a pending participant and confirms admission. Avoid collecting a
   real name: proposed defaults are "Player 1" and "Player 2", with optional
   length-limited display names.
5. Service issues temporary STUN/TURN configuration to authorized room members.
   The browsers exchange SDP offer/answer and trickled ICE candidates over WSS.
6. The host is the designated initial offerer and sole game authority. Serialize
   renegotiation attempts and tag candidate generations; buffer candidates that
   arrive before the matching remote description.
7. Establish data channels, authenticate application membership over the new
   connection, and compare protocol, game-build, terrain-generator, and
   physics/rules versions. Reject incompatible builds before play.
8. Exchange viewport capabilities, synchronize clocks, transfer the initial
   manifest/plans, and load/prewarm local assets. Each browser acknowledges the
   committed plan hash and readiness.
9. Both press ready. Host publishes an acknowledged start/countdown epoch. Do not
   start while one browser is still loading or lacks the course plan.
10. Keep signaling connected after the peer channel opens. It remains useful for
    ICE restart, room lifetime, and reconnect coordination; gameplay normally
    travels over the peer connection.

Handle expired/wrong/full rooms, denied admission, unsupported WebRTC, TURN
failure, incompatible builds, and canceled hosting with specific recoverable UI.
No room list, anonymous room browsing, late third-player joining, or replacement
player joining mid-match is needed.

### 5.3 Public service safeguards

- **Admission is not enough to control relay access.** If anyone can create two
  cooperating browser sessions, they can admit themselves and request TURN
  credentials without guessing another room's code. For private friends-only
  operation, require the confirmed separately shared hosting access code before
  issuing a host/create-room capability, in addition to hard global quotas.
  Do not ship an unrestricted credential-vending endpoint.
- Use HTTPS/WSS, validate the WebSocket `Origin`, bind each connection to one
  server-assigned role, and authorize every operation. Origin validation is not
  authentication and does not stop non-browser abuse.
- Rate-limit room creation, code guesses, joins, reconnect attempts, and TURN
  credential issuance. Apply per-room, per-source, and global capacity limits.
- Expire invitations, limit rooms to two members, and clear abandoned rooms.
  Room codes and capability tokens must never appear in normal access logs.
- Bound JSON depth/size, SDP/candidate payloads, messages per second, pending
  upgrades, buffered bytes, and outstanding requests. Do not route arbitrary
  messages to a client-supplied destination peer.
- Do not expose permanent TURN credentials or the coturn shared secret in Vite
  configuration, static assets, or the browser bundle.
- P2P connectivity can reveal network addressing to the other participant.
  Explain this in a short privacy notice. TURN-only operation can reduce direct
  address exposure if later desired, but changes relay usage and should be tested.
- No promises of protection from a modified host/client: trusted-friend play is
  the explicitly chosen trust model. Transport encryption does not prevent host
  cheating or a compromised signaling endpoint from undermining session setup.
  WebRTC's security architecture documents these trust boundaries [S19].

## 6. Shared simulation architecture

### 6.1 Separate session, player, and presentation

Introduce engine-independent components along these lines; names are proposals,
not a requirement to create every file before a spike.

| Component | Responsibility |
| --- | --- |
| `SessionConfig` / `CourseManifest` | Match identity, versions, host-selected theme, seed/configuration, rules, and formation parameters. |
| `SessionSimulation` | Shared tick/time, committed course schedule, two player states, authoritative commands, and session completion. |
| `EncounterPlan` | Shared target identity/kind/heading, geometry reference, two immutable tracks, and each player's release/acquisition/cutoff times. |
| `PlayerSimulation` | Its own release state, bomb, score, cumulative misses, assistance history, and elimination record. |
| `SessionController` | Local solo/host/guest mode, transport integration, connection/pause state, countdown, and persistence notifications. |
| `PeerReplica` | Validated plans/snapshots, presentation-time mapping, local speculative bomb, reconciliation, and resynchronization. |
| `World` / player views | Render a session view model without deciding scores, selecting new encounters, or authoring missile events. |

Model independent state machines rather than one enlarged `Screen` union:

```text
Session: lobby -> loading -> countdown -> running
                                 running <-> paused
                                 active  -> reconnecting -> paused or aborted
                                 running -> finishing -> completed

Player: active -> eliminated -> finale -> spectating
                                  (or finished if nobody survives)

Connection: connecting -> connected -> recovering -> connected or closed
```

The player is logically eliminated when the third miss is finalized. Its visible
destruction occurs later in the missile finale. A completed individual score is
saved at logical elimination, not at the end of the visual sequence.

### 6.2 Authority and determinism

- The host alone selects targets, creates both paths, accepts releases, resolves
  ground/water impacts, scores, increments misses, and declares eliminations.
- Keep the existing ballistic launch transform, 120 Hz integration, first-contact
  rules, target radius, and full-motion joins. Share these helpers with guest
  prediction rather than implementing network-specific approximate physics.
- The guest regenerates static course geometry from the validated manifest and
  matching code. It evaluates host-authored tracks locally and renders both planes.
- Use snapshots and authoritative outcomes as a correction boundary. JavaScript
  math, procedural calculations, camera timing, and serialization should not be
  assumed bit-for-bit identical across all browsers.
- Make acquisition a host-committed plan event, using the shared camera/visibility
  math and both viewports. Actual local visibility remains a checked invariant:
  a failed fairness check pauses/reports or triggers bounded replanning before the
  attempt, never silently grants an invisible release or removes `seeTarget`'s guard.
- For valley flight, commit the dive/acquisition timing and full-motion handoff
  so independent render frames cannot change the path. For canyon flight,
  serialize the actual time-indexed track and its timing boundaries.
- Viewport changes during a match require capability revalidation while paused.
  Local graphics quality may change appearance, not collision, release timing, or
  authoritative visibility rules.

### 6.3 What crosses the connection

| Data | When | Notes |
| --- | --- | --- |
| Protocol/build compatibility | Connection setup and recovery | Reject mismatched simulation/asset versions, including a stale tab after deployment. |
| Course manifest | Start and resync | Theme, generator/rules identity, relevant seeds and constants. Existing terrain is mainly code-defined; do not claim a seed controls geometry it currently does not. |
| Shared encounter plans | Ahead of use | Target ID/kind/heading, target position, both flight paths, timing, and hashes. |
| Player commands | On input | Release intent, assistance change, pause, ready, quit. Never accept a client-supplied score or arbitrary aircraft pose as authoritative. |
| Reliable events | On change | Accepted release, rejected release, impact/result, target wreck, damage/missile plan, elimination, match completion. |
| Small complete snapshots | Periodically | Host time/tick, per-player state, active encounter IDs, active bomb state, scores/misses, assistance, effect ages, and last processed input/event sequence. |
| Health/clock messages | Periodically | Round-trip samples, clock/epoch mapping, freshness, channel status. |
| Recovery checkpoint | After reconnect or detected drift | Current state, retained active/future plans, deduplication watermarks, and effect timelines. |

Do not serialize Babylon meshes, textures, `Surface` functions, live `Run`
instances, closures, or `FlightTrack` prototypes. Define bounded data-transfer
objects and explicit encode/validate/decode methods. Rehydrating a plan must not
rerun candidate selection and accidentally choose a different shelf.

For terrain consistency, compare generator/build identity and hashes of canonical
sample grids around shared targets. A mismatch is a loading/resync failure, not a
reason to accept guest-computed scoring. Preserve 8-unit canyon and 16-unit legacy
grids and the existing shared triangle diagonal.

## 7. Network timing and fair bomb release

### 7.1 Do not score by arrival time

At the top speed, a 100 ms input delay corresponds to approximately 35 world
units of travel along a 350-unit/second path. That is larger than the 28-unit
scoring radius. This is an illustrative travel calculation, not an exact impact
error estimate, but it shows why calling `release()` only when a guest packet
arrives would be unacceptable.

The host must score the pose at which the guest actually released, not the pose
at packet reception.

### 7.2 Recommended release protocol

1. Both clients render their controllable aircraft from the agreed flight plan.
   Record the plan ID and exact displayed simulation time used for the local
   aircraft/predictor when Space is pressed.
2. Send a reliable `ReleaseIntent` containing match/session epoch, player ID,
   encounter ID, unique input sequence, plan ID, and release tick plus any
   explicitly defined sub-tick component. The same command path handles host
   input; host releases do not get a different rounding rule.
3. Predict the local bomb immediately using the shared launch/physics functions.
   Mark outcome presentation provisional; do not increment an authoritative
   score, finalize a miss, or persist a record from speculation.
4. The host validates ownership, epoch, plan, release eligibility at that time,
   duplicate sequence, bounded age/future offset, and remaining bomb opportunity.
5. Reconstruct the historical launch pose from the immutable track and advance
   that bomb through canonical ground/water contact to the current session time.
   This game can replay the affected bomb without rolling back the entire world,
   provided aircraft/bombs/wrecks do not acquire new interacting colliders.
6. Publish an accepted/rejected command acknowledgement and authoritative
   release/result events. Correct or remove the speculative bomb without double
   explosion, audio, damage, score, or storage effects.

Referencing the displayed plan time is important. Merely attaching
`performance.now()` to a command is not enough: clocks differ, and interpolation
can show a pose older than the estimated host present.

Define launch-time precision deliberately. Existing canyon tests assert
near-center intervals greater than 5 ms; one 120 Hz step is about 8.33 ms.
Unexamined timestamp rounding can therefore alter top-end accuracy. Test the
actual frame/input/launch convention for both roles, including the predictor;
do not promise perfect millisecond clock agreement over asymmetric networks.

### 7.3 Cutoffs, late messages, and finality

An unreceived release must not instantly become a permanent timeout miss at the
host's cutoff. Allow a bounded input-settlement horizon after the release window:

- The release must refer to a time inside the genuine window; the network
  allowance does not extend the player's gameplay opportunity.
- Do not finalize a timeout miss, third-miss elimination, or stored score until
  that allowance expires or the relevant input is resolved.
- Retain previous plans and command/event deduplication state through settlement.
- A late-but-valid release must not need to undo a saved death or completed match.
- Commands beyond the supported horizon receive an explicit rejection. Sustained
  stale connectivity leads to connection recovery, not silent unfair misses.
- Pauses and recovery carry a new epoch/barrier. Commands from before the pause
  are settled under the agreed boundary; commands from an old epoch cannot
  accidentally release after resume.

Choose the settlement horizon from network tests and visible scoring delay, not
from the 15-second reconnect grace. They solve different problems.

### 7.4 Channels, clocks, and buffers

Use two data channels initially:

| Channel | Configuration | Contents |
| --- | --- | --- |
| `control` | Reliable, ordered | Commands/acks, authoritative events, pause/resume barriers, plan transfer, and recovery. |
| `state` | `ordered: false`, `maxRetransmits: 0` | Replaceable timestamped complete snapshots and disposable timing samples. |

`ordered: false` alone does not disable retransmission. The native API permits
either a retransmission-count limit or a packet-lifetime limit, not both [S5].
The required APIs are represented in Edge compatibility data [S20]; capability
checks and actual Windows Edge tests are still required.

A third reliable plan-transfer channel is an optimization only if plan payloads
interfere with control responsiveness. Channels share the same underlying
connection and congestion; separate labels do not create unlimited independent
bandwidth. TURN/TCP or TURN/TLS can still introduce transport-level head-of-line
blocking even when an application channel is unordered.

Start the transport spike at a proposed **20 snapshots/second**, then measure
10/20/30 Hz against the plan-driven renderer. Physics remains 120 Hz; rendering
remains local. Do not send updates at the render-frame rate by default.

Use repeated ping/pong samples and a monotonic clock to estimate RTT, offset,
drift, and uncertainty. Use a session tick/epoch, not wall-clock dates, to identify
game events. The server uses wall-clock deadlines only for room/connection leases.

For planned aircraft motion, evaluate the published curve instead of dead
reckoning down a tangent through a canyon wall. For remote effects, buffer
timestamped events/snapshots as needed and cap extrapolation. If data/plan
coverage runs out, pause/recover explicitly.

Monitor `bufferedAmount`, use a low-water threshold, skip obsolete snapshots,
and bound reliable queues. Respect the negotiated message limit; use a
conservative application chunk limit, initially no larger than 16 KiB, subject to
the negotiated limit and tests. Plans/checkpoints require bounded reassembly,
sequence IDs, expiry, and a hash before committing them.
Count UTF-8 encoded bytes, not JavaScript string length. The negotiated
`pc.sctp.maxMessageSize` and buffer-threshold mechanisms are documented in
[S6] and [S7]; 16 KiB is an application proposal, not a claimed Edge hard limit.

Cross-channel messages can arrive in either order. Every snapshot/event must
identify its epoch, plan revision, and sequence so an old snapshot cannot undo a
new result, resurrect a player, or reference an unavailable plan.

This is a hybrid of authored-plan evaluation, local bomb prediction, and
authoritative snapshots, not pure deterministic lockstep or pure snapshot-only
rendering. [Glenn Fiedler's primary explanation of snapshot interpolation][S1]
supports the buffering/sequence-number tradeoff; the plan-based reconstruction
and selective bomb replay are game-specific recommendations from the inspected
code, not claims made by that article.

## 8. Paired encounters and the second flight path

### 8.1 Shared target, independent attempts

Create one shared encounter identity with two per-player attempt records:

```text
Encounter N
  target position, kind, heading, surface, wreck state
  player 1 track + acquisition/release/cutoff + result
  player 2 track + acquisition/release/cutoff + result
```

Both receive the same tier for a shared encounter. Advance course difficulty by
the shared encounter sequence, not by packet arrivals, hits, or the order in
which one player's result resolves.

First hit changes the shared model to a wreck but does not remove the target
marker, scoring eligibility, or points for the other player. Wrecks remain visual
only. Do not reset the model merely because the follower's attempt begins.
Attribute bombs, impacts, smoke, and score popups by player.

### 8.2 Planning approach

1. Choose a candidate shared target on the canonical course.
2. Construct a valid lead track, preserving existing difficulty and full-motion
   handoff.
3. Construct a follower track with a later nominal release and a bounded,
   route-relative lateral distinction. Solve its launch intercept against the
   same target rather than shifting the lead pose after planning.
4. Check continuous speed, aircraft clearance, camera clearance, target
   acquisition, successful release windows, and full scoring-ring visibility
   independently for both tracks.
5. Check formation visibility from the follower camera: the lead aircraft and
   bomb departure must be readable around the useful lead release interval.
   Also check that the lead aircraft, smoke, explosions, and target wreck do not
   obscure the follower's scoring task.
6. If a pair fails, try a bounded set of formation parameters or the next
   candidate target. Reject the pair before publishing it; never alter terrain
   or increase work without bound during an active bomb flight.
7. Commit both tracks and target as a unit, sufficiently far ahead for guest
   transfer and acknowledgement.

Lateral separation should use canyon-route normal frames, not a fixed world-X
offset. A fixed time delay also produces different world distances at different
tiers and through slow turns. Consequently there is no evidence yet for a single
safe separation constant across the whole game.

There are no requested steering controls or combat interactions between players.
The proposed implementation keeps aircraft, bombs, and effects non-colliding
with the other aircraft, while the planner avoids visually intersecting paths.
Adding friendly fire or aircraft crashes would be a separate gameplay decision.

### 8.3 Do not break continuity at encounter boundaries

The leader can be moving toward a later encounter while the follower is finishing
the previous one. One global `currentTarget` or "wait until both finish and
teleport to the next pass" will not work.

Use a bounded rolling set of committed encounter plans. Retain a target until
both applicable attempts settle and its visible effects no longer need it.
Allow overlap where required by continuous flight, without giving a player more
than its one permitted active bomb/opportunity.

Derive the maximum number of simultaneously retained target views and plans
from formation delay, encounter duration, bomb lifetime, settlement, and effect
tail. Do not assume the current single-model pool is sufficient or grow the pool
forever. Planning ahead must include valid recovery/transit motion for both
aircraft, without crossing an unplanned course segment.

When a player is eliminated, stop issuing that player new attempts. Continue the
survivor's slot/timing and difficulty sequence; remove any scheduling barrier
that waits for the dead player's future releases.

### 8.4 Canyon acceptance before integration

Use the existing canonical shelves, route indexing, and collision mesh. Extend
the current tests rather than relaxing them:

- All 13 supported difficulty tiers and sequential runs beyond the speed cap,
  including at least the existing 26-30-pass scenarios and both bank directions.
- Full 3D speed and whole-curve handoff bounds, not only endpoint samples.
- Full position/velocity/acceleration continuity for both tracks.
- Swept conservative aircraft bounds and actual chase-camera clearance.
- One connected successful-release interval, achievable 100-point nominal
  release, and a measured near-center interval for each player.
- Preserve existing minimum successful-window checks, including the canyon
  `> 0.08 s` boundary-refined check and `> 0.005 s` near-center check on the
  existing test fixtures; extend them to the actual multiplayer input sampling.
- Compare both players' width/precision distributions with the single-player
  baseline at every tier. Agree a tolerance from results instead of equating
  equal speed with equal difficulty.
- Validate lead-drop visibility at representative successful release times and
  viewports, with damage smoke active. Define the visual acceptance percentage
  before treating the "normally sees the first drop" requirement as satisfied.
- Validate bounded plan selection time, bounded plan bytes, and enough future
  coverage for the second path and either player's finale.

Valley/Desert should be the easier geometry spike, but Canyon feasibility must
be established before committing to the final networked release. Inspect this
spike in actual Windows Edge, not just a headless Chromium renderer.

## 9. Rendering, audio, and spectator behavior

### 9.1 Multiple entities

- Load the original aircraft assets once and instantiate two independent roots.
  Share immutable geometry/textures, but keep carried bombs, damage visibility,
  transform, and any identity colors independent.
- Replace singleton aircraft/bomb/combat state with a small player-ID keyed set.
  Give each aircraft its own bounded smoke, missile, and finale presentation.
- Keep target-kind selection and heading host-authored and stable. Cache per-kind
  resources, with enough target instances for the bounded overlap described above.
- Keep one chase camera per browser, following its own live aircraft or the
  survivor while spectating. No split screen or screen streaming is required.
- Transmit world positions; rebase all aircraft, bombs, missiles, water, splashes,
  shadows, impacts, and pending effects against that browser's local origin.
- Stream terrain covering the camera and visible formation/effect envelope,
  including canyon route extrema. Do not double the whole scene or unconditionally
  stream the union of arbitrarily distant player positions.
- Preserve separate local quality/audio preferences. Multiplayer host terrain
  selection must not overwrite the guest's saved solo terrain preference.

### 9.2 Authoritative effects

Move effect-plan selection out of `World.update()`:

1. Host resolves a player outcome.
2. Host creates the missile/finale event, with player/event IDs, start time,
   launch/trajectory parameters, and a frozen future aircraft continuation.
3. Each browser renders the same effect at the corresponding session age.

Canyon launch planning currently needs an actual world-space camera snapshot.
For a guest-targeted event, supply the validated guest view or an agreed
reconstructable camera state at the event time; do not substitute the host's
unrelated chase camera. Establish this camera-state contract in the paired-flight
spike. Both clients need consistent geometry even though an effect cannot be
guaranteed visible from every camera simultaneously.

Retain low dry-bank launches, terrain-safe curved trajectories, 1.7-second
interceptions, 2.8-second flybys, and the 5.5-second finale. Neither renderer may
replan a missile independently or add a runtime height clamp. Reconnecting peers
restore effect age without replaying old audio or generating duplicate damage.

Use the existing shared alpha-enabled smoke texture; avoid cloning it in a way
that loses `hasAlpha`. Pool per-player effects and bound overlapping explosions.

### 9.3 Death and spectating

On the third finalized miss, disable only that player's release input and
predicted-impact marker, save its completed score once, and play its own finale.
The other player keeps flying, dropping, scoring, and receiving its own effects.

After the local finale, transition the camera smoothly to the survivor's chase
view. Preload the destination chunk envelope before moving the camera; clear
old prediction/camera smoothing state. The spectator still sees both totals and
assistance labels and participates in shared pause/readiness.

The host browser remains authoritative while spectating. The guest cannot make
progress without it in this version. Warn an eliminated host that closing the tab
ends the shared session.

If both are eliminated close together, let both appropriate finales complete
without briefly selecting a nonexistent survivor. Declare the final winner/draw
from scores, independently of effect completion ordering.

## 10. Shared pause, failure, and reconnection

### 10.1 Pause barriers

- Either browser sends a pause request on Escape, blur, or visibility loss and
  immediately stops accepting release input locally.
- Host establishes a pause boundary and communicates its tick/epoch and
  authoritative state. Freeze both player simulations, bombs, finales, water
  phase, smoke, countdown, and game audio.
- Settle in-flight commands consistently around that boundary; recover a guest
  that rendered a little farther ahead to the authoritative paused state.
- Track pause reasons/readiness per participant. One player cannot clear the
  other's hidden-tab condition or ready flag.
- Both visible, connected players confirm ready; then start a short acknowledged
  countdown with a fresh epoch. A new pause/disconnect cancels the countdown.
- Clear held-key state on pause, focus loss, reconnect, and resume. A held Space
  must not become a new drop after resuming.

Browsers may throttle or freeze background pages, and lifecycle notifications
are not guaranteed before termination. A pause packet alone is therefore not a
complete solution: use peer freshness checks and signaling-side leases. Do not
claim a Web Worker can guarantee continued simulation in a frozen browser.
Chromium's documented page-lifecycle states [S18] explain this limitation; actual
Windows Edge suspension/sleep behavior remains part of acceptance.

An intentional shared pause need not end after 15 seconds. That grace is for a
detected connection failure. If a paused browser is actually discarded, suspended
long enough to lose connectivity, or closed without notification, treat it as
connection loss; browsers cannot reliably distinguish all these cases.

### 10.2 Temporary interruption

1. Detect a stale/failed game channel or explicit leave. On uncertain network
   loss, freeze the shared game at the last authoritative recoverable boundary
   and show **Reconnecting: up to 15 seconds**.
2. Start one bounded recovery attempt sequence, not competing renegotiations.
   If signaling also dropped, reconnect it using the in-memory participant
   capability while the same page is alive.
3. Refresh temporary TURN credentials if needed and perform an ICE restart,
   exchanging a new offer/answer and generation-tagged candidates.
4. If necessary, recreate the peer connection while retaining the host's existing
   session state. Do not create a new `Run` from the seed.
5. Transfer an authoritative checkpoint, plans, epoch, pending input outcomes,
   and deduplication watermarks. Guest verifies compatibility and acknowledges.
6. Return to shared paused/ready state. Both confirm before resuming; never resume
   an already eliminated player's gameplay.
7. If recovery is not complete within 15 seconds, terminate the match as
   incomplete, retaining only individual scores already finalized.

The signaling service should provide a single lease/deadline view while it is
reachable. During a signaling outage, browsers need their own conservative
monotonic watchdogs; a recovered service cannot resurrect an aborted epoch.
`restartIce()` initiates renegotiation; calling it without exchanging the new
offer/answer over signaling does not reconnect the application [S8].

Closing/reloading the host is outside recovery scope. Best-effort leave signals
can end promptly, but an abrupt close may only be observable after the same
failure detection/grace interval. Do not promise instantaneous remote detection.
This version also makes no persistence-based promise for guest reloads; network
recovery preserves the live page, not a newly loaded one.

If signaling alone briefly fails while the peer path is healthy, gameplay can
continue with a degraded-service warning and reconnection attempts. If membership
can no longer be safely restored or peer recovery becomes necessary, pause and
apply the bounded recovery policy. Make this behavior explicit in the service
state machine rather than treating any WSS close as immediate gameplay death.

## 11. Scores, UI, and persistence

### 11.1 User interface work

Add multiplayer entry points without disturbing **Single player**:

- Host/create room, copy code/link, waiting, admit guest, cancel, and join code.
- Lobby with host-selected terrain, role/slot, each player's assistance, ready
  status, and loading/build compatibility.
- Connection status: connecting, direct/relayed where verified by WebRTC stats,
  degraded, reconnecting, and a meaningful failure message.
- In-flight HUD: both scores, cumulative misses, assistance labels, whose aircraft
  the camera follows, and local release/result state.
- Shared pause screen: who paused, connection state, each ready confirmation.
- Eliminated/spectator state and a clear explanation that the host must stay.
- Results: both totals, winner/draw, completed versus incomplete match, rematch
  readiness, and return-to-menu behavior.

Use existing UI/accessibility patterns, keyboard focus handling, and safe text
insertion for display names. Local mute/volume/quality remain independent.

### 11.2 Storage model

Introduce a separately versioned key, for example
`low-pass.multiplayer-records.v1`, and a dedicated validated store. Do not insert
multiplayer outcomes into `low-pass.records.v1` or migrate away existing scores.

Store bounded individual records and match summaries, including:

- Match ID, player/slot ID, record ID, terrain, build/rules version, score,
  finalized date, and sticky assisted flag.
- Player completion state and opponent's known final score/status.
- Match outcome: completed, draw/winner, or incomplete with an explicit reason.

Use `(matchId, playerId)` or another stable equivalent for completion
deduplication. At elimination, persist that player's finalized record immediately
where received. At match completion, update the match summary idempotently.

If the survivor disconnects, its unfinished score is not a completed leaderboard
entry and there is no winner. The already-eliminated player's record remains.
Without a persistent server ledger, a peer that never received a final result
cannot be guaranteed a later copy; state this honestly.

Store records locally in each browser; there is no account synchronization or
globally trusted leaderboard. Keep all-time/top-10 views bounded as in the
existing storage design. Storage errors warn and retain session data instead of
blocking play.

## 12. Application deployment and TURN integration

This section specifies an **Ansible handoff**, not actions to execute in this
repository or during this research. The existing Ansible repository remains the
source of truth for production containers, networks, secrets, proxy configuration,
DNS/firewall integration, and rollout. Do not introduce a competing production
Compose workflow here.

### 12.1 Application services

On `docker.circlone.net`, keep the existing game image static and unprivileged,
and keep `low-pass.biggsea.us` as its public hostname. Do not switch users to the
machine hostname or a new application origin. Add:

1. Node.js 24 LTS and the signaling build in the existing application image.
   Run Node directly as PID 1; preserve the unprivileged,
   read-only/dropped-capability posture, resource limits, and application health.
   Keep service readiness distinct so a signaling failure does not prevent solo.
2. Integration with the independently managed coturn service. Its deployment,
   networking, certificates and operating policy are outside this repository.
   The game requires an explicit connection/authentication contract, not a copy
   of the relay's deployment configuration.
3. Same-origin `/api/` and `/signal` on the single Node listener.
   Keep the existing Traefik HTTP route to the application on 8080.
   Configure WebSocket upgrades and idle timeouts consistent with heartbeat;
   TURN routing remains a separate protocol concern.

Start with one signaling instance and in-memory room state. No durable score
database is required. A signaling restart loses room registry state unless
explicit restoration is implemented: an existing peer connection may continue,
but uninterrupted reconnect capability across service restarts is not promised.
Drain or schedule service updates rather than pretending this is highly available.

If future scale needs multiple instances, shared room state and routing become a
separate project. Do not add Redis preemptively.

### 12.2 TURN connection contract

The user reports the server deployed at `turn.low-pass.biggsea.us`. Its actual
configuration was developed independently in Ansible; the removed examples do
not establish its ports, authentication mode or supported transports.

Before the networking implementation, obtain this non-secret integration contract:

| Information | Why the game needs it |
| --- | --- |
| Exact `turn:`/`turns:` URLs, including ports and UDP/TCP transport | Populate the browser's ICE server list without guessing enabled listeners. Confirm 443 separately if offered. |
| Whether standalone STUN is supported | Do not advertise a `stun:` URL if Binding requests are disabled or require authentication unsupported by that client flow. |
| Authentication mode, realm, username format and credential lifetime | Match the future protected credential issuer to the deployed service. |
| Secure application-side secret-file reference or credential-service interface | Integrate authorization without putting a shared secret or permanent password in the frontend, chat or Git. The secret value is not needed for design discussion. |
| Supported IPv4/IPv6/client-network scope and relevant quotas | Bound connection attempts, simultaneous allocations, refresh/restart behavior and diagnostics. |

The planned default is coturn REST-style temporary credentials; confirm that the
deployed service supports it before implementing issuance. Do not assume a
permanent username/password is the intended production integration.

At G2, validate authenticated allocations and bidirectional data between two
Windows Edge clients on different networks. Force relay and test each advertised
transport separately; a successful connection with several URLs configured
does not prove every fallback works. If 443 is offered, test with only that URL.
Include both peers using this same relay and a client-UDP-blocked scenario.
Successful DNS, TLS or game `/healthz` responses do not prove TURN data flow.

Report unsupported network cases explicitly. Neither TURN/TCP nor TURN/TLS
guarantees access through every corporate proxy or firewall. Relay-side
infrastructure troubleshooting belongs to its Ansible owner.

### 12.3 Credentials and abuse controls

- Put the coturn shared secret in a deployment secret, not the repository.
- Sign expiring TURN credentials server-side using coturn's documented REST
  credential scheme. Associate issuance with a valid admitted room participant.
- Choose credential lifetime and refresh behavior for long matches and network
  restarts; expired credentials must not strand a reconnecting player.
- Respect the relay owner's allocation/bandwidth limits and peer restrictions;
  surface quota and permission errors rather than bypassing those controls.
- Close allocations and room resources on exit where possible; also enforce
  server-side expiry because browser cleanup is not reliable.
- Avoid logging credentials, SDP, or full ICE candidates. Use opaque room IDs and
  redacted error categories for operational diagnosis.

The documented coturn REST credential scheme is [S13]:

```text
username   = "<expiry-unix-seconds>:<opaque-participant-id>"
credential = Base64(HMAC-SHA1(sharedSecret, username))
```

This is a compatibility formula for coturn, not a recommendation to invent a
new authentication scheme. The application service issues it; coturn does not
need a publicly exposed HTTP credential-generation endpoint. Credentials grant
relay access, not a cryptographic restriction to one game room or destination.
Expiry also does not guarantee immediate termination of every existing
allocation: combine tested lifetime/refresh behavior, synchronized server
clocks, quotas, and cleanup.

### 12.4 Capacity and cost

The likely incremental cost drivers on the existing single-IP VPS are TURN
bandwidth, CPU/memory headroom, and maintenance. No second public IP is assumed.
Signaling traffic should be small, but that must be measured alongside
plan/checkpoint transfers.

Let `B` be the measured combined application traffic in both directions in
bytes/second, `T` the average match length, `M` the number of matches, and `r` the
fraction relayed. A first-order single-relay payload-egress estimate is:

```text
relay payload bytes approximately B * T * M * r
```

Add transport overhead, retransmissions, refreshes, and the actual provider's
billing convention. Traffic accounting can differ when both peers allocate
relays or multiple relay hops are selected. Use coturn/interface metrics rather
than multiplying a guessed per-player figure by a guessed success rate.

For illustration only, two 1 KiB state messages per 20 Hz interval would be
40 KiB/s of combined application traffic. That is not a measurement of this game,
does not include plans or overhead, and is not a capacity guarantee.

### 12.5 Application-only handoff for Ansible

The eventual implementation should supply this contract to the separate Ansible
repository. These are instructions to document, not deployment actions performed
by this research.

1. **Preserve the existing application deployment.** Keep its approved container,
   network, routing and certificate integration. Preserve
   `low-pass.biggsea.us` and existing single-player service behavior unchanged.
2. **Prepare compatible artifacts.** Produce the evolving application image with
   both browser assets and signaling, immutable version/digest references and
   matching protocol/build IDs. Publish only through an authorized workflow.
   Document ports, health/readiness endpoints, required
   configuration, resource limits, and supported upgrade behavior.
3. **Agree the TURN integration contract.** Consume the operator's confirmed
   endpoint/authentication settings from section 12.2. Use the existing secret
   management workflow for any application-side signing-secret reference.
   Never put a shared secret in an image, `VITE_*` variable, public configuration
   or logs. Do not copy relay deployment configuration into this repository.
4. **Start/configure signaling inside the application container.** Bind it to
   the existing application listener (0.0.0.0:8080 in the container),
   configure the game origin, room/connection limits, TURN URLs/secret reference,
   credential expiry, and 15-second reconnect grace. Do not make the service
   port public.
5. **Preserve application routing.** Keep the
   existing Traefik game HTTP router. Route the game-origin `/api/` and `/signal`
   endpoints in Node before static-file delivery, with no HTML catch-all. Relay routing remains
   independently managed.
6. **Configure the browser's public connection settings.** Supply only public
   endpoint/version information, with temporary TURN credentials fetched from
   authenticated room membership at runtime. Review CSP and explicitly allow
   `wss://low-pass.biggsea.us` if required; do not broaden it to arbitrary
   origins or confuse CSP configuration with TURN firewall configuration.
7. **Run acceptance against the deployed application and existing relay.** Check
   HTTP readiness, invitation/join, actual Edge direct and forced-relay sessions,
   TURN/TLS port sharing if configured, both-player pause/death/reconnect behavior,
   and unchanged single-player records. Use valid temporary test credentials.
8. **Enable multiplayer only after acceptance.** Keep a feature flag or
    deployment configuration that can hide hosting/joining if signaling or relay
    service is not ready. Keep single-player available independently.
9. **Operate and roll back the application through Ansible.** Monitor room counts,
    connection failures, CPU/memory and queue limits. Drain active rooms before
    incompatible updates where possible.
    Roll back compatible game/signaling versions together, revoke/rotate secrets
    if needed, and never clear browser storage as part of rollback.

Proposed configuration contract to finalize with the implementation:

| Configuration | Owner and sensitivity |
| --- | --- |
| Game origin and public WSS/API paths | Public; preserve `low-pass.biggsea.us`. |
| Game/protocol/generator version IDs | Public; used to reject incompatible peers. |
| Confirmed TURN URLs, authentication mode, realm and credential lifetime | Operator-provided integration settings; do not infer them from removed deployment examples. |
| Application-side TURN signing-secret file reference, if required | Secret value remains outside chat, Git and the frontend. |
| Invitation expiry, room capacity, rate/queue limits | Server configuration; numeric budgets established in the spike. |
| Reconnect grace | Server/client protocol setting fixed at 15 seconds. |
| Readiness/liveness, logging retention and redaction | Operational contract; no room codes, tokens, SDP, or raw ICE addresses in normal logs. |

## 13. Implementation phases and exit criteria

These are dependency-ordered work packages, not calendar estimates. Canyon
planning and network fairness need empirical evidence before a credible schedule
can be produced.

| Phase | Work | Exit criterion |
| --- | --- | --- |
| 0. Baseline and specification | Capture existing behavior, settle deployment facts, define protocol/state-machine vocabulary and prototype metrics. | Solo behavior/records documented; confirmed rules and remaining measurement decisions are explicit. |
| 1. Local paired-flight feasibility | Two aircraft, shared targets, independent drops/scores, all terrains, locally driven inputs; prototype guest camera and finale planning. | Both slots satisfy trajectory/visibility/window requirements across tiers and sequential canyon passes, without terrain changes or release lockouts. |
| 2. Transport/infrastructure spike | Small signaling service, code admission, native WebRTC channels, coturn, and a separately authorized Ansible-managed test deployment. | Two Windows Edge computers on different home networks connect; TURN works when direct paths are unavailable; failure states are understandable. |
| 3. Simulation extraction | Separate session/player/presentation, immutable serializable plans, shared scheduler, authoritative event creation; retain solo adapter. | Engine-independent two-player lifecycle works, and solo behavior/storage remain unchanged. |
| 4. Replication and fair input | Plan transfer, tick/time mapping, speculative local release, authoritative replay/settlement, snapshot correction, event deduplication. | Same accepted release pose/time produces the same score through direct and relayed latency/loss profiles; no duplicate outcomes. |
| 5. Full presentation | Multiple models/effects, HUD, shared wreck, remote bomb visibility, audio policy, local quality settings, rebasing/streaming. | Both screens show consistent scores/events and readable formation; resources stay bounded through long runs. |
| 6. Lifecycle and records | Per-player death, survivor continuation, spectating, dual-ready pause/countdown, 15-second recovery, incomplete results, separate store. | Either death order, near-simultaneous deaths, pauses, reconnects, and duplicate final messages behave correctly. |
| 7. Infrastructure handoff and acceptance | Protocol bounds, monitoring contract, build compatibility and image publication here; firewall/TURN quotas and rollout through the separate Ansible repo when authorized; two-PC Windows Edge acceptance. | All three terrains pass the authorized deployment/network matrix, with documented operating limits. |
| 8. Release | Feature gate, help/controls/privacy/deployment contract, rollback instructions, and staged enablement through Ansible. | Single-player remains independently usable; multiplayer can be disabled without deleting scores or breaking static hosting. |

Phases 1 and 2 can proceed independently. Do not wait until polished lobby UI to
discover that the follower cannot make a fair canyon attack.

### Suggested file boundaries

| Path | Planned change |
| --- | --- |
| `src/game/session.ts`, `src/game/player.ts` | Shared session and per-player simulation/lifecycle. |
| `src/game/formation.ts`, `src/game/canyon-flight.ts` | Paired target/track planning and full-motion scheduling. |
| `src/game/run.ts` | Reuse/extract existing helpers and retain a solo-compatible path; avoid a wholesale unrelated rewrite. |
| `src/simulation/flight-track.ts` | Validated track DTO serialization/rehydration and independent returned poses. |
| `src/network/` | Browser signaling, peer transport, clock, protocol application, replica/reconciliation, and diagnostics. |
| `shared/protocol/` | Shared versioned schemas/types used by the browser and signaling service; no DOM/Babylon imports. |
| `server/` | Room/signaling HTTP/WSS service, capability/credential issuance, quotas and health. |
| `src/main.ts` | Controller-mode wiring; remove global-screen ownership of shared session progression. |
| `src/rendering/world.ts`, `src/rendering/combat-effects.ts` | Multi-entity view state and host-authored event presentation. |
| `src/ui/`, `src/input/`, `src/audio/` | Lobby, two-score HUD, spectator/pause UX, key gating, per-view sound. |
| `src/storage/multiplayer-records.ts` | Separate validated and idempotent records, preserving original storage. |
| `tests/unit/`, `tests/e2e/`, proposed server tests | Planner, protocol, lifecycle, real transport, deployment acceptance. |
| Existing Dockerfile and local-only test orchestration if needed | Node-only application image, tested lifecycle, and isolated development tests; do not replace the Ansible production workflow. |
| Separate Ansible repository (handoff only) | Required image tags/digests, service configuration, secret names, listeners, proxy routes, health, limits, rollout, and rollback. No edits or deployment during this research. |
| `package.json`, lockfile, TypeScript/ESLint configuration | Separate client/server/shared builds, new scoped dependencies, server lint/test coverage. |
| `.github/workflows/container.yml` or a scoped additional workflow | Validate both code outputs in the evolving application image; publish only when authorized, with verified action pins and minimal permissions. |
| `README.md`, deployment documentation, license-copy scripts as needed | Updated controls, architecture, ports, setup, troubleshooting, notices, and data/privacy explanation. |

Do not introduce Python tooling, downloaded runtime assets, external asset CDNs,
or a new rendering engine for this work.

## 14. Verification plan

### 14.1 Pure simulation and protocol tests

- Shared-target selection remains deterministic and tank/radar/SAM chances remain
  independent of player outcomes.
- Both players can score the same target, including a destroyed model; a first
  miss does not prevent the second hit.
- One release per player/encounter, no repeats/held-key carryover, one outcome per
  attempt, cumulative misses, and no damage-derived extra miss.
- Authoritative bomb contact matches prediction for ground, water, wall, edge,
  and high-speed cases; water never scores through an X/Z-only radius check.
- Both trajectory plans pass the section 8 checks and remain valid after either
  player dies.
- Plan DTO round trips preserve poses/derivatives/timings; malformed, oversized,
  incompatible, non-finite, duplicate, and out-of-order messages are handled
  explicitly without corrupting state.
- A scripted accepted input at an identical plan time gives identical
  authoritative outcomes at zero latency and under the supported network profile.
- Late input near cutoff cannot follow an already-persisted timeout elimination.
- Snapshot/event reordering cannot undo a result; reconnect replay cannot
  duplicate scores, sounds, craters, damage, or record writes.
- Pause/epoch transitions preserve ended-player status and reject stale releases.
- Existing single-player records/settings survive hosting, joining, rematching,
  multiplayer completion, abort, and invalid multiplayer storage.

### 14.2 Browser and network matrix

Use isolated browser contexts or processes for separate player storage/identity.
Two tabs in one browser are not sufficient evidence: the game's focus-loss pause
can itself stop the other tab. End-to-end visibility/pause tests need deliberately
controlled foreground state and final checks on two physical computers.

| Scenario | Required observation |
| --- | --- |
| Direct P2P across two home networks | Both load the same course; selected ICE candidate-pair stats confirm the actual route. |
| Forced TURN (`iceTransportPolicy: 'relay'` in a test configuration) | Both play with relay candidates, not an accidental direct success. |
| UDP blocked | Test TURN over TCP/TLS, including 443 if deployed; report unsupported networks rather than hanging. |
| Symmetric/CGNAT, double NAT, IPv4/IPv6 combinations | Verify traversal or clear relay/error behavior using real networks or an isolated test environment. |
| Latency/jitter/loss | Sweep proposed RTT cases 0/50/100/200/400 ms, jitter and packet loss; establish a supported envelope rather than promising all cases are fair. |
| Short outage and expiry | Recover within 15 seconds to paused/readiness; expire beyond the deadline with no winner or unfinished score entry. |
| Host dies first / guest dies first | Survivor continues unchanged; destroyed player watches; host authority persists in either order. |
| Close/reload host | Match ends promptly when notified, otherwise by failure detection; no migration or new seeded run. |
| Pause during release, damage, finale, countdown, and spectating | Both freeze consistently; both ready to resume; no stale key release. |
| Different quality/aspect settings and viewport resize | Same collision/scoring, fair acquisition, correct host-selected theme, readable remote drop. |
| Long canyon run and origin rebases | Both planes/effects/targets remain aligned; bounded chunks, meshes, textures, queues, plans, and caches. |
| Stale client build / server restart / unavailable TURN | Explicit compatibility/recovery/service errors; solo remains usable. |

Browser HTTP interception or "offline" emulation does not by itself establish
real WebRTC packet loss or TURN reachability. Use a deterministic fault-injection
transport for application tests and isolated network namespaces/test hosts for
actual packet shaping. Do not change the shared VPS's network rules or apply
system-wide traffic shaping merely to run a test.

Update the e2e external-request allowlist narrowly for the configured signaling
endpoint; game assets must stay local. WebRTC traffic needs RTC stats/server
observability in addition to Playwright HTTP request assertions.

### 14.3 Real Windows Edge and deployed-image acceptance

Run existing build/unit/lint/asset checks as applicable, then the extended
Chromium suite. Finally exercise the actual deployed containers with `TEST_URL`
and two Windows Edge computers on different networks, after the separately
authorized Ansible deployment. These are future acceptance steps, not permission
to deploy or probe production during this research.

Record Edge/Windows versions, GPU/driver, resolution, graphics quality, frame-time
distribution, RTT/jitter, selected candidate types, relay traffic, and sustained
memory/resource counts. Inspect screenshots/recordings of both cameras for all
three terrains, shared wrecks, two bombs/effects, either death order, and
spectating. Chromium-only results are not Windows Edge acceptance, and two
aircraft do not imply a guaranteed 60 FPS.

## 15. Risks and explicit non-goals

| Risk | Mitigation / decision gate |
| --- | --- |
| Follower cannot reach the same canyon shelf fairly | Local paired planner spike first; bounded candidate search, true intercept/clearance/window checks. |
| Network timing changes accuracy | Pose/time-referenced release, identical host/guest input convention, bounded replay/settlement, measured uncertainty. |
| Lead drop is hidden by bend, smoke, or distance | Validate actual follower camera across useful release times and damage states; tune formation, not scoring radius or lockouts. |
| Host death accidentally stops guest | Separate session authority from player lifecycle and screen state; test both death orders. |
| Browser freezes before sending pause | Freshness checks, server leases, bounded recovery, no guaranteed background execution claims. |
| Duplicate/reordered events corrupt records or effects | Session epochs, sequences, stable player/encounter IDs, idempotent settlement and storage. |
| TURN works in a lab but not on VPS | Verify advertised addresses, relay ports, firewall, TLS, and real forced-relay sessions from outside. |
| TURN/room endpoint becomes an abuse target | Admission, expiring credentials, quotas, rate limits, restricted relay destinations, redacted diagnostics. |
| Different builds silently diverge | Version/hash handshake and acknowledged plans; fail before starting incompatible peers. |
| Multiple models/plans cause unbounded growth | Derived overlap caps, pooled effects, independent render origins, queue/plan expiry, sustained-run measurements. |

Out of scope for this version: accounts, matchmaking, public rankings,
competitive anti-cheat, voice/text chat, player steering, friendly fire, aircraft
collision/crashes, more than two participants, host migration, reload restoration,
server-authoritative physics, globally synchronized records, or generated terrain
editing during play.

The recommended decision is to proceed with the two early spikes: **paired
flight feasibility across all terrains** and **native WebRTC plus self-hosted
signaling/coturn across real networks**. Their evidence should determine the
remaining numeric budgets and implementation schedule.

## 16. Research references and evidence boundaries

Public references were checked during this research on 2026-09-13. Browser/API
and proxy documentation establish available mechanisms, not proof that the
current VPS configuration or an actual Edge network path has been tested.
Repository findings in section 3 come from direct code inspection; this research
did not modify gameplay, inspect private server configuration, or deploy services.

| Reference | What it supports |
| --- | --- |
| [S1: Snapshot Interpolation, Glenn Fiedler / Gaffer on Games][S1] | Primary technical explanation of snapshot sequencing, jitter buffers, interpolation and determinism tradeoffs. Its example rates are not performance claims for this game. |
| [S2: `ws` license][S2] | MIT licensing for the proposed signaling WebSocket library. |
| [S3: Zod license][S3] | MIT licensing for the proposed shared runtime-validation library. |
| [S4: Using WebRTC data channels, MDN][S4] | Data-only communication, DTLS encryption, message-size/interleaving considerations. |
| [S5: `createDataChannel()`, MDN][S5] | Ordering and partial-reliability options; retransmission count versus packet lifetime. |
| [S6: `RTCSctpTransport.maxMessageSize`, MDN][S6] | Negotiated maximum message size rather than a universal fixed browser limit. |
| [S7: `bufferedAmountLowThreshold`, MDN][S7] | Application backpressure and low-water notification. |
| [S8: `restartIce()`, MDN][S8] | ICE restart requires renewed offer/answer negotiation. |
| [S9: PeerServer README][S9] | Signaling server scope; gameplay data is not proxied through PeerServer. |
| [S10: `simple-peer` README][S10] | Wrapper APIs, external signaling, ICE configuration, and channel options. |
| [S11: WebTransport, MDN][S11] | Browser-to-server streams/datagrams, not browser-to-browser listening. |
| [S12: coturn example configuration][S12] | Listeners, relay transports/ports, NAT mapping, quotas, and peer restrictions. Treat options as version-sensitive. |
| [S13: coturn server manual][S13] | TURN REST temporary-credential formula and authentication configuration. |
| [S18: Page Lifecycle API, Chrome for Developers][S18] | Frozen/discarded page limitations in Chromium; not a promise about every Edge lifecycle event. |
| [S19: RFC 8827, WebRTC Security Architecture][S19] | DTLS, signaling/application trust, and peer address-privacy boundaries. |
| [S20: MDN WebRTC browser-compatibility data][S20] | Edge API support evidence; actual Edge networking tests still required. |
| [S21: coturn license][S21] | BSD-style redistribution terms; use the text rather than guessing from repository metadata. |
| [S22: PeerJS channel-negotiation implementation][S22] | Reviewed wrapper option mapping; pin/recheck the released implementation before relying on it. |

[S1]: https://gafferongames.com/post/snapshot_interpolation/
[S2]: https://github.com/websockets/ws/blob/master/LICENSE
[S3]: https://github.com/colinhacks/zod/blob/main/LICENSE
[S4]: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels
[S5]: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/createDataChannel
[S6]: https://developer.mozilla.org/en-US/docs/Web/API/RTCSctpTransport/maxMessageSize
[S7]: https://developer.mozilla.org/en-US/docs/Web/API/RTCDataChannel/bufferedAmountLowThreshold
[S8]: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/restartIce
[S9]: https://github.com/peers/peerjs-server#readme
[S10]: https://github.com/feross/simple-peer#readme
[S11]: https://developer.mozilla.org/en-US/docs/Web/API/WebTransport
[S12]: https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf
[S13]: https://github.com/coturn/coturn/blob/master/man/man1/turnserver.1
[S18]: https://developer.chrome.com/docs/web-platform/page-lifecycle-api#states
[S19]: https://www.rfc-editor.org/rfc/rfc8827.html
[S20]: https://github.com/mdn/browser-compat-data/blob/main/api/RTCPeerConnection.json
[S21]: https://github.com/coturn/coturn/blob/master/LICENSE
[S22]: https://github.com/peers/peerjs/blob/master/lib/negotiator.ts

Additional compatibility records used for the Edge assessment:
[RTCDataChannel](https://github.com/mdn/browser-compat-data/blob/main/api/RTCDataChannel.json)
and
[RTCSctpTransport](https://github.com/mdn/browser-compat-data/blob/main/api/RTCSctpTransport.json).
Mutable documentation/default-branch links are research references, not version
pins. Recheck the chosen releases when implementation starts.
