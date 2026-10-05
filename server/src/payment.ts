import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { verifyAsync } from "@noble/ed25519";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const STELLAR_CHANNEL_SCHEME = "stellar-channel";
export const PAYMENT_HEADER = "PAYMENT-SIGNATURE";
export const REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * Per-endpoint payment requirement.
 *
 * Each protected route can override the global defaults for amount, token
 * address, description, and MIME type.  `path` is matched against the
 * Express `req.path` value (e.g. `"/paid/data"`).
 *
 * All fields are required so configuration is explicit and auditable:
 * silent inheritance of a global default could lead to under-priced routes
 * going unnoticed in production.
 */
export interface EndpointRequirement {
  /** Express path to protect, e.g. `"/paid/data"`. */
  path: string;
  /** Price per call in smallest token units (must be ≥ 1). */
  amount: bigint;
  /** Stellar contract address of the accepted token (`C…`). */
  tokenAddress: string;
  /** Human-readable description returned in the 402 resource object. */
  description: string;
  /** MIME type returned in the 402 resource object. */
  mimeType: string;
}

/**
 * Parsed shape of one element from the `ENDPOINT_REQUIREMENTS` JSON array.
 * Values are strings before bigint/address validation.
 */
interface RawEndpointRequirement {
  path: string;
  amount: string;
  tokenAddress: string;
  description: string;
  mimeType: string;
}

/**
 * Parse and validate the `ENDPOINT_REQUIREMENTS` environment variable.
 *
 * Expected format: a JSON array of objects:
 * ```json
 * [
 *   {
 *     "path": "/paid/data",
 *     "amount": "100",
 *     "tokenAddress": "C...",
 *     "description": "Metered data endpoint",
 *     "mimeType": "application/json"
 *   }
 * ]
 * ```
 *
 * Validation rules:
 * - Must be a valid JSON array (non-empty).
 * - Each element must have all five required string fields.
 * - `path` must start with `/`.
 * - `amount` must be a positive integer string (no leading zeros, ≥ 1).
 * - `tokenAddress` must be a non-empty string (contract address format is
 *    not re-checked here; the Soroban reader will reject unknown contracts).
 * - `description` and `mimeType` must be non-empty strings.
 * - Duplicate paths are rejected.
 *
 * Throws `Error` with a descriptive message on any validation failure.
 * Returns an empty array when `raw` is `undefined` or an empty string.
 */
