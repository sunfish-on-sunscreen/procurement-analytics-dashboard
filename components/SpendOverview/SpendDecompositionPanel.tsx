"use client";

import { useEffect, useState } from "react";
import { X, Loader2 } from "lucide-react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { SpendDetail, SupplierEvolution } from "@/lib/spend-overview-types";
import { CHART_COLORS } from "@/lib/chart-colors";
import { formatCompactCurrency, panelElevation } from "@/lib/utils";
import { periodSpanLabel } from "@/lib/panel-format";
import { Button } from "@/components/ui/button";
import { CountryFlag } from "@/components/CountryFlag";
import { RetiredBadge } from "@/components/RankingCells";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { StatBlock } from "@/components/ui/stat-block";
import { ChartFrame } from "@/components/charts/ChartFrame";
import { PillTabs } from "@/components/PillTabs";
import { ViewToggle, type View } from "@/components/ViewToggle";

const usd0 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jan 1" (single-year mode) / "Jan 1, 2024" (range mode) from an ISO date. */
function fmtActivityDate(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!m || !d) return iso;
  return withYear ? `${MONTHS[m - 1]} ${d}, ${y}` : `${MONTHS[m - 1]} ${d}`;
}

type Tab = "byItem" | "pos" | "evolution";

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- Tab 1: spend by item (horizontal bars) ------------------------------- #
type ItemDatum = { name: string; full: string; value: number; count: number; avg: number; pct: number };

function ItemTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ItemDatum }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="max-w-[220px] rounded-md border bg-background p-2 text-xs shadow-sm">
      <div className="font-medium">{d.full}</div>
      <div className="mt-1 text-muted-foreground">{usd0.format(d.value)} · {d.pct.toFixed(1)}% of total</div>
      <div className="text-muted-foreground">{d.count} invoice(s) · {usd0.format(d.avg)} avg</div>
    </div>
  );
}

function SpendByItemChart({ detail }: { detail: SpendDetail }) {
  const total = detail.stats.totalSpend || 1;
  const top = detail.byItem.slice(0, 15);
  const rest = detail.byItem.slice(15);
  const data: ItemDatum[] = top.map((it) => ({
    name: truncate(it.itemName, 22),
    full: it.itemName,
    value: it.totalSpend,
    count: it.invoiceCount,
    avg: it.invoiceCount > 0 ? it.totalSpend / it.invoiceCount : 0,
    pct: (it.totalSpend / total) * 100,
  }));
  if (rest.length) {
    const spend = rest.reduce((s, r) => s + r.totalSpend, 0);
    const count = rest.reduce((s, r) => s + r.invoiceCount, 0);
    data.push({ name: `Others (${rest.length})`, full: `${rest.length} more items`, value: spend, count, avg: count ? spend / count : 0, pct: (spend / total) * 100 });
  }
  const cum = detail.byItem.slice(0, 5).reduce((s, r) => s + r.totalSpend, 0);
  const top5pct = Math.round((cum / total) * 100);

  return (
    <div>
      <ChartFrame height={Math.max(220, data.length * 30 + 24)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tickFormatter={(v) => formatCompactCurrency(Number(v))} tick={{ fontSize: 10 }} />
          <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 10 }} interval={0} />
          <Tooltip content={<ItemTooltip />} cursor={{ fillOpacity: 0.06 }} />
          <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[0, 3, 3, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartFrame>
      <p className="mt-2 text-xs text-muted-foreground">
        Top 5 items account for {top5pct}% of spend · {detail.byItem.length} item(s) total.
      </p>
    </div>
  );
}

// ---- Tab 2: Invoices over time (bars) ------------------------------------- #
type PoDatum = { date: string; value: number; poId: string; item: string };

function PoTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PoDatum }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="max-w-[220px] rounded-md border bg-background p-2 text-xs shadow-sm">
      <div className="font-medium">{d.poId}</div>
      <div className="text-muted-foreground">{d.item}</div>
      <div className="mt-1 text-muted-foreground">{usd0.format(d.value)} · {d.date}</div>
    </div>
  );
}

