"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CostPremiumPartition } from "@/lib/risk-model";

const KEY_OPTS: [CostPremiumPartition["key"], string][] = [
  ["item", "Item"],
  ["item_period", "Item + period"],
  ["item_category", "Item + category"],
];
const STAT_OPTS: [CostPremiumPartition["benchmarkStat"], string][] = [
  ["spend_weighted_mean", "Spend-weighted mean"],
  ["mean", "Mean"],
  ["median", "Median"],
];
const BELOW_OPTS: [CostPremiumPartition["belowMinimum"], string][] = [
  ["excluded", "Excluded — drop the pair"],
  ["neutral", "Neutral — keep at premium 0"],
];
const MODE_OPTS: [CostPremiumPartition["benchmarkMode"], string][] = [
  ["internal", "Internal peer (our roster)"],
  ["external", "External list"],
  ["hybrid", "Hybrid — external, internal fallback"],
];

const selectCls =
  "mt-0.5 w-full rounded-md border bg-background px-2 py-1 text-xs disabled:opacity-60";

/**
 * Stage G: the cost_premium partition editor + external reference-price upload. Every control is a
 * real modelling decision that used to be hardcoded; the defaults reproduce the shipped scores.
 * Saving posts { costPremiumPartition } to the two-phase config save; the external/hybrid price
 * list is uploaded wholesale via /api/risk-model/reference-prices. print:hidden.
 */
export function CostPremiumPartitionCard({
  initial,
  busy,
  onAfterSave,
}: {
  initial: CostPremiumPartition;
  busy: boolean;
  onAfterSave: () => void;
}) {
  const [p, setP] = useState<CostPremiumPartition>(initial);
  const [saving, setSaving] = useState(false);
  const [csv, setCsv] = useState("");
  const [count, setCount] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/risk-model/reference-prices")
      .then((r) => r.json())
      .then((d) => {
        if (live && typeof d?.count === "number") setCount(d.count);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const dirty = JSON.stringify(p) !== JSON.stringify(initial);
  const disabled = busy || saving;
  const set = (patch: Partial<CostPremiumPartition>) => setP((x) => ({ ...x, ...patch }));
  const external = p.benchmarkMode === "external" || p.benchmarkMode === "hybrid";

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/risk-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ costPremiumPartition: p }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Save failed.");
        return;
      }
      toast.success("Saved cost-premium benchmark. All periods recomputed.");
      onAfterSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error.");
    } finally {
      setSaving(false);
    }
  }

  async function upload() {
    setUploading(true);
    try {
      const res = await fetch("/api/risk-model/reference-prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv }),
      });
      const data = (await res.json()) as { count?: number; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Upload failed.");
        return;
      }
      setCount(data.count ?? null);
      setCsv("");
      toast.success(`Uploaded ${data.count} reference prices${external ? " · recomputed" : ""}.`);
      onAfterSave();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="rounded-lg border p-3 print:hidden">
      <p className="text-sm font-medium text-foreground">Cost-premium benchmark</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        How <code className="font-mono">cost_premium</code> compares a supplier&apos;s item prices
        to a peer group. Each control is a real modelling choice; the shipped defaults reproduce the
        current scores exactly.
      </p>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="text-xs text-muted-foreground">
          Partition key
          <select className={selectCls} value={p.key} disabled={disabled} onChange={(e) => set({ key: e.target.value as CostPremiumPartition["key"] })}>
            {KEY_OPTS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Benchmark statistic
          <select className={selectCls} value={p.benchmarkStat} disabled={disabled} onChange={(e) => set({ benchmarkStat: e.target.value as CostPremiumPartition["benchmarkStat"] })}>
            {STAT_OPTS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Min suppliers in a group
          <Input type="number" min={1} value={String(p.minGroupMembers)} disabled={disabled} className="mt-0.5 tabular-nums" onChange={(e) => set({ minGroupMembers: Math.max(1, Number.parseInt(e.target.value) || 1) })} />
        </label>
        <label className="text-xs text-muted-foreground">
          Min POs per supplier-item
          <Input type="number" min={1} value={String(p.minPosPerSupplierItem)} disabled={disabled} className="mt-0.5 tabular-nums" onChange={(e) => set({ minPosPerSupplierItem: Math.max(1, Number.parseInt(e.target.value) || 1) })} />
        </label>
        <label className="text-xs text-muted-foreground">
          Below-minimum item
          <select className={selectCls} value={p.belowMinimum} disabled={disabled} onChange={(e) => set({ belowMinimum: e.target.value as CostPremiumPartition["belowMinimum"] })}>
            {BELOW_OPTS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          Benchmark mode
          <select className={selectCls} value={p.benchmarkMode} disabled={disabled} onChange={(e) => set({ benchmarkMode: e.target.value as CostPremiumPartition["benchmarkMode"] })}>
            {MODE_OPTS.map(([v, l]) => (<option key={v} value={v}>{l}</option>))}
          </select>
        </label>
      </div>

      <p className="mt-1.5 text-xs text-muted-foreground">
        A single-source item has no peer benchmark. <span className="font-medium">Excluded</span>{" "}
        (the shipped default) drops it from the supplier&apos;s premium — it does not count.{" "}
        <span className="font-medium">Neutral</span> keeps it at premium 0, diluting the score.
      </p>

      <div className="mt-2">
        <Button type="button" size="sm" disabled={!dirty || disabled} onClick={save}>
          {saving ? "Saving & recomputing…" : "Save benchmark settings"}
        </Button>
      </div>

      {external && (
        <div className="mt-3 border-t pt-2">
          <p className="text-xs font-medium text-foreground">
            External reference prices{count != null ? ` (${count} stored)` : ""}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Paste CSV with an <code className="font-mono">itemName,unitPriceUsd[,source]</code>{" "}
            header. Replaces the entire list (never a partial merge).
          </p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={4}
            disabled={busy || uploading}
            placeholder={"itemName,unitPriceUsd,source\nExcavator bucket,12500,MOPS"}
            className="mt-1 w-full rounded-md border bg-background p-1.5 font-mono text-xs"
          />
          <Button type="button" size="sm" variant="outline" disabled={!csv.trim() || uploading || busy} onClick={upload}>
            {uploading ? "Uploading…" : "Upload & replace"}
          </Button>
        </div>
      )}
    </div>
  );
}
