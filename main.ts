// main.ts — wire protocol, market book, account state, guardrails.
// Reads agent-fun/replay/v2 NDJSON on stdin (hello, batch..., done) and
// writes one reply per batch on stdout. All trading decisions live in
// strategy.ts; this file only moves data and refuses orders that break
// the rules. Nothing here reads the clock or rolls dice, so two runs
// over the same replay emit the same replies.
//
// Run: node main.ts   (Node 22.18+ runs the TypeScript as it is)

import { createInterface } from "node:readline";
import {
  createStrategy,
  type CoinView,
  type Order,
  type PositionView,
} from "./strategy.ts";

const SOL = 1_000_000_000n;
/** Lamports kept back per buy so the tx + protocol fees never bounce. */
const FEE_BUFFER = 300_000n;
/** A buy order that has not filled after this many slots may be retried. */
const PENDING_TTL_SLOTS = 4;
/** Forget a coin this long after creation when nothing is held in it. */
const PRUNE_AFTER_SLOTS = 64;
/** Buyer counts above this never change an eligibility call. */
const BUYER_CAP = 8;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function big(v: string | bigint | number): bigint {
  return typeof v === "bigint" ? v : BigInt(v);
}

/** SOL per token from virtual reserves; 0 when the curve is empty. */
function priceOf(vSol: string, vTok: string): number {
  const tok = BigInt(vTok);
  if (tok <= 0n) return 0;
  return Number(BigInt(vSol)) / Number(tok);
}

// ---------------------------------------------------------------------------
// Market book: per-mint state folded out of the event stream
// ---------------------------------------------------------------------------

interface CoinState {
  mint: string;
  createdSlot: number;
  creator: string;
  creatorBuy: bigint;
  realSol: bigint;
  price: number;
  high: number;
  creationPrice: number;
  buyers: Set<string>;
  buyerCount: number;
  buyersCapped: boolean;
  /** New distinct buyers first seen in the batch being ingested. */
  newBuyers: number;
  inflow: bigint;
  completed: boolean;
}

class MarketBook {
  private readonly coins = new Map<string, CoinState>();

  private ensure(mint: string, slot: number, creator: string): CoinState {
    const known = this.coins.get(mint);
    if (known) return known;
    const fresh: CoinState = {
      mint,
      createdSlot: slot,
      creator,
      creatorBuy: 0n,
      realSol: 0n,
      price: 0,
      high: 0,
      creationPrice: 0,
      buyers: new Set<string>(),
      buyerCount: 0,
      buyersCapped: false,
      newBuyers: 0,
      inflow: 0n,
      completed: false,
    };
    this.coins.set(mint, fresh);
    return fresh;
  }

  /** Call once per batch before ingesting its events. */
  beginBatch(): void {
    for (const coin of this.coins.values()) coin.newBuyers = 0;
  }

  onCreate(ev: any): void {
    const coin = this.ensure(ev.mint, ev.slot, ev.creator);
    coin.createdSlot = ev.slot;
    coin.creator = ev.creator;
    const price = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
    if (price > 0) {
      coin.price = price;
      coin.creationPrice = price;
      coin.high = price;
    }
  }

  onTrade(ev: any): void {
    const coin = this.ensure(ev.mint, ev.slot, ev.creator);
    const price = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
    if (price > 0) {
      coin.price = price;
      if (price > coin.high) coin.high = price;
      if (coin.creationPrice === 0) coin.creationPrice = price;
    }
    coin.realSol = big(ev.real_sol_reserves);
    const amount = big(ev.sol_amount);
    if (ev.is_buy) {
      coin.inflow += amount;
      if (ev.user === coin.creator) {
        coin.creatorBuy += amount;
      } else if (!coin.buyersCapped) {
        const before = coin.buyers.size;
        coin.buyers.add(ev.user);
        if (coin.buyers.size > before) coin.newBuyers += 1;
        coin.buyerCount = coin.buyers.size;
        if (coin.buyerCount > 7) {
          // Past the gate for good; stop paying to remember names.
          coin.buyersCapped = true;
          coin.buyerCount = BUYER_CAP;
          coin.buyers.clear();
        }
      }
    } else {
      coin.inflow -= amount;
    }
  }

  onComplete(ev: any): void {
    const coin = this.ensure(ev.mint, ev.slot, "");
    coin.completed = true;
  }

  applyMark(mark: any): void {
    const coin = this.coins.get(mark.mint);
    if (!coin) return;
    const price = priceOf(
      mark.virtual_quote_reserves,
      mark.virtual_token_reserves,
    );
    if (price > 0) {
      coin.price = price;
      if (price > coin.high) coin.high = price;
      if (coin.creationPrice === 0) coin.creationPrice = price;
    }
    coin.realSol = big(mark.real_quote_reserves);
  }

  prune(slot: number, held: ReadonlySet<string>): void {
    for (const [mint, coin] of this.coins) {
      if (held.has(mint)) continue;
      if (coin.completed || slot - coin.createdSlot > PRUNE_AFTER_SLOTS) {
        this.coins.delete(mint);
      }
    }
  }

