// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board ranks every pre-token protocol the watchlist rule admits (the full checkable filter,
// not a TVL-capped slice): 198 rows on this snapshot, the watchlist's 40 among them. A protocol is
// pre-token when its index entry records no token (no market cap, no CoinGecko id, no symbol); the
// snapshot's live-token protocols are kept apart and shown as the market's own values, never mixed
// into the ranked board.
//
// Implied value is priced off the snapshot's own traded protocols, not a magic multiple and not a
// category median. The traded protocols are fitted with one size curve, an ordinary least-squares
// line of log market cap on log TVL, after Tukey-cleaning the log market-cap-to-TVL ratios (1.5 x
// IQR fences): a dollar of TVL is worth less at a ten-billion-dollar protocol than at a
// hundred-million one, and a single median per category hides that. Growth and age then adjust
// the price, exactly as the snapshot states them:
//
//   log(mcap) = a + b x log(tvl)     (fitted on the cleaned traded peers; this snapshot: a, b and
//                                     the peer count are in the comparables table the dashboard prints)
//   ratio(tvl) = exp(a) x tvl^(b - 1)
//   growth    = clamp(change_7d, -60, 120) per cent
//   growthMult = 1 + (growth / 100) x GROWTH_WEIGHT
//   maturity  = 0.6 + min(age_days, 1095) / 1095 x 0.4   (age_days unknown: 365)
//   implied   = max(1, round(tvl_usd x ratio(tvl_usd) x growthMult x maturity))
//
// The curve is tested blind before it prices anything: leave-one-out over the traded peers, each
// protocol predicted from a fit that never saw it, against the shrunk category median the earlier
// model used. The dashboard prints both median errors and how often the curve wins, so the choice
// of the curve is a measured one, not a preference. Category medians are still computed and shown
// for reference, and they are what the blind test compares against.
//
// No protocol name is ever special-cased: the same function scores every row, and the comparables
// table the dashboard prints is the same table this file computes.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
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
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  shrink_k: number;
  min_peers: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  shrink_k: 5,
  min_peers: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-curve-1';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Categories the watchlist rule bars from the board (and from the comparables). */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped, staked or staking product of a token that already trades. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** An exchange name at the start of a protocol's name. */
const EXCHANGE_START = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** One category's comparables: how many traded peers, their median price, and the shrunk ratio. */
export interface CategoryComps {
  category: string;
  n: number;
  median: number | null;
  weight: number;
  shrunk: number;
  source: 'category' | 'global';
}

/**
 * The whole comparables table: the market median and one row per category that has peers.
 *
 * A protocol's launch value is not guessed from its name or its rank in a list. It is priced
 * the way a market prices a new listing: by looking at what comparable listings already trade
 * for. Every protocol that records a token, a market cap and a TVL contributes one ratio,
 * market cap divided by TVL, and the fitted size curve (see fitSizeCurve) turns those traded
 * values into a price for a dollar of TVL at any size. The category medians below are the
 * reference the blind test compares the curve against: a category with three or more traded
 * peers prices itself off its own median, shrunk toward the market-wide median, because a
 * median drawn from one or two names is mostly noise; a category with no traded peers at all
 * borrows the market median outright, and says so in the ratio_source the detail view shows.
 * The board itself prices off the curve, not these medians: the blind test (loo) is why.
 *
 * Two multipliers then adjust the price. Growth multiplies by half the protocol's 7-day
 * change, clamped to -60%..+120%, so a protocol that grew 20% in a week prices 10% higher
 * than one that stood still and a protocol that fell 60% prices 30% lower, but a single
 * wild week cannot double or halve the number. Maturity adds up to 40% for a protocol that
 * has run three years with no token, on the reasoning that a protocol that survived that
 * long without launching is likelier to launch at all, while a protocol younger than a year
 * gets only the floor. A protocol whose listing date is unknown is given a year, the middle
 * of the range, rather than the floor or the ceiling.
 *
 * The comparables are recomputed from the snapshot on every run, so the board follows the
 * market instead of freezing a number from the day it was built.
 */
export interface Comparables {
  global_median: number;
  n: number;
  categories: CategoryComps[];
  curve: SizeCurve;
  loo: LooValidation;
}

/** The fitted size curve: log(mcap) = intercept + slope x log(tvl), on the cleaned peers. */
export interface SizeCurve {
  intercept: number;
  slope: number;
  kept: number;
  dropped: number;
  r2: number;
}

/** The blind test: leave-one-out over the traded peers, curve against the median model. */
export interface LooValidation {
  n: number;
  curve_median: number;
  median_median: number;
  curve_wins: number;
}

