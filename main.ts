// Token Radar — the entry program (Node 22, standard library only).
//
// It reads the sealed DefiLlama snapshot (input/snapshot.json, or --input <file|dir>),
// ranks every protocol the brief allows, and writes the ranked board to
// /output/board.json, the dashboard's data to /output/data.js, copies this
// repository's dashboard/ and screenshots/ to /output, and writes
// /output/dossier.json with the vendored make.fun library.
//
// The ranking model is radar-2. It is the entry's own claim, stated in full in
// the dashboard and the README: a protocol's implied value is its TVL times a
// multiple the snapshot's own live-token protocols set for its category, times
// a growth factor from its seven-day TVL change, times a maturity factor from
// how long it has run with no token. No protocol name is ever special-cased.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The model's version label: the dashboard names it and the README quotes it. */
const MODEL_VERSION = 'radar-2';

/** The dossier's caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** One protocol record from the sealed snapshot: exactly the ten fields it carries. */
interface SnapProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

/** One farm step: the action, what it costs, and how long it takes. */
interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    comparables: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** One row of the dashboard's data: the board's row, compact, with its farm plan. */
interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  comparables: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's multiple: the median mcap/TVL of its live-token protocols. */
interface MultipleRow {
  category: string;
  multiple: number;
  comparables: number;
}

/** Everything the dashboard renders, from the snapshot. */
interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  set_aside: number;
  global_multiple: number;
  multiples: MultipleRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this program can score. */
class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted list of numbers. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A number clamped into [low, high]. */
function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

/** A number rounded to four decimals. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/* ------------------------------------------------------------------ the model */

// The model's constants. The multiples are not constants: they are computed
// from the snapshot itself (see categoryMultiples), so a different snapshot
// would set different ones. The bounds below only keep a thin category from
// implying an absurd value.
const MULT_MIN = 0.05;
const MULT_MAX = 1.5;
const MIN_COMPARABLES = 3;
const GROWTH_WEIGHT = 0.5;
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;
const MATURITY_FLOOR = 0.6;
const MATURITY_RANGE = 0.4;
const MATURITY_DAYS = 1095;
const UNKNOWN_AGE_DAYS = 365;

/** How many live-token protocols the Live token view carries, by market cap. */
const LIVE_ROWS = 24;

/** A name ending in a release marker is a pool of another protocol, not a launch of its own. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories that are a wrapped, staked, bridged or exchange product, never a protocol still to launch. */
const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Names that begin with an exchange's name are that exchange's product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A whole word `wrapped`, `staked` or `staking` in the name marks a product of a token that trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
function isPreToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, and not a wrapped, staked, bridged or exchange product, nor a versioned pool. */
function isRankable(p: SnapProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  for (const prefix of EXCHANGE_PREFIXES) {
    if (p.name.startsWith(prefix)) return false;
  }
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapProtocol[]): Map<string, SnapProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/**
 * The category multiples, computed from the snapshot's own live-token protocols.
 * For each category with at least MIN_COMPARABLES live-token protocols that are
 * not exchanges, the multiple is the median of their mcap/TVL ratios; a thinner
 * category falls back to the global median over all such protocols. Every
 * multiple is clamped into [MULT_MIN, MULT_MAX] so one thin category cannot
 * imply an absurd value. Returns the per-category table and the global median.
 */
function categoryMultiples(snapshot: Snapshot): { byCategory: Map<string, MultipleRow>; global: number } {
  const ratiosByCategory = new Map<string, number[]>();
  const allRatios: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    const key = p.category ?? 'Uncategorized';
    const list = ratiosByCategory.get(key);
    if (list === undefined) ratiosByCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  allRatios.sort((a, b) => a - b);
  const global = round4(clamp(median(allRatios), MULT_MIN, MULT_MAX));
  const byCategory = new Map<string, MultipleRow>();
  for (const [category, ratios] of ratiosByCategory) {
    ratios.sort((a, b) => a - b);
    const multiple = ratios.length >= MIN_COMPARABLES ? clamp(median(ratios), MULT_MIN, MULT_MAX) : global;
    byCategory.set(category, { category, multiple: round4(multiple), comparables: ratios.length });
  }
  return { byCategory, global };
}

/** The multiple one protocol's category sets, with how many live protocols set it. */
function multipleFor(p: SnapProtocol, multiples: { byCategory: Map<string, MultipleRow>; global: number }): { multiple: number; comparables: number } {
  const row = multiples.byCategory.get(p.category ?? 'Uncategorized');
  if (row === undefined) return { multiple: multiples.global, comparables: 0 };
  if (row.comparables < MIN_COMPARABLES) return { multiple: multiples.global, comparables: row.comparables };
  return { multiple: row.multiple, comparables: row.comparables };
}

