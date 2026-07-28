-- CreateTable
CREATE TABLE "SensitivityResult" (
    "id" TEXT NOT NULL,
    "configFingerprint" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultJson" JSONB NOT NULL,

    CONSTRAINT "SensitivityResult_pkey" PRIMARY KEY ("id")
);
