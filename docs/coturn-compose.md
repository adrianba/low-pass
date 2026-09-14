# Separate coturn container: Compose and abuse prevention

The selected layout is **one Nginx/Node game container plus a separate
`coturn/coturn` container**, on the existing host/public IP. Ansible in the
other repository owns deployment, secrets, certificates and firewalls.
Nothing in this guide deploys or authorizes changes to that host.

**Current limitation:** the game still has multiplayer disabled and cannot issue
TURN credentials. This guide prepares the relay side of the future integration;
it does not enable playable multiplayer or satisfy G0/G2 acceptance. Keep the
relay profile/firewall closed until configuration and authorization have been
verified. Never compensate for the missing issuer by allowing anonymous TURN or
putting a permanent password in the browser.

## 1. Files and network layout

Use these examples as input to the Ansible deployment, not as an additional
Compose project on top of the existing running game:

- [`compose.yaml`](../examples/multiplayer/compose.yaml): game and optional relay
  services, separate networks, mounts, hardening, limits and exact port mapping.
- [`turnserver.conf.j2`](../examples/multiplayer/turnserver.conf.j2): Ansible
  template for a **private generated configuration containing the shared secret**.

The Compose example assumes Traefik's Docker provider and an existing external
Traefik network. Merge its game section into the existing deployment. Preserve
the existing router name, HTTPS entrypoint, certificate resolver and any other
required labels rather than creating duplicate routers. If Traefik uses a file
provider or externally provisioned certificates, retain that working route and
certificate configuration instead of copying the example's resolver labels.
Keep the browser origin `https://low-pass.biggsea.us` unchanged.

Nginx's 8080 port is reachable by Traefik on the existing network, not published
directly to the internet. Node's 8081 remains private inside the game container.
The game does not depend on coturn health/startup; solo remains usable without it.

Coturn uses a separate IPv4 bridge with a fixed container address. It is not on
the application/Traefik network. A small, **port-preserving** published UDP range
avoids host networking and its broader access to host services. Host networking
is an upstream recommendation for large ranges, not a TURN requirement.
If the deployment later needs a much larger range, re-evaluate networking and
isolation explicitly rather than silently switching to host networking.

Set these non-secret Compose inputs through Ansible or a local, uncommitted
operator environment file:

| Input | Meaning |
| --- | --- |
| `LOW_PASS_IMAGE` | Tested application image tag/digest for the intended host architecture; do not assume this branch is published as `latest`. |
| `TRAEFIK_NETWORK` | Existing Docker network shared with Traefik. |
| `TRAEFIK_HTTPS_ENTRYPOINT` | Existing HTTPS entrypoint name. |
| `TRAEFIK_CERT_RESOLVER` | Existing resolver, only if that is how the existing game certificate is configured. |
| `TURN_SUBNET` | Private subnet verified not to overlap host, VPN, LAN or other Docker routes. |
| `TURN_RELAY_IP` | Free fixed address within that subnet; use the same value for Ansible's `low_pass_turn_relay_ip`. |
| `TURN_BIND_IP` | IPv4 address actually assigned to the Docker host for published ports. Behind provider NAT this can differ from the public IP. |
| `TURN_CONFIG_FILE` | Absolute host path to the rendered private config, not the `.j2` source. |
| `TURN_CERT_DIR` | Absolute host directory holding readable `fullchain.pem` and `privkey.pem`. |

For example, `172.30.240.0/24` with `172.30.240.2` is illustrative only; check
overlap before choosing it. Supply the actual public IPv4 as
`low_pass_turn_public_ip`. `external-ip=PUBLIC/CONTAINER` advertises that public
address while binding the container address. Docker and any upstream NAT must
map every relay port to the **same numbered public port**.

Create an unproxied DNS A record for `turn.low-pass.biggsea.us` pointing at that
public IPv4. This example deliberately does not support IPv6 listeners/relays;
do not publish an AAAA record until IPv6 routing, firewall rules and ICE are
implemented and tested. IPv6-only client networks are not claimed supported.

## 2. Secret and certificate handling

Generate a distinct high-entropy secret, for example 32 random bytes encoded as
64 hex characters, in the Ansible secret store. It is **not** the hosting access
code, a room invitation, an ordinary TURN user password or a TLS private key.
Ansible should assert exactly 64 hex characters before rendering. The required
variables are `low_pass_turn_secret`, `low_pass_turn_public_ip` and
`low_pass_turn_relay_ip`; validate both IP values as IPv4 addresses too.

Render the template with `no_log: true` and `diff: false`. Protect the rendered
config as a secret: owner UID/GID `65534:65534`, mode `0400`, parent directories
appropriately restricted. The source template's `mandatory` filters catch
missing variables, but do not replace validation for empty/malformed values.
Never mount the unrendered template or commit the rendered file.

