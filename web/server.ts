/**
 * Demo server for the "Integrate Midnight" story: a mock rental application
 * that used to collect a raw birthdate, upgraded to prove age eligibility
 * via the ProofPass contract instead. Connects to the deployed contract
 * once at startup (same pattern as cli.ts) and serves a tiny JSON API for
 * the static frontend in web/public.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { WebSocket } from 'ws';
import express from 'express';

import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateWallet, getDeployment } from '../src/network';
import { createWallet } from '../src/wallet';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import {
  createProofPassPrivateState,
  witnesses,
  encodeIsoDate,
  todayEncoded,
  type ProofPassPrivateState,
} from '../contracts/witnesses';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const PRIVATE_STATE_ID = 'proofpassPrivateState';
const PORT = Number(process.env.PORT ?? 3000);

async function main() {
  const { network, config: networkConfig } = resolveNetwork();
  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}. Run \`npm run setup\` first.`);
    process.exit(1);
  }
  const contractAddress = deployment.address;

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const zkConfigPath = path.resolve(__dirname, '..', 'contracts', 'managed', 'proofpass');
  const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
  if (!fs.existsSync(contractPath)) {
    console.error('Contract not compiled! Run: npm run compile');
    process.exit(1);
  }
  const ProofPass = await import(pathToFileURL(contractPath).href);

  const withWitnessesAny: any = CompiledContract.withWitnesses;
  const withCompiledFileAssetsAny: any = CompiledContract.withCompiledFileAssets;
  const compiledContract = (CompiledContract.make('proofpass', ProofPass.Contract) as any).pipe(
    withWitnessesAny(witnesses),
    withCompiledFileAssetsAny(zkConfigPath),
  );

  console.log('Connecting wallet + syncing with devnet...');
  const SEED = getOrCreateWallet(network).seed;
  const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
  await walletCtx.wallet.waitForSyncedState();

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
  const privateStateProvider = levelPrivateStateProvider<typeof PRIVATE_STATE_ID, ProofPassPrivateState>({
    privateStateStoreName: 'proofpass-state',
    accountId,
    privateStoragePasswordProvider: () =>
      process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1',
  });
  const providers = {
    privateStateProvider,
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };

  // One browser demo session = one applicant identity, kept only in this
  // server process's memory. A real deployment would keep this on the
  // applicant's own device instead of a shared server.
  const secretKey = new Uint8Array(randomBytes(32));

  console.log('Connecting to contract...');
  const deployed: any = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: createProofPassPrivateState(0n, secretKey),
  });
  providers.privateStateProvider.setContractAddress(contractAddress);
  console.log('Connected. Serving demo on http://localhost:' + PORT);

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/status', async (_req, res) => {
    try {
      const state = await providers.publicDataProvider.queryContractState(contractAddress);
      const ledger = ProofPass.ledger(state!.data);
      res.json({
        minAge: ledger.minAge.toString(),
        maxAge: ledger.maxAge.toString(),
        hasResult: ledger.hasResult,
        eligible: ledger.hasResult ? ledger.eligible : null,
        applicantId: ledger.hasResult ? Buffer.from(ledger.applicantId).toString('hex') : null,
        yourApplicantId: Buffer.from(ProofPass.pureCircuits.applicantKey(secretKey)).toString('hex'),
        contractAddress,
        network,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/prove', async (req, res) => {
    try {
      if (typeof req.body?.birthDate !== 'string') {
        return res.status(400).json({ error: 'Enter a valid birth date (YYYY-MM-DD).' });
      }
      let birthDate: bigint;
      try {
        birthDate = encodeIsoDate(req.body.birthDate);
      } catch {
        return res.status(400).json({ error: 'Enter a valid birth date (YYYY-MM-DD).' });
      }
      const currentDate = todayEncoded();
      if (birthDate > currentDate) {
        return res.status(400).json({ error: 'Birth date cannot be in the future.' });
      }

      // Overwritten right before proving — this value is read once by the
      // localBirthDate witness inside the circuit and never leaves this
      // process, let alone the chain. See contracts/witnesses.ts.
      await providers.privateStateProvider.set(PRIVATE_STATE_ID, createProofPassPrivateState(birthDate, secretKey));

      const tx = await deployed.callTx.proveEligibility(currentDate);
      const state = await providers.publicDataProvider.queryContractState(contractAddress);
      const ledger = ProofPass.ledger(state!.data);

      res.json({
        eligible: ledger.eligible,
        txId: tx.public.txId,
        blockHeight: tx.public.blockHeight,
        applicantId: Buffer.from(ledger.applicantId).toString('hex'),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.listen(PORT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
