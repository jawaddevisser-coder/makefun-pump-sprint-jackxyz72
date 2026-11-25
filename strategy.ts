// strategy.ts — pure decision rules for the pump.fun replay sprint.
// No I/O, no clock, no randomness: the same market snapshots always
// produce the same orders, so the two grading runs agree byte for byte.
//
// The idea, in one paragraph: never chase the launch candle. Wait a few
// slots after a coin is created and buy only coins that are still being
// bought by several different people (not the creator), sit in a sane
// size band, and have not run away yet. Flip fast: take profit, cut
// losses, trail a winner once it moves, never hold long.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CoinView {
  mint: string;
  createdSlot: number;
  creatorBuyLamports: bigint;
  realSolLamports: bigint;
  /** SOL per token, from virtual reserves. */
  price: number;
  /** Highest price seen since creation. */
  highPrice: number;
  /** Price at creation. */
  creationPrice: number;
  /** Distinct non-creator buyers, capped at 8 (more is never needed). */
  buyers: number;
  /** New distinct non-creator buyers first seen in this batch. */
  newBuyersThisBatch: number;
  /** Buy SOL minus sell SOL since creation. */
  inflowLamports: bigint;
  completed: boolean;
}

export interface PositionView {
  mint: string;
  tokenAmount: bigint;
  /** SOL spent on this position (cost basis). */
  costLamports: bigint;
}

export type Order =
  | {
      kind: "buy";
      mint: string;
      quoteLamports: bigint;
      maxSlippageBps: number;
    }
  | {
      kind: "sell";
      mint: string;
      tokenAmount: bigint;
      maxSlippageBps: number;
    };

export interface EvaluateInput {
  slot: number;
  coins: CoinView[];
  positions: PositionView[];
  cashLamports: bigint;
  maxOpenPositions: number;
  maxOrdersPerBatch: number;
  /** Mints to skip buying (already bought, or a buy order is in flight). */
  skipMints: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StrategyConfig {
  minBuyers: number;
  maxBuyers: number;
  maxCreatorBuySol: number;
  minRealSol: number;
  maxRealSol: number;
  minHoldRatio: number;
  maxRunup: number;
  buyWindowMinSlots: number;
  buyWindowMaxSlots: number;
  targetBuySol: number;
  maxOrderBpsOfReserve: number;
  takeProfit: number;
  stopLoss: number;
  trailingArm: number;
  trailingDrop: number;
  maxHoldSlots: number;
  maxSlippageBps: number;
  /** Looser than buys: a crashing exit must land, not bounce and retry. */
  sellSlippageBps: number;
  minBuyLamports: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  // Dev-window evidence: 6-buyer entries lost -0.29 SOL over 70 trips
  // while 7-buyer entries made +0.17 over 50; real SOL above 10 lost
  // money in every bucket. Age 1 is the only clearly profitable age.
  minBuyers: 7,
  maxBuyers: 7,
  maxCreatorBuySol: 1.5,
  minRealSol: 3,
  maxRealSol: 10,
  minHoldRatio: 0.9,
  maxRunup: 3,
  buyWindowMinSlots: 1,
  buyWindowMaxSlots: 6,
  targetBuySol: 0.25,
  maxOrderBpsOfReserve: 90,
  takeProfit: 1.8,
  // Dev-window evidence: the -8% stop caught 8 extra trips that would
  // mostly have drifted out near breakeven, so the -12% line stays; the
  // tighter trail (arm +5%, drop 6%) is kept — it moved exits out of
  // max-hold into small wins.
  stopLoss: 0.88,
  trailingArm: 1.05,
  trailingDrop: 0.94,
  maxHoldSlots: 10,
  maxSlippageBps: 500,
  sellSlippageBps: 2000,
  minBuyLamports: 10_000_000,
};

const SOL = 1_000_000_000;

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`invalid strategy config: ${msg}`);
}

function finite(n: number, name: string): void {
  check(Number.isFinite(n), `${name} must be finite`);
}

// ---------------------------------------------------------------------------
// Strategy
// ---------------------------------------------------------------------------

interface Held {
  entryPrice: number;
  entrySlot: number;
  peak: number;
  armed: boolean;
}

export class Strategy {
  private readonly cfg: StrategyConfig;
  private readonly held = new Map<string, Held>();

  constructor(cfg: StrategyConfig) {
    this.cfg = cfg;
  }