The official Alpine image runs as UID/GID 65534. Its bind-mounted config and key
must be readable by that container user; account for any user-namespace remapping
and SELinux policy. Do not solve a permission problem with root, `privileged`,
world-readable keys or a Docker socket mount. Bind mounts use
`create_host_path: false` so a missing source is not silently created as a directory.

Provide a publicly trusted certificate covering `turn.low-pass.biggsea.us`,
including its intermediate chain. Keep the private key mode `0400`, readable by
the same container UID. Ansible/ACME tooling manages issuance and renewal;
coturn does not issue certificates. Traefik's `acme.json` is not a PEM certificate
directory and must not be mounted wholesale into coturn.

Mount a dedicated managed directory rather than individual changing certificate
inodes. If the ACME deployment uses symlinks, make their targets available within
the mount or have Ansible copy the active chain/key into this directory. After
renewal, use a controlled coturn restart and verify the served chain. Do not
assume SIGHUP reloads TLS material: upstream documents it for log reopening.
Relay restarts interrupt allocations even though the game image stays running.

The future Node issuer will need the **same secret value** via a separate
read-only secret file. Do not mount the whole coturn config or private key into
the game container. Its secret-file/configuration API is not implemented yet;
no invented `LOW_PASS_TURN_*` variables are added to this example.

Keep encrypted-at-rest backups and renewal/rotation automation in the existing
secret-management workflow. Ordinary Compose bind mounts or file-backed secrets
do not encrypt their host source files. A container administrator or root on the
host can read them; this setup is not an isolation boundary against that operator.

## 3. Authentication and resource limits

`use-auth-secret` enables coturn's timestamped REST-credential authentication.
Use it instead of combining static `user=` accounts, `no-auth` or a separate
`lt-cred-mech` setting. No credential-generation HTTP endpoint is needed in coturn.
Only the future protected application service should issue:

```text
username   = "<expiry-unix-seconds>:<opaque-participant-id>"
credential = Base64(HMAC-SHA1(sharedSecret, username))
```

Generate the HMAC over the **hex secret string itself**, not hex-decoded bytes,
if that string is what `static-auth-secret` contains. Keep clocks synchronized.
Credentials are bearer credentials: their holder can use the allowed relay
service, not just a particular room or the Low Pass origin.

Before public activation the application must verify the separate hosting access
code, atomically limit rooms to two admitted players, and gate credential issuance
and refresh on valid membership. Apply per-source, per-room and global limits to
hosting-code attempts, room creation, join attempts and credential issuance.
Two attacker-controlled browser sessions must not create a free credential
vending service. Frontend hiding, Origin checks or a hard-to-guess invitation are
not substitutes for hosting authorization. Guests never receive the hosting code.

An initial credential lifetime around ten minutes can be evaluated at G2, with
refresh before expiry while membership remains valid. The client must apply new
credentials through the tested ICE restart/recovery path; replacing a JavaScript
configuration object does not refresh existing allocations automatically.
Credential expiry/revocation is not guaranteed to kill every existing allocation
immediately. In an abuse incident, stop issuance, block the offending traffic and,
if necessary, restart coturn; secret rotation/restart can disrupt both players.
Never leave an old secret accepted indefinitely.

The template sets deliberately small **initial operating limits**, not measured
game capacity or performance guarantees:

| Control | Initial value and interpretation |
| --- | --- |
| `user-quota` | 4 simultaneous allocations per coturn-accounted user. |
| `total-quota` | 16 total allocations; global protection still matters when callers obtain additional identities. |
| `max-bps` | 262144 **bytes/second** per session; input and output are treated separately. Excess can be dropped/suppressed. |
| `bps-capacity` | 4194304 **bytes/second** aggregate allocation capacity, input/output separately; not an exact provider-egress billing cap. |
| `max-allocate-lifetime` | 600 seconds per allocation before refresh, not a ten-minute match limit. |
| Relay range | UDP 49160-49223, 64 ports with identical Docker/firewall/config bounds. ICE transports/restarts can consume multiple allocations. |
| Container limits | 1 CPU, 256 MiB, 64 PIDs, 4096 file descriptors; two relay threads. Re-measure under two-client relay/recovery load. |
| Logs | Warning-level coturn output and bounded Docker log rotation. Logs can still contain IPs/identifiers; restrict access and retention. |

Quotas do not stop unauthenticated packet floods or guarantee a monetary ceiling.
Use provider/host rate limiting and bandwidth alerts too. Do not lift all limits
when ICE fails: inspect quota errors, permissions, advertised addresses and UDP
mapping first. Leave permission/channel lifetimes at their protocol defaults.