/**
 * The three factors and the implied value one protocol gets.
 *   implied = tvl_usd x categoryMultiple x growthMult x maturityMult
 *   growthMult  = 1 + clamp(change_7d, -60, 120) / 100 x 0.5
 *   maturityMult = 0.6 + min(age_days, 1095) / 1095 x 0.4 (age unknown: 365)
 * The value is a whole number of dollars, at least $1.
 */
function impliedValue(
  p: SnapProtocol,
  asOf: string,
  multiples: { byCategory: Map<string, MultipleRow>; global: number },
): { implied: number; multiple: number; comparables: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, p.listed_at);
  const { multiple, comparables } = multipleFor(p, multiples);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = clamp(rawGrowth, GROWTH_FLOOR, GROWTH_CAP);
  const growthMult = 1 + (growthPct / 100) * GROWTH_WEIGHT;
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const maturityMult = MATURITY_FLOOR + (Math.min(Math.max(ageForModel, 0), MATURITY_DAYS) / MATURITY_DAYS) * MATURITY_RANGE;
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * maturityMult));
  return { implied, multiple, comparables, growthPct, growthMult, maturityMult, age };
}

/* ------------------------------------------------------------------ the farm plan */

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 25_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 30;
}

/** The category's main action, in the words a farmer can follow. */
function actionFor(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC on ${name} (${chain}) and leave it supplied.`;
  if (c.includes('dex') || c.includes('amm') || c.includes('swap')) return `Add $${capital} of liquidity to ${name}'s main pool on ${chain}.`;
  if (c.includes('yield') || c.includes('farm')) return `Deposit $${capital} of USDC into ${name}'s highest-yield vault on ${chain}.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one small position in a ${name} market.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain}.`;
  if (c.includes('stak') || c.includes('restak')) return `Stake $${capital} through ${name} and hold the receipt token.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and leave the position open.`;
}

/** The category's weekly action: a second, different touch that keeps the position alive. */
function weeklyFor(p: SnapProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'Borrow a small amount against the supply, then repay it the same week.';
  if (c.includes('dex') || c.includes('amm') || c.includes('swap')) return 'Swap a small amount through the pool so the wallet shows trading activity.';
  if (c.includes('yield') || c.includes('farm')) return 'Claim the vault rewards and compound them back into the same vault.';
  if (c.includes('perpetual') || c.includes('derivative')) return 'Close the hedge and open a fresh one so the margin account stays active.';
  if (c.includes('rwa')) return 'Check the asset\'s yield accrual and top the position up by a small amount.';
  if (c.includes('curator') || c.includes('allocator')) return 'Vote on the vault\'s next allocation when a vote opens.';
  if (c.includes('prediction')) return 'Settle one market and open another so the account shows repeated use.';
  if (c.includes('stable')) return 'Move a small amount of the stable asset in and out of the protocol.';
  if (c.includes('insurance')) return 'Review the cover terms and renew the policy before it lapses.';
  if (c.includes('stak') || c.includes('restak')) return 'Check the staking rewards and restake them instead of withdrawing.';
  return 'Make one more qualifying action, such as a deposit, a swap or a vote.';
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time.
 * The plan is derived from the protocol's own record (category, chains, TVL,
 * age), never from a hand-written list of names.
 */
function farmSteps(p: SnapProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  return [
    {
      text: 'Open a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline where no one else can read it.',
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: actionFor(p, capital, chain),
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: weeklyFor(p),
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Check the protocol's own site for a points or rewards page; a launch is announced there first, never by a stranger's message.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: 'Decide the exit before any token launches: how much to sell, how much to keep, and what gas the claim will cost.',
      cost: 'nothing but the decision',
      time: '10 minutes',
    },
  ];
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/* ------------------------------------------------------------------ the board */

/** The protocols the board ranks, strongest first, with ranks 1..n. */
function buildBoard(snapshot: Snapshot, multiples: { byCategory: Map<string, MultipleRow>; global: number }): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its size.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable protocol below the watchlist floor, by TVL.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiples);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      category_multiple: s.multiple,
      comparables: s.comparables,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js, with the farm plan carried whole. */
function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    comparables: row.model.comparables,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const multiples = categoryMultiples(snapshot);
  const board = buildBoard(snapshot, multiples);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const setAside = snapshot.protocols.filter((p) => !board.some((r) => r.slug === p.slug) && !live.some((l) => l.slug === p.slug)).length;
  const multiplesTable = [...multiples.byCategory.values()].sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    set_aside: setAside,
    global_multiple: multiples.global,
    multiples: multiplesTable,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/* ------------------------------------------------------------------ the gate and the run */

/** The snapshot out of a file's text, refused unless it is the shape the program scores. */
function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

// Board and data first: the dashboard needs them to render, and the screenshots
// are taken from this output before the entry is complete.
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
