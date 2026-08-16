-- CreateEnum
CREATE TYPE "QrType" AS ENUM ('SITE', 'AD', 'AGENT', 'ORDER');

-- CreateTable
CREATE TABLE "QrCode" (
    "id" TEXT NOT NULL,
    "type" "QrType" NOT NULL,
    "token" TEXT NOT NULL,
    "allowedRoles" "Role"[],
    "refId" TEXT NOT NULL,
    "metadata" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QrCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QrScan" (
    "id" TEXT NOT NULL,
    "qrId" TEXT NOT NULL,
    "scannedById" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "role" "Role",
    "action" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QrCode_token_key" ON "QrCode"("token");

-- CreateIndex
CREATE INDEX "QrScan_qrId_idx" ON "QrScan"("qrId");

-- CreateIndex
CREATE INDEX "QrScan_scannedById_idx" ON "QrScan"("scannedById");

-- AddForeignKey
ALTER TABLE "QrScan" ADD CONSTRAINT "QrScan_qrId_fkey" FOREIGN KEY ("qrId") REFERENCES "QrCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QrScan" ADD CONSTRAINT "QrScan_scannedById_fkey" FOREIGN KEY ("scannedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
