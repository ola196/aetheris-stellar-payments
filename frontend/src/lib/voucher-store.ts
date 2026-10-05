/**
 * Voucher persistence helpers.
 *
 * Only the signed voucher fields are written to localStorage — never the
 * ephemeral delegate private key. A stored voucher is enough for the payee to
 * call `settle` on-chain; the signing key is intentionally discarded.
 *
 * Key format: `aetheris_voucher_<channelId>`
 * One entry per channel; each successful API call overwrites the previous one
 * because vouchers are cumulative (the latest supersedes all earlier ones).
 */

export interface PersistedVoucher {
  channelId: string;
  amount: string;
  nonce: string;
  validUntil: string;
  /** lowercase hex Ed25519 signature, 128 chars */
  signature: string;
  /** ISO timestamp of when this entry was last written */
  savedAt: string;
}

const PREFIX = "aetheris_voucher_";

function storageKey(channelId: string): string {
  return `${PREFIX}${channelId}`;
}

/** Return the available Storage, or null if unavailable (SSR, quota exceeded, etc.). */
function storage(): Storage | null {
  try {
    // Access via globalThis so test environments can stub it with vi.stubGlobal.
    const s = globalThis.localStorage;
    // A minimal sanity check: the object must exist and expose getItem.
    if (typeof s?.getItem !== "function") return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Persist the latest signed voucher for a channel.
 * Private keys are never passed to or stored by this function.
 */
export function saveVoucher(voucher: PersistedVoucher): void {
  const s = storage();
  if (s === null) return;
  try {
    s.setItem(
      storageKey(voucher.channelId),
      JSON.stringify({ ...voucher, savedAt: new Date().toISOString() }),
    );
  } catch {
    // Storage may be unavailable (private-browsing quota, etc.).
    // Fail silently; the in-memory voucher is still available for this session.
  }
}

/**
 * Load a previously persisted voucher for a channel, or null if none exists.
 */
export function loadVoucher(channelId: string): PersistedVoucher | null {
  const s = storage();
  if (s === null) return null;
  try {
    const raw = s.getItem(storageKey(channelId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPersistedVoucher(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Remove the stored voucher for a channel (e.g. after successful settlement).
 */
export function clearVoucher(channelId: string): void {
  const s = storage();
  if (s === null) return;
  try {
    s.removeItem(storageKey(channelId));
  } catch {
    // Ignore storage errors on cleanup.
  }
}

/**
 * Return all persisted vouchers from localStorage.
 * Useful for showing a recovery panel on page load when no channel is active
 * in memory.
 */
export function listStoredVouchers(): PersistedVoucher[] {
  const s = storage();
  if (s === null) return [];
  const vouchers: PersistedVoucher[] = [];
  const len = s.length;
  for (let i = 0; i < len; i++) {
    try {
      const key = s.key(i);
      if (key === null || !key.startsWith(PREFIX)) continue;
      const raw = s.getItem(key);
      if (raw === null) continue;
      const parsed: unknown = JSON.parse(raw);
      if (isPersistedVoucher(parsed)) vouchers.push(parsed);
    } catch {
      // Skip any entry that cannot be parsed or accessed.
    }
  }
  return vouchers;
}

function isPersistedVoucher(value: unknown): value is PersistedVoucher {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.channelId === "string" &&
    typeof v.amount === "string" &&
    typeof v.nonce === "string" &&
    typeof v.validUntil === "string" &&
    typeof v.signature === "string" &&
    /^(?:[0-9a-f]{2}){64}$/.test(v.signature) &&
    typeof v.savedAt === "string"
  );
}
