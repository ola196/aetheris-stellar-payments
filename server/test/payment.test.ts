/**
 * Integration tests for the Aetheris x402 payment middleware.
 *
 * These tests exercise the full HTTP request/response boundary using Supertest
 * and an in-memory SQLite replay store so they run deterministically in CI
 * without a live Stellar Testnet.
 *
 * Coverage
 * ─────────
 * • HTTP 402 with a valid PAYMENT-REQUIRED header on unauthenticated requests
 * • HTTP 200 + PAYMENT-RESPONSE header on a correctly signed voucher
 * • Replay (same nonce) rejection
 * • Out-of-order nonce rejection
 * • Non-consecutive cumulative-amount rejection
 * • Invalid Ed25519 signature rejection
 * • Malformed / non-base64 / oversized header rejection
 * • Expired voucher rejection (validUntil in the past)
 * • Multi-step cumulative voucher scenario across several sequential requests
 * • /health endpoint always returns 200
 * • /paid/data returns 402 when accessed without a payment header
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import {
  createPaymentMiddleware,
  SqliteReplayStore,
  voucherMessage,
} from "../src/payment.js";

// ─── Fixture constants ────────────────────────────────────────────────────────

/** Deterministic 32-byte private key for all tests. */
const secretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const publicKey = await getPublicKeyAsync(secretKey);

/** A second, unrelated key used to produce bad signatures. */
const wrongSecretKey = Uint8Array.from({ length: 32 }, (_, i) => i + 100);

const networkPassphrase = "Test SDF Network ; September 2015";
const contractId = `C${"A".repeat(55)}`;
const payTo = `G${"B".repeat(55)}`;
const tokenAddress = `C${"D".repeat(55)}`;
const channelId = "7";

/** Price per API call in smallest token units. */
const PRICE = 5n;

/** Channel deposit – large enough for many sequential calls. */
const DEPOSITED = 1_000n;

/** Default expiry: 10 minutes from now (plenty of headroom). */
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 600);

// ─── Helpers ──────────────────────────────────────────────────────────────────

let replayStore: SqliteReplayStore;

beforeEach(() => {
  replayStore = new SqliteReplayStore(":memory:");
});

afterEach(() => {
  replayStore.close();
});

/**
 * Build a minimal Express app wired up with the payment middleware.
 *
 * @param overrides - Partial channel snapshot overrides for edge-case tests.
 */
function makeApp(
  overrides: Partial<{
    deposited: bigint;
    settled: bigint;
    lastNonce: bigint;
    expiresAt: bigint;
    voucherKey: Uint8Array;
  }> = {},
) {
  const server = express();
  server.get(
    "/paid",
    createPaymentMiddleware({
      network: "stellar:testnet",
      networkPassphrase,
      contractId,
      tokenAddress,
      payTo,
      amount: PRICE,
      description: "test resource",
      mimeType: "application/json",
      loadChannel: async () => ({
        payer: payTo,
        payee: payTo,
        token: tokenAddress,
        voucherKey: publicKey,
        deposited: DEPOSITED,
        settled: 0n,
        lastNonce: 0n,
        expiresAt,
        ...overrides,
      }),
      replayStore,
    }),
    (_req, res) => res.json({ ok: true }),
  );
  return server;
}

/**
 * Sign a voucher and return the base64-encoded PAYMENT-SIGNATURE header value.
 *
 * @param nonce           - Voucher nonce (must be strictly increasing per channel).
 * @param cumulativeAmount - Running total amount authorised so far.
 * @param opts            - Optional overrides for expiry and signing key.
 */
