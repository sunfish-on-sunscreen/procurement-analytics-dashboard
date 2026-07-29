"use client";

import { useEffect, useState } from "react";
import { X, Loader2, ArrowUp, ArrowDown, Minus, ChevronDown } from "lucide-react";
import type { SpendDetail, SupplierEvolution } from "@/lib/spend-overview-types";
import type {
  KraljicResult,
  PerformanceSpendResult,
  KraljicQuadrant,
  RiskComponents,
} from "@/lib/analysis-types";
import { QUADRANT_COLORS } from "@/lib/chart-colors";
import { panelElevation, formatCompactCurrency } from "@/lib/utils";
import { periodSpanLabel } from "@/lib/panel-format";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/CountryFlag";
import { RetiredBadge } from "@/components/RankingCells";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PillTabs } from "@/components/PillTabs";
import { ScoreComponents } from "@/components/PerformanceTrajectory";

type SubKey = "quality" | "delivery" | "process" | "risk";
const SUBS: { key: SubKey; label: string }[] = [
  { key: "quality", label: "Quality" },
  { key: "delivery", label: "Delivery" },
  { key: "process", label: "Process" },
  { key: "risk", label: "Risk" },
];

const upCls = "text-[var(--success)]";
const downCls = "text-[var(--destructive)]";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Feb 27" (single-year mode) / "Feb 27, 2024" (range mode) from an ISO date. */
function fmtActivityDate(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return withYear ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${d}`;
}

/** Per-tab one-line takeaway, divider + "Insight:" lead. */
function InsightLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">Insight:</span> {children}
    </p>
  );
}

// ---- Insights card 1: performance trajectory (expandable) ----------------- #
function pickCurPrev(periods: SupplierEvolution["periods"], selectedYear: string | null) {
  const withSub = periods.filter((p) => p.subScores != null);
  if (withSub.length === 0) return null;
  let curIdx = selectedYear ? withSub.findIndex((p) => p.year === selectedYear) : -1;
  if (curIdx === -1) curIdx = withSub.length - 1;
  return { cur: withSub[curIdx], prev: curIdx > 0 ? withSub[curIdx - 1] : null };
}

function MoverChip({ label, delta }: { label: string; delta: number }) {
  const up = delta > 0;
  const Icon = up ? ArrowUp : ArrowDown;
  return (
    <span className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${up ? upCls : downCls}`}>
      {label} <Icon className="h-3 w-3" />
      {up ? "+" : "−"}
      {Math.abs(delta).toFixed(2)}
    </span>
  );
}

/**
 * The expandable card's summary (always visible): two biggest sub-score movers,
 * the composite + delta, and a context line. The whole summary is the toggle
 * button; the expanded "Score components" render below it (parent), full width.
 */
