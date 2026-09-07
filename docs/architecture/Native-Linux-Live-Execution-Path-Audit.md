# Live Execution Path Audit — Runtime Context Contradiction

## Disclosure: what this audit can and cannot verify directly

This session runs in a local Windows/Git-Bash development environment with **no access to
your real Ubuntu machine** — no SSH, no remote shell, nothing. Every previous "reproduction"
in this engagement was run against this local checkout, not your machine. I cannot read your
machine's filesystem, and I will not present a guess as if it were a measurement.

What follows is (1) a definitive, evidence-backed explanation for the contradiction, found by
auditing **this repository's own git history** — not your machine — and (2) an exact command
block for you to run **on the real machine** to get the missing, authoritative half of the
picture (script paths, SHA-256, mtimes, staged-copy comparison).

## What the git history actually shows

```
$ git rev-parse native-linux origin/native-linux
ede50ae653004b97e694cf44ce39a34552abacf4
ede50ae653004b97e694cf44ce39a34552abacf4

$ git show ede50ae:infra/native-linux/install.sh | grep -c reconstruct_runtime_context
0

$ git show origin/native-linux:infra/native-linux/lib/deploy-steps.sh | grep -c reconstruct_runtime_context
0

$ git status --short -- infra/native-linux
 M infra/native-linux/install.sh
 M infra/native-linux/lib/common.sh
 M infra/native-linux/lib/deploy-steps.sh
```

**The entire runtime-context-reconstruction fix — `reconstruct_runtime_context()`,
`load_persisted_answers()`, every `validate_phase_*` function, `log_runtime_context_snapshot()`
— exists ONLY as an uncommitted working-tree change in this local session.** It was never
committed, and therefore never pushed to `origin/native-linux`. The most recent real commit on
`native-linux` (both locally and on the remote — they're identical, `ede50ae`, "Production-
harden native-linux deployment; RC-1 audit fixes") predates this fix entirely and still
contains the exact bug pattern described: `SUPREME_RELEASE_VERSION` set only inside
`sync_repo()`/`install_release_artifact()`, with no unconditional reconstruction call anywhere
in `main()`.

This resolves the contradiction without speculation: **my "reproduction doesn't fail" and your
"real machine fails" are both correct simultaneously**, because they were never running the
same code. My test ran against this session's local, uncommitted working tree (which has the
fix). Your real machine — however it obtained its copy of this repository (`git clone`,
`git pull`, a release package, a manual copy) — can only be running code that traces back to
a real commit, and every real commit up to and including `ede50ae` lacks the fix. There is no
version of this repository your machine could have legitimately pulled from `origin` that
would exhibit the fixed behavior, because the fix was never pushed.

## Baseline for comparison (this repository, not your machine)

| File | Git commit (HEAD, both local & `origin/native-linux`) | SHA-256 at that commit |
|---|---|---|
| `infra/native-linux/install.sh` | `ede50ae` (2026-08-03 22:33:12 +0530) | `633ff4001c3e99c908cee19689a4b72d804844779b224cbd7c3dffc2844a498f` |
| `infra/native-linux/lib/deploy-steps.sh` | `ede50ae` | `b32436650be3698778ccce12eab1e5941e2a14735db5e65e06df57f651d51cbc` |
| `infra/native-linux/lib/common.sh` | `ede50ae` | `8bef0dca1fb121f84afc8284e83039d9400a2e71c469d2454c1dde4140efae9a` |

If your machine's `install.sh` hashes to `633ff400...`, that **is** the pre-fix version — this
fully explains the failure, and it is not a new bug, just an unpropagated fix.

If your machine's hash differs from `633ff400...` and also isn't the local working-tree hash
below, it's running a third, currently-unidentified version, and the commands below will show
exactly what.

(For reference only — NOT authoritative until you confirm it matches what's actually
deployed: this local session's current uncommitted working tree hashes to
`450f6dc930073b25f1253738d6955321d5b112b117efc2ff9e98c1e1fa9ce1a2` for `install.sh`,
`37339c15690758468f3cabf22c212c55c6c55805812d42619bf96500a2ce1c06` for `deploy-steps.sh`,
`780e2311594d2fc871249f76035918b80246cad01d69ce8f6e69186679a11373` for `common.sh`.)

