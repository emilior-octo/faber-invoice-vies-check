-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceRequest" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceRequest_pkey" PRIMARY KEY ("id")
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
