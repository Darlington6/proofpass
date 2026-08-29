/**
 * CLI for interacting with the proofpass contract.
 *
 * Plays both roles for the demo: "Prove eligibility" is the applicant
 * (enters a birth year, which never leaves this process); "Check eligibility"
 * is the verifier (reads only the pass/fail boolean off-chain via the
 * indexer, keyed by a pseudonymous applicant id).
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { Buffer } from 'buffer';

// Midnight SDK imports
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, formatWalletBackupNotice, getDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  createProofPassPrivateState,
  witnesses,
  encodeIsoDate,
  todayIso,
  type ProofPassPrivateState,
} from '../contracts/witnesses';

// Enable WebSocket for GraphQL subscriptions
// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

// Must match the privateStateId used at deploy time so the CLI reconnects to
// the same private state.
const PRIVATE_STATE_ID = 'proofpassPrivateState';

const { network, config: networkConfig } = resolveNetwork();
const WALLET = getOrCreateWallet(network);
const SEED = WALLET.seed;
{
  const notice = formatWalletBackupNotice(WALLET, network);
  if (notice) console.log(notice);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'proofpass');

// Load compiled contract
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

// Check if contract is compiled
if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}

const ProofPass = await import(pathToFileURL(contractPath).href);

// The contract module is loaded dynamically (see the import above), so its
// type is `any` and these two combinators can't infer their generic
// parameters from context — cast to `any` to skip that inference entirely
// rather than fight it.
const withWitnessesAny: any = CompiledContract.withWitnesses;
const withCompiledFileAssetsAny: any = CompiledContract.withCompiledFileAssets;

const compiledContract = (CompiledContract.make('proofpass', ProofPass.Contract) as any).pipe(
  withWitnessesAny(witnesses),
  withCompiledFileAssetsAny(zkConfigPath),
);

// This process's applicant identity for the session. Regenerated each run —
// good enough for the demo (prove, then check, in the same session). A real
// applicant would keep this secret key on their own device across sessions.
const SESSION_SECRET_KEY = new Uint8Array(randomBytes(32));

// ─── Providers ─────────────────────────────────────────────────────────────────

async function createProviders(walletCtx: WalletContext) {
  // The SDK requires the private-state password to be at least 16 characters.
  // The default below is a placeholder for local devnet only — set a strong
  // password via PRIVATE_STATE_PASSWORD when you move to a non-local target.
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    // In Midnight.js 4.1.x the WalletProvider interface returns the key objects
    // (CoinPublicKey / EncPublicKey) directly — no longer hex strings.
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      // balanceUnboundTransaction -> finalizeRecipe is the complete balancing
      // path in wallet-sdk 1.x; the earlier explicit signRecipe step is gone.
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  const privateStateProvider = levelPrivateStateProvider<typeof PRIVATE_STATE_ID, ProofPassPrivateState>({
    privateStateStoreName: 'proofpass-state',
    accountId,
    privateStoragePasswordProvider: () => privateStatePassword,
  });

  return {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

// ─── Main CLI ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   proofpass CLI                                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  // Check for deployment
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}. Run \`npm run setup -- --network ${network}\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  try {
    const seed = SEED;

    console.log('  Connecting to wallet...');
    const walletCtx = await createWallet({ network, networkConfig, seed });
    const restoredCount = Object.values(walletCtx.restored).filter(Boolean).length;
    if (restoredCount > 0) {
      console.log(`  Restored ${restoredCount}/3 child wallets from .midnight-wallet-state — sync will resume from saved point.`);
    }

    console.log('  Syncing with network...');
    console.log('  ℹ  This may take several minutes depending on network size.');
    console.log('     RPC disconnection messages during sync are normal and can be safely ignored.\n');
    const syncStart = Date.now();
    const syncInterval = setInterval(() => {
      const elapsed = Math.round((Date.now() - syncStart) / 1000);
      process.stdout.write(`\r  ⏳ Still syncing... (${elapsed}s elapsed)   `);
    }, 5000);
    const state = await walletCtx.wallet.waitForSyncedState();
    clearInterval(syncInterval);
    process.stdout.write('\r  ✓ Synced with network.                                      \n');

    // Persist sync state so the next run doesn't have to redo this work.
    await persistWalletState(network, walletCtx);
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

    // Surface a faucet hint when a public-network wallet has 0 tNIGHT.
    // Reads (option 2) work without funds, but writes (option 1) need DUST
    // generated from registered NIGHT — without this hint the next failure
    // mode is a confusing "Insufficient Funds" deep inside the tx builder.
    if (balance === 0n && network !== 'undeployed' && networkConfig.faucet) {
      const address = walletCtx.unshieldedKeystore.getBech32Address();
      console.log('  ⚠ Wallet has no tNight. Fund it from the faucet to send transactions:');
      console.log(`     ${networkConfig.faucet}`);
      console.log(`     Wallet address: ${address}\n`);
    }

    // Setup providers and connect to contract
    console.log('  Connecting to contract...');
    const providers = await createProviders(walletCtx);

    const deployed: any = await findDeployedContract(providers, {
      compiledContract: compiledContract as any,
      contractAddress: deployment.address,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: createProofPassPrivateState(0n, SESSION_SECRET_KEY),
    });

    console.log('  ✅ Connected!\n');

    providers.privateStateProvider.setContractAddress(deployment.address);

    const applicantId = ProofPass.pureCircuits.applicantKey(SESSION_SECRET_KEY);
    console.log(`  Your applicant id (pseudonymous, safe to share): ${Buffer.from(applicantId).toString('hex')}\n`);

    // Interactive CLI loop
    let running = true;
    while (running) {
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log('  1. Prove eligibility (applicant: enter birth date)');
      console.log('  2. Check your eligibility result (verifier: reads pass/fail only)');
      console.log('  3. Show required age range');
      console.log('  4. Check wallet balance');
      console.log('  5. Exit\n');

      const choice = await rl.question('  Your choice: ');

      switch (choice.trim()) {
        case '1': {
          const birthDateInput = await rl.question('  Enter your birth date (YYYY-MM-DD, e.g. 2000-06-15): ');
          const birthDate = encodeIsoDate(birthDateInput.trim());
          const currentDateInput = await rl.question(`  Current date (YYYY-MM-DD) [${todayIso()}]: `);
          const currentDate = encodeIsoDate(currentDateInput.trim() || todayIso());

          // Overwrite this session's private state with the entered birth
          // date right before proving. Only this process ever sees it; the
          // circuit discloses just the pass/fail boolean and applicant id.
          await providers.privateStateProvider.set(
            PRIVATE_STATE_ID,
            createProofPassPrivateState(birthDate, SESSION_SECRET_KEY),
          );

          console.log('\n  Proving eligibility (this may take 30-60 seconds)...');
          try {
            const tx = await deployed.callTx.proveEligibility(currentDate);
            console.log(`\n  ✅ Proof submitted. Your birth date was never sent anywhere.`);
            console.log(`  Transaction ID: ${tx.public.txId}`);
            console.log(`  Block height: ${tx.public.blockHeight}\n`);
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '2': {
          console.log('\n  Reading eligibility result from the chain...');
          try {
            const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
            if (contractState) {
              const ledgerState = ProofPass.ledger(contractState.data);
              if (!ledgerState.hasResult) {
                console.log('\n  📋 No proof on file yet — run option 1 first.\n');
              } else {
                const recordedApplicantId = Buffer.from(ledgerState.applicantId).toString('hex');
                const yours = Buffer.from(applicantId).toString('hex') === recordedApplicantId;
                console.log(`\n  📋 Last recorded applicant: ${recordedApplicantId}${yours ? ' (you)' : ' (not you — someone else proved most recently)'}`);
                console.log(`  📋 Eligibility: ${ledgerState.eligible ? '✅ PASS' : '❌ FAIL'}`);
                console.log('     (birth year was never disclosed to reach this result)\n');
              }
            } else {
              console.log('\n  📋 No contract state found.\n');
            }
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '3': {
          console.log('\n  Reading required age range from the chain...');
          try {
            const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
            if (contractState) {
              const ledgerState = ProofPass.ledger(contractState.data);
              console.log(`\n  📋 Required age range: ${ledgerState.minAge}–${ledgerState.maxAge}\n`);
            } else {
              console.log('\n  📋 No contract state found.\n');
            }
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '4': {
          console.log('\n  Checking balance...');
          const currentState = await walletCtx.wallet.waitForSyncedState();
          const currentBalance = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
          const dustBalance = currentState.dust.balance(new Date());
          console.log(`\n  tNight: ${currentBalance.toLocaleString()}`);
          console.log(`  DUST: ${dustBalance.toLocaleString()}\n`);
          break;
        }

        case '5':
          running = false;
          console.log('\n  👋 Goodbye!\n');
          break;

        default:
          console.log('\n  ❌ Invalid choice. Please enter 1-5.\n');
      }
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