function PosTimeChart({ detail }: { detail: SpendDetail }) {
  const data: PoDatum[] = [...detail.pos]
    .map((p) => ({ date: p.paymentDate ?? p.prDate ?? "—", value: p.totalValueUsd, poId: p.poId, item: p.itemName }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dateRange =
    data.length > 0 ? `${data[0].date} to ${data[data.length - 1].date}` : "—";

  return (
    <div>
      <ChartFrame height={260}>
        <BarChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 24 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="date" tick={{ fontSize: 9 }} angle={-35} textAnchor="end" height={48} interval="preserveStartEnd" />
          <YAxis tickFormatter={(v) => formatCompactCurrency(Number(v))} tick={{ fontSize: 10 }} width={48} />
          <Tooltip content={<PoTooltip />} cursor={{ fillOpacity: 0.06 }} />
          <Bar dataKey="value" fill={CHART_COLORS[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartFrame>
      <p className="mt-2 text-xs text-muted-foreground">{detail.pos.length} invoice(s) · {dateRange} · by payment date.</p>
    </div>
  );
}

// ---- Tab 1/2 table fallbacks ---------------------------------------------- #
function ItemTable({ detail }: { detail: SpendDetail }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="py-1.5 text-right font-medium">Invoices</th>
          <th className="py-1.5 font-medium">Item</th>
          <th className="py-1.5 text-right font-medium">Total spend</th>
        </tr>
      </thead>
      <tbody>
        {detail.byItem.map((it) => (
          <tr key={it.itemName} className="border-b">
            <td className="py-1.5 text-right text-muted-foreground">{it.invoiceCount}</td>
            <td className="py-1.5">{it.itemName}</td>
            <td className="py-1.5 text-right">{usd0.format(it.totalSpend)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PosTable({ detail }: { detail: SpendDetail }) {
  const rows = [...detail.pos].sort((a, b) =>
    (b.paymentDate ?? b.prDate ?? "").localeCompare(a.paymentDate ?? a.prDate ?? ""),
  );
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="border-b text-left text-muted-foreground">
          <th className="py-1.5 font-medium">PO ID</th>
          <th className="py-1.5 font-medium">Item</th>
          <th className="py-1.5 font-medium">Payment date</th>
          <th className="py-1.5 text-right font-medium">Total</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.poId} className="border-b">
            <td className="py-1.5 font-medium">{p.poId}</td>
            <td className="py-1.5">{p.itemName}</td>
            <td className="py-1.5 text-muted-foreground">{p.paymentDate ?? p.prDate ?? "—"}</td>
            <td className="py-1.5 text-right">{usd0.format(p.totalValueUsd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---- Tab 3: evolution ----------------------------------------------------- #
function EvolutionTab({ data }: { data: SupplierEvolution }) {
  const active = data.periods.filter((p) => p.spend > 0 || p.invoiceCount > 0);
  // Spend-focused observations only — drop the classification insights (those
  // live on the Supplier Classification panel now).
  const spendInsights = data.insights.filter(
    (t) => !t.startsWith("Consistently ") && !t.startsWith("Classification "),
  );

  // Product mix: top-5 items across years + Others residual per year.
  const totalByItem = new Map<string, number>();
  for (const p of data.periods)
    for (const it of p.topItems)
      totalByItem.set(it.itemName, (totalByItem.get(it.itemName) ?? 0) + it.spend);
  const topItemNames = [...totalByItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n]) => n);
  const mix = data.periods.map((p) => {
    const row: Record<string, number | string> = { year: p.year };
    let shown = 0;
    for (const name of topItemNames) {
      const v = p.topItems.find((it) => it.itemName === name)?.spend ?? 0;
      row[name] = v;
      shown += v;
    }
    const others = Math.max(0, p.spend - shown);
    if (others > 0) row.Others = others;
    return row;
  });
  const mixKeys = [...topItemNames, ...(mix.some((r) => "Others" in r) ? ["Others"] : [])];

  return (
    <div className="flex flex-col gap-5">
      {active.length <= 1 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
          Limited evolution data — supplier active{" "}
          {active.length === 1 ? `only in ${active[0].year}` : "in no periods"}.
        </p>
      )}

      {/* B: spend trajectory */}
      <section>
        <h4 className="mb-2 text-xs font-medium text-muted-foreground">Annual spend</h4>
        <ChartFrame height={180}>
          <LineChart data={data.periods} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="year" tick={{ fontSize: 11 }} />
            <YAxis tickFormatter={(v) => formatCompactCurrency(Number(v))} tick={{ fontSize: 10 }} width={48} />
            <Tooltip formatter={(v) => [usd0.format(Number(v)), "Spend"]} />
            <Line type="monotone" dataKey="spend" stroke={CHART_COLORS[0]} strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
          </LineChart>
        </ChartFrame>
      </section>

      {/* D: product mix over time */}
      {mixKeys.length > 0 && (
        <section>
          <h4 className="mb-2 text-xs font-medium text-muted-foreground">Product mix over time</h4>
          <ChartFrame height={200}>
            <BarChart data={mix} margin={{ left: 4, right: 12, top: 8, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="year" tick={{ fontSize: 11 }} />
              <YAxis tickFormatter={(v) => formatCompactCurrency(Number(v))} tick={{ fontSize: 10 }} width={48} />
              <Tooltip formatter={(v, n) => [usd0.format(Number(v)), truncate(String(n), 24)]} />
              {mixKeys.map((k, i) => (
                <Bar key={k} dataKey={k} stackId="mix" fill={CHART_COLORS[i % CHART_COLORS.length]} isAnimationActive={false} />
              ))}
            </BarChart>
          </ChartFrame>
        </section>
      )}

      {/* E: spend insights */}
      {spendInsights.length > 0 && (
        <section>
          <h4 className="mb-1 text-xs font-medium text-muted-foreground">Insights</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {spendInsights.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---- Panel ---------------------------------------------------------------- #
export function SpendDecompositionPanel({
  supplierId,
  startDate,
  endDate,
  onClose,
}: {
  supplierId: string | null;
  startDate: string;
  endDate: string;
  onClose: () => void;
}) {
  const detailKey = supplierId ? `${supplierId}_${startDate}_${endDate}` : "";
  const [detailState, setDetailState] = useState<{ key: string; detail?: SpendDetail; err?: string } | null>(null);
  const [evo, setEvo] = useState<{ id: string; data?: SupplierEvolution; err?: string } | null>(null);

  const detail = detailState?.key === detailKey ? detailState.detail : undefined;
  const detailErr = detailState?.key === detailKey ? detailState.err : undefined;
  const detailLoading = !!supplierId && !detail && !detailErr;
  const span = periodSpanLabel(startDate, endDate);

  // Period-scoped spend detail (refetch on supplier OR span change).
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

  // All-years evolution (refetch on supplier change only).
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
  const evoErr = evo?.id === supplierId ? evo.err : undefined;
  const s = detail?.supplier;

  return (
    <Dialog open={!!supplierId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        aria-label="Spend decomposition"
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
                  const parts = [s.category, s.abcClass, s.kraljicQuadrant, s.zone].filter(Boolean);
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

        <SpendDetailBody
          supplierId={supplierId}
          startDate={startDate}
          endDate={endDate}
          detail={detail}
          detailErr={detailErr}
          detailLoading={detailLoading}
          evo={evoData}
          evoErr={evoErr}
        />
      </DialogContent>
    </Dialog>
  );
}

// ---- Body (presentational; reused by the Action Priorities unified modal) --- #
export function SpendDetailBody({
  supplierId,
  startDate,
  endDate,
  detail,
  detailErr,
  detailLoading,
  evo,
  evoErr,
}: {
  supplierId: string | null;
  startDate: string;
  endDate: string;
  detail: SpendDetail | undefined;
  detailErr: string | undefined;
  detailLoading: boolean;
  evo: SupplierEvolution | undefined;
  evoErr: string | undefined;
}) {
  const [tab, setTab] = useState<Tab>("byItem");
  const [itemView, setItemView] = useState<View>("chart");
  const [posView, setPosView] = useState<View>("chart");

  // Reset transient UI when the supplier changes.
  const [prevId, setPrevId] = useState(supplierId);
  if (prevId !== supplierId) {
    setPrevId(supplierId);
    setTab("byItem");
    setItemView("chart");
    setPosView("chart");
  }
  const span = periodSpanLabel(startDate, endDate);
  // Single-year selection (slices the sub-score sparklines); null in range mode.
  const selectedYear =
    startDate.slice(0, 4) === endDate.slice(0, 4) ? startDate.slice(0, 4) : null;
  const evoData = evo;
  const s = detail?.supplier;
  const st = detail?.stats;
  // No purchases in the selected period — render an honest "absent" view.
  const absent = st != null && st.invoiceCount === 0;

  return (
    <>
      {detailLoading && (
        <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading spend detail…
        </div>
      )}
      {detailErr && <p className="p-4 text-sm text-destructive">{detailErr}</p>}

      {detail && st && s && (
        <>
          {/* Section 1: spend stats — 4-card grid incl. period composite. */}
            <div className="border-b p-4">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Spend at a glance</h4>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatBlock label="Total spend" value={absent ? "—" : formatCompactCurrency(st.totalSpend)} />
                <StatBlock label="Invoices" value={absent ? "—" : String(st.invoiceCount)} />
                <StatBlock label="Avg invoice" value={absent ? "—" : formatCompactCurrency(st.avgInvoiceValue)} />
                <StatBlock
                  label="Performance"
                  value={
                    s.performance.score != null ? (
                      <span>
                        {s.performance.score.toFixed(2)}{" "}
                        <span className="text-sm font-normal text-muted-foreground">/ 100</span>
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </div>
            </div>

            {/* Section 1b: spend insights — portfolio rank + YoY change. */}
            <div className="border-b p-4">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Spend insights</h4>
              <div className="grid grid-cols-2 gap-2">
                {/* Card 1: portfolio rank (period-scoped). */}
                <div className="rounded-xl bg-card px-3.5 py-3 ring-1 ring-foreground/10">
                  {absent || st.rank == null ? (
                    <p className="text-sm text-muted-foreground">Not active in this period</p>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-lg font-semibold tabular-nums">#{st.rank}</span>
                        <span className="text-[11px] leading-tight text-muted-foreground">
                          {st.rank === 1 ? "top spend supplier" : "by spend"}{" "}
                          {selectedYear ? "this period" : "overall"}
                        </span>
                      </div>
                      <div className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                        {st.percentOfTotal != null ? `${st.percentOfTotal.toFixed(1)}% of total` : "—"} · #
                        {st.rank} of {st.activeSupplierCount} suppliers
                      </div>
                    </>
                  )}
                </div>
                {/* Card 2: YoY spend change (single-year) / range context. */}
                <div className="rounded-xl bg-card px-3.5 py-3 ring-1 ring-foreground/10">
                  {(() => {
                    if (!selectedYear) {
                      return <p className="text-sm text-muted-foreground">Active {span.short}</p>;
                    }
                    if (!evoData) {
                      return <p className="text-sm text-muted-foreground">—</p>;
                    }
                    const activeYears = evoData.periods.filter((p) => p.spend > 0 || p.invoiceCount > 0);
                    const lastActive = activeYears[activeYears.length - 1];
                    const cur = evoData.periods.find((p) => p.year === selectedYear);
                    const prevYear = String(Number(selectedYear) - 1);
                    const prev = evoData.periods.find((p) => p.year === prevYear);
                    const curSpend = cur?.spend ?? 0;
                    const prevSpend = prev?.spend ?? 0;
                    if (curSpend <= 0) {
                      return (
                        <p className="text-sm text-muted-foreground">
                          {lastActive ? `Most recent activity: ${lastActive.year}` : "No activity"}
                        </p>
                      );
                    }
                    if (prevSpend <= 0) {
                      return (
                        <p className="text-sm text-muted-foreground">
                          First active in {activeYears[0]?.year ?? selectedYear}
                        </p>
                      );
                    }
                    const yoy = ((curSpend - prevSpend) / prevSpend) * 100;
                    const up = yoy >= 0;
                    const cls = up
                      ? "text-green-600 dark:text-green-500"
                      : "text-red-600 dark:text-red-500";
                    return (
                      <>
                        <div className="flex items-baseline gap-1.5">
                          <span className={`text-lg font-semibold tabular-nums ${cls}`}>
                            {up ? "↑ +" : "↓ -"}
                            {Math.abs(yoy).toFixed(1)}%
                          </span>
                          <span className="text-[11px] leading-tight text-muted-foreground">
                            spend {up ? "grew" : "fell"} vs {prevYear}
                          </span>
                        </div>
                        <div className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                          {formatCompactCurrency(prevSpend)} → {formatCompactCurrency(curSpend)} YoY
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Section 2: activity period — first → last invoice dates. */}
            <div className="border-b p-4">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Activity period</h4>
              {absent || !st.earliestDate || !st.latestDate ? (
                <p className="text-sm text-muted-foreground">No activity in this period</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {span.short} · {fmtActivityDate(st.earliestDate, !selectedYear)} →{" "}
                  {fmtActivityDate(st.latestDate, !selectedYear)}
                </p>
              )}
            </div>

            <div className="border-b px-4 pt-3 pb-1">
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">Spend detail</h4>
              <PillTabs
                tabs={[["byItem", "Spend by item"], ["pos", "All invoices"], ["evolution", "Annual breakdown"]] as const}
                active={tab}
                onChange={setTab}
              />
            </div>

            <div className="p-4">
              {tab === "byItem" && (
                absent ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No items purchased in this period.</p>
                ) : (
                  <>
                    <ViewToggle view={itemView} setView={setItemView} />
                    {itemView === "chart" ? <SpendByItemChart detail={detail} /> : <ItemTable detail={detail} />}
                  </>
                )
              )}
              {tab === "pos" && (
                absent ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">No invoices in this period.</p>
                ) : (
                  <>
                    <ViewToggle view={posView} setView={setPosView} />
                    {posView === "chart" ? <PosTimeChart detail={detail} /> : <PosTable detail={detail} />}
                  </>
                )
              )}
              {tab === "evolution" && (
                <>
                  <p className="mb-3 text-[11px] text-muted-foreground">All years (not period-scoped).</p>
                  {evoErr ? (
                    <p className="text-sm text-destructive">{evoErr}</p>
                  ) : evoData ? (
                    <EvolutionTab data={evoData} />
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading evolution…
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
    </>
  );
}