  evaluate(input: EvaluateInput): Order[] {
    const cfg = this.cfg;
    const orders: Order[] = [];
    const byMint = new Map<string, CoinView>();
    for (const coin of input.coins) byMint.set(coin.mint, coin);

    // --- exits first: they free slots and cash for the entries below ---
    const open = new Set<string>();
    for (const pos of input.positions) {
      open.add(pos.mint);
      const coin = byMint.get(pos.mint);
      const track = this.trackPosition(pos, coin, input.slot);
      if (!coin) continue;
      if (coin.completed) {
        orders.push(this.sellAll(pos));
        continue;
      }
      const price = coin.price;
      if (!(price > 0) || !(track.entryPrice > 0)) continue;
      if (price >= track.entryPrice * cfg.takeProfit) {
        orders.push(this.sellAll(pos));
      } else if (price <= track.entryPrice * cfg.stopLoss) {
        orders.push(this.sellAll(pos));
      } else if (track.armed && price <= track.peak * cfg.trailingDrop) {
        orders.push(this.sellAll(pos));
      } else if (input.slot - track.entrySlot >= cfg.maxHoldSlots) {
        orders.push(this.sellAll(pos));
      }
    }
    // Forget positions that are gone, so a later re-buy starts clean.
    for (const mint of [...this.held.keys()]) {
      if (!open.has(mint)) this.held.delete(mint);
    }

    // --- entries: best inflow first, one buy per mint, slots permitting ---
    const freeSlots = input.maxOpenPositions - input.positions.length;
    if (freeSlots > 0) {
      const candidates = input.coins.filter((c) =>
        this.eligible(c, input.slot, open, input.skipMints),
      );
      candidates.sort((a, b) => {
        if (a.inflowLamports !== b.inflowLamports) {
          return a.inflowLamports > b.inflowLamports ? -1 : 1;
        }
        return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
      });
      let cash = input.cashLamports;
      let taken = 0;
      for (const coin of candidates) {
        if (taken >= freeSlots) break;
        if (orders.length >= input.maxOrdersPerBatch) break;
        const quote = this.sizeBuy(coin, cash);
        if (quote < BigInt(cfg.minBuyLamports)) continue;
        orders.push({
          kind: "buy",
          mint: coin.mint,
          quoteLamports: quote,
          maxSlippageBps: cfg.maxSlippageBps,
        });
        cash -= quote;
        taken += 1;
      }
    }

    return orders.slice(0, input.maxOrdersPerBatch);
  }

  private sellAll(pos: PositionView): Order {
    return {
      kind: "sell",
      mint: pos.mint,
      tokenAmount: pos.tokenAmount,
      maxSlippageBps: this.cfg.sellSlippageBps,
    };
  }

  private trackPosition(
    pos: PositionView,
    coin: CoinView | undefined,
    slot: number,
  ): Held {
    const known = this.held.get(pos.mint);
    if (known) {
      if (coin && coin.price > 0) {
        if (coin.price >= known.entryPrice * this.cfg.trailingArm) {
          known.armed = true;
        }
        if (coin.price > known.peak) known.peak = coin.price;
      }
      return known;
    }
    const entryPrice =
      pos.tokenAmount > 0n
        ? Number(pos.costLamports) / Number(pos.tokenAmount)
        : 0;
    const fresh: Held = {
      entryPrice,
      entrySlot: slot,
      peak: coin && coin.price > 0 ? coin.price : entryPrice,
      armed: false,
    };
    this.held.set(pos.mint, fresh);
    return fresh;
  }

  private eligible(
    coin: CoinView,
    slot: number,
    open: Set<string>,
    skip: Set<string>,
  ): boolean {
    const cfg = this.cfg;
    if (coin.completed) return false;
    if (open.has(coin.mint) || skip.has(coin.mint)) return false;
    const age = slot - coin.createdSlot;
    if (age < cfg.buyWindowMinSlots || age > cfg.buyWindowMaxSlots) {
      return false;
    }
    if (coin.buyers < cfg.minBuyers || coin.buyers > cfg.maxBuyers) {
      return false;
    }
    if (
      coin.creatorBuyLamports >
      BigInt(Math.floor(cfg.maxCreatorBuySol * SOL))
    ) {
      return false;
    }
    const realSol = Number(coin.realSolLamports) / SOL;
    if (realSol < cfg.minRealSol || realSol > cfg.maxRealSol) return false;
    if (
      !(coin.price > 0) ||
      !(coin.highPrice > 0) ||
      !(coin.creationPrice > 0)
    ) {
      return false;
    }
    // Still holding near its high, and not already run away.
    if (coin.price < cfg.minHoldRatio * coin.highPrice) return false;
    if (coin.price >= cfg.maxRunup * coin.creationPrice) return false;
    // Net money still flowing in.
    if (coin.inflowLamports <= 0n) return false;
    // And the buying is happening now, not five slots ago: at least one
    // new buyer showed up in this batch.
    if (coin.newBuyersThisBatch <= 0) return false;
    return true;
  }

