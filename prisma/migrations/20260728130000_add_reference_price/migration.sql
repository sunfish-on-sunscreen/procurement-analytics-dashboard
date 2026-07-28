-- CreateTable
CREATE TABLE "ReferencePrice" (
    "itemName" TEXT NOT NULL,
    "unitPriceUsd" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "source" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferencePrice_pkey" PRIMARY KEY ("itemName")
);
