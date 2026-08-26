# Native Linux Deployment Hardening — Phase 4 (Redis Startup Investigation)

Real runtime evidence, from a real Ubuntu 24.04 VM, first time in this engagement:

```
Type=forking
ExecStart=/usr/bin/redis-server /etc/redis/redis.conf
PIDFile=/run/redis/redis-server.pid

redis.conf:
daemonize yes
supervised no

systemd:
Can't open PID file /run/redis/redis-server.pid (yet?) after start: Operation not permitted
... start operation timed out
```

## Disclosure up front

I do not have shell access to the VM that produced this evidence — no SSH, no way to run
`systemctl show redis-server`, `journalctl -u redis-server`, `ls -la /run/redis`, or manually
start `redis-server` as the `redis` user myself, all of which the task correctly asked to be
inspected before proposing a fix. What follows is the most rigorous determination possible
without that access: an exhaustive audit of every line of code in this deployment layer that
could plausibly touch the paths in question, combined with the exact, textbook-documented
mechanism this specific error message maps to. The proposed fix is designed to be correct and
safe regardless of exactly which upstream mechanism is at fault, and is disclosed as reasoned,
not observed. **If a session with real VM access can run the five commands the task listed,
that would upgrade this from "well-reasoned" to "confirmed" — recommended as the concrete next
step, not skipped as unnecessary.**

## Root cause

**`/run` is `tmpfs` — wiped empty on every reboot.** `/run/redis` is not part of the
persistent filesystem; something has to recreate it every single boot before
`redis-server.service` starts. On Debian/Ubuntu, that "something" is the `redis-server`
package's own systemd integration (a `RuntimeDirectory=`/`tmpfiles.d` mechanism, applied by
`systemd-tmpfiles-setup.service`, which runs **once, early in boot** — not on every service
start).

`install.sh` runs `apt-get install redis-server` mid-session, on an **already-booted**
machine, with **no reboot anywhere in the installer's flow** (confirmed by reading the entire
`install.sh`/`update.sh`/`recover.sh` — none of them ever call `reboot`, `systemctl
reboot`, or otherwise cycle the machine). The boot-time `systemd-tmpfiles-setup.service` pass
already ran, once, before `redis-server` was ever installed on this machine — so `/run/redis`
was never created this session, and won't be until the *next* reboot.

`redis-server.service` runs as `User=redis` (an unprivileged system account) —
per the evidence, `Type=forking` with `daemonize yes`, meaning redis-server itself, not
systemd, is responsible for writing its own PID file to the path `PIDFile=` names. Redis
cannot create `/run/redis` itself (`/run` is root-owned, mode 755 — a non-root process cannot
create a directory there), so if `/run/redis` doesn't exist, the resulting attempt to write
`/run/redis/redis-server.pid` fails exactly as reported: `Operation not permitted`. This is
not a permissions bug in *our* config — it is the textbook, widely-documented Debian/Ubuntu
`redis-server` behavior when the package is installed without an intervening reboot.

## Tracing the failure — install.sh through systemd to the filesystem

```
install.sh main()
  ├─ run_phase "create_system_user"        # creates the `supreme` system account — unrelated
  ├─ run_phase "create_directories"        # only touches SUPREME_*_DIR — confirmed, see below
  ├─ run_phase "persist_secrets"           # umask 077, scoped to a subshell (Phase 2 fix) —
  │                                        # cannot affect anything after it returns, and
  │                                        # CANNOT survive into a later systemd service
  │                                        # invocation regardless (see "Ruled out" below)
  ├─ run_phase "install_apt_dependencies"  # <-- apt-get install redis-server HAPPENS HERE.
  │                                        #     This is where the `redis` system user,
  │                                        #     /etc/redis, /var/lib/redis, /var/log/redis,
  │                                        #     and the package's systemd unit + its own
  │                                        #     tmpfiles/RuntimeDirectory config all get
  │                                        #     created — by dpkg's postinst, not by us.
  ...
  └─ run_phase "configure_redis"           # sed-edits /etc/redis/redis.conf, then
                                            # systemctl_enable_now redis-server
                                            #   -> systemd tries to START redis-server NOW,
                                            #      in THIS boot session — the one whose
                                            #      boot-time tmpfiles pass already ran,
                                            #      before redis-server existed.
                                            #   -> redis-server (User=redis) tries to write
                                            #      /run/redis/redis-server.pid
                                            #   -> /run/redis doesn't exist
                                            #   -> Operation not permitted
```

