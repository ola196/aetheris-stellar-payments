import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import express from "express";
import helmet from "helmet";
import { Networks } from "@stellar/stellar-sdk";
import {
  createPaymentMiddleware,
  parseEndpointRequirements,
  SqliteReplayStore,
} from "./payment.js";
import { SorobanChannelReader } from "./stellar-reader.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const replayPath = process.env.REPLAY_DATABASE ?? "./data/replay.sqlite";
mkdirSync(dirname(replayPath), { recursive: true });

const contractId = required("SOROBAN_CONTRACT_ID");
const payTo = required("PAY_TO");
const sourceAccount = required("SOROBAN_SOURCE_ACCOUNT");
const rpcUrl = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
const networkPassphrase = Networks.TESTNET;
const network = "stellar:testnet";

// ── Per-endpoint payment requirements ──────────────────────────────────────────
//
// ENDPOINT_REQUIREMENTS is a JSON array that specifies the payment terms for
// each protected route.  When provided it takes full precedence; the legacy
// REQUEST_PRICE / SOROBAN_TOKEN_ID env variables are only used as a fallback
// for the built-in /paid/data demo route when ENDPOINT_REQUIREMENTS is absent.
//
// Example value (set as a single-line JSON string in your .env):
//
//   ENDPOINT_REQUIREMENTS=[{"path":"/paid/data","amount":"100","tokenAddress":"C...","description":"Metered data","mimeType":"application/json"}]
//
// Validation runs at startup and throws immediately on any invalid entry,
// so misconfigured containers fail fast rather than serving wrong prices.

const endpointRequirements = parseEndpointRequirements(
  process.env.ENDPOINT_REQUIREMENTS,
);

// Global fallback token – required when ENDPOINT_REQUIREMENTS is empty so the
// legacy /paid/data route can still be registered.
const globalTokenAddress =
  endpointRequirements.length === 0 ? required("SOROBAN_TOKEN_ID") : (process.env.SOROBAN_TOKEN_ID ?? "");

const reader = new SorobanChannelReader({
  rpcUrl,
  sourceAccount,
  contractId,
  networkPassphrase,
});
const replayStore = new SqliteReplayStore(replayPath);
const app = express();
const allowedOrigins = new Set(
  (process.env.FRONTEND_ORIGINS ??
    "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.disable("x-powered-by");
app.use(helmet());
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "PAYMENT-SIGNATURE");
    res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ── Register paid routes ────────────────────────────────────────────────────────

if (endpointRequirements.length > 0) {
  // Explicit per-endpoint configuration: register one middleware per entry.
  for (const endpoint of endpointRequirements) {
    app.get(
      endpoint.path,
      createPaymentMiddleware({
        network,
        networkPassphrase,
        contractId,
        tokenAddress: endpoint.tokenAddress,
        payTo,
        amount: endpoint.amount,
        description: endpoint.description,
        mimeType: endpoint.mimeType,
        loadChannel: (channelId) => reader.getChannel(channelId),
        replayStore,
      }),
      (_req, res) => {
        res.json({
          data: "Access granted using a signed Stellar channel voucher.",
          network,
          path: endpoint.path,
        });
      },
    );
    console.info(
      `Registered paid route ${endpoint.path} — ${endpoint.amount} units of ${endpoint.tokenAddress}`,
    );
  }
} else {
  // Legacy single-route mode: fall back to REQUEST_PRICE / SOROBAN_TOKEN_ID.
  app.get(
    "/paid/data",
    createPaymentMiddleware({
      network,
      networkPassphrase,
      contractId,
      tokenAddress: globalTokenAddress,
      payTo,
      amount: BigInt(process.env.REQUEST_PRICE ?? "100"),
      description: "Aetheris metered data endpoint",
      mimeType: "application/json",
      loadChannel: (channelId) => reader.getChannel(channelId),
      replayStore,
    }),
    (_req, res) => {
      res.json({
        data: "Access granted using a signed Stellar channel voucher.",
        network,
      });
    },
  );
}

app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error("Request failed", error);
    res.status(500).json({ error: "Internal server error" });
  },
);

const port = Number(process.env.PORT ?? "4020");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be a valid TCP port");
}
app.listen(port, () => {
  console.info(`Aetheris x402 server listening on port ${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    replayStore.close();
    process.exit(0);
  });
}