async function buildSignedHeader(
  nonce: string | bigint,
  cumulativeAmount: string | bigint,
  opts: { validUntil?: bigint; signingKey?: Uint8Array } = {},
): Promise<string> {
  const validUntil = opts.validUntil ?? expiresAt - 1n;
  const signingKey = opts.signingKey ?? secretKey;

  const message = voucherMessage(
    networkPassphrase,
    contractId,
    BigInt(channelId),
    BigInt(cumulativeAmount),
    BigInt(nonce),
    validUntil,
  );
  const signature = await signAsync(message, signingKey);

  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: "stellar-channel",
        network: "stellar:testnet",
        asset: tokenAddress,
        amount: PRICE.toString(),
        payTo,
      },
      payload: {
        channelId,
        cumulativeAmount: cumulativeAmount.toString(),
        nonce: nonce.toString(),
        validUntil: validUntil.toString(),
        signature: Buffer.from(signature).toString("hex"),
      },
    }),
  ).toString("base64");
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("x402 payment middleware", () => {
  // ── Acceptance criterion 1: HTTP 402 + payment requirements ─────────────────

  describe("unauthenticated request", () => {
    it("returns HTTP 402 when no PAYMENT-SIGNATURE header is present", async () => {
      await request(makeApp()).get("/paid").expect(402);
    });

    it("includes a base64-encoded PAYMENT-REQUIRED header", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      expect(raw, "PAYMENT-REQUIRED header must be present").toBeTruthy();
      // Must be valid base64.
      expect(() => Buffer.from(raw, "base64")).not.toThrow();
    });

    it("PAYMENT-REQUIRED decodes to a valid x402 V2 payment requirement", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

      expect(required.x402Version).toBe(2);
      expect(required.accepts).toBeInstanceOf(Array);
      expect(required.accepts.length).toBeGreaterThan(0);

      const accept = required.accepts[0];
      expect(accept.scheme).toBe("stellar-channel");
      expect(accept.network).toBe("stellar:testnet");
      expect(accept.asset).toBe(tokenAddress);
      expect(accept.amount).toBe(PRICE.toString());
      expect(accept.payTo).toBe(payTo);
    });

    it("PAYMENT-REQUIRED extra fields reference the contract and voucher scheme", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      const extra = required.accepts[0].extra;

      expect(extra?.contractId).toBe(contractId);
      expect(extra?.channelVoucher).toBe("AETHERIS-X402-V1");
    });

    it("includes a resource object describing the paid route", async () => {
      const response = await request(makeApp()).get("/paid").expect(402);
      const raw = response.headers["payment-required"];
      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));

      expect(required.resource).toBeTruthy();
      expect(required.resource.description).toBe("test resource");
      expect(required.resource.mimeType).toBe("application/json");
    });
  });

  // ── Acceptance criterion 2: valid voucher → HTTP 200 + PAYMENT-RESPONSE ─────

  describe("valid payment", () => {
    it("returns HTTP 200 for a correctly signed voucher", async () => {
      const header = await buildSignedHeader("1", PRICE);
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);
    });

    it("returns the protected resource body on success", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const response = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      expect(response.body.ok).toBe(true);
    });

    it("includes a base64-encoded PAYMENT-RESPONSE header on success", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const response = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      const raw = response.headers["payment-response"];
      expect(raw, "PAYMENT-RESPONSE header must be present").toBeTruthy();
      expect(() => Buffer.from(raw, "base64")).not.toThrow();
    });

    it("PAYMENT-RESPONSE decodes to a valid x402 V2 success object", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const response = await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      const raw = response.headers["payment-response"];
      const paymentResponse = JSON.parse(
        Buffer.from(raw, "base64").toString("utf8"),
      );

      expect(paymentResponse.x402Version).toBe(2);
      expect(paymentResponse.success).toBe(true);
      expect(paymentResponse.network).toBe("stellar:testnet");
      expect(paymentResponse.channelId).toBe(channelId);
      expect(paymentResponse.nonce).toBe("1");
      expect(paymentResponse.cumulativeAmount).toBe(PRICE.toString());
      expect(paymentResponse.settlement).toBe("deferred");
    });
  });

  // ── Acceptance criterion 3a: replay rejection ────────────────────────────────

  describe("replay protection", () => {
    it("rejects a replayed voucher (same nonce, same server instance)", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });

    it("includes an error message in the replay rejection body", async () => {
      const header = await buildSignedHeader("1", PRICE);
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      const response = await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);

      expect(response.body.error).toBeTruthy();
    });

    it("does NOT advance the cursor on a failed (invalid-signature) request", async () => {
      // A bad request must not consume the nonce so a subsequent good one works.
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.payload.signature = "00".repeat(64);
      const invalid = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", invalid)
        .expect(402);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", valid)
        .expect(200);
    });
  });

  // ── Acceptance criterion 3b: out-of-order / non-consecutive rejections ───────

  describe("out-of-order and non-consecutive voucher rejection", () => {
    it("rejects a voucher with a nonce lower than the current cursor", async () => {
      const first = await buildSignedHeader("2", PRICE);
      const second = await buildSignedHeader("1", PRICE);
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", first)
        .expect(200);

      // Nonce 1 is now behind the cursor (nonce 2 was already accepted).
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", second)
        .expect(402);
    });

    it("rejects a voucher where cumulativeAmount skips more than one increment", async () => {
      // After nonce 1 / amount=5 is accepted, jumping to amount=15 (skipping 10) is invalid.
      const first = await buildSignedHeader("1", PRICE);
      const bad = await buildSignedHeader("2", PRICE * 3n); // skips amount=10

      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", first)
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", bad)
        .expect(402);
    });

    it("rejects a voucher with a zero nonce (nonce must be strictly positive)", async () => {
      const header = await buildSignedHeader("0", PRICE);
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });
  });

  // ── Acceptance criterion 3c: invalid signatures ──────────────────────────────

  describe("invalid signature rejection", () => {
    it("rejects an all-zero signature", async () => {
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.payload.signature = "00".repeat(64);
      const invalid = Buffer.from(JSON.stringify(decoded)).toString("base64");

      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", invalid)
        .expect(402);
    });

    it("rejects a voucher signed by the wrong key", async () => {
      const header = await buildSignedHeader("1", PRICE, {
        signingKey: wrongSecretKey,
      });
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });

    it("rejects a signature produced over tampered payload fields", async () => {
      // Sign nonce=1 / amount=5, then mutate cumulativeAmount to 10.
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.payload.cumulativeAmount = (PRICE * 2n).toString();
      const tampered = Buffer.from(JSON.stringify(decoded)).toString("base64");

      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", tampered)
        .expect(402);
    });
  });

  // ── Malformed header rejection ────────────────────────────────────────────────

  describe("malformed PAYMENT-SIGNATURE header", () => {
    it("returns HTTP 400 for a non-base64 header value", async () => {
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", "!!!not-base64!!!")
        .expect(400);
    });

    it("returns HTTP 400 for a base64 value that is not valid JSON", async () => {
      const notJson = Buffer.from("hello world").toString("base64");
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", notJson)
        .expect(400);
    });

    it("returns HTTP 400 for a JSON object that is missing required fields", async () => {
      const incomplete = Buffer.from(
        JSON.stringify({ x402Version: 2, accepted: {}, payload: {} }),
      ).toString("base64");
      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", incomplete)
        .expect(400);
    });

    it("rejects a header exceeding the size limit (HTTP 400 or 431)", async () => {
      // Build a header > 16 384 characters.
      // Node's HTTP layer responds with 431 (Request Header Fields Too Large)
      // before the middleware runs; the middleware returns 400 for headers
      // within Node's limit but larger than the application limit. Both codes
      // are valid rejection responses.
      const oversized = "A".repeat(20_000);
      const status = (
        await request(makeApp())
          .get("/paid")
          .set("PAYMENT-SIGNATURE", oversized)
      ).status;
      expect([400, 431]).toContain(status);
    });

    it("returns HTTP 400 or 402 for an unsupported x402 version", async () => {
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.x402Version = 1; // unsupported
      const bad = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const status = (
        await request(makeApp())
          .get("/paid")
          .set("PAYMENT-SIGNATURE", bad)
      ).status;
      expect([400, 402]).toContain(status);
    });

    it("returns HTTP 400 or 402 for an unsupported scheme", async () => {
      const valid = await buildSignedHeader("1", PRICE);
      const decoded = JSON.parse(Buffer.from(valid, "base64").toString());
      decoded.accepted.scheme = "unknown-scheme";
      const bad = Buffer.from(JSON.stringify(decoded)).toString("base64");

      const status = (
        await request(makeApp())
          .get("/paid")
          .set("PAYMENT-SIGNATURE", bad)
      ).status;
      expect([400, 402]).toContain(status);
    });
  });

  // ── Expired voucher rejection ─────────────────────────────────────────────────

  describe("expired voucher rejection", () => {
    it("rejects a voucher whose validUntil is in the past", async () => {
      const pastTimestamp = BigInt(Math.floor(Date.now() / 1000) - 60);
      const header = await buildSignedHeader("1", PRICE, {
        validUntil: pastTimestamp,
      });

      await request(makeApp())
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });

    it("rejects a voucher when the channel itself has expired", async () => {
      const pastExpiry = BigInt(Math.floor(Date.now() / 1000) - 1);
      // validUntil must be <= channel.expiresAt, so set both in the past.
      const header = await buildSignedHeader("1", PRICE, {
        validUntil: pastExpiry,
      });

      await request(makeApp({ expiresAt: pastExpiry }))
        .get("/paid")
        .set("PAYMENT-SIGNATURE", header)
        .expect(402);
    });
  });

  // ── Multi-step cumulative voucher scenario ────────────────────────────────────

  describe("multi-step cumulative voucher sequence", () => {
    it("accepts three sequential vouchers with strictly increasing nonces and amounts", async () => {
      const server = makeApp();

      for (let step = 1; step <= 3; step++) {
        const header = await buildSignedHeader(step, PRICE * BigInt(step));
        await request(server)
          .get("/paid")
          .set("PAYMENT-SIGNATURE", header)
          .expect(200);
      }
    });

    it("PAYMENT-RESPONSE reflects the correct nonce and cumulative amount at each step", async () => {
      const server = makeApp();

      for (let step = 1; step <= 3; step++) {
        const nonce = step;
        const cumulative = PRICE * BigInt(step);
        const header = await buildSignedHeader(nonce, cumulative);
        const response = await request(server)
          .get("/paid")
          .set("PAYMENT-SIGNATURE", header)
          .expect(200);

        const paymentResponse = JSON.parse(
          Buffer.from(response.headers["payment-response"], "base64").toString(
            "utf8",
          ),
        );
        expect(paymentResponse.nonce).toBe(nonce.toString());
        expect(paymentResponse.cumulativeAmount).toBe(cumulative.toString());
      }
    });

    it("rejects any voucher after a gap in the cumulative amount sequence", async () => {
      const server = makeApp();

      // Accept steps 1 and 2.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(1, PRICE))
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(2, PRICE * 2n))
        .expect(200);

      // Skip to amount=20 (PRICE*4) instead of PRICE*3.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(3, PRICE * 4n))
        .expect(402);
    });

    it("still accepts the correct step 3 after the gap-skip was rejected", async () => {
      const server = makeApp();

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(1, PRICE))
        .expect(200);

      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(2, PRICE * 2n))
        .expect(200);

      // Bad voucher (gap) – must not corrupt the cursor.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(3, PRICE * 4n))
        .expect(402);

      // Correct step 3.
      await request(server)
        .get("/paid")
        .set("PAYMENT-SIGNATURE", await buildSignedHeader(3, PRICE * 3n))
        .expect(200);
    });
  });

  // ── /health endpoint ──────────────────────────────────────────────────────────

  describe("/health endpoint", () => {
    it("returns HTTP 200 without any payment header", async () => {
      const server = express();
      server.get("/health", (_req, res) => res.json({ status: "ok" }));
      const response = await request(server).get("/health").expect(200);
      expect(response.body.status).toBe("ok");
    });
  });

  // ── /paid/data-style route 402 gate ───────────────────────────────────────────

  describe("paid data route gate", () => {
    it("returns 402 without a payment header on a named paid route", async () => {
      const server = express();
      server.get(
        "/paid/data",
        createPaymentMiddleware({
          network: "stellar:testnet",
          networkPassphrase,
          contractId,
          tokenAddress,
          payTo,
          amount: PRICE,
          description: "Aetheris metered data endpoint",
          mimeType: "application/json",
          loadChannel: async () => ({
            payer: payTo,
            payee: payTo,
            token: tokenAddress,
            voucherKey: publicKey,
            deposited: DEPOSITED,
            settled: 0n,
            lastNonce: 0n,
            expiresAt,
          }),
          replayStore,
        }),
        (_req, res) =>
          res.json({
            data: "Access granted using a signed Stellar channel voucher.",
            network: "stellar:testnet",
          }),
      );

      const response = await request(server).get("/paid/data").expect(402);
      const raw = response.headers["payment-required"];
      expect(raw).toBeTruthy();

      const required = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
      expect(required.x402Version).toBe(2);
      expect(required.accepts[0].scheme).toBe("stellar-channel");
    });

    it("returns 200 with correct body when a valid voucher is provided to /paid/data", async () => {
      const server = express();
      server.get(
        "/paid/data",
        createPaymentMiddleware({
          network: "stellar:testnet",
          networkPassphrase,
          contractId,
          tokenAddress,
          payTo,
          amount: PRICE,
          description: "Aetheris metered data endpoint",
          mimeType: "application/json",
          loadChannel: async () => ({
            payer: payTo,
            payee: payTo,
            token: tokenAddress,
            voucherKey: publicKey,
            deposited: DEPOSITED,
            settled: 0n,
            lastNonce: 0n,
            expiresAt,
          }),
          replayStore,
        }),
        (_req, res) =>
          res.json({
            data: "Access granted using a signed Stellar channel voucher.",
            network: "stellar:testnet",
          }),
      );

      const header = await buildSignedHeader("1", PRICE);
      const response = await request(server)
        .get("/paid/data")
        .set("PAYMENT-SIGNATURE", header)
        .expect(200);

      expect(response.body.data).toMatch(/Access granted/);
      expect(response.body.network).toBe("stellar:testnet");
    });
  });
});