## What was ruled out, with evidence

**Our own code touching `/run/redis`, `/var/run/redis`, `RuntimeDirectory`, or `tmpfiles`:**
```
grep -rniE "run/redis|var/run/redis|runtimedirectory|tmpfiles|/run\b" infra/native-linux/*.sh infra/native-linux/lib/*.sh infra/native-linux/config/*.template infra/native-linux/systemd/*.service
```
Zero matches, before this phase's fix. `configure_redis()`'s only action on the real
filesystem was `sed -i` on `/etc/redis/redis.conf` (setting `save`/`appendonly`/`bind`) — it
never touched `/run`, ownership, or the systemd unit itself (that unit is entirely
vendor-provided; this deployment does not render or own a `redis-server.service`).

**Phase 2's `persist_secrets()` umask leak, or Phase 3's `build_workspace()` CWD leak,
indirectly causing this:** ruled out on structural grounds, not just "already fixed." Both
leaks, even in their unfixed form, could only ever affect *`install.sh`'s own process*, for
the remainder of *that single execution*. A `systemd`-spawned service (like
`redis-server.service`, started via `systemctl enable --now` — a completely separate process,
forked by PID 1, not by `install.sh`) does not inherit `install.sh`'s shell umask or working
directory. `systemd` services get their environment from the unit file (`Environment=`,
`UMask=` if set — `redis-server.service`'s own package-provided unit does not source
anything from `install.sh`) and from `systemd` itself, never from the shell that happened to
run `systemctl enable --now`. This is not specific to this bug being already-fixed — it
would have been true even had Phase 2/3 never landed.

**`create_directories()` or any `chown -R` sweep touching `/etc/redis`/`/var/lib/redis`/
`/var/log/redis`:** ruled out by reading every `chown`/`chmod` call in `install.sh`,
`recover.sh`, and `lib/common.sh` — every single one is scoped to a `SUPREME_*_DIR` variable
(`/opt/supreme`, `/etc/supremeos`, `/var/lib/supremeos`, `/var/backups/supremeos`) or an
explicit, single, non-glob path (`nats.conf`, `Caddyfile`, the mosquitto config). None
reference `/etc/redis`, `/var/lib/redis`, `/var/log/redis`, or a wildcard broad enough to
accidentally sweep them in.

**`create_system_user()`'s `supreme` account colliding with the `redis` system user's
UID/GID:** considered and set aside — `groupadd --system`/`useradd --system` both allocate
the next available system UID/GID automatically; `create_system_user()` runs once, early,
and `redis`'s own account is created later by `redis-server`'s postinst, which does the same
auto-allocation — sequential, non-reusing allocation gives no mechanism for a forced
collision. No evidence points here, and the reported error (`Operation not permitted` on a
*specific path*, not a UID-conflict-shaped symptom) doesn't match this class of bug either.

## Why this qualifies as a deployment-layer bug, not just "an environment fact to shrug off"

This phase's own prior acceptance criterion (Phase 2/3) is explicit: *"A brand-new Ubuntu
24.04 installation should become a fully operational SupremeOS controller by running only
`sudo ./install.sh`. No manual intervention should ever be required."* A fresh VM, freshly
imaged, running `sudo ./install.sh` for the first time with no reboot in between, is exactly
the scenario that reliably reproduces this — not an edge case. The *proximate* mechanism
(systemd's boot-time-only tmpfiles pass) is genuinely a Debian/Ubuntu packaging behavior we
don't control, but the *deployment's responsibility* to make a zero-manual-steps install
actually work end to end is ours — so this is fixed here, in the deployment layer, not
dismissed as "not our bug."

## Fix — deployment layer only, no application code touched

New shared function, `ensure_redis_runtime_dir()` (`infra/native-linux/lib/common.sh`), called
from `install.sh`'s `configure_redis()` (before `systemctl_enable_now redis-server`) and from
`recover.sh`'s repair flow (for a controller repaired/restarted after already being live for a
while):

