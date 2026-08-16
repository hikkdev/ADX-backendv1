-- CreateEnum
CREATE TYPE "AdvertisementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "AdvertiserKyc" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "kycType" TEXT NOT NULL DEFAULT 'INDIVIDUAL',
    "nationalIdUrl" TEXT,
    "panCardUrl" TEXT,
    "utilityBillUrl" TEXT,
    "drivingLicenseUrl" TEXT,
    "commercialIncCertUrl" TEXT,
    "commercialAssociationArticleUrl" TEXT,
    "commercialPanIdUrl" TEXT,
    "commercialGstCertUrl" TEXT,
    "ngoRegCertUrl" TEXT,
    "ngo80gCertUrl" TEXT,
    "ngoFcraRegUrl" TEXT,
    "agencyAuthLetterUrl" TEXT,
    "agencyGovtIdUrl" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvertiserKyc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "department" TEXT,
    "designation" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "passportPhotoUrl" TEXT,
    "referenceLetterUrl" TEXT,
    "ndaAgreementUrl" TEXT,
    "nonCompeteAgreementUrl" TEXT,
    "class10MarksheetUrl" TEXT,
    "class12MarksheetUrl" TEXT,
    "graduationMarksheetUrl" TEXT,
    "postGraduationMarksheetUrl" TEXT,
    "form2NominationUrl" TEXT,
    "form6aUrl" TEXT,
    "esiFormUrl" TEXT,
    "form2FamilyDeclarationUrl" TEXT,
    "form6EmployeeRegistrationUrl" TEXT,
    "salaryAccountLetterUrl" TEXT,
    "salarySlipUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "complianceFormUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "epfFormUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "gratuityFormUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoleConfig" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoleConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Advertisement" (
    "id" TEXT NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "AdvertisementStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Advertisement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserKyc" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "selfVideoUrl" TEXT,
    "status" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserKyc_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "advertisementId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AdvertiserKyc_advertiserId_key" ON "AdvertiserKyc"("advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleConfig_name_key" ON "RoleConfig"("name");

-- CreateIndex
CREATE INDEX "Advertisement_advertiserId_idx" ON "Advertisement"("advertiserId");

-- CreateIndex
CREATE UNIQUE INDEX "UserKyc_userId_key" ON "UserKyc"("userId");

-- AddForeignKey
ALTER TABLE "AdvertiserKyc" ADD CONSTRAINT "AdvertiserKyc_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Advertisement" ADD CONSTRAINT "Advertisement_advertiserId_fkey" FOREIGN KEY ("advertiserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserKyc" ADD CONSTRAINT "UserKyc_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_advertisementId_fkey" FOREIGN KEY ("advertisementId") REFERENCES "Advertisement"("id") ON DELETE SET NULL ON UPDATE CASCADE;
