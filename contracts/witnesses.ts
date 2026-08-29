/*
 * Private state for the ProofPass contract, and the witness functions that
 * read from it. Neither the birth date nor the secret key ever leaves this
 * file's return values undisclosed — only proveEligibility's derived
 * boolean and applicant key do, and only because the contract explicitly
 * wraps them in disclose().
 *
 * Dates are encoded as plain YYYYMMDD integers (e.g. 19901129n for
 * 1990-11-29) — see contracts/proofpass.compact for why that encoding lets
 * the circuit do exact-to-the-day comparisons with plain integer arithmetic.
 */
import { Ledger } from './managed/proofpass/contract/index.js';
import { WitnessContext } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';

export type ProofPassPrivateState = {
  readonly birthDate: bigint;
  readonly secretKey: Uint8Array;
};

export const createProofPassPrivateState = (birthDate: bigint, secretKey: Uint8Array): ProofPassPrivateState => ({
  birthDate,
  secretKey,
});

/** Encode a "YYYY-MM-DD" string (e.g. from an <input type=date>) as YYYYMMDD. */
export const encodeIsoDate = (isoDate: string): bigint => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim());
  if (!match) throw new Error(`Expected an ISO date (YYYY-MM-DD), got: ${isoDate}`);
  const [, y, m, d] = match;
  return BigInt(y) * 10000n + BigInt(m) * 100n + BigInt(d);
};

export const encodeDateParts = (year: number, month: number, day: number): bigint =>
  BigInt(year) * 10000n + BigInt(month) * 100n + BigInt(day);

/** Today's date (UTC) as YYYYMMDD — what a real frontend would pass as currentDate. */
export const todayEncoded = (): bigint => {
  const now = new Date();
  return encodeDateParts(now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate());
};

/** Today's date (UTC) as "YYYY-MM-DD", for prompts/defaults. */
export const todayIso = (): string => {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const witnesses = {
  localBirthDate: ({
    privateState,
  }: WitnessContext<Ledger, ProofPassPrivateState>): [ProofPassPrivateState, bigint] => [
    privateState,
    privateState.birthDate,
  ],
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, ProofPassPrivateState>): [ProofPassPrivateState, Uint8Array] => [
    privateState,
    privateState.secretKey,
  ],
};