```bash
ensure_redis_runtime_dir() {
  cat > /etc/tmpfiles.d/supremeos-redis.conf <<'EOF'
d /run/redis 0755 redis redis -
EOF
  if command_exists systemd-tmpfiles; then
    systemd-tmpfiles --create /etc/tmpfiles.d/supremeos-redis.conf || log_warn ...
  else
    log_warn ...
  fi
}
```

Two things, deliberately, not one:
1. **A `tmpfiles.d` rule file** — the correct, idiomatic systemd mechanism, so `/run/redis`
   is recreated correctly on **every future boot**, not just once. A one-time `mkdir` during
   install alone would not survive the very next reboot (tmpfs) and would silently
   reintroduce this exact failure — recognized and deliberately avoided.
2. **`systemd-tmpfiles --create` run immediately** — so **this session**, the one that just
   installed the package with no reboot, is fixed right now, not only after a future reboot.

This does not modify the vendor-shipped `redis-server.service` unit, does not touch
`redis.conf`'s `daemonize`/`supervised` settings the task explicitly said not to assume are
wrong (they aren't touched), and is harmless/idempotent if Ubuntu's own package-provided
mechanism turns out to already handle this correctly in some other way — the rule simply
restates the same directory/ownership/mode a correctly-functioning `redis-server` package
would already want.

## Files modified

- `infra/native-linux/lib/common.sh` — new `ensure_redis_runtime_dir()` function.
- `infra/native-linux/install.sh` — `configure_redis()` calls it before enabling the
  service; `validate_phase_configure_redis()` extended to also check the tmpfiles rule exists.
- `infra/native-linux/recover.sh` — repair flow calls it too, for an already-running
  controller.
- `infra/native-linux/tests/deployment-regression.test.sh` — 5 new static assertions (see
  below).

No application code, protocol logic, or driver code was touched, per this phase's explicit
scope.

## Security impact

None. `/run/redis 0755 redis redis` is the same ownership/mode this VM's evidence already
shows the unit expects (`User=redis`/`Group=redis`) — this fix grants nothing beyond what the
service already runs as. No `chmod 777` used. The `tmpfiles.d` rule file itself is
root-owned, default mode (not writable by `redis` or `supreme`).

## Regression prevention

Added to `infra/native-linux/tests/deployment-regression.test.sh` (new section, 5
assertions, run via `bash infra/native-linux/tests/deployment-regression.test.sh` — no root,
no real systemd required, doesn't write to the real `/etc/tmpfiles.d` on whatever machine
runs the test):
- `ensure_redis_runtime_dir()` is defined.
- Its body declares exactly `d /run/redis 0755 redis redis -` (static content check against
  the real function source, not a live write).
- `install.sh` and `recover.sh` both call it.
- It's called **before** `systemctl_enable_now redis-server` in `install.sh` — ordering
  matters here (calling it after would defeat the entire fix), verified by line-number
  comparison against the real source.

All 50/50 assertions in the full suite pass (45 carried over from Phase 2/3, 5 new).

## What remains unverified — honest status

Per this task's own request, the following require real VM access this session did not have,
and are recommended as the concrete next step rather than silently skipped:
- `systemctl show redis-server` / `systemctl cat redis-server` — to see the *exact* live unit
  and rule out an unexpected drop-in or override this investigation's static analysis
  couldn't see.
- `journalctl -u redis-server` — full failure log, to confirm no second, unrelated error is
  also present.
- `ls -la /run/redis /var/run/redis /var/lib/redis /var/log/redis /etc/redis` — to directly
  observe the ownership/existence state this report inferred rather than read.
- Manually starting `redis-server` as the `redis` user (`sudo -u redis redis-server
  /etc/redis/redis.conf`) — the single most direct confirmation of this exact hypothesis.
- Confirming, after this fix, that `redis-server` reaches `active (running)`, listens on
  `6379`, and that a subsequent `sudo reboot` + re-check still shows it healthy (proving the
  `tmpfiles.d` rule, not just the immediate `--create` call, is what's carrying it across
  boots).
