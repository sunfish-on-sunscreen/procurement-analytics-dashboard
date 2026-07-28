/**
 * Client-safe types for the Stage-F formula PREVIEW + IMPACT (python/preview.py). Kept in
 * their own module (no server imports) so both the route and the settings-UI editor can import
 * them without pulling in lib/python (child_process).
 */
export type PreviewComponent = {
  id: string;
  raw: number;
  normalized: number;
  contribution: number;
};
export type PreviewRow = { supplier_id: string; score: number; components: PreviewComponent[] };
export type PreviewMover = { supplier_id: string; from: string; to: string };
export type PreviewImpact = { kind: string; changed: number; total: number; movers: PreviewMover[] };
export type PreviewData = { perSupplier: PreviewRow[]; impact: PreviewImpact } | { error: string };
