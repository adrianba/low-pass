# Enhancement guide

## Project and workflow

Low Pass is a single-player desktop browser game: TypeScript, Vite, Babylon.js
WebGL2, and Web Audio. Node.js is build tooling only; production is static files
served by unprivileged Nginx in Docker. The target browser is current Windows
Microsoft Edge. The user confirmed the initial game works there; repeat browser
checks after changes. Do not assume a particular GPU or guarantee 60 FPS.

- Prefer Node 24 LTS, npm, the committed lockfile, and existing helpers.
- Keep changes scoped. Preserve existing local scores and user changes.
- Original code and assets are MIT-licensed; preserve third-party CC0/Apache-2.0
  notices. Never commit credentials, local environment files, generated builds,
  browser traces, or personal paths embedded in editable assets.
- Use **uv for all Python commands and dependencies**; never bare Python/pip.
- Keep runtime assets local and free to redistribute. No external asset CDNs,
  paid assets, accounts, backend, or multiplayer unless explicitly requested.
- Read `README.md` for setup, controls, deployment, and asset reproduction.

```sh
npm ci
npm run dev
npm test
npm run lint
npm run assets:verify
npm run build
npx playwright test --project=chromium
```

Install a missing local test browser with `npx playwright install chromium`.
The build performs strict type checking and copies dependency notices. Playwright
starts Vite preview at port 4173 unless `TEST_URL` points to an existing server.
Use `--project=edge` on a host with Edge installed; installing Edge via Playwright
can overwrite the system browser. Chromium-only results are not Edge validation.

## Where changes belong

| Path | Responsibility |
| --- | --- |
| `src/config/game.ts` | Gameplay constants, difficulty, quality, acquisition distance |
| `src/game/run.ts` | Encounter planning, flight poses, release, score/miss lifecycle |
| `src/simulation/` | Engine-independent math and shared bomb/impact prediction |
| `src/terrain/heightfield.ts` | Canonical triangulated terrain and swept collision |
| `src/game/missile.ts` | Deterministic cosmetic missile trajectories and finale timing |
| `src/rendering/world.ts` | Scene, camera, chunks, origin rebasing, model/effect integration |
| `src/rendering/target-vehicle.ts`, `combat-effects.ts` | Original tank, missiles, explosions |
| `src/ui/`, `src/input/` | Screens, instruments, projected impact reticle, key gating |
| `src/audio/`, `src/storage/` | Gesture-unlocked audio; validated, versioned local records |
| `src/main.ts` | Fixed-step loop, interpolation, screen transitions, persistence wiring |

## Gameplay invariants

- The computer pilots; Space releases **one bomb per visible encounter**. Suppress
  key repeats and held-key carryover. There is no player steering or wind.
- Distance from the concentric target's center determines 1-100 points inside the
  outer radius. Outside, or failing to release before cutoff, is one miss.
  **Three cumulative misses** end a run; hits never erase misses.
- Physics and the predictor share launch transforms, velocity, fixed-step
  integration, and first terrain contact. The tank is visual, not a new collider.
- Current difficulty reaches speed 350 on pass 13. When changing speed/jinks,
  validate actual successful-release windows, dive completion, visibility range,
  terrain clearance, and chunk coverage at every supported tier.
- Pass transitions must carry the full `Pose` (including velocity/acceleration),
  not just position. `joinMotion` preserves these at joins; dive entry starts
  from current motion, bank uses actual acceleration, and rendering interpolates
  attitude as well as position. Keep this continuity when changing flight paths.
- Preserve terrain triangle orientation and sampling consistency. Simulation uses
  world coordinates; rendering subtracts the rebased origin from every relevant
  object. Decorative props must not obstruct the open flight/target corridor.
- The HUD impact reticle projects the true impact point and overlays the aircraft.
  Keep it legible across resolutions and hide it when assistance/release is off.

## Lifecycle and persistence traps

- Successful hits can trigger harmless missile flybys. The first two misses
  trigger survivable strikes and persistent, progressively heavier smoke; neither
  effects nor damage add extra misses or change flight physics. Hits do not repair
  damage. Smoke uses a bounded pool and must freeze on pause and clear on restart.
  Share the original alpha-enabled cloud texture between smoke materials:
  Babylon's `RawTexture.clone()` loses `hasAlpha`, exposing square sprite edges.
  Keep smoke alpha-blended, depth writes disabled, and billboard rotation on Z only.
  `Run.status` becomes `over` on the third miss, and the completed score is saved
  **once immediately**, before the UI's `ending` missile/explosion sequence.
- UI `ending` is presentation, not resumed gameplay. Pause/focus loss must freeze
  it; resume must not set an already-ended run back to `running`.
- Restart restores the aircraft/tank and clears missiles, particles, input,
  encounter/result IDs, and presentation state. Dispose transient meshes and
  audio voices; keep long-run resource counts bounded.
- `low-pass.records.v1` stores the top 10 completed runs and settings. Any use of
  assistance marks the run assisted. Do not count abandoned active runs.
  Validate stored data and surface failures without blocking session play.
- Preserve the deployment origin: browser storage is origin/profile-specific,
  not a Docker volume. Never silently reset records for a gameplay adjustment.

## Assets and validation

Editable aircraft: `art/kestrel.blend`; generator: `scripts/build-aircraft.py`.
`npm run assets:aircraft` uses uv with `/usr/bin/python3` and NumPy to match the
Debian Blender installation. Other Blender builds need a compatible interpreter;
do not substitute a standalone Python standard library into system Blender.
Ordinary application builds do **not** need Blender or Python.

External texture provenance/checksums live in `public/assets/manifest.json`;
notices are in `public/assets/credits.txt`. Use
`node scripts/verify-assets.mjs --write` only after intentional, licensed asset
changes. Preserve sources and update notices, not just checksums.

Add focused Vitest coverage for rules/trajectories; NullEngine tests can verify
procedural geometry and effect cleanup without a browser. Extend Playwright for
visible behavior, keyboard input, finale/pause/restart, persistence, and errors.
E2E uses Low graphics at a small viewport for software-rendered CI, not as a
performance benchmark. Inspect screenshots when changing visuals.

Build/test before replacing a running preview. `docker compose up --build`
serves port 8080 with `/healthz`; a session may instead have an attached
`docker run` container. Identify it first and do not stop unrelated containers.
After updating, verify health and exercise the actual container using `TEST_URL`.
`.github/workflows/container.yml` publishes linux/amd64 images to GHCR on main
pushes. Keep action pins at verified release SHAs and token permissions limited
to source reads and package writes. Do not add personal registry credentials.
