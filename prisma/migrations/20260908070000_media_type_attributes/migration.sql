-- CreateTable
CREATE TABLE "MediaTypeSizeClass" (
    "mediaTypeId" TEXT NOT NULL,
    "sizeClassId" TEXT NOT NULL,

    CONSTRAINT "MediaTypeSizeClass_pkey" PRIMARY KEY ("mediaTypeId","sizeClassId")
);

-- CreateTable
CREATE TABLE "MediaTypeMaterial" (
    "mediaTypeId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,

    CONSTRAINT "MediaTypeMaterial_pkey" PRIMARY KEY ("mediaTypeId","materialId")
);

-- CreateIndex
CREATE INDEX "MediaTypeSizeClass_sizeClassId_idx" ON "MediaTypeSizeClass"("sizeClassId");

-- CreateIndex
CREATE INDEX "MediaTypeMaterial_materialId_idx" ON "MediaTypeMaterial"("materialId");

-- AddForeignKey
ALTER TABLE "MediaTypeSizeClass" ADD CONSTRAINT "MediaTypeSizeClass_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaTypeSizeClass" ADD CONSTRAINT "MediaTypeSizeClass_sizeClassId_fkey" FOREIGN KEY ("sizeClassId") REFERENCES "SizeClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaTypeMaterial" ADD CONSTRAINT "MediaTypeMaterial_mediaTypeId_fkey" FOREIGN KEY ("mediaTypeId") REFERENCES "MediaType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaTypeMaterial" ADD CONSTRAINT "MediaTypeMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE CASCADE ON UPDATE CASCADE;
