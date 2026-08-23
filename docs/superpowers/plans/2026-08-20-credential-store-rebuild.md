# Credential store rebuild — plan closure

**Branch:** `feat/credential-store-hardening` (PR #27)
**Closed:** 2026-08-20, steps 1–9 of 10. Step 10 is the deploy and waits on the merge.

## Why there was a plan at all

The PR set out to do three things, from ADR-0018 §5.6:

1. Changing `GAMESHELF_ENCRYPTION_KEY` destroyed every stored credential — no rotation path.
2. The KDF was unsalted single-pass SHA-256.
3. An endpoint handed out stored TOTP secrets.

Eight review rounds followed. In six consecutive rounds, **the previous round's fix was
the main source of the next round's severe defects**: a security regression (a
low-entropy passphrase used verbatim as the AES-256 key, with the KDF skipped), a
deadlock in the recovery path the code itself prescribed, TOTP data loss on re-save, a
key validator that stopped the app booting, and twice re-breaking the salt-creation
race.

The adversarial review that produced this plan found roughly 600 of 2,562 added lines
were the three goals and roughly 2,000 were eleven subsystems added in reaction to
review findings. Every regression lived in the additions; none lived in the goals.
Verdict: strip, do not close.

## The three invariants

Each defect above traces to one of these being violated, so the rebuild made them
explicit and testable rather than emergent.

- **A — the read path is pure.** `decrypt()` never creates, repairs, or writes
  anything, the salt file included. Only `createSaltIfMissing()` may write it, and only
  sealing may call it.
- **B — boot never writes credential rows.** `migrate.js` probes and reports.
- **C — no request field *value* is destructive.** An empty string means "unchanged",
  identical to absence. Removal takes an explicit verb.

## Planned vs actual

One commit per step, test-first with the RED observed, both suites green before each.

| # | Planned | Actual | Commit |
|---|---|---|---|
| 1 | Split `loadOrCreateSalt` into pure `loadSalt` + `createSaltIfMissing`; `deriveKey` defaults to read | as planned | `37c6739` |
| 2 | Delete the boot v0→v1 re-seal and the salt-loss detector | as planned | `2003fb7` |
| 3 | Boot probe quotes the error rather than narrating a cause | as planned | `2e0e5f3` |
| 4 | Characterisation test pinning the script-owned upgrade | as planned, plus correcting a now-false rollback warning the test disproved | `9e9dcb1` |
| 5 | Hex-only declared keys; delete the base64 branch and round-trip normaliser | as planned | `31f37f1` |
| 6 | Drop the clear-on-empty loop; add `remove_totp_secret` | as planned | `64af7af` |
| 7 | Client emits the verb, never an empty secret; add `totp_configured` and initialise the checkbox from it | as planned | `516567f` |
| 8 | `syncEngine.js` read-merge-write inside a transaction | as planned, plus honouring a *removal* that lands in the window by writing nothing — merging onto a fresh read alone would still have resurrected deleted credentials | `7af8838` |
| 9 | Rewrite the `.env.example` / `Dockerfile.backend` notes; rehearse on a copy of the live volume | notes needed less than expected (the base64 form survived in five comments; everything else checked out against the code); rehearsal done in full | `61b3747` |
| 10 | Deploy | not started — needs the merge | — |

## Decisions made during execution

- **Removal is a specific verb, not a generic one.** `remove_totp_secret: true` rather
  than `remove: ['totp_secret']`. TOTP is the only field the UI can remove without
  replacing; the others are required by validation, so a general mechanism would have
  been a second contract with one user.
- **The verb is applied after the merge**, so a request that both supplies and removes
  the same field resolves the same way every time.
- **`totp_configured` is computed only for launchers whose auth type can have a
  secret**, so a Steam API key is never decrypted to answer a question about TOTP.
- **An unreadable blob answers `false` there rather than failing the request.** The boot
  probe and Test Connection already name that condition; this one decides where a
  checkbox starts, and the Setup page must load so the operator can re-enter the
  credentials that fix it.
- **A sync that finds no credentials at write time writes nothing.** The refreshed token
  is lost, which is correct — there is nothing left for it to belong to.

## Rehearsal against live data (step 9)

Run on a consistent copy of the live database, in a throwaway container built from this
branch. The live volume was never mounted writable and was byte-identical afterwards.

- The install is on the pre-versioned envelope with **no salt file**. All eight stored
  credentials open unchanged on this branch and the boot probe reports no faults — so
  deploying changes nothing on disk, which is what makes rollback safe.
- The optional upgrade works end to end: the rotation script with `NEW` set to the
  current key rewrote all eight to v1, created the salt as uid 1000 mode 0600, and
  verified every row re-opened. Field names identical before and after.
- **Invariant A held on real data.** Nothing minted a salt — not the boot probe, not
  eight decrypt attempts. Deleting the salt afterwards makes every launcher report by
  name quoting the missing file, and it is still not recreated.

## Post-plan adversarial review

A full adversarial review of the finished branch found ten defects. Eight are fixed
here, one commit each, test-first; two were already-known deferrals. Three of the ten
were in work done during this plan, which is the point of reviewing after finishing
rather than only during.