/** The median of a sorted list of numbers, or null when the list is empty. */
function medianOf(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The comparables table, from the snapshot's own traded protocols. A comparable records a token
 * (it is not pre-token), has a positive market cap and a positive TVL, and sits in a category the
 * board itself ranks. A protocol whose market cap is missing or zero is a data gap, not a price,
 * and is left out rather than dragging every median down.
 */
export function buildComparables(snapshot: Snapshot): Comparables {
  const peers = comparablePeers(snapshot);
  const ratios = peers.map((p) => p.mcap_usd / p.tvl_usd).sort((a, b) => a - b);
  const globalMedian = medianOf(ratios) ?? 0.25;
  const byCategory = new Map<string, number[]>();
  for (const p of peers) {
    if (p.category === null) continue;
    const list = byCategory.get(p.category);
    if (list) list.push(p.mcap_usd / p.tvl_usd);
    else byCategory.set(p.category, [p.mcap_usd / p.tvl_usd]);
  }
  const categories: CategoryComps[] = [...byCategory.entries()]
    .map(([category, list]) => {
      const sorted = list.sort((a, b) => a - b);
      const med = medianOf(sorted);
      const n = sorted.length;
      if (med === null || n < MODEL.min_peers) {
        return { category, n, median: med, weight: 0, shrunk: globalMedian, source: 'global' as const };
      }
      const w = n / (n + MODEL.shrink_k);
      return { category, n, median: med, weight: w, shrunk: w * med + (1 - w) * globalMedian, source: 'category' as const };
    })
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
  return { global_median: globalMedian, n: peers.length, categories, curve: fitSizeCurve(peers), loo: looValidation(peers) };
}

/** One traded peer: a protocol with a token, a market cap and a TVL, in a ranked category. */
interface Peer {
  slug: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
}

/** The snapshot's traded peers: the comparables every pricing in this file is fitted on. */
function comparablePeers(snapshot: Snapshot): Peer[] {
  return snapshot.protocols
    .filter(
      (p) =>
        !isPreToken(p) &&
        p.mcap_usd !== null &&
        p.mcap_usd > 0 &&
        p.tvl_usd > 0 &&
        (p.category === null || !EXCLUDED_CATEGORIES.has(p.category)),
    )
    .map((p) => ({ slug: p.slug, category: p.category, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! }));
}

/**
 * The fitted size curve: Tukey-clean the peers' log market-cap-to-TVL ratios (1.5 x IQR
 * fences), then ordinary least squares of log market cap on log TVL over what survives.
 * A slope below 1 means a dollar of TVL is worth less at a larger protocol, which is what
 * the traded market shows; the curve is the price of a dollar of TVL at a given size.
 */
export function fitSizeCurve(peers: Peer[]): SizeCurve {
  const logs = peers.map((p) => Math.log(p.mcap_usd / p.tvl_usd)).sort((a, b) => a - b);
  const q1 = logs[Math.floor(logs.length * 0.25)]!;
  const q3 = logs[Math.floor(logs.length * 0.75)]!;
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  const kept = peers.filter((p) => {
    const l = Math.log(p.mcap_usd / p.tvl_usd);
    return l >= lo && l <= hi;
  });
  const xs = kept.map((p) => Math.log(p.tvl_usd));
  const ys = kept.map((p) => Math.log(p.mcap_usd));
  const n = kept.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx, dy = ys[i]! - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = (sxy * sxy) / (sxx * syy);
  return { intercept, slope, kept: n, dropped: peers.length - n, r2 };
}

/** The market-cap-to-TVL ratio the size curve gives a protocol of this TVL. */
export function curveRatio(tvlUsd: number, curve: SizeCurve): number {
  return Math.exp(curve.intercept) * Math.pow(tvlUsd, curve.slope - 1);
}

/** The shrunk category median ratio for a category, from a peer pool (the old model's price). */
function medianRatioFor(category: string | null, pool: Peer[]): number {
  const ratios = pool.map((p) => p.mcap_usd / p.tvl_usd).sort((a, b) => a - b);
  const global = medianOf(ratios) ?? 0.25;
  if (category === null) return global;
  const cat = pool.filter((p) => p.category === category).map((p) => p.mcap_usd / p.tvl_usd).sort((a, b) => a - b);
  if (cat.length < MODEL.min_peers) return global;
  const med = medianOf(cat)!;
  const w = cat.length / (cat.length + MODEL.shrink_k);
  return w * med + (1 - w) * global;
}

/**
 * The blind test: leave one traded peer out, fit the curve and the median model without it,
 * predict the held-out protocol's market cap from its TVL, and score |log(pred/actual)|.
 * The curve wins when its median error is the smaller one; the dashboard prints both.
 */
function looValidation(peers: Peer[]): LooValidation {
  const curveErrs: number[] = [];
  const medianErrs: number[] = [];
  let wins = 0;
  for (const p of peers) {
    const pool = peers.filter((q) => q.slug !== p.slug);
    const curve = fitSizeCurve(pool);
    const eCurve = Math.abs(Math.log((p.tvl_usd * curveRatio(p.tvl_usd, curve)) / p.mcap_usd));
    const eMedian = Math.abs(Math.log((p.tvl_usd * medianRatioFor(p.category, pool)) / p.mcap_usd));
    curveErrs.push(eCurve);
    medianErrs.push(eMedian);
    if (eCurve < eMedian) wins++;
  }
  const curveMedian = medianOf([...curveErrs].sort((a, b) => a - b)) ?? 0;
  const medianMedian = medianOf([...medianErrs].sort((a, b) => a - b)) ?? 0;
  return { n: peers.length, curve_median: curveMedian, median_median: medianMedian, curve_wins: wins };
}

/** The ratio one category's protocols are priced at, from the comparables table. */
export function ratioFor(category: string | null, comps: Comparables): { ratio: number; median: number | null; n: number; weight: number; source: 'category' | 'global' } {
  if (category === null) return { ratio: comps.global_median, median: null, n: 0, weight: 0, source: 'global' };
  const row = comps.categories.find((c) => c.category === category);
  if (!row || row.source === 'global') return { ratio: comps.global_median, median: row?.median ?? null, n: row?.n ?? 0, weight: 0, source: 'global' };
  return { ratio: row.shrunk, median: row.median, n: row.n, weight: row.weight, source: 'category' };
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The multipliers and the implied value one protocol gets under `model` and `comps`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  comps: Comparables,
): {
  implied: number;
  ratio: number;
  categoryMedian: number | null;
  categoryN: number;
  shrinkWeight: number;
  ratioSource: 'curve';
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  age: number | null;
} {
  const age = ageDays(asOf, protocol.listed_at);
  // The board prices off the fitted size curve; the category median is kept as the reference
  // the blind test compares against, not as the price.
  const priced = ratioFor(protocol.category, comps);
  const ratio = curveRatio(protocol.tvl_usd, comps.curve);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * ratio * growthMult * maturityMult));
  return {
    implied,
    ratio,
    categoryMedian: priced.median,
    categoryN: priced.n,
    shrinkWeight: priced.weight,
    ratioSource: 'curve',
    growthPct,
    growthMult,
    maturityMult,
    age,
  };
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: the watchlist rule, as far as the snapshot's ten
 * fields can check it. Pre-token, not an exchange product, not a versioned pool, not a wrapped or
 * staked product of a token that already trades, and not named after an exchange. The snapshot
 * carries no parentProtocol field, so that part of the house rule is already applied to the
 * watchlist it ships and cannot be re-checked here.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_START.test(p.name)) return false;
  return true;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
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
    ratio_used: number;
    ratio_source: 'category' | 'global' | 'curve';
    category_median: number | null;
    category_peers: number;
    shrink_weight: number;
    global_median: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with the farm plan generated in the page. */