export function parseEndpointRequirements(raw: string | undefined): EndpointRequirement[] {
  if (raw === undefined || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ENDPOINT_REQUIREMENTS is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("ENDPOINT_REQUIREMENTS must be a JSON array");
  }

  const seen = new Set<string>();
  const results: EndpointRequirement[] = [];

  for (let index = 0; index < parsed.length; index++) {
    const item = parsed[index];
    const prefix = `ENDPOINT_REQUIREMENTS[${index}]`;

    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${prefix}: each element must be a JSON object`);
    }

    const entry = item as Record<string, unknown>;

    for (const field of ["path", "amount", "tokenAddress", "description", "mimeType"] as const) {
      if (typeof entry[field] !== "string" || (entry[field] as string).trim() === "") {
        throw new Error(`${prefix}: field "${field}" must be a non-empty string`);
      }
    }

    const { path, amount: amountStr, tokenAddress, description, mimeType } =
      entry as unknown as RawEndpointRequirement;

    if (!path.startsWith("/")) {
      throw new Error(`${prefix}: path must start with "/" (got "${path}")`);
    }

    if (!/^[1-9][0-9]*$/.test(amountStr)) {
      throw new Error(
        `${prefix}: amount must be a positive integer string without leading zeros (got "${amountStr}")`,
      );
    }

    const amount = BigInt(amountStr);
    // Belt-and-suspenders: regex already guarantees amount ≥ 1, but keep
    // explicit guard so the type contract is clear at call sites.
    if (amount <= 0n) {
      throw new Error(`${prefix}: amount must be greater than zero`);
    }

    if (seen.has(path)) {
      throw new Error(`${prefix}: duplicate path "${path}" in ENDPOINT_REQUIREMENTS`);
    }
    seen.add(path);

    results.push({ path, amount, tokenAddress: tokenAddress.trim(), description, mimeType });
  }

  return results;
}

export interface ChannelSnapshot {
  payer: string;
  payee: string;
  token: string;
  voucherKey: Uint8Array;
  deposited: bigint;
  settled: bigint;
  lastNonce: bigint;
  expiresAt: bigint;
}

export interface ChannelReader {
  getChannel(channelId: string): Promise<ChannelSnapshot | null>;
}

export interface PaidRoute {
  network: string;
  networkPassphrase: string;
  contractId: string;
  tokenAddress: string;
  payTo: string;
  amount: bigint;
  description: string;
  mimeType: string;
  loadChannel: ChannelReader["getChannel"];
  replayStore: ReplayStore;
}

export interface ReplayStore {
  reserve(input: {
    channelId: string;
    nonce: bigint;
    cumulativeAmount: bigint;
    chainNonce: bigint;
    chainSettled: bigint;
    increment: bigint;
    expiresAt: bigint;
  }): boolean;
}

export interface VoucherPayload {
  channelId: string;
  cumulativeAmount: string;
  nonce: string;
  validUntil: string;
  signature: string;
}

interface X402Payment {
  x402Version: 2;
  accepted: {
    scheme: string;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    extra?: Record<string, unknown>;
  };
  payload: VoucherPayload;
}

export class SqliteReplayStore implements ReplayStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS voucher_cursor (
        channel_id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL,
        cumulative_amount TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  reserve(input: Parameters<ReplayStore["reserve"]>[0]): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM voucher_cursor WHERE expires_at <= ?")
        .run(BigInt(Math.floor(Date.now() / 1000)).toString());
      const prior = this.db
        .prepare(
          "SELECT nonce, cumulative_amount FROM voucher_cursor WHERE channel_id = ?",
        )
        .get(input.channelId) as
        | { nonce: string; cumulative_amount: string }
        | undefined;
      const priorNonce =
        prior === undefined || BigInt(prior.nonce) < input.chainNonce
          ? input.chainNonce
          : BigInt(prior.nonce);
      const priorAmount =
        prior === undefined || BigInt(prior.cumulative_amount) < input.chainSettled
          ? input.chainSettled
          : BigInt(prior.cumulative_amount);
      if (
        input.nonce <= priorNonce ||
        input.cumulativeAmount !== priorAmount + input.increment
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }
      this.db
        .prepare(
          `INSERT INTO voucher_cursor (channel_id, nonce, cumulative_amount, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(channel_id) DO UPDATE
           SET nonce = excluded.nonce,
               cumulative_amount = excluded.cumulative_amount,
               expires_at = excluded.expires_at`,
        )
        .run(
          input.channelId,
          input.nonce.toString(),
          input.cumulativeAmount.toString(),
          input.expiresAt.toString(),
        );
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function voucherMessage(
  networkPassphrase: string,
  contractId: string,
  channelId: bigint,
  amount: bigint,
  nonce: bigint,
  validUntil: bigint,
): Uint8Array {
  return concat(
    new TextEncoder().encode("AETHERIS-X402-V1\0"),
    createHash("sha256").update(networkPassphrase, "utf8").digest(),
    new TextEncoder().encode(contractId),
    integerBytes(channelId, 8),
    integerBytes(amount, 16),
    integerBytes(nonce, 8),
    integerBytes(validUntil, 8),
  );
}

export function createPaymentMiddleware(config: PaidRoute): RequestHandler {
  if (config.amount <= 0n) {
    throw new Error("Paid route amount must be a positive token-unit integer");
  }
  return async (req: Request, res: Response, next: NextFunction) => {
    const paymentHeader = req.get(PAYMENT_HEADER);
    if (paymentHeader === undefined) {
      const requirements = requiredPayment(config, req);
      res
        .status(402)
        .set(REQUIRED_HEADER, encodeHeader(requirements))
        .json(requirements);
      return;
    }

    let payment: X402Payment;
    try {
      payment = decodePayment(paymentHeader);
    } catch {
      res.status(400).json({ error: "Invalid PAYMENT-SIGNATURE header" });
      return;
    }

    try {
      await verifyPayment(payment, config);
    } catch (error) {
      if (error instanceof PaymentRejected) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      next(error);
      return;
    }

    res.set(
      RESPONSE_HEADER,
      encodeHeader({
        x402Version: 2,
        success: true,
        network: config.network,
        channelId: payment.payload.channelId,
        cumulativeAmount: payment.payload.cumulativeAmount,
        nonce: payment.payload.nonce,
        settlement: "deferred",
      }),
    );
    next();
  };
}

export class PaymentRejected extends Error {
  constructor(
    message: string,
    readonly status: number = 402,
  ) {
    super(message);
    this.name = "PaymentRejected";
  }
}

async function verifyPayment(
  payment: X402Payment,
  config: PaidRoute,
): Promise<void> {
  if (payment.x402Version !== 2 || payment.accepted.scheme !== STELLAR_CHANNEL_SCHEME) {
    throw new PaymentRejected("Unsupported x402 version or payment scheme", 400);
  }
  if (
    payment.accepted.network !== config.network ||
    payment.accepted.asset !== config.tokenAddress ||
    payment.accepted.amount !== config.amount.toString() ||
    payment.accepted.payTo !== config.payTo
  ) {
    throw new PaymentRejected("Payment terms do not match this resource", 400);
  }

  const channelId = parseUnsigned(payment.payload.channelId, 64, "channelId");
  const amount = parseUnsigned(
    payment.payload.cumulativeAmount,
    127,
    "cumulativeAmount",
  );
  const nonce = parseUnsigned(payment.payload.nonce, 64, "nonce");
  const validUntil = parseUnsigned(payment.payload.validUntil, 64, "validUntil");
  const signature = decodeFixedHex(payment.payload.signature, 64, "signature");
  const channel = await config.loadChannel(channelId.toString());
  if (channel === null) throw new PaymentRejected("Channel not found");
  if (
    channel.token !== config.tokenAddress ||
    channel.payee !== config.payTo ||
    channel.deposited <= 0n ||
    amount > channel.deposited
  ) {
    throw new PaymentRejected("Channel does not authorize this resource");
  }
  if (validUntil <= BigInt(Math.floor(Date.now() / 1000)) || validUntil > channel.expiresAt) {
    throw new PaymentRejected("Voucher has expired");
  }

  const message = voucherMessage(
    config.networkPassphrase,
    config.contractId,
    channelId,
    amount,
    nonce,
    validUntil,
  );
  if (!(await verifyAsync(signature, message, channel.voucherKey))) {
    throw new PaymentRejected("Voucher signature is invalid");
  }

  const reserved = config.replayStore.reserve({
    channelId: channelId.toString(),
    nonce,
    cumulativeAmount: amount,
    chainNonce: channel.lastNonce,
    chainSettled: channel.settled,
    increment: config.amount,
    expiresAt: channel.expiresAt,
  });
  if (!reserved) {
    throw new PaymentRejected("Voucher is replayed or has an invalid cumulative amount");
  }
}

function requiredPayment(config: PaidRoute, req: Request) {
  return {
    x402Version: 2,
    error: "Payment required",
    resource: {
      url: `${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`,
      description: config.description,
      mimeType: config.mimeType,
    },
    accepts: [
      {
        scheme: STELLAR_CHANNEL_SCHEME,
        network: config.network,
        asset: config.tokenAddress,
        amount: config.amount.toString(),
        payTo: config.payTo,
        extra: {
          contractId: config.contractId,
          channelVoucher: "AETHERIS-X402-V1",
        },
      },
    ],
  };
}

function decodePayment(header: string): X402Payment {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(header) || header.length > 16_384) {
    throw new Error("Malformed base64");
  }
  const decoded = Buffer.from(header, "base64");
  if (decoded.toString("base64") !== header) throw new Error("Non-canonical base64");
  const value: unknown = JSON.parse(decoded.toString("utf8"));
  if (!isPayment(value)) throw new Error("Invalid payment shape");
  return value;
}

function isPayment(value: unknown): value is X402Payment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const accepted = candidate.accepted;
  const payload = candidate.payload;
  if (typeof accepted !== "object" || accepted === null) return false;
  if (typeof payload !== "object" || payload === null) return false;
  const terms = accepted as Record<string, unknown>;
  const voucher = payload as Record<string, unknown>;
  return (
    candidate.x402Version === 2 &&
    typeof terms.scheme === "string" &&
    typeof terms.network === "string" &&
    typeof terms.asset === "string" &&
    typeof terms.amount === "string" &&
    typeof terms.payTo === "string" &&
    typeof voucher.channelId === "string" &&
    typeof voucher.cumulativeAmount === "string" &&
    typeof voucher.nonce === "string" &&
    typeof voucher.validUntil === "string" &&
    typeof voucher.signature === "string"
  );
}

function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function parseUnsigned(value: string, bits: number, field: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new PaymentRejected(`Invalid ${field}`, 400);
  }
  const parsed = BigInt(value);
  if (parsed >= 1n << BigInt(bits)) {
    throw new PaymentRejected(`Invalid ${field}`, 400);
  }
  return parsed;
}

function decodeFixedHex(value: string, length: number, field: string): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) {
    throw new PaymentRejected(`Invalid ${field}`, 400);
  }
  return Uint8Array.from(Buffer.from(value, "hex"));
}

function integerBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n || value >= 1n << BigInt(length * 8)) {
    throw new RangeError("Voucher integer is out of range");
  }
  const output = new Uint8Array(length);
  for (let index = length - 1; index >= 0; index -= 1) {
    output[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return output;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
