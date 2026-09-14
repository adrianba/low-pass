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
Production builds include the MIT and Babylon.js license texts under `/licenses/`.
The application container also includes notices for Node.js, Nginx, s6,
skalibs and execline at that path.

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

### Optional application service (multiplayer preparation)

Single-player builds and play remain independent of this service. The Node 24
runtime is preparation only: it does not create rooms, signal peers, issue relay
credentials, or enable multiplayer.

```sh
npm run build:server
npm run start:server
```

It binds only to `127.0.0.1:8081`. `GET /livez` reports process health;
`GET /readyz` reports HTTP-service readiness, **not multiplayer availability**.
`GET /api/multiplayer/capabilities` returns
`{"multiplayer":false,"reason":"not_implemented"}`. Responses are uncached JSON;
unknown routes (including `/signal` and room endpoints) return 404. SIGTERM and
SIGINT stop accepting connections, drain requests, then close remaining HTTP
connections at the shutdown deadline with a warning.

| Environment variable | Default | Accepted values |
| --- | --- | --- |
| `LOW_PASS_SERVICE_PORT` | `8081` | Integer 1-65535; loopback only |
| `LOW_PASS_SHUTDOWN_TIMEOUT_MS` | `5000` | Integer 1-30000 |
| `LOW_PASS_MULTIPLAYER_ENABLED` | `false` | Only `false` in this build |

Invalid configuration exits with code 78 rather than silently enabling or
disabling a feature. No secrets are needed at this checkpoint.
`npm run test:server` exercises real local HTTP and independently compiled ESM
startup/shutdown; these tests are also included in `npm test`.

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
The multi-stage image serves static files with unprivileged Nginx and runs the
optional Node 24 service on private loopback, supervised by s6. Multiplayer is
still disabled. It needs no GPU, database, secrets, or persistent server volume.
The client performs all rendering, simulation, and audio. Single-player remains
available if Node fails or its configuration is invalid.

The runtime listens on port 8080 and exposes `/healthz`. A hosting reverse proxy
should terminate HTTPS. Keep a stable public origin to retain users' local scores.
Only content-hashed JS/CSS gets immutable caching; HTML and unversioned assets
revalidate. Missing assets return 404, not an HTML fallback. All runtime assets and
dependency notices ship in the image; no external asset CDN is used.

Keep the read-only root, writable `/tmp` tmpfs (which may remain `noexec`),
dropped capabilities and no-new-privileges setting. Allow **45 seconds** for
container shutdown. The image still runs as UID/GID `101:101`. Its entrypoint now
starts s6, not the vendor Nginx entrypoint; do not override its command.
`/api/multiplayer/readyz` checks Node separately from static `/healthz`; it does
not indicate that multiplayer is playable.

See the [G0 container handoff](docs/application-container-checkpoint.md) for
the exact configuration contract, local checks, Ansible-owned deployment
validation, architecture limitation and rollback.
The selected separate `coturn/coturn` deployment is covered by the
[Compose and relay-hardening guide](docs/coturn-compose.md), including example
files for the Ansible handoff. The current game does not issue TURN credentials.
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

For the isolated container lifecycle/proxy checks (Docker required):

```sh
docker build -t low-pass:multiplayer-g0 .
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
`src/simulation/flight-track.ts` separates path geometry from real traversal time.
It anticipates bends, limits acceleration, joins full motion with quintic curves,
and bounds the entire interpolated velocity curve using Bezier control hulls.
The 350 ceiling applies to the actual 3D vector, not just forward velocity.
Release remains at planned time zero; acquisition, dive, cutoff and recovery have
explicit per-encounter times. HUD and audio use the same speed definition.
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