  private sizeBuy(coin: CoinView, cash: bigint): bigint {
    const cfg = this.cfg;
    const reserveCap =
      (coin.realSolLamports * BigInt(cfg.maxOrderBpsOfReserve)) / 10000n;
    let quote = BigInt(Math.floor(cfg.targetBuySol * SOL));
    if (quote > reserveCap) quote = reserveCap;
    if (quote > cash) quote = cash;
    if (quote < 0n) quote = 0n;
    return quote;
  }
}

/** Build a strategy, failing fast on a nonsense parameter set. */
export function createStrategy(
  overrides?: Partial<StrategyConfig>,
): Strategy {
  const cfg: StrategyConfig = { ...DEFAULT_CONFIG, ...overrides };
  finite(cfg.minBuyers, "minBuyers");
  finite(cfg.maxBuyers, "maxBuyers");
  check(
    cfg.minBuyers >= 1 && cfg.maxBuyers >= cfg.minBuyers,
    "need 1 <= minBuyers <= maxBuyers",
  );
  finite(cfg.maxCreatorBuySol, "maxCreatorBuySol");
  check(cfg.maxCreatorBuySol > 0, "maxCreatorBuySol must be > 0");
  finite(cfg.minRealSol, "minRealSol");
  finite(cfg.maxRealSol, "maxRealSol");
  check(
    cfg.minRealSol > 0 && cfg.maxRealSol >= cfg.minRealSol,
    "need 0 < minRealSol <= maxRealSol",
  );
  finite(cfg.minHoldRatio, "minHoldRatio");
  check(
    cfg.minHoldRatio > 0 && cfg.minHoldRatio <= 1,
    "minHoldRatio must be in (0, 1]",
  );
  finite(cfg.maxRunup, "maxRunup");
  check(cfg.maxRunup > 1, "maxRunup must be > 1");
  finite(cfg.buyWindowMinSlots, "buyWindowMinSlots");
  finite(cfg.buyWindowMaxSlots, "buyWindowMaxSlots");
  check(
    cfg.buyWindowMinSlots >= 0 &&
      cfg.buyWindowMaxSlots >= cfg.buyWindowMinSlots,
    "need 0 <= buyWindowMinSlots <= buyWindowMaxSlots",
  );
  finite(cfg.targetBuySol, "targetBuySol");
  check(cfg.targetBuySol > 0, "targetBuySol must be > 0");
  finite(cfg.maxOrderBpsOfReserve, "maxOrderBpsOfReserve");
  check(
    cfg.maxOrderBpsOfReserve > 0 && cfg.maxOrderBpsOfReserve <= 10000,
    "maxOrderBpsOfReserve must be in (0, 10000]",
  );
  finite(cfg.takeProfit, "takeProfit");
  check(cfg.takeProfit > 1, "takeProfit must be > 1");
  finite(cfg.stopLoss, "stopLoss");
  check(
    cfg.stopLoss > 0 && cfg.stopLoss < 1,
    "stopLoss must be in (0, 1)",
  );
  finite(cfg.trailingArm, "trailingArm");
  check(cfg.trailingArm > 1, "trailingArm must be > 1");
  finite(cfg.trailingDrop, "trailingDrop");
  check(
    cfg.trailingDrop > 0 && cfg.trailingDrop < 1,
    "trailingDrop must be in (0, 1)",
  );
  finite(cfg.maxHoldSlots, "maxHoldSlots");
  check(cfg.maxHoldSlots > 0, "maxHoldSlots must be > 0");
  finite(cfg.maxSlippageBps, "maxSlippageBps");
  check(
    cfg.maxSlippageBps >= 0 && cfg.maxSlippageBps <= 10000,
    "maxSlippageBps must be in [0, 10000]",
  );
  finite(cfg.sellSlippageBps, "sellSlippageBps");
  check(
    cfg.sellSlippageBps >= 0 && cfg.sellSlippageBps <= 10000,
    "sellSlippageBps must be in [0, 10000]",
  );
  finite(cfg.minBuyLamports, "minBuyLamports");
  check(cfg.minBuyLamports > 0, "minBuyLamports must be > 0");
  return new Strategy(cfg);
}
