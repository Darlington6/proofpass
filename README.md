# ProofPass

**MLH Midnight Hackathon — "Integrate Midnight" track.**

A rental application upgraded to prove age eligibility with a zero-knowledge
proof instead of collecting a raw date of birth. The applicant's exact birth
date is read once, locally, to build the proof — it never reaches a server,
a database, or the chain. Only a pass/fail boolean and a pseudonymous
applicant id do. The check is exact to the day, not just the year: someone
who turns the minimum age today passes; someone who turns it tomorrow does
not.

The required range is `[minAge, maxAge]`, set at deploy time — a simple
18+ threshold, or a bounded range (e.g. 18–65 for an event ticket policy).

`web/public/index.html` demos this as a before/after: the same "Sunrise
Rentals" application flow, once as a standard form that stores your exact
DOB, once upgraded to a ProofPass form that proves you clear a minimum age
without disclosing it.

## How it works

- **Contract** (`contracts/proofpass.compact`): a Compact contract with two
  private witnesses (`localBirthDate`, `localSecretKey`) and one circuit,
  `proveEligibility(currentDate)`. Dates are encoded as plain `YYYYMMDD`
  integers (e.g. `19901129`) — subtracting `N * 10000` shifts the year by
  exactly `N` years while leaving month/day untouched, so integer comparison
  on these encoded dates matches real calendar order, exact to the day. The
  circuit asserts `minAge <= age <= maxAge` this way, and discloses only the
  resulting boolean plus a `persistentHash` of the caller's secret key (a
  pseudonymous applicant id) to the ledger. `birthDate` never leaves the
  circuit. `minAge`/`maxAge` are constructor arguments, overridable at
  deploy time via `MIN_AGE`/`MAX_AGE` env vars (defaults: 18, 120 — 120 is
  high enough to be a no-op ceiling). One known edge case: a Feb 29
  birthdate compared against a non-leap cutoff year lands on a nonexistent
  calendar date — an accepted approximation, not a silent bug.
- **Witnesses** (`contracts/witnesses.ts`): supply `birthDate` and
  `secretKey` from local private state at proof time, plus `encodeIsoDate`/
  `todayEncoded` helpers for converting normal date strings to/from the
  `YYYYMMDD` encoding.
- **CLI** (`src/cli.ts`): interactive demo — prove eligibility as an
  applicant, then read back the pass/fail result as a verifier would.
- **Web demo** (`web/`): a small Express server that keeps one contract
  connection alive and exposes `/api/prove` + `/api/status` behind the
  static before/after UI.

## Quick start

Requirements: Node 22+, Docker (with Compose v2), the [Compact
toolchain](https://docs.midnight.network/getting-started/installation).

```bash
npm install
npm run setup      # local devnet + compile + deploy
npm run test:prove # non-interactive smoke test: pass, fail, and both day-precision boundary cases, on-chain
npm run cli        # interactive demo (applicant + verifier roles)
npm run web        # before/after web demo at http://localhost:3000
```

## A toolchain gotcha worth knowing

`create-mn-app`'s scaffold pins `@midnight-ntwrk/compact-runtime@0.16.0`
(range `^3.0.0` on `onchain-runtime-v3`) alongside
`@midnight-ntwrk/midnight-js-protocol@4.1.1` (exact pin
`onchain-runtime-v3@3.0.0`). Once `onchain-runtime-v3@3.1.0` was published,
a fresh `npm install` resolved **two different copies** of that WASM
binding into the tree — one hoisted, one nested under
`midnight-js-protocol`. Every stateful circuit call then failed with
`Error: expected instance of StateValue` deep inside
`mergeUnsubmittedCallTxData`, because an object built with one WASM
module's `ChargedState` class fails the other module's `instanceof`-style
check. It reproduces on a completely untouched `hello-world` template, so
it isn't specific to this contract.

Fixed with an `overrides` entry in `package.json` pinning
`onchain-runtime-v3` to `3.0.0` everywhere, followed by a clean
`rm -rf node_modules package-lock.json && npm install` (an incremental
install alone patches versions in place without actually deduplicating the
two copies).

## Compact compiler version

Compiled with `compact` `0.31.1` — the only version tested against the
`0.16.0` `compact-runtime` pin above. Newer/older compiler versions may
regenerate contract output the installed SDK can't merge; if you bump the
compiler, retest with `npm run test:prove` before trusting a deploy.

## Project structure

```
proofpass/
├── contracts/
│   ├── proofpass.compact       # the ZK age-eligibility contract
│   └── witnesses.ts            # private-state + witness implementations
├── scripts/
│   ├── e2e-check.ts            # read-only smoke check (connect + query)
│   └── prove-smoke-test.ts     # full pass/fail proof round-trip, non-interactive
├── src/
│   ├── cli.ts                  # interactive applicant/verifier demo
│   ├── deploy.ts / setup.ts    # deploy + orchestration
│   └── network.ts / wallet.ts  # network + wallet plumbing
├── web/
│   ├── server.ts                # Express API wrapping the contract connection
│   └── public/index.html        # before/after demo UI
└── docker-compose.yml           # local devnet: node + indexer + proof-server
```