## Commands to run on the real machine

Run this exactly as shown (no `sudo` needed for any of it — it's read-only) and paste back the
output. It answers every question this audit was asked to answer: real script paths, SHA-256,
mtimes, git commit, and whether a staged copy under `/opt/supreme` is what's actually running.

```bash
echo "=== 1. What install.sh was actually invoked? ==="
# Replace this with the EXACT path/command you ran — readlink -f resolves any symlink
readlink -f ./infra/native-linux/install.sh 2>/dev/null || echo "adjust path to match your actual invocation"

echo "=== 2. Current working directory at invocation time ==="
pwd

echo "=== 3. SHA-256 + mtime of the script tree that was actually invoked ==="
for f in install.sh lib/common.sh lib/deploy-steps.sh uninstall.sh update.sh; do
  p="./infra/native-linux/${f}"
  if [ -r "$p" ]; then
    echo "--- $p ---"
    sha256sum "$p"
    stat -c '%y' "$p"
  else
    echo "--- $p NOT FOUND at this path ---"
  fi
done

echo "=== 4. Git commit this checkout is actually on ==="
git -C "$(pwd)" rev-parse HEAD 2>/dev/null || echo "not a git checkout — likely a release tarball or manual copy"
git -C "$(pwd)" status --short 2>/dev/null

echo "=== 5. Does THIS install.sh contain the fix? ==="
grep -c "reconstruct_runtime_context\|log_runtime_context_snapshot" ./infra/native-linux/install.sh ./infra/native-linux/lib/deploy-steps.sh

echo "=== 6. Is there a STAGED copy under /opt/supreme, and does it differ? ==="
if [ -e /opt/supreme/current ]; then
  echo "current -> $(readlink -f /opt/supreme/current)"
  ls -la /opt/supreme/releases/ 2>/dev/null
  for staged in /opt/supreme/releases/*/infra/native-linux/install.sh; do
    [ -r "$staged" ] || continue
    echo "--- staged: $staged ---"
    sha256sum "$staged"
    stat -c '%y' "$staged"
    grep -c "reconstruct_runtime_context" "$staged"
  done
else
  echo "/opt/supreme/current does not exist — no staged release yet (consistent with failing before the first successful stage_and_switch_release)."
fi

echo "=== 7. install.state — which phases are actually checkpointed on THIS machine ==="
cat /etc/supremeos/install.state 2>/dev/null || echo "no install.state found at /etc/supremeos/install.state"
```

### Why step 6 matters even though the install never completed once

If this is genuinely the **first-ever** install attempt on this machine, `/opt/supreme/current`
and `/opt/supreme/releases/` won't exist yet — `stage_and_switch_release` is the step that
creates them, and it's the step that's failing. In that case step 6 will correctly report
nothing staged, and the answer collapses entirely to step 3/4/5: whatever `install.sh` was
literally invoked, and whether it contains the fix. Step 6 matters if this is a **second or
later** attempt after a partial/earlier run that got far enough to stage something — in which
case a stale staged copy could independently confuse a *future* investigation even after the
source tree is fixed and re-run, which is exactly the scenario the previous audit's
"most likely explanation" guessed at (and which this audit is not allowed to leave as a guess).

## Bottom line

No code changed in this turn, per your instruction. The most probable, evidence-backed
explanation — not a speculation, a direct reading of this repo's own git log — is that **the
fix was never committed or pushed**, so no real machine pulling from `origin/native-linux` (or
any commit reachable from it) could have it. If you confirm the real machine's `install.sh`
hashes to `633ff400...` (the pre-fix `ede50ae` commit) or anything else that lacks
`reconstruct_runtime_context`, that closes this out completely: the fix is correct, it simply
never shipped. If it instead matches neither known hash, the command block above will surface
the actual third version so we can trace that specifically instead of guessing.