| Severity | Defect | Fix |
|---|---|---|
| HIGH | The sync merge was defeated for the launcher it was written for. Step 8 made the merge *base* fresh, but the *overlay* was still stale, and spread makes the overlay win. Ubisoft returns the username and password it was handed, so a password corrected mid-sync was reverted. | `1f580b9` — three-way merge: only fields the launcher actually **changed** win over the store |
| HIGH | The test guarding step 8 proved nothing. Its fake returned `{token:'refreshed'}` — a shape no launcher produces, sharing no field with the store — so the merge could not go wrong however it was written. | same commit — the fake echoes its input, and a second test pins the opposite direction |
| MED-HIGH | Rotating a `hex:` install to a passphrase was impossible. The "already sealed under the new key?" short-circuit derives that key on the *read* path, which refuses to create the salt a hex install has never had, and the error told the operator to restore a file that has never existed. | `8eb438b` — a missing salt answers that question `false`; `rotate()` creates it on the seal path |
| MED | Unticking 2FA from a reloaded page returned 400. The page holds no password to send, so the removal-only body failed the create-a-credential validation — the feature did not work from the one state it is used in. | `081a330` — a removal is not a create, exempt only when genuinely alone |
| MED | `priorUnreadable` had no consumer anywhere. The recovery save after a lost salt showed a green "Saved" while sealing under a **new** salt, leaving every other launcher sealed under the lost one. | `669c817` — surfaced in the UI, and added to the UI-only key set so it is not posted back |
| MED | A test whose named scenario was never entered: it seeded a v0 blob, which uses the legacy derivation and never reads the salt, so occupying the salt path changed nothing. Deleting the code it covers would not have failed it. | `f5cac06` — seeded under the current scheme; verified by deleting that code and watching it go red |
| LOW-MED | The rotation script counted rows it never opened as verified — on the one tool whose selling point is verifying before you discard the old key. | `36e4487` |
| LOW | Invariant C broke on one shape a browser cannot produce: `[]` and `{}` are truthy, so they overwrote a stored TOTP secret while `totp_configured` still reported `true`. | `65279f2` — "supplied" means a non-empty string, in validation and payload alike |
| LOW | The script *verified* by calling `rotate()` — the write path, whose derivation may create the salt. | `36e4487` — new `decryptWith`, proven pure by the read-path test |
| LOW | `onError: 'skip'`, its `failed` list, and the `activeKey` / `saltExists` exports had no callers left. | `d867d6b` |

Invariant verdicts from that review: **A held** (hooked every fs write, drove the whole
read surface with the salt deleted — zero writes), **B held**, **C held for every shape
a browser can produce** and broke only on the non-string values fixed above.

## Verification round

The remediation was itself reviewed. Seven of the eight fixes were confirmed working;
the reviewer could not break the three-way merge, and verified the left-to-right
evaluation claim behind the rotation fix empirically rather than on trust. Four things
came back, two of them real.

| Severity | Defect | Fix |
|---|---|---|
| MEDIUM | `given()` required a string but `' '` is a string, so whitespace still destroyed a stored secret — the exact failure that commit's own comment described. Stored as `' '`, `totp_configured` still reported `true`. | `8a4b42e` — trimmed emptiness decides whether a value counts; the value is still stored as sent, because a space in a password is legitimate |
| MEDIUM | The new `decryptWith` purity test could not fail for the change it named: against a v1 blob the impure form throws from `open()` before deriving, so both implementations passed. The same mistake this round was called in to fix, made while fixing it. | `5933041` — a pre-versioned blob discriminates, checked by making `decryptWith` impure and watching it go red |
| LOW (latent) | A removal-only request went through the save path's upsert, so it set `enabled = 1` on a disabled launcher. | `f514ce0` |
| LOW (latent) | The exemption was gated on `otp_supported` alone; an `otp_supported` launcher on the replace-not-merge path would have stored an empty credential. | `f514ce0` — the exemption now also requires the merge path |

The reviewer also confirmed one residual is **pre-existing, not introduced**: with a
passphrase install and a lost salt, a v0 row still rotates and mints a fresh salt,
because `isSealedWith` short-circuits before deriving. Verified byte-identical against
the pre-round code. Recorded below.

## Deferred

- Unreadable credentials are reported to the log only. `/api/health` or
  `/api/sync/status` would be the right depth, but that is a new endpoint contract.
- `keyIdFor` is 32 bits. A kid collision would make rotation skip a row. P ≈ 2⁻³².
- The rotation runbook passes keys via `-e` on the command line, so they land in shell
  history.
- `saltExists` and `activeKey` are exported from `encrypt.js` with no callers anywhere,
  including tests — leftovers from the stripped subsystems.
- For `session_cookie` launchers the merge is skipped entirely, so re-pasting a Humble
  cookie replaces the whole credential. Harmless today because nothing else is stored
  for Humble, and by design — those exchanges mint a new session — but it is the one
  place where absence does not mean unchanged.
- A salt created inside the rotation transaction is not rolled back if a later row
  fails. Benign in both reachable cases: a hex install ignores a stray salt, and a
  passphrase install fails at `open()` before anything is created.
- With a passphrase install and a lost salt, a v0 row rotates and mints a fresh salt:
  `isSealedWith` short-circuits on the version before deriving, so the missing-salt
  swallow never sees it. In a mixed store the minted salt then turns the next row's
  clean `SaltMissingError` into an opaque GCM failure. Pre-existing, verified identical
  against the pre-round code.
- `priorUnreadable` is not cleared by a failed save, so the warning persists while the
  operator edits. Arguably correct; cosmetic either way.
- Pre-existing and out of scope: `GET /api/health` asserts a hardcoded version.
