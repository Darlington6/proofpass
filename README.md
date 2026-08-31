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

## Why this exists

Age-gated flows (rentals, ticketing, age-restricted purchases) almost always
ask for a full date of birth just to answer a yes/no question. That DOB then
sits in a database as a standing liability — a breach, a subpoena, or plain
scope creep can turn "we checked you were 18+" into "we're holding
everyone's exact birthdate." ProofPass shows the alternative: a
zero-knowledge circuit answers the yes/no question and the raw DOB never
leaves the applicant's machine.

## Tech stack

| Layer | Technology |
| --- | --- |
| Smart contract / ZK circuit | [Compact](https://docs.midnight.network/) (Midnight's ZK smart-contract language) |
| Chain | Midnight Network (local devnet, or the `preview`/`preprod` testnets) |
| App runtime | Node.js + TypeScript (`tsx`) |
| Web demo | Express (API) + static HTML/JS (`web/public/index.html`) |
| Local infra | Docker Compose (Midnight node, indexer, proof server) |
| Wallet | `@midnight-ntwrk/wallet-sdk`, BIP-39 mnemonics (Lace-compatible) |

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

## Prerequisites

Install these before doing anything else:

| Requirement | Version | Notes |
| --- | --- | --- |
| [Node.js](https://nodejs.org/) | 22+ | Enforced via `engines` in `package.json`. |
| npm | bundled with Node | Used for all scripts below. |
| [Docker](https://www.docker.com/products/docker-desktop/) | with **Compose v2** (`docker compose`, not `docker-compose`) | Runs the local Midnight node, indexer, and proof server. |
| [Compact compiler](https://docs.midnight.network/getting-started/installation) | `0.31.1` | The `compact` binary must be on your `PATH`. This is the only version tested against this project's pinned `compact-runtime` — see [Compact compiler version](#compact-compiler-version). |

Platform notes:
- **Apple Silicon (M-series) Macs**: use `proof-server` image `8.1.0`
  (already pinned in `docker-compose.yml`). The `7.x` line hangs
  indefinitely generating proofs on Apple Silicon under Docker Desktop —
  don't downgrade it.
- No GPU, Midnight testnet tokens, or cloud account are required for local
  development — `npm run setup` targets a fully local devnet by default and
  funds its own throwaway wallet from the devnet genesis.

## Getting started (local devnet)

This is the fastest path: everything runs on your machine, no testnet
tokens needed.

```bash
git clone <this-repo-url>
cd proofpass

npm install

npm run setup      # starts the local devnet (Docker), compiles the
                    # contract, and deploys it — first run only
npm run test:prove  # non-interactive smoke test: pass, fail, and both
                     # day-precision boundary cases, proved on-chain
npm run cli         # interactive demo — play applicant, then verifier
npm run web         # before/after web demo at http://localhost:3000
```

What `npm run setup` does, in order:
1. `docker compose up -d --wait` — brings up the Midnight node, indexer,
   and proof server, and waits for their healthchecks (node producing
   blocks, indexer past genesis, proof server listening).
2. `npm run compile` — compiles `contracts/proofpass.compact` into
   `contracts/managed/proofpass` (gitignored, regenerated every time).
3. `npm run deploy` — generates/loads a wallet, funds it from the devnet
   genesis, deploys the contract, and records the address in
   `.midnight-state.json` (gitignored — holds wallet seeds, don't commit
   it).

Re-running `npm run setup` reuses the existing wallet and prior deploy
state where possible; use `npm run clean` (below) to start over from
scratch.

## Available scripts

| Script | What it does |
| --- | --- |
| `npm run setup` | Full local bootstrap: devnet up, compile, deploy. Accepts `-- --network <name>` (see [Networks](#networks-local-devnet-vs-testnet)). |
| `npm run compile` | Compiles `contracts/proofpass.compact` via the `compact` CLI. |
| `npm run deploy` | Deploys the compiled contract to the active network. |
| `npm run cli` | Interactive CLI demo (applicant + verifier roles). |
| `npm run web` | Starts the Express demo server at `http://localhost:3000`. |
| `npm run test:prove` | Non-interactive smoke test proving both pass/fail and the exact day-precision boundary, on-chain. |
| `npm run test:e2e` | Read-only smoke check (connects and queries, no proving). |
| `npm run check-balance` | Prints the active wallet's balance. |
| `npm run network` | Prints/sets the active network (`undeployed`/`preview`/`preprod`). |
| `npm run proof-server:start` / `proof-server:stop` | Starts/stops just the Docker services without compiling or deploying. |
| `npm run clean` | Removes compiled contract output, deploy/wallet state, and private state — use this to fully reset. |

## Networks: local devnet vs. testnet

By default everything targets `undeployed`, a fully local devnet spun up by
`docker-compose.yml` (node + indexer + proof server on your machine, funded
from a well-known genesis wallet — no real tokens involved).

You can instead target Midnight's public testnets:

```bash
npm run setup -- --network preview   # or: preprod
```

On `preview`/`preprod`, only the `proof-server` container runs locally;
the node and indexer point at Midnight's hosted infrastructure. A wallet
(BIP-39 mnemonic) is generated on first use and saved to
`.midnight-state.json` — **write down the recovery phrase it prints**, it
is not shown again and controls that wallet. You'll need to fund it from
the network's faucet (URL printed by the setup script) before deploying.

Switch/inspect the active network at any time with:

```bash
npm run network            # print the active network
npm run network preview    # switch to it
```

## Environment variables

All optional — sensible local-devnet defaults apply if unset. Create a
`.env` file or export these in your shell as needed (`.env` is gitignored).

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIN_AGE` | `18` | Minimum age the deployed contract enforces. |
| `MAX_AGE` | `120` | Maximum age the deployed contract enforces (no-op ceiling by default). |
| `PRIVATE_STATE_PASSWORD` | a fixed local placeholder | Encrypts the local private-state store; set a real secret for anything beyond local devnet. |
| `PORT` | `3000` | Port for `npm run web`. |
| `MIDNIGHT_WALLET_SEED` | — | Use a specific 32–128 hex char wallet seed instead of generating one (`preview`/`preprod` only). |
| `MIDNIGHT_WALLET_MNEMONIC` | — | Use a specific BIP-39 recovery phrase instead of generating one (`preview`/`preprod` only). Mutually exclusive with `MIDNIGHT_WALLET_SEED`. |
| `MIDNIGHT_FAUCET_TIMEOUT_MS` | script default | How long to wait for faucet funding during deploy. |
| `MIDNIGHT_INDEXER_URL` / `MIDNIGHT_INDEXER_WS_URL` / `MIDNIGHT_NODE_URL` / `MIDNIGHT_PROOF_SERVER_URL` / `MIDNIGHT_FAUCET_URL` | per-network defaults in `src/network.ts` | Override any endpoint for the active network. |

## Troubleshooting

### A toolchain gotcha worth knowing

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
two copies). This is already applied in this repo's `package.json` — if you
hit this error anyway (e.g. after manually bumping a dependency), re-run
that clean-install sequence.

### Compact compiler version

Compiled with `compact` `0.31.1` — the only version tested against the
`0.16.0` `compact-runtime` pin above. Newer/older compiler versions may
regenerate contract output the installed SDK can't merge; if you bump the
compiler, retest with `npm run test:prove` before trusting a deploy.

### Indexer or proof server won't come up

`npm run setup` (and `proof-server:start`) use `docker compose up --wait`,
which fails fast if a container's healthcheck never passes. Check
`docker compose logs -f` for the failing service. Common causes:
- Ports `9944`, `8088`, or `6300` already in use on your machine.
- Apple Silicon + Docker Desktop with the wrong `proof-server` tag (see
  [Prerequisites](#prerequisites) — must be `8.1.0`, not `7.x`).

### Starting over

```bash
docker compose down -v   # tear down devnet containers + volumes
npm run clean            # remove compiled contract + deploy/wallet state
```

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

## License

MIT
