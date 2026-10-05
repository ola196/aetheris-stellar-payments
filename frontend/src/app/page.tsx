"use client";

import { useEffect, useState } from "react";
import {
  Contract,
  Networks,
  rpc,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { contract } from "@stellar/stellar-sdk";
import { requestAccess, signAuthEntry, signTransaction } from "@stellar/freighter-api";
import { openChannelArgsToScVal } from "@/lib/channel";
import { createVoucherSigner, signVoucher, type VoucherSigner } from "@/lib/voucher";
import {
  clearVoucher,
  listStoredVouchers,
  loadVoucher,
  saveVoucher,
  type PersistedVoucher,
} from "@/lib/voucher-store";

const RPC_URL = "https://soroban-testnet.stellar.org";
const PRICE = BigInt(process.env.NEXT_PUBLIC_REQUEST_PRICE ?? "100");
const DEPOSIT = 100_000n;

type Status = "idle" | "working" | "success" | "error";

interface SignedVoucher {
  amount: bigint;
  nonce: bigint;
  validUntil: bigint;
  signature: string;
}

interface SettlementMethods {
  settle: (args: {
    id: bigint;
    amount: bigint;
    nonce: bigint;
    valid_until: bigint;
    signature: Uint8Array;
  }) => Promise<contract.AssembledTransaction<bigint>>;
  refund: (args: { id: bigint }) => Promise<contract.AssembledTransaction<bigint>>;
}

export default function Home() {
  const [wallet, setWallet] = useState("");
  const [channelId, setChannelId] = useState("");
  const [channelExpiresAt, setChannelExpiresAt] = useState(0n);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [calls, setCalls] = useState(0);
  const [voucherSigner, setVoucherSigner] = useState<VoucherSigner | null>(null);
  const [latestVoucher, setLatestVoucher] = useState<SignedVoucher | null>(null);
  const [settledAmount, setSettledAmount] = useState(0n);
  const [recoveredVouchers, setRecoveredVouchers] = useState<PersistedVoucher[]>([]);

  const contractId = process.env.NEXT_PUBLIC_SOROBAN_CONTRACT_ID ?? "";
  const tokenId = process.env.NEXT_PUBLIC_SOROBAN_TOKEN_ID ?? "";
  const payTo = process.env.NEXT_PUBLIC_PAY_TO ?? "";
  const apiUrl =
    process.env.NEXT_PUBLIC_PAID_API_URL ?? "http://localhost:4020/paid/data";

  // On mount, surface any vouchers stored from previous sessions.
  useEffect(() => {
    setRecoveredVouchers(listStoredVouchers());
  }, []);

  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const channelExpired = channelExpiresAt > 0n && channelExpiresAt <= nowSeconds;
  const remainingEscrow = DEPOSIT - settledAmount;

  async function connectWallet() {
    setStatus("working");
    setMessage("");
    try {
      const response = await requestAccess();
      if (response.error) throw new Error(response.error.message);
      if (!response.address) throw new Error("Freighter did not return an account");
      setWallet(response.address);
      setStatus("success");
      setMessage("Freighter connected on Stellar Testnet.");
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function openChannel() {
    setStatus("working");
    setMessage("Preparing the Testnet escrow transaction...");
    try {
      if (!wallet) throw new Error("Connect Freighter before opening a channel");
      if (!contractId || !tokenId || !payTo) {
        throw new Error("Set the contract, token, and payee in frontend/.env.local");
      }
      const signer = await createVoucherSigner();
      const id = randomChannelId();
      const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 86_400);
      const server = new rpc.Server(RPC_URL);
      const account = await server.getAccount(wallet);
      const contractInstance = new Contract(contractId);
      const args = openChannelArgsToScVal({
        id,
        payer: wallet,
        payee: payTo,
        token: tokenId,
        voucher_key: signer.publicKey,
        deposit: DEPOSIT,
        expires_at: expiresAt,
      });
      const operation = contractInstance.call("open_channel", args);
      const transaction = new TransactionBuilder(account, {
        fee: "100",
        networkPassphrase: Networks.TESTNET,
      })
        .addOperation(operation)
        .setTimeout(60)
        .build();
      const simulation = await server.simulateTransaction(transaction);
      if (rpc.Api.isSimulationError(simulation)) {
        throw new Error(`Transaction simulation failed: ${simulation.error}`);
      }
      if (simulation.result === undefined) {
        throw new Error("Transaction simulation returned no result");
      }
      const prepared = rpc.assembleTransaction(transaction, simulation).build();
      const signed = await signTransaction(prepared.toXDR(), {
        networkPassphrase: Networks.TESTNET,
      });
      if (signed.error) throw new Error(signed.error.message);
      if (!signed.signedTxXdr) throw new Error("Freighter returned no signed transaction");
      const signedTransaction = TransactionBuilder.fromXDR(
        signed.signedTxXdr,
        Networks.TESTNET,
      );
      const submitted = await server.sendTransaction(signedTransaction);
      if (submitted.status === "ERROR") {
        throw new Error(`Testnet rejected the transaction: ${submitted.errorResult}`);
      }
      await waitForTransaction(server, submitted.hash);
      setChannelId(id.toString());
      setChannelExpiresAt(expiresAt);
      setVoucherSigner(signer);
      setLatestVoucher(null);
      setSettledAmount(0n);
      setCalls(0);
      setStatus("success");
      setMessage(`Channel ${id.toString()} opened. Delegate signing key is in this tab's memory only.`);
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function callPaidApi() {
    setStatus("working");
    try {
      if (!channelId || !voucherSigner) {
        throw new Error("Open a channel in this tab before calling the API");
      }
      const challenge = await fetch(apiUrl);
      if (challenge.status !== 402) {
        throw new Error(`Expected HTTP 402 from the API, received ${challenge.status}`);
      }
      const encodedRequirements = challenge.headers.get("PAYMENT-REQUIRED");
      if (!encodedRequirements) {
        throw new Error("The API omitted the PAYMENT-REQUIRED header");
      }
      const requirements = JSON.parse(atob(encodedRequirements)) as {
        accepts: Array<{
          scheme: string;
          network: string;
          asset: string;
          amount: string;
          payTo: string;
        }>;
      };
      const accepted = requirements.accepts[0];
      if (!accepted || accepted.scheme !== "stellar-channel") {
        throw new Error("The API did not offer the Stellar channel scheme");
      }
      const nonce = BigInt(calls + 1);
      const cumulativeAmount = BigInt(accepted.amount) * nonce;
      const validUntil = BigInt(Math.floor(Date.now() / 1000) + 300);
      const signature = await signVoucher(voucherSigner, {
        networkPassphrase: Networks.TESTNET,
        contractId,
        channelId: BigInt(channelId),
        amount: cumulativeAmount,
        nonce,
        validUntil,
      });
      const payment = {
        x402Version: 2,
        accepted,
        payload: {
          channelId,
          cumulativeAmount: cumulativeAmount.toString(),
          nonce: nonce.toString(),
          validUntil: validUntil.toString(),
          signature,
        },
      };
      const response = await fetch(apiUrl, {
        headers: {
          "PAYMENT-SIGNATURE": btoa(JSON.stringify(payment)),
        },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? `API returned ${response.status}`);
      }

      const newVoucher: SignedVoucher = {
        amount: cumulativeAmount,
        nonce,
        validUntil,
        signature,
      };
      setLatestVoucher(newVoucher);
      setCalls(Number(nonce));

      // Persist the latest voucher so the payee can settle after a page refresh.
      // The signing key is NOT stored — only the self-contained signed fields.
      saveVoucher({
        channelId,
        amount: cumulativeAmount.toString(),
        nonce: nonce.toString(),
        validUntil: validUntil.toString(),
        signature,
        savedAt: new Date().toISOString(),
      });
      setRecoveredVouchers(listStoredVouchers());

      setStatus("success");
      setMessage(JSON.stringify(body));
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function settleLatestVoucher() {
    if (!channelId || !latestVoucher) return;
    await settleVoucher(
      channelId,
      latestVoucher.amount,
      latestVoucher.nonce,
      latestVoucher.validUntil,
      latestVoucher.signature,
    );
  }

  async function settleRecoveredVoucher(v: PersistedVoucher) {
    await settleVoucher(
      v.channelId,
      BigInt(v.amount),
      BigInt(v.nonce),
      BigInt(v.validUntil),
      v.signature,
    );
  }

  async function settleVoucher(
    cId: string,
    amount: bigint,
    nonce: bigint,
    validUntil: bigint,
    signature: string,
  ) {
    setStatus("working");
    try {
      if (!wallet) throw new Error("Connect the payee's Freighter account to settle");
      if (wallet !== payTo) {
        throw new Error("Switch Freighter to the configured payee account before settling");
      }
      const client = await contract.Client.from<SettlementMethods>({
        contractId,
        networkPassphrase: Networks.TESTNET,
        rpcUrl: RPC_URL,
        publicKey: wallet,
        signTransaction: async (transactionXdr, options) => {
          const result = await signTransaction(transactionXdr, {
            networkPassphrase: options?.networkPassphrase ?? Networks.TESTNET,
            address: wallet,
          });
          if (result.error) throw new Error(result.error.message);
          if (!result.signedTxXdr) {
            throw new Error("Freighter returned no signed settlement transaction");
          }
          return {
            signedTxXdr: result.signedTxXdr,
            signerAddress: result.signerAddress,
          };
        },
        signAuthEntry: async (entryXdr, options) => {
          const result = await signAuthEntry(entryXdr, {
            networkPassphrase: options?.networkPassphrase ?? Networks.TESTNET,
            address: wallet,
          });
          if (result.error) throw new Error(result.error.message);
          if (!result.signedAuthEntry) {
            throw new Error("Freighter returned no signed Soroban authorization");
          }
          return {
            signedAuthEntry: result.signedAuthEntry,
            signerAddress: result.signerAddress,
          };
        },
      });
      const transaction = await client.settle({
        id: BigInt(cId),
        amount,
        nonce,
        valid_until: validUntil,
        signature: fromHex(signature),
      });
      const submitted = await transaction.signAndSend();
      // On successful settlement remove the voucher from storage.
      clearVoucher(cId);
      setRecoveredVouchers(listStoredVouchers());
      if (cId === channelId) {
        setSettledAmount(amount);
        setLatestVoucher(null);
      }
      setStatus("success");
      setMessage(
        `Settled ${amount.toString()} token units on Stellar Testnet. Transaction: ${submitted.sendTransactionResponse?.hash ?? "confirmed"}`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(errorMessage(error));
    }
  }

  async function refundExpiredChannel(cId: string) {
    setStatus("working");
    try {
      if (!wallet) throw new Error("Connect Freighter to refund the channel");
      const client = await contract.Client.from<SettlementMethods>({
        contractId,
        networkPassphrase: Networks.TESTNET,
        rpcUrl: RPC_URL,
        publicKey: wallet,
        signTransaction: async (transactionXdr, options) => {
          const result = await signTransaction(transactionXdr, {
            networkPassphrase: options?.networkPassphrase ?? Networks.TESTNET,
            address: wallet,
          });
          if (result.error) throw new Error(result.error.message);
          if (!result.signedTxXdr) {
            throw new Error("Freighter returned no signed refund transaction");
          }
          return {
            signedTxXdr: result.signedTxXdr,
            signerAddress: result.signerAddress,
          };
        },
        signAuthEntry: async (entryXdr, options) => {
          const result = await signAuthEntry(entryXdr, {
            networkPassphrase: options?.networkPassphrase ?? Networks.TESTNET,
            address: wallet,
          });
          if (result.error) throw new Error(result.error.message);
          if (!result.signedAuthEntry) {
            throw new Error("Freighter returned no signed Soroban authorization");
          }
          return {
            signedAuthEntry: result.signedAuthEntry,
            signerAddress: result.signerAddress,
          };
        },
      });
      const transaction = await client.refund({ id: BigInt(cId) });
      const submitted = await transaction.signAndSend();
      clearVoucher(cId);
      setRecoveredVouchers(listStoredVouchers());
      if (cId === channelId) {
        setChannelId("");
        setChannelExpiresAt(0n);
        setLatestVoucher(null);
        setVoucherSigner(null);
      }
      setStatus("success");
      setMessage(
        `Refund submitted for channel ${cId}. Transaction: ${submitted.sendTransactionResponse?.hash ?? "confirmed"}`,
      );
    } catch (error) {
      setStatus("error");
      setMessage(refundErrorMessage(error));
    }
  }

  return (
    <main className="shell">
      <nav className="topbar">
        <a className="brand" href="#">
          <span className="brand-mark">A</span>
          <span>AETHERIS</span>
        </a>
        <div className="network-pill"><span className="online-dot" /> STELLAR TESTNET</div>
        <button className="wallet-button" onClick={connectWallet}>
          {wallet ? `${wallet.slice(0, 5)}...${wallet.slice(-5)}` : "Connect Freighter"}
        </button>
      </nav>

      <section className="hero">
        <div className="eyebrow"><span /> PAY-PER-REQUEST, WITHOUT PER-REQUEST SETTLEMENT</div>
        <h1>Micropayments<br /><em>at machine speed.</em></h1>
        <p className="intro">
          Open one Soroban escrow channel. Sign tiny off-chain vouchers for each API call.
          Redeem them on-chain when it makes sense.
        </p>
        <div className="hero-meta">
          <span><b>01</b> Deposit once</span>
          <span><b>02</b> Sign off-chain</span>
          <span><b>03</b> Settle later</span>
        </div>
      </section>

      {/* Recovery panel — shown when vouchers were found in localStorage */}
      {recoveredVouchers.length > 0 && (
        <section className="workspace">
          <div className="section-heading">
            <div>
              <span className="section-index">RECOVERY / UNSETTLED VOUCHERS</span>
              <h2>Recover from a previous session</h2>
            </div>
          </div>
          <p className="muted" style={{ marginBottom: "1rem" }}>
            The following signed vouchers were saved locally before the page was last closed.
            The signing key is gone, so new calls cannot be signed for these channels.
            The payee can still settle the vouchers below, or the payer can refund after expiry.
            See <a href="https://github.com/your-org/aetheris-stellar-payments/blob/main/docs/voucher-recovery.md" target="_blank" rel="noreferrer">voucher-recovery.md</a> for details.
          </p>
          <div className="card-grid">
            {recoveredVouchers.map((v) => {
              const nowSec = Math.floor(Date.now() / 1000);
              const expired = Number(v.validUntil) <= nowSec;
              return (
                <article key={v.channelId} className="panel">
                  <div className="panel-label">STORED VOUCHER</div>
                  <div className="detail-row"><span>Channel</span><span>{v.channelId}</span></div>
                  <div className="detail-row"><span>Amount</span><span>{v.amount} units</span></div>
                  <div className="detail-row"><span>Nonce</span><span>{v.nonce}</span></div>
                  <div className="detail-row">
                    <span>Valid until</span>
                    <span>{new Date(Number(v.validUntil) * 1000).toLocaleString()}</span>
                  </div>
                  <div className="detail-row"><span>Saved</span><span>{new Date(v.savedAt).toLocaleString()}</span></div>
                  <div className="divider" />
                  {expired ? (
                    <>
                      <p className="hint" style={{ color: "var(--error, #e55)" }}>
                        Voucher has expired — settlement is no longer possible for this voucher.
                        If the channel&apos;s own expiry has also passed, the original payer can
                        recover any remaining escrow using the Refund button below.
                      </p>
                      <p className="hint">
                        <b>Payer only:</b> connect the original payer account in Freighter to
                        authorize the refund. Only the payer can reclaim escrow after expiry.
                      </p>
                      <button
                        className="primary-button"
                        disabled={status === "working" || !wallet}
                        onClick={() => refundExpiredChannel(v.channelId)}
                      >
                        Refund expired channel <span>↗</span>
                      </button>
                      <p className="hint">Payer account must be active in Freighter.</p>
                    </>
                  ) : (
                    <>
                      <button
                        className="settle-button"
                        disabled={status === "working" || !wallet || wallet !== payTo}
                        onClick={() => settleRecoveredVoucher(v)}
                      >
                        {wallet === payTo
                          ? `Settle ${v.amount} units`
                          : "Connect payee wallet to settle"}
                        <span>↗</span>
                      </button>
                      <p className="hint">
                        Switch Freighter to the payee account ({payTo ? `${payTo.slice(0, 8)}…${payTo.slice(-5)}` : "not configured"}) to enable settlement.
                      </p>
                    </>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      <section className="workspace">
        <div className="section-heading">
          <div><span className="section-index">01 / CHANNEL</span><h2>Your payment rail</h2></div>
          <span className="asset-tag">SOROBAN · TESTNET TOKEN</span>
        </div>

        <div className="card-grid">
          <article className="panel channel-panel">
            <div className="panel-label">ESCROW CHANNEL <span className="status-dot" /></div>
            <div className="metric">{channelId ? "ACTIVE" : "NOT OPEN"}</div>
            <p className="muted">
              {channelId ? `Channel ${channelId}` : "Your deposit stays in contract escrow."}
            </p>
            <div className="divider" />
            <div className="detail-row"><span>Wallet</span><span>{wallet ? `${wallet.slice(0, 8)}...${wallet.slice(-5)}` : "Not connected"}</span></div>
            <div className="detail-row"><span>Payee</span><span>{payTo ? `${payTo.slice(0, 8)}...${payTo.slice(-5)}` : "Not configured"}</span></div>
            <div className="detail-row"><span>Deposit</span><span>{DEPOSIT.toString()} token units</span></div>
            <div className="detail-row"><span>Request price</span><span>{PRICE.toString()} token units</span></div>
            {channelId && (
              <>
                <div className="detail-row"><span>Settled</span><span>{settledAmount.toString()} token units</span></div>
                <div className="detail-row"><span>Remaining in escrow</span><span>{remainingEscrow.toString()} token units</span></div>
              </>
            )}
            {channelExpiresAt > 0n && (
              <div className="detail-row">
                <span>Expires</span>
                <span>
                  {new Date(Number(channelExpiresAt) * 1000).toLocaleString()}
                  {channelExpired
                    ? " — expired"
                    : ` — in ${formatTimeRemaining(channelExpiresAt)}`}
                </span>
              </div>
            )}
            <button className="primary-button" disabled={status === "working" || Boolean(channelId)} onClick={openChannel}>
              {channelId ? "Channel opened" : status === "working" ? "Waiting for wallet..." : "Open channel"}
              <span>↗</span>
            </button>
            <p className="hint">
              Freighter confirms the Testnet transaction. A temporary delegate key signs usage
              vouchers — it lives only in this tab. Signed vouchers are saved locally so the
              payee can settle even after a page refresh.
            </p>
            {channelId && !channelExpired && (
              <>
                <div className="divider" />
                <p className="hint">
                  <b>Refunds:</b> Only the payer can request a refund. A refund is only possible
                  after the channel expiry time. Until then, the payee can still settle any
                  outstanding signed voucher.
                </p>
              </>
            )}
            {channelId && channelExpired && (
              <>
                <div className="divider" />
                <p className="hint" style={{ color: "var(--error, #e55)" }}>
                  This channel has expired.{" "}
                  {remainingEscrow > 0n
                    ? `${remainingEscrow.toString()} token units remain in escrow.`
                    : "All deposited funds have already been settled."}
                </p>
                <p className="hint">
                  <b>Payer only:</b> connect the original payer account in Freighter, then click
                  Refund to recover the remaining escrow. The payee can no longer settle after
                  the channel expires.
                </p>
                <button
                  className="primary-button"
                  disabled={status === "working" || !wallet || remainingEscrow <= 0n}
                  onClick={() => refundExpiredChannel(channelId)}
                >
                  {remainingEscrow > 0n
                    ? `Refund ${remainingEscrow.toString()} units to payer`
                    : "Nothing to refund"}
                  <span>↗</span>
                </button>
              </>
            )}
          </article>

          <article className="panel request-panel">
            <div className="panel-label">HTTP 402 FLOW <span className="route-tag">GET /paid/data</span></div>
            <div className="request-line"><span className="method">GET</span><code>{apiUrl}</code></div>
            <div className="flow-box">
              <div className="flow-step"><span className="flow-number">1</span><div><b>Discover</b><small>API returns 402 + payment requirements</small></div><span className="flow-result">402</span></div>
              <div className="flow-connector" />
              <div className="flow-step"><span className="flow-number">2</span><div><b>Authorize</b><small>Delegate signs cumulative voucher</small></div><span className="flow-result">✳</span></div>
              <div className="flow-connector" />
              <div className="flow-step"><span className="flow-number">3</span><div><b>Access</b><small>Server checks channel and replay cursor</small></div><span className="flow-result">200</span></div>
            </div>
            <div className="request-footer">
              <div><span className="section-index">VOUCHERS SIGNED</span><strong>{String(calls).padStart(2, "0")}</strong></div>
              <div><span className="section-index">TOTAL AUTHORIZED</span><strong>{(BigInt(calls) * PRICE).toString()} <small>units</small></strong></div>
            </div>
            <button className="secondary-button" disabled={status === "working" || !channelId || !voucherSigner} onClick={callPaidApi}>
              {status === "working" ? "Signing & requesting..." : "Call the paid API"} <span>→</span>
            </button>
            <div className="settlement-box">
              <div>
                <span className="section-index">ON-CHAIN SETTLEMENT</span>
                <strong>{settledAmount.toString()} <small>units settled</small></strong>
                {channelId && (
                  <div style={{ marginTop: "0.25rem" }}>
                    <span className="section-index">REMAINING IN ESCROW</span>
                    <strong>{remainingEscrow.toString()} <small>units</small></strong>
                  </div>
                )}
              </div>
              <button
                className="settle-button"
                disabled={
                  status === "working" ||
                  !latestVoucher ||
                  wallet !== payTo
                }
                onClick={settleLatestVoucher}
              >
                {latestVoucher
                  ? wallet === payTo
                    ? `Settle ${latestVoucher.amount.toString()} units`
                    : "Connect payee wallet"
                  : "No outstanding voucher"}
                <span>↗</span>
              </button>
            </div>
            <p className="hint">
              Vouchers are off-chain until the configured payee submits the latest claim in Freighter.
              {wallet !== payTo ? " Switch Freighter to the payee account, then reconnect to settle." : ""}
              {" "}Each signed voucher is saved locally — if you refresh the page, open the recovery
              panel above to settle the last saved voucher without needing to re-sign.
            </p>
          </article>
        </div>

        <div className={`notice ${status}`}>
          <span className="notice-mark">{status === "error" ? "!" : status === "success" ? "✓" : "i"}</span>
          <div><b>{status === "error" ? "Action needs attention" : status === "success" ? "Aetheris update" : "Ready for Testnet"}</b><p>{message || "Connect Freighter, open a channel, then exercise the x402-style paid endpoint."}</p></div>
        </div>
      </section>

      <footer><span>BUILT ON STELLAR · POWERED BY SOROBAN</span><span>VOUCHER CHANNEL DEMO <b>v0.1</b></span></footer>
    </main>
  );
}

function randomChannelId(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result === 0n ? 1n : result;
}

function fromHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2}){64}$/.test(value)) {
    throw new Error("The saved voucher signature is malformed");
  }
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
}

async function waitForTransaction(server: rpc.Server, hash: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await server.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return;
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new Error("Channel transaction failed during Testnet execution");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Timed out waiting for Stellar Testnet confirmation");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected wallet or network error";
}

/**
 * Returns a human-readable countdown string for a future unix timestamp (seconds).
 * e.g. "23h 55m" or "5m 30s"
 */
function formatTimeRemaining(expiresAt: bigint): string {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const delta = expiresAt > nowSec ? expiresAt - nowSec : 0n;
  const totalSec = Number(delta);
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Produces a user-friendly error message for refund failures, distinguishing
 * the ChannelStillActive contract error from other failures.
 */
function refundErrorMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : "Unexpected wallet or network error";
  if (msg.includes("ChannelStillActive") || msg.includes("(9)")) {
    return (
      "Refund rejected: the channel has not yet expired. " +
      "Only the payer can request a refund, and only after the channel expiry time has passed."
    );
  }
  if (msg.includes("NothingToRefund") || msg.includes("(12)")) {
    return "Refund rejected: all deposited funds have already been settled — there is nothing left to refund.";
  }
  return msg;
}