## 4. Prevent relay abuse and internal-network access

The template blocks private, loopback, link-local/metadata, carrier-grade NAT,
documentation, benchmarking, multicast/reserved IPv4 destinations and all IPv6
peers, including IPv4-mapped IPv6. It also blocks Azure's special public platform
address. Extend the policy for your provider's metadata/control addresses,
publicly addressed internal systems, management services and other sensitive
destinations. The list is not a permanent exhaustive registry of special addresses.

Do not enable `allow-loopback-peers`, `server-relay`, anonymous authentication,
CLI, web administration or public metrics. An `allowed-peer-ip` entry overrides
a deny entry; do not add a broad allow to make a failed test pass.
The pinned version defaults to CLI/web admin/metrics and DTLS off, and minimum
TLS 1.2. Keep `tlsv1`, `tlsv1_1`, `dtls`, `cli`, `web-admin` and `prometheus`
absent. Older examples use obsolete flags; recheck the pinned version's docs.

`no-tcp-relay` disables **RFC 6062 TCP peer relay endpoints**, not the browser's
TCP/TLS connection to coturn. WebRTC can still use TURN/TCP 3478 or TURN/TLS
5349 with UDP relay sockets. Do not enable `no-udp-relay` for this configuration.

`no-stun` disables standalone STUN Binding service to reduce unauthenticated
reflection/amplification exposure. Authenticated TURN still works; its initial
authentication challenge is expected. Give browsers TURN URLs, not a `stun:`
URL for this instance. Measure direct ICE candidate success at G2; if a separate
STUN service becomes necessary, design and rate-limit it explicitly.
`stale-nonce` alone does **not** authenticate STUN Binding requests.

### Firewall policy: required in addition to coturn's peer ACLs

Implement this policy through the existing provider firewall and the host's
Docker-aware forwarding rules. Docker-published ports can bypass simplistic
host INPUT/UFW rules. Apply equivalent pre-/post-DNAT policy using the actual
iptables/nftables backend; this guide intentionally does not issue host commands
that might break the existing Traefik deployment.

| Direction | Policy |
| --- | --- |
| Internet to game | Keep existing HTTPS 443/ACME handling at Traefik. No public Node 8081 or direct game 8080. |
| Internet to coturn | Allow only UDP/TCP 3478, TCP 5349, and UDP 49160-49223. No UDP 5349, TCP relay range, admin 5766/8080 or metrics 9641. |
| Client replies | Allow established/related return traffic. Initially allow the two friends' known public source IPs for testing where practical. |
| New relay egress | Coturn needs UDP to public peer addresses/ports, including ports outside its own allocation range. Do not restrict all destination ports to 49160-49223. |
| Sensitive destinations | Deny new relay access to host/LAN/VPN/Docker/private/link-local/metadata/multicast/reserved networks and provider-specific public infrastructure. Block new outbound TCP from coturn; TCP relay is disabled. |
| Same-server relay | Allow coturn to reach **its own public IP only at UDP 49160-49223**, and the corresponding exact container/range after DNAT. Deny its other public-IP destination ports. Ensure NAT reflection/hairpin routing actually works. |
| Flood controls | Rate-limit new TCP connections and unauthenticated ingress where supported; cap/alert provider bandwidth. Quotas apply too late to absorb a volumetric DoS attack. |

**Do not blanket-deny the TURN server's own public IP:** both browsers may allocate
on this one server and send to each other's relay candidates. They then need
that public-IP/relay-port path. Conversely, allowing that IP at every port exposes
other UDP services on the host. Coturn's IP-only deny list cannot express this
port-scoped exception, so enforce it in the firewall and test both-peer relay.
Order the narrow post-DNAT relay exception before the broad private-network deny;
never broadly allow the whole Docker subnet.

## 5. Optional TURN/TLS through the existing TCP 443 listener

Start with direct 3478/5349. The Compose example deliberately leaves coturn off
Traefik's network and does not claim shared-443 support.

For the later G2 test, the existing Traefik file provider can route exact SNI
`turn.low-pass.biggsea.us` with **TLS passthrough** to a host address reachable
from Traefik at the published TCP 5349 port. Use the actual existing 443 entrypoint:

```yaml
tcp:
  routers:
    low-pass-turn:
      entryPoints: ["REPLACE_WITH_EXISTING_HTTPS_ENTRYPOINT"]
      rule: "HostSNI(`turn.low-pass.biggsea.us`)"
      service: low-pass-turn
      tls:
        passthrough: true
  services:
    low-pass-turn:
      loadBalancer:
        servers:
          - address: "REPLACE_WITH_REACHABLE_HOST_ADDRESS:5349"
```

