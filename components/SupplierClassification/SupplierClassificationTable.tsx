"use client";

import { useState } from "react";
import { X } from "lucide-react";
import type { ClassificationRankingRow } from "@/lib/supplier-classification-types";
import { ABC_COLORS, QUADRANT_COLORS } from "@/lib/chart-colors";
import { cardElevation, formatCompactCurrency } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PerfBar, SortArrow, RetiredBadge } from "@/components/RankingCells";

type SortKey =
  | "supplier_name"
  | "category"
  | "abc_class"
  | "kraljic_quadrant"
  | "performance_score"
  | "total_spend";

type Align = "left" | "right" | "center";

const COLUMNS: { key: SortKey; label: string; align: Align; width?: string }[] = [
  { key: "supplier_name", label: "Supplier", align: "left" },
  { key: "category", label: "Category", align: "left" },
  { key: "abc_class", label: "ABC", align: "center", width: "w-[56px]" },
  { key: "kraljic_quadrant", label: "Kraljic quadrant", align: "center", width: "w-[120px]" },
  { key: "performance_score", label: "Performance", align: "right", width: "w-[140px]" },
  { key: "total_spend", label: "Spend", align: "right" },
];

const alignText: Record<Align, string> = { left: "text-left", right: "text-right", center: "text-center" };
const alignJustify: Record<Align, string> = { left: "", right: "flex-row-reverse", center: "justify-center" };

function compare(a: ClassificationRankingRow, b: ClassificationRankingRow, key: SortKey) {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  // Nulls sort last regardless of direction caller; treat as empty string.
  return String(av ?? "").localeCompare(String(bv ?? ""));
}

// Color-mix chip (12% tint + token text); null → muted placeholder.
function Chip({ color, label }: { color: string | null; label: string | null }) {
  if (!color || !label) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
      style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }}
    >
      {label}
    </span>
  );
}

export function SupplierClassificationTable({
  rows,
  onSupplierClick,
  selectedSupplierId,
  filterLabel,
  onClearFilter,
}: {
  rows: ClassificationRankingRow[];
  onSupplierClick: (supplierId: string) => void;
  selectedSupplierId: string | null;
  filterLabel?: string | null;
  onClearFilter?: () => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "total_spend",
    dir: "desc",
  });

  const sorted = [...rows].sort((a, b) => {
    const c = compare(a, b, sort.key);
    return sort.dir === "asc" ? c : -c;
  });

  const toggleSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "supplier_name" || key === "category" ? "asc" : "desc" },
    );

  return (
    // overflow-visible so the sticky header can pin (Card defaults to overflow-hidden).
    <Card className={`overflow-visible ${cardElevation}`}>
      <CardHeader>
        <CardTitle>All Suppliers</CardTitle>
      </CardHeader>
      <CardContent className="pt-1">
        {/* Prominent filter banner (decision R) — destructive tint, above table. */}
        {filterLabel && (
          <div
            className="mb-3 flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-sm"
            style={{
              backgroundColor: "color-mix(in srgb, var(--destructive) 8%, transparent)",
              borderColor: "color-mix(in srgb, var(--destructive) 35%, transparent)",
            }}
          >
            <span>
              Filtered to <span className="font-medium">{filterLabel}</span> ·{" "}
              {rows.length} supplier{rows.length === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              onClick={onClearFilter}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-foreground/5"
            >
              Clear <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky top-0 z-10 border-b bg-card py-2 text-right font-medium tabular-nums text-muted-foreground">
                #
              </th>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className={`sticky top-0 z-10 whitespace-nowrap border-b bg-card py-2 font-medium text-muted-foreground ${alignText[col.align]} ${col.width ?? ""}`}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={`inline-flex items-center gap-1 hover:text-foreground ${alignJustify[col.align]}`}
                  >
                    {col.label}
                    <SortArrow active={sort.key === col.key} dir={sort.dir} />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} className="py-8 text-center text-muted-foreground">
                  No suppliers match this filter.
                </td>
              </tr>
            ) : (
              sorted.map((r, i) => (
                <tr
                  key={r.supplier_id}
                  onClick={() => onSupplierClick(r.supplier_id)}
                  title={r.inactive ? "No activity in this period" : undefined}
                  className={`cursor-pointer border-b ${
                    r.supplier_id === selectedSupplierId
                      ? "bg-foreground/5 ring-1 ring-inset ring-foreground/30"
                      : "hover:bg-muted/40"
                  } ${r.inactive ? "opacity-50" : ""}`}
                >
                  <td className="py-3 text-right tabular-nums text-muted-foreground">{i + 1}</td>
                  <td className="py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span className="block max-w-[200px] truncate" title={r.supplier_name}>
                        {r.supplier_name}
                      </span>
                      {r.retired && <RetiredBadge />}
                    </div>
                  </td>
                  <td className="py-3">
                    <span className="block max-w-[160px] truncate" title={r.category ?? undefined}>
                      {r.category ?? "—"}
                    </span>
                  </td>
                  <td className="py-3 text-center">
                    <Chip color={r.abc_class ? ABC_COLORS[r.abc_class] : null} label={r.abc_class} />
                  </td>
                  <td className="py-3 text-center">
                    <Chip
                      color={r.kraljic_quadrant ? QUADRANT_COLORS[r.kraljic_quadrant] : null}
                      label={r.kraljic_quadrant}
                    />
                  </td>
                  <td className="py-3 text-right">
                    <PerfBar score={r.performance_score} />
                  </td>
                  <td className="py-3 text-right tabular-nums">
                    {r.inactive ? "—" : formatCompactCurrency(r.total_spend)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