  snapshot(): CoinView[] {
    const out: CoinView[] = [];
    for (const coin of this.coins.values()) {
      out.push({
        mint: coin.mint,
        createdSlot: coin.createdSlot,
        creatorBuyLamports: coin.creatorBuy,
        realSolLamports: coin.realSol,
        price: coin.price,
        highPrice: coin.high,
        creationPrice: coin.creationPrice,
        buyers: coin.buyerCount,
        newBuyersThisBatch: coin.newBuyers,
        inflowLamports: coin.inflow,
        completed: coin.completed,
      });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Bot: one strategy, one book, account mirrored from the harness
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const strategy = createStrategy();
  const book = new MarketBook();
  const positions = new Map<
    string,
    { tokenAmount: bigint; costLamports: bigint }
  >();
  const pendingBuys = new Map<string, number>();
  const bought = new Set<string>();
  // Sells in flight, mint -> slot decided. A position stays in the
  // account until its sell fills two slots later; without this the bot
  // re-sells the same tokens every batch and the copies bounce with
  // insufficient_tokens.
  const pendingSells = new Map<string, number>();
  let cash = 0n;
  let maxOpenPositions = 5;
  let maxOrdersPerBatch = 16;

  const lines = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`bad line, skipping: ${line.slice(0, 80)}\n`);
      continue;
    }

    if (msg.type === "hello") {
      cash = big(msg.capital.lamports);
      maxOpenPositions = msg.caps.max_open_positions;
      maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      continue;
    }
    if (msg.type === "done") break;
    if (msg.type !== "batch") continue;

    const slot: number = msg.slot;
    const seq: number = msg.seq;

    book.beginBatch();
    for (const ev of msg.events ?? []) {
      if (ev.event === "CreateEvent") book.onCreate(ev);
      else if (ev.event === "TradeEvent") book.onTrade(ev);
      else if (ev.event === "CompleteEvent") book.onComplete(ev);
    }
    for (const mark of msg.marks ?? []) book.applyMark(mark);

    // Mirror the harness account: it is the truth about what we hold.
    cash = big(msg.account.cash_lamports);
    positions.clear();
    for (const pos of msg.account.positions ?? []) {
      positions.set(pos.mint, {
        tokenAmount: big(pos.token_amount),
        costLamports: big(pos.cost_lamports),
      });
    }

    // Learn from our fills: a filled buy is one mint, one position.
    for (const fill of msg.fills ?? []) {
      if (fill.side === "sell") {
        // Any verdict frees the mint for a fresh sell decision.
        pendingSells.delete(fill.mint);
        continue;
      }
      if (fill.status === "filled") {
        bought.add(fill.mint);
        pendingBuys.delete(fill.mint);
      } else if (fill.status === "rejected" || fill.status === "failed") {
        pendingBuys.delete(fill.mint);
      }
    }
    for (const [mint, at] of [...pendingBuys]) {
      if (slot - at > PENDING_TTL_SLOTS) pendingBuys.delete(mint);
    }
    for (const [mint, at] of [...pendingSells]) {
      if (slot - at > PENDING_TTL_SLOTS) pendingSells.delete(mint);
    }

    book.prune(slot, new Set(positions.keys()));

    const skip = new Set<string>([...bought, ...pendingBuys.keys()]);
    const views: PositionView[] = [];
    for (const [mint, pos] of positions) {
      views.push({
        mint,
        tokenAmount: pos.tokenAmount,
        costLamports: pos.costLamports,
      });
    }
    const wanted: Order[] = strategy.evaluate({
      slot,
      coins: book.snapshot(),
      positions: views,
      cashLamports: cash,
      maxOpenPositions,
      maxOrdersPerBatch,
      skipMints: skip,
    });

    // Guardrails: never send an order the account cannot honour.
    const wire: any[] = [];
    let cashLeft = cash;
    let committedSlots = positions.size + pendingBuys.size;
    // One lookup map for the guardrails below: rebuilding the snapshot
    // per order would scan every tracked coin on every buy.
    const byMint = new Map(book.snapshot().map((c) => [c.mint, c]));
    for (const order of wanted) {
      if (wire.length >= maxOrdersPerBatch) break;
      if (order.kind === "buy") {
        const coin = byMint.get(order.mint);
        if (!coin) continue;
        const reserveCap =
          (coin.realSolLamports * 90n) / 10000n;
        if (order.quoteLamports < 10_000_000n) continue;
        if (order.quoteLamports > reserveCap) continue;
        if (order.quoteLamports + FEE_BUFFER > cashLeft) continue;
        if (committedSlots >= maxOpenPositions) continue;
        if (bought.has(order.mint) || pendingBuys.has(order.mint)) continue;
        pendingBuys.set(order.mint, slot);
        committedSlots += 1;
        cashLeft -= order.quoteLamports + FEE_BUFFER;
        wire.push({
          side: "buy",
          client_id: `b-${seq}-${order.mint}`,
          mint: order.mint,
          quote_lamports: order.quoteLamports.toString(),
          max_slippage_bps: order.maxSlippageBps,
        });
      } else {
        const held = positions.get(order.mint);
        if (!held) continue;
        if (order.tokenAmount <= 0n) continue;
        if (order.tokenAmount > held.tokenAmount) continue;
        if (pendingSells.has(order.mint)) continue;
        pendingSells.set(order.mint, slot);
        wire.push({
          side: "sell",
          client_id: `s-${seq}-${order.mint}`,
          mint: order.mint,
          token_amount: order.tokenAmount.toString(),
          max_slippage_bps: order.maxSlippageBps,
        });
      }
    }

    process.stdout.write(
      JSON.stringify({ type: "reply", seq, orders: wire }) + "\n",
    );
  }
}

run().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