Containerized Traefik's `127.0.0.1` is not the Docker host. Verify the chosen
backend route/firewall without adding a broad private-network egress exception
to coturn. No HTTP middleware, certificate resolver or HTTP path proxy handles
the TURN stream; coturn supplies the certificate under passthrough.
Never use a TURN `HostSNI("*")` catch-all or replace the existing game HTTPS route.
TCP routing support does not establish that actual Edge sends usable TURN SNI.

## 6. Operator validation and activation

After Ansible renders and validates its private files, `docker compose
--env-file <operator-env> -f <adapted-compose.yaml> --profile turn config --quiet`
checks Compose structure, **not** coturn authentication or firewall safety.
The `turn` profile is opt-in; no coturn startup is implied by ordinary game-only
deployment. Required interpolation values must still be supplied when validating
this combined example. Have Ansible start/stop the selected services; do not use
the example to replace the live deployment ad hoc.

Before allowing general internet access, verify on the intended AMD64 image/host:

1. Config/key permissions, numeric advertised address and all port mappings;
   startup logs contain no unknown-option, unreadable-key, disabled-TLS or
   missing-secret errors. The container runs unprivileged and without a writable
   root. Do not treat a live process or TCP port as TURN readiness.
2. Authorized, short-lived credentials produce allocations and **bidirectional
   RTCDataChannel traffic**. Wrong-secret, expired and unauthenticated attempts
   cannot obtain usable allocations; distinguish an expected initial 401
   challenge from a successful allocation.
3. Authenticated CreatePermission/ChannelBind attempts toward owned test endpoints
   representing private/loopback/metadata/IPv6 restrictions are denied with no
   forwarded traffic. Do not probe real provider metadata or unrelated systems.
4. Both browsers forced to relay through this same coturn instance work. Prove
   the narrowly allowed public-IP hairpin path and denial of other host services.
5. Force UDP 3478, TCP 3478 and TLS 5349 separately from two Windows Edge computers
   on different networks, including a client-UDP-blocked case. Keep the server's
   relay-side UDP path open. Confirm the selected ICE candidate pair, not just TLS.
6. If testing shared 443, offer **only**
   `turns:turn.low-pass.biggsea.us:443?transport=tcp` with `iceTransportPolicy:
   "relay"`; prove allocation/data and continued normal game HTTPS/WSS.
   Retain 3478/5349 fallback if Edge/SNI fails.
7. Exercise quotas, credential refresh/rotation, disconnect cleanup, certificate
   renewal and relay restart; watch CPU, memory, FDs, allocation counts and
   provider egress. Keep solo play and existing browser records unchanged.

The future in-app diagnostic/issuer is still pending. Until then, use controlled
local diagnostic tooling with temporary credentials, never third-party test
pages that would receive those credentials. Do not publish a diagnostic secret,
test user or public credential endpoint. Roll back by disabling the relay profile
and its firewall/TCP routes through Ansible, leaving the existing game untouched.

### Verified sources and limits of local checking

Image release and multi-platform digest checked on 2026-09-13:
[`docker/4.18.0-r0`](https://github.com/coturn/coturn/releases/tag/docker/4.18.0-r0).
The [official Docker guide](https://github.com/coturn/coturn/blob/docker/4.18.0-r0/docker/coturn/README.md),
[Alpine Dockerfile](https://github.com/coturn/coturn/blob/docker/4.18.0-r0/docker/coturn/alpine/Dockerfile),
[reference configuration](https://github.com/coturn/coturn/blob/docker/4.18.0-r0/examples/etc/turnserver.conf)
and [option parser](https://github.com/coturn/coturn/blob/docker/4.18.0-r0/src/apps/relay/mainrelay.c)
are the authority for the settings above.

The official binary has a `NET_BIND_SERVICE` file capability. On the locally
checked ARM64 image, dropping all capabilities caused `operation not permitted`;
retaining only that bounding capability worked with non-root and
no-new-privileges. It is not permission to add `NET_ADMIN`, host networking or
privileged mode. The game container still drops **all** capabilities.
The explicit binary entrypoint also bypasses the image's default shell argument
expansion and external-IP discovery. Do not put secret values in command arguments
or environment variables.

The example Compose model was validated locally. A rendered template with dummy
credentials, a disposable certificate and loopback-only test addresses started
under the documented resource/security limits, with only TCP 3478/5349 and UDP
3478 listeners. That test used `network: none` and no published ports; the test
container and temporary key/config files were removed afterward.

Local configuration checks are not proof of AMD64 deployment, firewall isolation,
public TLS, NAT reflection, Windows Edge interoperability or abuse resistance
under load. Those remain the operator checks above and the G0/G2 approval gates.
