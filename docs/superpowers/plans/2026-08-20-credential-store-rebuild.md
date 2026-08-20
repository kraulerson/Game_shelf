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

## Deferred

- Unreadable credentials are reported to the log only. `/api/health` or
  `/api/sync/status` would be the right depth, but that is a new endpoint contract.
- `keyIdFor` is 32 bits. A kid collision would make rotation skip a row. P ≈ 2⁻³².
- The rotation runbook passes keys via `-e` on the command line, so they land in shell
  history.
- `saltExists` and `activeKey` are exported from `encrypt.js` with no callers anywhere,
  including tests — leftovers from the stripped subsystems.
- Pre-existing and out of scope: `GET /api/health` asserts a hardcoded version.
