/**
 * Non-interactive smoke test for the ProofPass contract's core claim: an
 * applicant proving a birth date implies minAge <= age <= maxAge, without
 * ever disclosing the birth date itself, and the resulting boolean landing
 * correctly on-chain.
 *
 * Exercises exact day-level precision, not just year granularity: someone
 * who turns minAge exactly today should pass; someone who turns minAge
 * tomorrow (one day short) should fail. Also covers a comfortably mid-range
 * pass and a too-old (below maxAge floor) fail. Exits 0 only if every case
 * matches its expectation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, getDeployment } from '../src/network';
import { createWallet } from '../src/wallet';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { createProofPassPrivateState, witnesses, encodeDateParts } from '../contracts/witnesses';

// @ts-expect-error wallet sync requires WebSocket
globalThis.WebSocket = WebSocket;

const PRIVATE_STATE_ID = 'proofpassPrivateState';

function fail(msg: string): never {
  console.error(`❌ prove-smoke-test failed: ${msg}`);
  process.exit(1);
}

function yearsAgo(from: Date, years: number): Date {
  return new Date(Date.UTC(from.getUTCFullYear() - years, from.getUTCMonth(), from.getUTCDate()));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function toEncoded(d: Date): bigint {
  return encodeDateParts(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

async function main() {
  const { network, config: networkConfig } = resolveNetwork();
  const deployment = getDeployment(network);
  if (!deployment) fail(`No deploy on file for network ${network}. Run npm run setup first.`);
  const contractAddress: string = deployment.address;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'proofpass');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) fail('Compiled contract missing — run `npm run compile`.');
  const ProofPass = await import(pathToFileURL(contractPath).href);

  const withWitnessesAny: any = CompiledContract.withWitnesses;
  const withCompiledFileAssetsAny: any = CompiledContract.withCompiledFileAssets;
  const compiledContract = (CompiledContract.make('proofpass', ProofPass.Contract) as any).pipe(
    withWitnessesAny(witnesses),
    withCompiledFileAssetsAny(zkConfigPath),
  );

  const SEED = getOrCreateWallet(network).seed;
  console.log('Connecting wallet + syncing (this can take a minute)...');
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();

  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';
  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
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
  const privateStateProvider = levelPrivateStateProvider({
    privateStateStoreName: 'proofpass-state',
    accountId,
    privateStoragePasswordProvider: () => privateStatePassword,
  });
  const providers = {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  const now = new Date();
  const currentDate = toEncoded(now);
  const onChainLedger = ProofPass.ledger((await providers.publicDataProvider.queryContractState(contractAddress))!.data);
  const minAgeOnChain = Number(onChainLedger.minAge as bigint);
  const maxAgeOnChain = Number(onChainLedger.maxAge as bigint);
  console.log(`On-chain age range: ${minAgeOnChain}-${maxAgeOnChain}, currentDate=${currentDate}`);

  // Connect once, like the interactive CLI does — findDeployedContract twice
  // against the same providers/privateStateId in one process is untested and
  // triggered an internal SDK state-merge error, so every case below reuses
  // this single connection and just overwrites private state before each call.
  const seedSecretKey = new Uint8Array(randomBytes(32));
  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: createProofPassPrivateState(0n, seedSecretKey),
  });
  providers.privateStateProvider.setContractAddress(contractAddress);

  async function proveFor(label: string, birthDate: bigint) {
    const secretKey = new Uint8Array(randomBytes(32));
    await providers.privateStateProvider.set(PRIVATE_STATE_ID, createProofPassPrivateState(birthDate, secretKey));

    console.log(`\n[${label}] proving (birthDate=${birthDate}, currentDate=${currentDate})...`);
    await deployed.callTx.proveEligibility(currentDate);

    const expectedApplicantId = Buffer.from(ProofPass.pureCircuits.applicantKey(secretKey)).toString('hex');
    const state = await providers.publicDataProvider.queryContractState(contractAddress);
    const ledger = ProofPass.ledger(state!.data);
    if (!ledger.hasResult) fail(`[${label}] no result recorded`);
    const recordedApplicantId = Buffer.from(ledger.applicantId).toString('hex');
    if (recordedApplicantId !== expectedApplicantId) {
      fail(`[${label}] applicant id on chain (${recordedApplicantId}) doesn't match expected (${expectedApplicantId})`);
    }
    const result = ledger.eligible as boolean;
    console.log(`[${label}] recorded result: ${result}`);
    return result;
  }

  const passResult = await proveFor('should PASS (born mid-range)', toEncoded(yearsAgo(now, minAgeOnChain + 10)));
  const justTurnedResult = await proveFor(
    'should PASS (turns minAge exactly today — day-precision boundary)',
    toEncoded(yearsAgo(now, minAgeOnChain)),
  );
  const oneDayShortResult = await proveFor(
    'should FAIL (turns minAge tomorrow — one day short, day-precision boundary)',
    toEncoded(addDays(yearsAgo(now, minAgeOnChain), 1)),
  );
  const tooOldResult = await proveFor(
    'should FAIL (born before maxAge cutoff — too old)',
    toEncoded(yearsAgo(now, maxAgeOnChain + 5)),
  );

  if (passResult !== true) fail('Expected mid-range case to record eligible=true, got false');
  if (justTurnedResult !== true) fail('Expected "turns minAge exactly today" case to record eligible=true, got false');
  if (oneDayShortResult !== false) fail('Expected "one day short of minAge" case to record eligible=false, got true');
  if (tooOldResult !== false) fail('Expected too-old case to record eligible=false, got true');

  console.log(
    '\n✅ prove-smoke-test passed — all four cases matched expectations, down to exact day-level precision, birth dates never left the client.',
  );
  await walletCtx.wallet.stop();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
