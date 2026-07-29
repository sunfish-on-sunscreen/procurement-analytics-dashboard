"use client";

import { useState } from "react";
import type { SupplierRankingRow } from "@/lib/spend-overview-types";
import { ABC_COLORS } from "@/lib/chart-colors";
import { cardElevation, formatCompactCurrency } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SortArrow, RetiredBadge } from "@/components/RankingCells";

const num0 = new Intl.NumberFormat("en-US");

type SortKey =
  | "supplier_name"
  | "category"
  | "total_spend"
  | "invoice_count"
  | "avg_invoice_value"
  | "abc_class";

type Align = "left" | "right" | "center";

// The leading "#" column is a positional index (not in COLUMNS) — it reflects
// the current sort order and is intentionally NOT sortable.
const COLUMNS: { key: SortKey; label: string; align: Align; width?: string }[] = [
  { key: "supplier_name", label: "Supplier", align: "left" },
  { key: "category", label: "Category", align: "left" },
  { key: "total_spend", label: "Spend", align: "right" },
  { key: "invoice_count", label: "Invoices", align: "right" },
  { key: "avg_invoice_value", label: "Avg invoice", align: "right" },
  { key: "abc_class", label: "ABC", align: "center", width: "w-[56px]" },
];

const alignText: Record<Align, string> = { left: "text-left", right: "text-right", center: "text-center" };
const alignJustify: Record<Align, string> = {
  left: "",
  right: "flex-row-reverse",
  center: "justify-center",
};

function compare(a: SupplierRankingRow, b: SupplierRankingRow, key: SortKey) {
  const av = a[key];
  const bv = b[key];
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av ?? "").localeCompare(String(bv ?? ""));
}

export function SupplierRankingTable({
  rows,
  onSupplierClick,
  selectedSupplierId,
}: {
  rows: SupplierRankingRow[];
  onSupplierClick: (supplierId: string) => void;
  selectedSupplierId: string | null;
}) {
  // Default sort: total spend descending.
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
    // overflow-visible overrides Card's overflow-hidden so the sticky header can
    // pin to the viewport (an overflow:hidden ancestor would trap position:sticky).
    <Card className={`overflow-visible ${cardElevation}`}>
      <CardHeader>
        <CardTitle>All Suppliers</CardTitle>
      </CardHeader>
      <CardContent className="pt-1">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {/* Positional index column — visual reference only, not sortable. */}
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
            {sorted.map((r, i) => (
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
                {/* Positional index reflecting current sort order. */}
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
                <td className="py-3 text-right tabular-nums">{r.inactive ? "—" : formatCompactCurrency(r.total_spend)}</td>
                <td className="py-3 text-right tabular-nums">{r.inactive ? "—" : num0.format(r.invoice_count)}</td>
                <td className="py-3 text-right tabular-nums">{r.inactive ? "—" : formatCompactCurrency(r.avg_invoice_value)}</td>
                <td className="py-3 text-center">
                  {r.abc_class ? (
                    <span
                      className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium"
                      style={{
                        backgroundColor: `color-mix(in srgb, ${ABC_COLORS[r.abc_class]} 12%, transparent)`,
                        color: ABC_COLORS[r.abc_class],
                      }}
                    >
                      {r.abc_class}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
