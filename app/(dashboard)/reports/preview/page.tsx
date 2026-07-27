import { requireAdmin } from "@/lib/auth";
import { getAllPeriods, getCurrentPeriodSelection } from "@/lib/period";
import {
  getCategories,
  getSupplierCategoryMap,
  getSupplierDirectory,
} from "@/lib/suppliers";
import { readRiskModelStamp } from "@/lib/risk-model-server";
import { ReportEditor } from "@/components/Reports/ReportEditor";

// The universal report editor (Batch 6a). Admin-only: it can persist reports.
export default async function ReportPreviewPage() {
  const session = await requireAdmin();
  const [selection, periods, categories, supplierCategory, supplierDirectory, stamp] =
    await Promise.all([
      getCurrentPeriodSelection(),
      getAllPeriods(),
      getCategories(),
      getSupplierCategoryMap(),
      getSupplierDirectory(),
      readRiskModelStamp(),
    ]);

  const periodOptions = periods.map((p) => ({ id: p.id, name: p.name }));

  return (
    <ReportEditor
      defaultPeriod={selection}
      periods={periodOptions}
      allCategories={categories}
      supplierCategory={supplierCategory}
      supplierDirectory={supplierDirectory}
      generatedBy={session.name}
      configStamp={stamp}
    />
  );
}