function PerfSummaryButton({
  perf,
  evo,
  selectedYear,
  open,
  onToggle,
}: {
  perf: SpendDetail["supplier"]["performance"];
  evo: SupplierEvolution | undefined;
  selectedYear: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  // Movers: biggest up + biggest down sub-score vs the prior active period.
  const cp = evo ? pickCurPrev(evo.periods, selectedYear) : null;
  let movers: React.ReactNode = null;
  if (cp?.cur.subScores && cp.prev?.subScores) {
    const cs = cp.cur.subScores;
    const ps = cp.prev.subScores;
    const deltas = SUBS.map((s) => ({ label: s.label, d: cs[s.key] - ps[s.key] })).filter(
      (x) => Math.abs(x.d) >= 0.005,
    );
    const up = [...deltas].filter((x) => x.d > 0).sort((a, b) => b.d - a.d)[0];
    const down = [...deltas].filter((x) => x.d < 0).sort((a, b) => a.d - b.d)[0];
    if (up || down) {
      movers = (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {up && <MoverChip label={up.label} delta={up.d} />}
          {up && down && <span className="text-muted-foreground/40">·</span>}
          {down && <MoverChip label={down.label} delta={down.d} />}
        </div>
      );
    } else {
      movers = <p className="text-sm text-muted-foreground">Sub-scores unchanged vs {cp.prev.year}.</p>;
    }
  } else {
    movers = <p className="text-sm text-muted-foreground">No prior period to compare sub-scores.</p>;
  }

  // Composite + delta (period-scoped, authoritative).
  const score = perf.score;
  const delta =
    perf.mode === "single" && score != null && perf.previousScore != null
      ? score - perf.previousScore
      : null;
  const dRounded = delta == null ? null : Math.round(delta * 100) / 100;
  const DeltaIcon = dRounded == null ? Minus : dRounded > 0 ? ArrowUp : dRounded < 0 ? ArrowDown : Minus;
  const deltaCls = dRounded == null || dRounded === 0 ? "text-muted-foreground" : dRounded > 0 ? upCls : downCls;

  // Context line.
  let context: string;
  if (dRounded != null && perf.previousLabel) {
    const flat = Math.abs(dRounded) < 0.5;
    context = flat
      ? `≈ flat vs ${perf.previousLabel}`
      : `${dRounded > 0 ? "up" : "down"} vs ${perf.previousLabel}`;
  } else if (perf.mode === "range") {
    context = perf.latestLabel ? `range · latest active ${perf.latestLabel}` : `range ${perf.periodLabel ?? ""}`;
  } else {
    context = "first year on record";
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={open ? "Hide score components" : "Show score components"}
      className="relative block w-full rounded-xl bg-card px-3.5 py-3 text-left ring-1 ring-foreground/10"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-muted-foreground">Performance trajectory</span>
        <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </div>
      {movers}
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums">{score != null ? score.toFixed(2) : "—"}</span>
        {dRounded != null && (
          <span className={`inline-flex items-center gap-0.5 text-sm font-medium tabular-nums ${deltaCls}`}>
            <DeltaIcon className="h-3.5 w-3.5" />
            {Math.abs(dRounded).toFixed(2)}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">performance</span>
      </div>
      <div className="mt-0.5 text-[11px] text-muted-foreground">{context}</div>
    </button>
  );
}

// ---- Insights card 2: quadrant tenure ------------------------------------- #
function QuadrantChip({ quadrant }: { quadrant: KraljicQuadrant | null }) {
  if (!quadrant) return <span className="text-muted-foreground">—</span>;
  const color = QUADRANT_COLORS[quadrant];
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
    >
      {quadrant}
    </span>
  );
}

function QuadrantTenureCard({
  current,
  evo,
}: {
  current: KraljicQuadrant | null;
  evo: SupplierEvolution | undefined;
}) {
  const activeQ = (evo?.periods ?? []).filter(
    (p) => (p.spend > 0 || p.invoiceCount > 0) && p.kraljicQuadrant,
  );
  const headline = current ?? (activeQ.length ? activeQ[activeQ.length - 1].kraljicQuadrant : null);

  let stability: React.ReactNode;
  if (activeQ.length === 0) {
    stability = <p className="text-sm text-muted-foreground">Not classified in any period.</p>;
  } else if (activeQ.length === 1) {
    stability = (
      <p className="text-sm text-muted-foreground">
        Only active year: <span className="font-medium text-foreground">{activeQ[0].year}</span>.
      </p>
    );
  } else {
    const quads = activeQ.map((p) => p.kraljicQuadrant);
    const allSame = quads.every((q) => q === quads[0]);
    const first = activeQ[0];
    const last = activeQ[activeQ.length - 1];
    stability = allSame ? (
      <p className="text-sm text-muted-foreground">
        Held {activeQ.length === 2 ? "both active years" : `all ${activeQ.length} active years`}.
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">
        Moved <span className="font-medium text-foreground">{first.kraljicQuadrant}</span> to{" "}
        <span className="font-medium text-foreground">{last.kraljicQuadrant}</span>.
      </p>
    );
  }

  return (
    <div className="rounded-xl bg-card px-3.5 py-3 ring-1 ring-foreground/10">
      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">Quadrant tenure</div>
      <div className="mb-1.5">
        <QuadrantChip quadrant={headline} />
      </div>
      {stability}
      {activeQ.length > 1 && (
        <div className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">
          {activeQ.map((p) => `${p.year} ${p.kraljicQuadrant}`).join(" to ")}
        </div>
      )}
    </div>
  );
}

// ---- Tab 1: supply-risk breakdown ----------------------------------------- #
const RISK_COMPONENTS: { key: keyof RiskComponents; label: string; cap: number }[] = [
  { key: "supply_concentration", label: "Supply concentration", cap: 50 },
  { key: "cost_premium", label: "Cost premium", cap: 25 },
  { key: "import_friction", label: "Import friction", cap: 25 },
];

function SupplyRiskBreakdown({
  components,
  total,
  quadrant,
}: {
  components: RiskComponents | null;
  total: number | null;
  quadrant: KraljicQuadrant | null;
}) {
  if (!components || total == null) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No supply-risk classification in this period.
      </p>
    );
  }
  const color = quadrant ? QUADRANT_COLORS[quadrant] : "var(--primary)";
  const ranked = RISK_COMPONENTS.map((c) => ({ ...c, v: components[c.key] })).sort((a, b) => b.v - a.v);
  const top = ranked[0];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm text-muted-foreground">Supply risk score</span>
        <span className="text-lg font-semibold tabular-nums">
          {total.toFixed(2)} <span className="text-sm font-normal text-muted-foreground">/ 100</span>
        </span>
      </div>
      <div className="flex flex-col gap-2.5">
        {RISK_COMPONENTS.map(({ key, label, cap }) => {
          const v = components[key];
          return (
            <div key={key}>
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-foreground">{label}</span>
                <span className="tabular-nums text-muted-foreground">
                  {v.toFixed(2)} <span className="text-muted-foreground/60">/ {cap}</span>
                </span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ backgroundColor: "color-mix(in srgb, var(--muted-foreground) 15%, transparent)" }}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(100, (v / cap) * 100)}%`, backgroundColor: color }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Supply risk = supply concentration (≤50) + cost premium (≤25) + import friction (≤25),
        clipped to 100. The three components sum to the score above.
      </p>
      <InsightLine>
        {top.v <= 0.005 ? (
          "Minimal supply risk — no material driver."
        ) : (
          <>
            <span className="font-medium text-foreground">{top.label}</span> is the dominant driver (
            <span className="tabular-nums">{top.v.toFixed(2)}</span> of{" "}
            <span className="tabular-nums">{total.toFixed(2)}</span>).
          </>
        )}
      </InsightLine>
    </div>
  );
}

// ---- Tab 2: quadrant peers ------------------------------------------------ #
type PeerSort = "performance" | "spend" | "risk";
type Peer = {
  id: string;
  name: string;
  performance: number;
  spend: number;
  risk: number | null;
};

const SORT_LABEL: Record<PeerSort, string> = {
  performance: "performance",
  spend: "spend",
  risk: "supply risk",
};

// The quadrant's defining axis drives the default sort. Strategic is hi-spend AND
// hi-risk ("both"); we default it to supply risk (the axis that separates it from
// Leverage) and offer all three toggles.
const DEFAULT_PEER_SORT: Record<KraljicQuadrant, PeerSort> = {
  Bottleneck: "risk",
  Strategic: "risk",
  Leverage: "spend",
  Routine: "spend",
};

const PEER_COLLAPSE_N = 5;

function QuadrantPeers({
  supplierId,
  quadrant,
  perf,
  kraljic,
  onSupplierClick,
}: {
  supplierId: string;
  quadrant: KraljicQuadrant | null;
  perf: PerformanceSpendResult;
  kraljic: KraljicResult | null;
  onSupplierClick: (id: string) => void;
}) {
  const [sort, setSort] = useState<PeerSort>(quadrant ? DEFAULT_PEER_SORT[quadrant] : "spend");
  const [showAll, setShowAll] = useState(false);
  // Reset sort + collapse to the quadrant default when the supplier changes.
  const [prevQuad, setPrevQuad] = useState(quadrant);
  if (prevQuad !== quadrant) {
    setPrevQuad(quadrant);
    setSort(quadrant ? DEFAULT_PEER_SORT[quadrant] : "spend");
    setShowAll(false);
  }

  if (!quadrant) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Not assigned an Exposure position (Kraljic matrix quadrant) in this period.
      </p>
    );
  }

  const riskById = new Map(
    (kraljic?.quadrant_assignments ?? []).map((q) => [q.supplier_id, q.supply_risk_score]),
  );
  const peers: Peer[] = perf.suppliers
    .filter((s) => s.kraljic_quadrant === quadrant)
    .map((s) => ({
      id: s.supplier_id,
      name: s.supplier_name,
      performance: s.performance_score,
      spend: s.total_spend_usd,
      risk: riskById.get(s.supplier_id) ?? null,
    }));

  const sorted = [...peers].sort((a, b) => {
    if (sort === "performance") return b.performance - a.performance;
    if (sort === "spend") return b.spend - a.spend;
    return (b.risk ?? -1) - (a.risk ?? -1);
  });

  const selfRank = sorted.findIndex((p) => p.id === supplierId) + 1; // 0 → not found
  const collapsed = sorted.length > PEER_COLLAPSE_N && !showAll;
  const rows = collapsed ? sorted.slice(0, PEER_COLLAPSE_N) : sorted;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {peers.length} supplier{peers.length === 1 ? "" : "s"} in {quadrant}
        </p>
        <PillTabs
          tabs={[["performance", "Performance"], ["spend", "Spend"], ["risk", "Supply risk"]] as const}
          active={sort}
          onChange={setSort}
        />
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-1.5 text-right font-medium">#</th>
            <th className="py-1.5 font-medium">Supplier</th>
            <th className="py-1.5 text-right font-medium">Perf.</th>
            <th className="py-1.5 text-right font-medium">Spend</th>
            <th className="py-1.5 text-right font-medium">Risk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => {
            const isSelf = p.id === supplierId;
            return (
              <tr
                key={p.id}
                onClick={() => onSupplierClick(p.id)}
                className={`cursor-pointer border-b last:border-0 ${
                  isSelf ? "bg-foreground/5 ring-1 ring-inset ring-foreground/30" : "hover:bg-muted/40"
                }`}
              >
                <td className="py-1.5 text-right tabular-nums text-muted-foreground">{i + 1}</td>
                <td className="py-1.5">
                  <span className={`block max-w-[200px] truncate ${isSelf ? "font-semibold" : ""}`} title={p.name}>
                    {p.name}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums">{p.performance.toFixed(2)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatCompactCurrency(p.spend)}</td>
                <td className="py-1.5 text-right tabular-nums">{p.risk != null ? p.risk.toFixed(2) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > PEER_COLLAPSE_N && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="self-start text-xs font-medium text-primary hover:underline"
        >
          {collapsed ? `Expand to full table (${sorted.length}) →` : "Show less"}
        </button>
      )}
      <InsightLine>
        {selfRank > 0 ? (
          <>
            Ranks <span className="font-medium tabular-nums text-foreground">#{selfRank}</span> of{" "}
            <span className="tabular-nums">{sorted.length}</span> in {quadrant} by {SORT_LABEL[sort]}.
          </>
        ) : (
          <>Not ranked among the {quadrant} peers this period.</>
        )}
      </InsightLine>
    </div>
  );
}

// ---- Panel ---------------------------------------------------------------- #
type Tab = "risk" | "peers";

export function SupplierClassificationDetailPanel({
  supplierId,
  startDate,
  endDate,
  kraljic,
  perf,
  onClose,
  onSupplierClick,
}: {
  supplierId: string | null;
  startDate: string;
  endDate: string;
  kraljic: KraljicResult | null;
  perf: PerformanceSpendResult;
  onClose: () => void;
  onSupplierClick: (id: string) => void;
}) {
  const detailKey = supplierId ? `${supplierId}_${startDate}_${endDate}` : "";
  const [detailState, setDetailState] = useState<{ key: string; detail?: SpendDetail; err?: string } | null>(null);
  const [evo, setEvo] = useState<{ id: string; data?: SupplierEvolution; err?: string } | null>(null);

  const detail = detailState?.key === detailKey ? detailState.detail : undefined;
  const detailErr = detailState?.key === detailKey ? detailState.err : undefined;
  const detailLoading = !!supplierId && !detail && !detailErr;
  const span = periodSpanLabel(startDate, endDate);

  useEffect(() => {
    if (!supplierId) return;
    const key = `${supplierId}_${startDate}_${endDate}`;
    let cancelled = false;
    const qs = startDate && endDate ? `?start=${startDate}&end=${endDate}` : "";
    fetch(`/api/suppliers/${supplierId}/spend-detail${qs}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Failed to load");
        return res.json() as Promise<SpendDetail>;
      })
      .then((d) => { if (!cancelled) setDetailState({ key, detail: d }); })
      .catch((e: unknown) => { if (!cancelled) setDetailState({ key, err: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [supplierId, startDate, endDate]);

  useEffect(() => {
    if (!supplierId) return;
    const sid = supplierId;
    let cancelled = false;
    fetch(`/api/suppliers/${sid}/evolution`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load evolution");
        return res.json() as Promise<SupplierEvolution>;
      })
      .then((d) => { if (!cancelled) setEvo({ id: sid, data: d }); })
      .catch((e: unknown) => { if (!cancelled) setEvo({ id: sid, err: e instanceof Error ? e.message : String(e) }); });
    return () => { cancelled = true; };
  }, [supplierId]);

  const evoData = evo?.id === supplierId ? evo.data : undefined;
  const s = detail?.supplier;

  // This supplier's period-scoped Performance-vs-Spend zone (identity subline).
  const myZone = supplierId
    ? perf.suppliers.find((p) => p.supplier_id === supplierId)?.zone ?? null
    : null;

  return (
    <Dialog open={!!supplierId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-label="Supplier classification detail"
        className={`flex max-h-[85vh] w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[680px] ${panelElevation}`}
      >
        <header className="flex items-start justify-between gap-2 border-b p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <DialogTitle className="truncate font-heading text-base font-medium leading-snug">{s?.name ?? "Loading…"}</DialogTitle>
              {s?.retired && <RetiredBadge />}
            </div>
            {s && (
              <p className="truncate text-xs text-muted-foreground">
                {(() => {
                  const parts = [s.category, s.abcClass, s.kraljicQuadrant, myZone].filter(Boolean);
                  if (parts.length === 0 && !s.country) return s.id;
                  return (
                    <>
                      {parts.join(" · ")}
                      {s.country && (
                        <>
                          {parts.length > 0 ? " · " : ""}
                          {s.country}
                          <CountryFlag code={s.country} />
                        </>
                      )}
                    </>
                  );
                })()}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground" title={span.full}>
              Showing {span.short}
            </p>
          </div>
          <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" aria-label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <ClassificationDetailBody
          supplierId={supplierId}
          startDate={startDate}
          endDate={endDate}
          kraljic={kraljic}
          perf={perf}
          onSupplierClick={onSupplierClick}
          detail={detail}
          detailErr={detailErr}
          detailLoading={detailLoading}
          evo={evoData}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---- Body (presentational; reused by the Action Priorities unified modal) --- #
export function ClassificationDetailBody({
  supplierId,
  startDate,
  endDate,
  kraljic,
  perf,
  onSupplierClick,
  detail,
  detailErr,
  detailLoading,
  evo,
}: {
  supplierId: string | null;
  startDate: string;
  endDate: string;
  kraljic: KraljicResult | null;
  perf: PerformanceSpendResult;
  onSupplierClick: (id: string) => void;
  detail: SpendDetail | undefined;
  detailErr: string | undefined;
  detailLoading: boolean;
  evo: SupplierEvolution | undefined;
}) {
  const [tab, setTab] = useState<Tab>("risk");
  const [perfOpen, setPerfOpen] = useState(true);
  const [prevId, setPrevId] = useState(supplierId);
  if (prevId !== supplierId) {
    setPrevId(supplierId);
    setTab("risk");
    setPerfOpen(true);
  }
  const span = periodSpanLabel(startDate, endDate);
  const selectedYear = startDate.slice(0, 4) === endDate.slice(0, 4) ? startDate.slice(0, 4) : null;
  const evoData = evo;
  const s = detail?.supplier;
  const st = detail?.stats;
  const absent = st != null && st.invoiceCount === 0;
  // This supplier's period-scoped Kraljic assignment (risk breakdown source).
  const myAssignment = supplierId
    ? kraljic?.quadrant_assignments.find((q) => q.supplier_id === supplierId)
    : undefined;

  return (
    <>
      {detailLoading && (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading detail…
        </div>
      )}
      {detailErr && <p className="p-4 text-sm text-destructive">{detailErr}</p>}

      {detail && st && s && (
        <>
          {/* Section 1: classification insights — expandable card + tenure card. */}
            <div className="border-b p-4">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Classification insights</h4>
              {absent ? (
                <p className="text-sm text-muted-foreground">No classification in this period.</p>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <PerfSummaryButton
                      perf={s.performance}
                      evo={evoData}
                      selectedYear={selectedYear}
                      open={perfOpen}
                      onToggle={() => setPerfOpen((o) => !o)}
                    />
                    <QuadrantTenureCard current={s.kraljicQuadrant} evo={evoData} />
                  </div>
                  {/* Expanded "Score components" — full width below the grid. */}
                  {perfOpen && evoData && (
                    <div className="mt-3 border-t pt-3">
                      <ScoreComponents data={evoData} selectedYear={selectedYear} />
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Section 2: activity period. */}
            <div className="border-b p-4">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Activity period</h4>
              {absent || !st.earliestDate || !st.latestDate ? (
                <p className="text-sm text-muted-foreground">No activity in this period</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {span.short} · {fmtActivityDate(st.earliestDate, !selectedYear)} to{" "}
                  {fmtActivityDate(st.latestDate, !selectedYear)}
                </p>
              )}
            </div>

            {/* Section 3: classification detail tabs. */}
            <div className="border-b px-4 pt-3 pb-1">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Classification detail</h4>
              <PillTabs
                tabs={[["risk", "Supply risk"], ["peers", "Quadrant peers"]] as const}
                active={tab}
                onChange={setTab}
              />
            </div>

            <div className="p-4">
              {tab === "risk" && (
                <SupplyRiskBreakdown
                  components={myAssignment?.risk_components ?? null}
                  total={myAssignment?.supply_risk_score ?? null}
                  quadrant={s.kraljicQuadrant}
                />
              )}
              {tab === "peers" && supplierId && (
                <QuadrantPeers
                  supplierId={supplierId}
                  quadrant={s.kraljicQuadrant}
                  perf={perf}
                  kraljic={kraljic}
                  onSupplierClick={onSupplierClick}
                />
              )}
            </div>
          </>
        )}
    </>
  );
}