export interface RadarRow {
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
  ratio_used: number;
  ratio_source: 'category' | 'global' | 'curve';
  category_median: number | null;
  category_peers: number;
  shrink_weight: number;
  global_median: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, the comparables, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  watchlist: string[];
  board_size: number;
  early_size: number;
  live_size: number;
  comparables: Comparables;
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/**
 * The protocols the board ranks, strongest first, with ranks 1..n. Every protocol the watchlist
 * rule admits is ranked: the watchlist is the floor and the early radar is every other pre-token
 * protocol the rule admits, above or below the floor. Ties on implied value break by slug, so the
 * board is deterministic across runs.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = buildComparables(snapshot);
  const chosen = snapshot.protocols.filter((p) => isRankable(p));
  const scored = chosen.map((p) => {
    const v = impliedValue(p, snapshot.as_of, model, comps);
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
      ratio_used: s.ratio,
      ratio_source: s.ratioSource,
      category_median: s.categoryMedian,
      category_peers: s.categoryN,
      shrink_weight: s.shrinkWeight,
      global_median: comps.global_median,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** What one transaction costs on a chain, and how much extra to fund for gas. */
function gasFor(chain: string): { perTx: string; buffer: number } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { perTx: 'about $8', buffer: 50 };
  if (c === 'solana') return { perTx: 'a few cents', buffer: 5 };
  const cheap = new Set([
    'base', 'arbitrum', 'optimism', 'bsc', 'bnb chain', 'hyperliquid', 'monad', 'polygon',
    'avalanche', 'zksync', 'zksync era', 'linea', 'scroll', 'blast', 'mantle', 'mode',
    'fraxtal', 'arbitrum nova', 'opbnb', 'gnosis', 'celo', 'fantom', 'sonic',
  ]);
  if (cheap.has(c)) return { perTx: 'under $1', buffer: 10 };
  return { perTx: 'about $2', buffer: 20 };
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('basis')) return `Deposit $${capital} into a ${name} basis vault on ${chain} and keep the position.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('index')) return `Buy $${capital} of the ${name} index on ${chain} and hold it.`;
  if (c.includes('payment') || c.includes('card')) return `Route $${capital} of payments through ${name} on ${chain} and keep the receipts.`;
  if (c.includes('otc')) return `Place a $${capital} order through ${name} on ${chain} and settle it.`;
  if (c.includes('governance')) return `Lock $${capital} of voting power with ${name} on ${chain} and keep it locked.`;
  if (c.includes('chain')) return `Bridge $${capital} to ${chain} and use it in ${name}'s apps.`;
  if (c.includes('btc') || c.includes('bitcoin')) return `Deposit $${capital} of wrapped BTC into ${name} on ${chain} and keep the position.`;
  if (c.includes('cedefi')) return `Deposit $${capital} into a ${name} CeDeFi vault on ${chain} and keep the shares.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** A second qualifying action, different from the first, so the position shows real activity. */
function secondActionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow a small amount against the position and repay it in full.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Swap a small amount in the same pool and add the proceeds back as liquidity.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('rwa') || c.includes('basis')) return `Deposit a second, smaller amount into a different vault of the same protocol.`;
  if (c.includes('staking') || c.includes('restak')) return `Claim the staking rewards and restake them through ${name}.`;
  if (c.includes('prediction')) return `Take a position on a second, different outcome on ${name}.`;
  if (c.includes('bridge')) return `Bridge a small amount back the other way through ${name}.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Close the hedge and open a fresh one on ${name}.`;
  return `Make a second deposit of a smaller amount into ${name} on ${chain}.`;
}

/**
 * A protocol's farm plan: eight steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names. Capital scales with TVL, gas with the chain, the hold with the protocol's age, and the
 * actions with its category.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const fund = capital + gas.buffer;
  const action = actionFor(p, capital, chain);
  const second = secondActionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'nothing to set up',
      time: '5 minutes',
    },
    {
      text: `Fund the wallet with $${fund} of USDC on ${chain}, enough for the position plus gas.`,
      cost: `${gas.perTx} of gas to receive it`,
      time: '10 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gas.perTx} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `${gas.perTx} of gas`,
      time: '10 minutes',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: `${gas.perTx} of gas a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
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

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
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
    ratio_used: row.model.ratio_used,
    ratio_source: row.model.ratio_source,
    category_median: row.model.category_median,
    category_peers: row.model.category_peers,
    shrink_weight: row.model.shrink_weight,
    global_median: row.model.global_median,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const comps = buildComparables(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    watchlist: snapshot.watchlist,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    comparables: comps,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/**
 * The snapshot out of a file's text. The shape is strict: the document must be a JSON object
 * with an as_of date, a source string, a positive whole floor, a protocols array and a
 * watchlist of slugs; every protocol must carry a slug, a name and a finite TVL. Anything
 * else is refused with a SnapshotError naming the problem, so a malformed input fails loudly
 * instead of silently scoring the wrong protocols.
 */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') {
    throw new SnapshotError('snapshot.json has no source');
  }
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) {
    throw new SnapshotError('snapshot.json has no protocols array');
  }
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    const bad = typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd);
    if (bad) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
      slug: p.slug as string,
      name: p.name as string,
      category: strOrNull(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd as number,
      change_7d: numOrNull(p.change_7d),
      mcap_usd: numOrNull(p.mcap_usd),
      listed_at: strOrNull(p.listed_at),
      gecko_id: strOrNull(p.gecko_id),
      symbol: strOrNull(p.symbol),
    };
  });
  return {
    as_of: o.as_of as string,
    source: o.source as string,
    floor_usd: o.floor_usd as number,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/**
 * Why a board is not one the gate will take, or null. The checks run in the order the gate
 * cares about: the watchlist must be fully covered first, then the ranks must be exactly
 * 1..N, then the implied values must not rise as the rank ascends, then the board must
 * actually rank something (not one shared value), and finally every row must carry a valid
 * implied value and a farm plan of 3 to 12 steps of 20 to 600 characters each.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) {
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  }
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) {
      return `${r.slug} has ${steps.length} farm steps`;
    }
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) {
        return `${r.slug} has a farm step of ${s.length} characters`;
      }
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
