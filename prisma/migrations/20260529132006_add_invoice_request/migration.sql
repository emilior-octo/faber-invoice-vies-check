-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "cartToken" TEXT,
    "checkoutToken" TEXT,
    "customerId" TEXT,
    "customerEmail" TEXT,
    "orderId" TEXT,
    "orderName" TEXT,
    "invoiceType" TEXT NOT NULL,
    "countryCode" TEXT,
    "fiscalCode" TEXT,
    "vatNumber" TEXT,
    "pec" TEXT,
    "sdi" TEXT,
    "companyName" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "viesChecked" BOOLEAN NOT NULL DEFAULT false,
    "viesValid" BOOLEAN,
    "viesRawResponse" TEXT,
    "reverseCharge" BOOLEAN NOT NULL DEFAULT false,
    "taxExemptApplied" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "InvoiceRequest_shop_idx" ON "InvoiceRequest"("shop");

-- CreateIndex
CREATE INDEX "InvoiceRequest_cartToken_idx" ON "InvoiceRequest"("cartToken");

-- CreateIndex
CREATE INDEX "InvoiceRequest_customerId_idx" ON "InvoiceRequest"("customerId");

-- CreateIndex
CREATE INDEX "InvoiceRequest_orderId_idx" ON "InvoiceRequest"("orderId");

-- CreateIndex
CREATE INDEX "InvoiceRequest_status_idx" ON "InvoiceRequest"("status");
