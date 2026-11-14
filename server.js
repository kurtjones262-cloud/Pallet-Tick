var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/server/docketOcr.ts
var docketOcr_exports = {};
__export(docketOcr_exports, {
  DEFAULT_FALLBACK_VISION_MODELS: () => DEFAULT_FALLBACK_VISION_MODELS,
  DEFAULT_PRIMARY_VISION_MODEL: () => DEFAULT_PRIMARY_VISION_MODEL,
  DOCKET_EXTRACTION_SYSTEM_INSTRUCTION: () => DOCKET_EXTRACTION_SYSTEM_INSTRUCTION,
  GCI_MISSING_JOB_NO_WARNING: () => GCI_MISSING_JOB_NO_WARNING,
  GEMINI_REQUEST_TIMEOUT_MS: () => GEMINI_REQUEST_TIMEOUT_MS,
  INITIAL_BACKOFF_MS: () => INITIAL_BACKOFF_MS,
  MAX_AUTOMATIC_RETRIES: () => MAX_AUTOMATIC_RETRIES,
  buildDocketExtractionPrompt: () => buildDocketExtractionPrompt,
  buildRestDocketResponseSchema: () => buildRestDocketResponseSchema,
  classifyGeminiError: () => classifyGeminiError,
  cleanGciRefToken: () => cleanGciRefToken,
  clearGeminiModelCooldownsForTesting: () => clearGeminiModelCooldownsForTesting,
  computeExponentialBackoffWithJitter: () => computeExponentialBackoffWithJitter,
  extractDocketWithGeminiVision: () => extractDocketWithGeminiVision,
  extractGciFieldsFromSelectableText: () => extractGciFieldsFromSelectableText,
  extractPartCodeWithGeminiVision: () => extractPartCodeWithGeminiVision,
  generateWithRetryAndFallback: () => generateWithRetryAndFallback,
  isGciSupplierHint: () => isGciSupplierHint,
  isSyntheticDocketPlaceholder: () => isSyntheticDocketPlaceholder,
  logOcrEvent: () => logOcrEvent,
  normalizeGciDispatchDate: () => normalizeGciDispatchDate,
  normalizeRawBatchItem: () => normalizeRawBatchItem,
  recoverMissingDocketItems: () => recoverMissingDocketItems,
  resolveConfiguredVisionModels: () => resolveConfiguredVisionModels,
  resolveGciPageHeaderFields: () => resolveGciPageHeaderFields,
  sanitizeVisionModelIdentifier: () => sanitizeVisionModelIdentifier,
  validateAndParseOcrJsonResponse: () => validateAndParseOcrJsonResponse
});
function sanitizeVisionModelIdentifier(rawModel, role = "primary") {
  const trimmed = (rawModel || "").trim();
  if (!trimmed) {
    return role === "primary" ? DEFAULT_PRIMARY_VISION_MODEL : DEFAULT_FALLBACK_VISION_MODELS[0];
  }
  const lower = trimmed.toLowerCase();
  if (role === "primary" && OBSOLETE_PRIMARY_MODELS.has(lower)) {
    return DEFAULT_PRIMARY_VISION_MODEL;
  }
  if (role === "fallback" && OBSOLETE_FALLBACK_MODELS.has(lower)) {
    return DEFAULT_FALLBACK_VISION_MODELS[0];
  }
  return trimmed;
}
function resolveConfiguredVisionModels(envOverride) {
  const procEnv = typeof process !== "undefined" && process.env ? process.env : {};
  const rawPrimaryInput = typeof envOverride?.GEMINI_PRIMARY_MODEL === "string" && envOverride.GEMINI_PRIMARY_MODEL.trim() || typeof procEnv.GEMINI_PRIMARY_MODEL === "string" && procEnv.GEMINI_PRIMARY_MODEL.trim() || DEFAULT_PRIMARY_VISION_MODEL;
  const primaryModel = sanitizeVisionModelIdentifier(rawPrimaryInput, "primary");
  const rawFallbacks = typeof envOverride?.GEMINI_FALLBACK_MODEL === "string" && envOverride.GEMINI_FALLBACK_MODEL.trim() || typeof envOverride?.GEMINI_FALLBACK_MODELS === "string" && envOverride.GEMINI_FALLBACK_MODELS.trim() || typeof procEnv.GEMINI_FALLBACK_MODEL === "string" && procEnv.GEMINI_FALLBACK_MODEL.trim() || typeof procEnv.GEMINI_FALLBACK_MODELS === "string" && procEnv.GEMINI_FALLBACK_MODELS.trim() || DEFAULT_FALLBACK_VISION_MODELS.join(",");
  const seen = /* @__PURE__ */ new Set([primaryModel]);
  const fallbackModels = [];
  for (const token of rawFallbacks.split(",")) {
    const cleaned = sanitizeVisionModelIdentifier(token, "fallback");
    if (cleaned && !seen.has(cleaned)) {
      seen.add(cleaned);
      fallbackModels.push(cleaned);
    }
  }
  return {
    primaryModel,
    fallbackModels: fallbackModels.length > 0 ? fallbackModels : DEFAULT_FALLBACK_VISION_MODELS.filter((m) => m !== primaryModel)
  };
}
function logOcrEvent(level, event, meta = {}) {
  const sanitizedMeta = {};
  for (const [k, v] of Object.entries(meta)) {
    if (/key|token|secret|image|base64|dataurl|text/i.test(k)) continue;
    if (typeof v === "string") {
      sanitizedMeta[k] = v.replace(/key=[A-Za-z0-9_\-]+/gi, "key=[REDACTED]").slice(0, 300);
    } else {
      sanitizedMeta[k] = v;
    }
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const payload = JSON.stringify({ timestamp, component: "PartTrack-OCR", event, ...sanitizedMeta });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.log(payload);
  }
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function computeExponentialBackoffWithJitter(retryAttempt, baseDelayMs = INITIAL_BACKOFF_MS) {
  const exponent = Math.max(0, retryAttempt - 1);
  const exponentialDelay = baseDelayMs * Math.pow(2, exponent);
  const jitter = Math.floor(Math.random() * 450);
  return Math.min(8e3, exponentialDelay + jitter);
}
function clearGeminiModelCooldownsForTesting() {
  modelQuotaCooldownUntil.clear();
}
function classifyGeminiError(err) {
  const rawMessage = String(err?.message || err || "Unknown Gemini API error").replace(
    /key=[A-Za-z0-9_\-]+/gi,
    "key=[REDACTED]"
  );
  let statusCode = Number(err?.status || err?.statusCode || err?.httpStatus || 0);
  if (!statusCode) {
    const codeMatch = rawMessage.match(/\b(400|401|403|404|429|500|502|503|504)\b/) || rawMessage.match(/"code"\s*:\s*(\d{3})/);
    if (codeMatch) {
      statusCode = parseInt(codeMatch[1], 10);
    }
  }
  const isTimeout = Boolean(err?.isTimeout) || err?.name === "AbortError" || statusCode === 504 || /504|DEADLINE_EXCEEDED|gateway timeout|timed out|AbortError|The operation was aborted|request timed out/i.test(
    rawMessage
  );
  const isAuthError = statusCode === 401 || statusCode === 403 || /401|403|UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_INVALID|API key not valid|invalid api key|unauthorized|forbidden/i.test(
    rawMessage
  );
  const isInvalidModel = statusCode === 404 || /404|NOT_FOUND|models\/[^\s]+ is not found|not supported for generateContent|model not found/i.test(
    rawMessage
  );
  const isHighDemand503 = !isTimeout && (statusCode === 503 || statusCode === 502 || /503|502|UNAVAILABLE|high demand|overloaded|service unavailable|temporarily unavailable|capacity|bad gateway/i.test(
    rawMessage
  ));
  const isRateLimit = statusCode === 429 || /429|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(rawMessage);
  const isModelDailyQuotaExhausted = isRateLimit && /GenerateRequestsPerDayPerProjectPerModel|free_tier_requests|requests per day|daily quota|exceeded your current quota|billing|plan and billing|limit:\s*0\b|Please retry in \d+h/i.test(
    rawMessage
  );
  const isTemporary500 = !isTimeout && !isAuthError && !isInvalidModel && (statusCode === 500 || /\b500\b|INTERNAL|fetch failed/i.test(rawMessage));
  if (!statusCode) {
    if (isTimeout) statusCode = 504;
    else if (isAuthError) statusCode = 401;
    else if (isInvalidModel) statusCode = 404;
    else if (isHighDemand503) statusCode = 503;
    else if (isRateLimit) statusCode = 429;
    else if (isTemporary500) statusCode = 502;
    else statusCode = 500;
  }
  let errorCode = "AI_EXTRACTION_FAILED";
  if (err?.code === "MISSING_GEMINI_API_KEY" || /GEMINI_API_KEY/i.test(rawMessage)) {
    errorCode = "MISSING_GEMINI_API_KEY";
    statusCode = 503;
  } else if (isAuthError) {
    errorCode = "GEMINI_AUTH_ERROR";
  } else if (isInvalidModel) {
    errorCode = "GEMINI_INVALID_MODEL";
  } else if (statusCode === 400) {
    errorCode = "GEMINI_BAD_REQUEST";
  } else if (isModelDailyQuotaExhausted) {
    errorCode = "GEMINI_QUOTA_EXHAUSTED";
  } else if (isRateLimit) {
    errorCode = "GEMINI_RATE_LIMIT_429";
  } else if (isTimeout) {
    errorCode = "GEMINI_TIMEOUT";
  } else if (isHighDemand503) {
    errorCode = "GEMINI_HIGH_DEMAND_503";
  }
  const isRetryableAvailabilityError = !isAuthError && !isInvalidModel && !isModelDailyQuotaExhausted && !isTimeout && statusCode !== 400 && (isHighDemand503 || isRateLimit || isTemporary500);
  return {
    statusCode,
    errorCode,
    isRetryableAvailabilityError,
    isRateLimit,
    isHighDemand503,
    isTimeout,
    isAuthError,
    isInvalidModel,
    isModelDailyQuotaExhausted,
    cleanMessage: rawMessage.slice(0, 260)
  };
}
function validateAndParseOcrJsonResponse(rawText, mode = "batch") {
  const trimmed = (rawText || "").trim();
  if (!trimmed) {
    throw new Error("Malformed OCR response: Gemini returned an empty response body.");
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (parseErr) {
    throw new Error(
      `Malformed OCR JSON response: Could not parse JSON output (${parseErr?.message || "syntax error"}).`
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Malformed OCR response: Root JSON value must be an object.");
  }
  if (mode === "label") {
    const hasCode = typeof parsed.detectedCode === "string" || typeof parsed.partNumber === "string" || typeof parsed.rawText === "string";
    if (!hasCode) {
      throw new Error(
        "Malformed label OCR response: missing detectedCode, partNumber, or rawText string field."
      );
    }
    return parsed;
  }
  if (!Array.isArray(parsed.items)) {
    throw new Error('Incomplete OCR response: Missing required "items" array in JSON output.');
  }
  for (let i = 0; i < parsed.items.length; i++) {
    const row = parsed.items[i];
    if (!row || typeof row !== "object") {
      throw new Error(`Malformed OCR item at index ${i}: item is not an object.`);
    }
    const hasPartOrDesc = typeof row.part === "string" && row.part.trim().length > 0 || typeof row.desc === "string" && row.desc.trim().length > 0;
    if (!hasPartOrDesc) {
      throw new Error(
        `Incomplete OCR item at index ${i}: both part number and description are empty.`
      );
    }
    const qtyNum = Number(row.qty);
    if (Number.isNaN(qtyNum) || qtyNum < 0) {
      throw new Error(`Invalid OCR item quantity at index ${i}: qty="${String(row.qty)}".`);
    }
  }
  return parsed;
}
function parseDataUrl(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  return {
    mimeType: match ? match[1] : "image/jpeg",
    base64Data: match ? match[2] : dataUrl.replace(/^data:image\/\w+;base64,/, "")
  };
}
function parseCleanRowNo(raw) {
  const str = String(raw ?? "").trim();
  if (!str) return "";
  const dashMatch = str.match(/^\d{3,10}\s*[-–—]\s*0*(\d{1,4})$/);
  if (dashMatch) {
    return dashMatch[1];
  }
  const cleanCandidate = str.replace(/^(?:ITM|ITEM|LINE|POS|NO\.?|SR\.?\s*NO\.?|#)\s*[-:]?\s*/i, "").replace(/^0+(?=\d)/, "").trim();
  if (/^\d{1,4}$/.test(cleanCandidate)) {
    const num = parseInt(cleanCandidate, 10);
    if (num >= 1 && num <= 2500) {
      return String(num);
    }
  }
  return "";
}
function isGciSupplierHint(supplierHint) {
  return typeof supplierHint === "string" && supplierHint.trim().toLowerCase() === "gci";
}
function cleanGciRefToken(raw) {
  const s = String(raw || "").replace(/^(?:client\s*order\s*(?:no|num|number|#)|job\s*(?:no|num|number|#)|docket\s*(?:no|num|number|#)|order\s*(?:no|num|number|#)|po\s*(?:no|num|number|#)?)\s*[:#.\-]?\s*/i, "").trim();
  return s;
}
function isSyntheticDocketPlaceholder(raw) {
  return /^DK-(?:REVIEW-)?(?:P?\d+-)?\d+$/i.test(String(raw || "").trim());
}
function normalizeGciDispatchDate(rawDate) {
  const s = String(rawDate || "").trim();
  if (!s) return void 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) {
    let day = parseInt(dmy[1], 10);
    let month = parseInt(dmy[2], 10);
    const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    if (month > 12 && day >= 1 && day <= 12) {
      const swap = day;
      day = month;
      month = swap;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }
  const named = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (named) {
    const months = {
      jan: "01",
      january: "01",
      feb: "02",
      february: "02",
      mar: "03",
      march: "03",
      apr: "04",
      april: "04",
      may: "05",
      jun: "06",
      june: "06",
      jul: "07",
      july: "07",
      aug: "08",
      august: "08",
      sep: "09",
      sept: "09",
      september: "09",
      oct: "10",
      october: "10",
      nov: "11",
      november: "11",
      dec: "12",
      december: "12"
    };
    const mCode = months[named[2].toLowerCase()];
    const day = parseInt(named[1], 10);
    if (mCode && day >= 1 && day <= 31) {
      return `${named[3]}-${mCode}-${String(day).padStart(2, "0")}`;
    }
  }
  return void 0;
}
function extractGciFieldsFromSelectableText(selectableText) {
  const text = String(selectableText || "").trim();
  if (!text) return {};
  let jobNo;
  let clientOrderNo;
  let dispatchDate;
  const clientOrderMatch = text.match(/Client\s*Order\s*(?:No|Num|Number|#)?\s*[:#.\-|\s]+\s*([A-Z0-9][A-Z0-9\-_/]{2,18})/i);
  if (clientOrderMatch?.[1] && !/^(?:JOB|NO|DATE|DESPATCH|DISPATCH)$/i.test(clientOrderMatch[1])) {
    clientOrderNo = clientOrderMatch[1].trim();
  }
  const jobMatch = text.match(/Job\s*(?:No|Num|Number|#)\s*[:#.\-|\s]+\s*([A-Z0-9][A-Z0-9\-_/]{2,18})/i);
  if (jobMatch?.[1] && !/^(?:NO|DATE|DESPATCH|DISPATCH|BY)$/i.test(jobMatch[1])) {
    jobNo = jobMatch[1].trim();
  }
  const dateMatch = text.match(/(?:Despatch|Dispatch)\s*Date\s*[:#.\-|\s]+\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  if (dateMatch?.[1]) {
    dispatchDate = normalizeGciDispatchDate(dateMatch[1].trim());
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    if (/\bclient\s*order\b/i.test(lines[i]) && /\bjob\s*no\b/i.test(lines[i])) {
      const valLine = lines[i + 1];
      const tabular = valLine.match(/([A-Z0-9\-]{3,16})\s*(?:\||\s{2,}|\s)\s*([A-Z0-9\-]{4,16})(?:\s*(?:\||\s)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2}))?/i);
      if (tabular) {
        if (!clientOrderNo && tabular[1]) clientOrderNo = tabular[1].trim();
        if (!jobNo && tabular[2]) jobNo = tabular[2].trim();
        if (!dispatchDate && tabular[3]) dispatchDate = normalizeGciDispatchDate(tabular[3].trim());
      }
      break;
    }
  }
  return { jobNo, clientOrderNo, dispatchDate };
}
function resolveGciPageHeaderFields(input, options) {
  const normId = (s) => s.trim().toUpperCase().replace(/\s+/g, "");
  const rawDocketClean = cleanGciRefToken(input.docketNumber);
  const rawDocket = isSyntheticDocketPlaceholder(rawDocketClean) ? "" : rawDocketClean;
  const rawJob = cleanGciRefToken(input.jobNumber);
  const rawOrder = cleanGciRefToken(input.orderNumber);
  const textHints = extractGciFieldsFromSelectableText(options?.selectableText);
  const resolvedOrder = rawOrder || textHints.clientOrderNo || "";
  const orderNorm = normId(resolvedOrder);
  const textOrderNorm = normId(textHints.clientOrderNo || "");
  let resolvedJob = "";
  if (rawJob && (!orderNorm || normId(rawJob) !== orderNorm) && (!textOrderNorm || normId(rawJob) !== textOrderNorm)) {
    resolvedJob = rawJob;
  } else if (textHints.jobNo && (!orderNorm || normId(textHints.jobNo) !== orderNorm)) {
    resolvedJob = textHints.jobNo;
  } else if (rawDocket && (!orderNorm || normId(rawDocket) !== orderNorm) && (!textOrderNorm || normId(rawDocket) !== textOrderNorm)) {
    resolvedJob = rawDocket;
  }
  const resolvedDate = normalizeGciDispatchDate(input.deliveryDate) || textHints.dispatchDate;
  const missingJobNo = !resolvedJob && !options?.isContinuationWithoutHeader;
  const warnings = Array.from(
    new Set((input.validationWarnings || []).map((w) => String(w || "").trim()).filter(Boolean))
  );
  if (missingJobNo && !warnings.some((w) => /GCI Job No/i.test(w))) {
    warnings.push(GCI_MISSING_JOB_NO_WARNING);
  }
  return {
    docketNumber: resolvedJob,
    jobNumber: resolvedJob || void 0,
    orderNumber: resolvedOrder || void 0,
    deliveryDate: resolvedDate,
    supplier: "GCI",
    missingJobNo,
    validationWarnings: warnings
  };
}
function buildDocketExtractionPrompt(pageDescriptions, pageNumbers, totalPages, supplierHint) {
  const basePrompt = `Examine ${pageDescriptions.join(" and ")} (out of ${totalPages} total pages) and extract EVERY physical part row literally visible in top-to-bottom order. If the document is blank or has no part rows, return items: [].

MANDATORY 100%-RECALL EXTRACTION RULES:
1. RECORD FIRST & LAST VISIBLE ROW NUMBERS:
   - Record printed "No" of first visible part row in 'firstVisibleRowNo' and last visible row in 'lastVisibleRowNo' (or "" if none).
2. EXTRACT EVERY SINGLE PART ROW FROM TOP TO BOTTOM:
   - Never skip a numbered row and never merge two separate numbered rows into one item.
   - If a page is presented as an UPPER half and a LOWER half with center overlap, read top-to-bottom without duplicating overlap rows and without skipping rows near the seam.
   - Preserve legitimate separate rows even if the same part number appears multiple times with different revisions, pallets, descriptions, or line numbers.
3. IGNORE NON-PART LINES:
   - Exclude phone/fax numbers, ABN numbers, street/postal codes, delivery instructions, header barcodes, consignment notes, column headers, weights/kg totals, and tax/charge rows (Freight, Delivery, Setup, Pallet Fee, Subtotal, GST, Total, Balance Due).
4. MULTIPLE DOCKETS / PAGE HEADERS:
   - Record one entry in 'pageHeaders' for EVERY page (${pageNumbers.join(", ")}) with: page, docketNumber (exact printed Docket No, Delivery Note, Packing Slip, Tax Invoice No; "" if continuation page has no header), supplier (sender/fabricator e.g. Laser Central, GCI), customerName (Deliver To / Customer / Bill To recipient), deliveryDate (YYYY-MM-DD if visible), orderNumber (Customer PO / Order No), jobNumber (Job # / Work Order # if separate), carrier, palletCount, and startsNewDocket (true if this page clearly starts a new docket/invoice).
5. FIELD MAPPING FOR EACH PART ROW:
   - page: Page number (${pageNumbers.join(" or ")}) where row appears.
   - no: Exact printed "No" / "Item" / "Pos" / "Line" / "#" number (if a NEW docket starts and numbering restarts at 1, keep "1").
   - part: Exact Part Number, Client Part Code, Drawing Number, J-series code, Mark, or Profile Name as printed. Join wrapped multi-line part codes cleanly. Never place row numbers, phone numbers, or quantities into 'part'.
   - desc: Full part description written on the row. If quantity/unit like "4 EA" appears beside description while Qty column is numeric, keep unit ("EA") in 'unit'.
   - rev: Drawing revision / Rev code if shown ("A", "B", "01"), else "".
   - mat: Material grade if printed, else "".
   - thk: Thickness if printed, else "".
   - dim: Dimensions/size if printed, else "".
   - wt: Weight if printed, else "".
   - unit: Unit of measurement (e.g. "EA", "PC", "PCS", "SET", "M", "KG") if shown, else "".
   - qty: Dispatched/delivered numeric quantity (prefer "Desp" / "Despatched" / "Shipped" / "Qty"; never use Unit Price $ or Total $).
   - originalText: Exact raw text string read from this row when helpful for review/verification.
   - confidence: "high", "medium", or "low" (use "low" if smudged, faded, ambiguous, or split awkwardly).
   - validationWarnings: Array of short warnings for this row if uncertain (else []).`;
  if (!isGciSupplierHint(supplierHint)) {
    return basePrompt;
  }
  return `${basePrompt}

6. GCI SUPPLIER-SPECIFIC HEADER MAPPING (CRITICAL \u2014 DO NOT SWAP):
   - The user selected supplier = GCI. GCI dockets use header labels: "Client Order No", "Job No", "Despatch Date" / "Dispatch Date", and "Despatched By".
   - "Job No" (e.g. 194322) IS the primary Docket / Ref # -> populate BOTH 'docketNumber' and 'jobNumber' with the exact Job No value in 'pageHeaders' and top-level fields.
   - "Client Order No" (e.g. 72018) IS the customer PO / Order # -> populate 'orderNumber' ONLY. NEVER place "Client Order No" into 'docketNumber' or 'jobNumber'.
   - "Despatch Date" / "Dispatch Date" (Australian DD/MM/YYYY format, e.g. 12/11/2026 -> 2026-11-12) -> populate 'deliveryDate' formatted as YYYY-MM-DD.
   - Set 'supplier' to "GCI".
   - Multi-page & multi-docket GCI grouping: Use "Job No" as the primary identifier for independent GCI dockets. Group continuation pages sharing the same "Job No" together; if a page has a different "Job No", set startsNewDocket=true and keep its corresponding "Client Order No" in 'orderNumber'.
   - Missing or unreadable Job No: If "Job No" is missing or unreadable on a page, leave 'docketNumber' and 'jobNumber' empty "" and note it in 'validationWarnings'. NEVER substitute "Client Order No" into 'docketNumber'.`;
}
function buildRestDocketResponseSchema() {
  return {
    type: "OBJECT",
    properties: {
      docketNumber: { type: "STRING" },
      supplier: { type: "STRING" },
      customerName: { type: "STRING" },
      deliveryDate: { type: "STRING" },
      orderNumber: { type: "STRING" },
      jobNumber: { type: "STRING" },
      carrier: { type: "STRING" },
      palletCount: { type: "INTEGER" },
      validationWarnings: { type: "ARRAY", items: { type: "STRING" } },
      pageHeaders: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            page: { type: "INTEGER" },
            docketNumber: { type: "STRING" },
            supplier: { type: "STRING" },
            customerName: { type: "STRING" },
            deliveryDate: { type: "STRING" },
            orderNumber: { type: "STRING" },
            jobNumber: { type: "STRING" },
            carrier: { type: "STRING" },
            palletCount: { type: "INTEGER" },
            startsNewDocket: { type: "BOOLEAN" }
          },
          required: ["page"]
        }
      },
      hasPrintedNoColumn: { type: "BOOLEAN" },
      firstVisibleRowNo: { type: "STRING" },
      lastVisibleRowNo: { type: "STRING" },
      items: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            page: { type: "INTEGER" },
            no: { type: "STRING" },
            part: { type: "STRING" },
            desc: { type: "STRING" },
            rev: { type: "STRING" },
            mat: { type: "STRING" },
            thk: { type: "STRING" },
            dim: { type: "STRING" },
            wt: { type: "STRING" },
            unit: { type: "STRING" },
            qty: { type: "NUMBER" },
            originalText: { type: "STRING" },
            confidence: { type: "STRING" },
            validationWarnings: { type: "ARRAY", items: { type: "STRING" } }
          },
          required: ["no", "part", "desc", "qty"]
        }
      }
    },
    required: ["items"]
  };
}
async function generateWithRetryAndFallback(ai, ThinkingLevel, parts, systemInstruction, responseSchema, mode = "batch", envOverride, baseDelayMs = INITIAL_BACKOFF_MS) {
  const { primaryModel, fallbackModels } = resolveConfiguredVisionModels(envOverride);
  const allConfiguredModels = [primaryModel, ...fallbackModels];
  const nowMs = Date.now();
  const useCooldownMemory = baseDelayMs >= 500;
  const candidateModels = useCooldownMemory ? [
    ...allConfiguredModels.filter((m) => (modelQuotaCooldownUntil.get(m) || 0) <= nowMs),
    ...allConfiguredModels.filter((m) => (modelQuotaCooldownUntil.get(m) || 0) > nowMs)
  ] : allConfiguredModels;
  let totalRetryAttempts = 0;
  let lastError = null;
  let lastClassification = null;
  for (let mIdx = 0; mIdx < candidateModels.length; mIdx++) {
    const currentModel = candidateModels[mIdx];
    const isFallbackModel = currentModel !== primaryModel;
    const maxRetriesForModel = MAX_AUTOMATIC_RETRIES;
    logOcrEvent("info", isFallbackModel ? "model_fallback_selected" : "model_selected", {
      model: currentModel,
      isFallback: isFallbackModel,
      mode
    });
    for (let retry = 0; retry <= maxRetriesForModel; retry++) {
      const controller = new AbortController();
      const timeoutMs = GEMINI_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const config = {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema,
          abortSignal: controller.signal
        };
        if (ThinkingLevel && currentModel.includes("gemini-4-hydrogen")) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW || ThinkingLevel.MEDIUM };
        }
        const response = await ai.models.generateContent({
          model: currentModel,
          contents: { parts },
          config
        });
        clearTimeout(timer);
        const rawText = (response?.text ?? "").trim();
        const validated = validateAndParseOcrJsonResponse(rawText, mode);
        logOcrEvent("info", "extraction_succeeded", {
          model: currentModel,
          isFallback: isFallbackModel,
          retryAttempts: totalRetryAttempts,
          statusCode: 200,
          itemsExtracted: Array.isArray(validated?.items) ? validated.items.length : 1
        });
        return {
          parsed: validated,
          modelUsed: currentModel,
          fallbackUsed: isFallbackModel,
          retryAttempts: totalRetryAttempts
        };
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted && !err?.isTimeout) {
          const timeoutErr = new Error(
            `Gemini API request to ${currentModel} timed out after ${Math.round(timeoutMs / 1e3)}s (HTTP 504).`
          );
          timeoutErr.status = 504;
          timeoutErr.code = "GEMINI_TIMEOUT";
          timeoutErr.isTimeout = true;
          err = timeoutErr;
        }
        lastError = err;
        const classification = classifyGeminiError(err);
        lastClassification = classification;
        const isValidationFailure = String(err?.message || "").includes("Malformed") || String(err?.message || "").includes("Incomplete OCR") || String(err?.message || "").includes("Invalid OCR item");
        logOcrEvent("warn", "extraction_attempt_failed", {
          model: currentModel,
          isFallback: isFallbackModel,
          attempt: retry + 1,
          maxAttemptsForModel: maxRetriesForModel + 1,
          statusCode: classification.statusCode,
          errorCode: classification.errorCode,
          isRetryable: classification.isRetryableAvailabilityError || isValidationFailure,
          reason: classification.cleanMessage
        });
        if (!isValidationFailure && (classification.isAuthError || classification.statusCode === 400)) {
          const permErr = new Error(
            classification.isAuthError ? `Gemini API authentication/permission error (HTTP ${classification.statusCode}): ${classification.cleanMessage}` : `Gemini API malformed request error (HTTP 400): ${classification.cleanMessage}`
          );
          permErr.status = classification.statusCode;
          permErr.code = classification.errorCode;
          permErr.retryable = false;
          throw permErr;
        }
        if (!isValidationFailure && (classification.isInvalidModel || classification.isModelDailyQuotaExhausted || classification.isTimeout)) {
          if (useCooldownMemory) {
            const cooldownMs = classification.isTimeout ? MODEL_TRANSIENT_COOLDOWN_MS : MODEL_COOLDOWN_DURATION_MS;
            modelQuotaCooldownUntil.set(currentModel, Date.now() + cooldownMs);
          }
          logOcrEvent("info", "model_fast_failover", {
            failedModel: currentModel,
            nextModel: candidateModels[mIdx + 1] || "none",
            statusCode: classification.statusCode,
            errorCode: classification.errorCode
          });
          break;
        }
        if ((classification.isRetryableAvailabilityError || isValidationFailure) && retry < maxRetriesForModel) {
          totalRetryAttempts++;
          const waitMs = computeExponentialBackoffWithJitter(retry + 1, baseDelayMs);
          logOcrEvent("info", "retrying_after_backoff", {
            model: currentModel,
            retryAttempt: retry + 1,
            maxRetries: maxRetriesForModel,
            waitMs,
            statusCode: classification.statusCode
          });
          await sleep(waitMs);
          continue;
        }
        if (useCooldownMemory && (classification.isHighDemand503 || classification.isRateLimit)) {
          modelQuotaCooldownUntil.set(currentModel, Date.now() + MODEL_TRANSIENT_COOLDOWN_MS);
        }
      }
    }
  }
  const finalClassification = lastClassification || classifyGeminiError(lastError);
  logOcrEvent("error", "all_models_and_retries_exhausted", {
    primaryModel,
    fallbackModels: fallbackModels.join(","),
    totalRetryAttempts,
    lastStatusCode: finalClassification.statusCode,
    errorCode: finalClassification.errorCode,
    error: finalClassification.cleanMessage
  });
  if (finalClassification.isInvalidModel) {
    const modelErr = new Error(
      `Gemini model unavailable or invalid (HTTP 404): ${finalClassification.cleanMessage}`
    );
    modelErr.status = 404;
    modelErr.code = "GEMINI_INVALID_MODEL";
    modelErr.retryable = false;
    throw modelErr;
  }
  if (finalClassification.isModelDailyQuotaExhausted) {
    const quotaErr = new Error(
      `Gemini AI quota exceeded (HTTP 429): ${finalClassification.cleanMessage}`
    );
    quotaErr.status = 429;
    quotaErr.code = "GEMINI_QUOTA_EXHAUSTED";
    quotaErr.retryable = false;
    throw quotaErr;
  }
  if (finalClassification.isTimeout) {
    const timeoutErr = new Error(
      `Gemini AI extraction timed out (HTTP 504) after ${Math.round(GEMINI_REQUEST_TIMEOUT_MS / 1e3)}s per request. Your uploaded docket has been preserved \u2014 please click "Retry Extraction".`
    );
    timeoutErr.status = 504;
    timeoutErr.code = "GEMINI_TIMEOUT";
    timeoutErr.retryable = true;
    throw timeoutErr;
  }
  if (finalClassification.isHighDemand503) {
    const busyErr = new Error(
      `Gemini AI is currently experiencing high demand (HTTP 503) after ${totalRetryAttempts} automatic retry and fallback to ${fallbackModels[0] || "secondary model"}. Your uploaded docket has been preserved \u2014 please click "Retry Extraction" in a moment.`
    );
    busyErr.status = 503;
    busyErr.code = "GEMINI_HIGH_DEMAND_503";
    busyErr.retryable = true;
    throw busyErr;
  }
  if (finalClassification.isRateLimit) {
    const rateErr = new Error(
      `Gemini AI rate limit reached (HTTP 429) after ${totalRetryAttempts} automatic retry. Your uploaded docket has been preserved \u2014 please wait a few seconds and click "Retry Extraction".`
    );
    rateErr.status = 429;
    rateErr.code = "GEMINI_RATE_LIMIT_429";
    rateErr.retryable = true;
    throw rateErr;
  }
  const genericErr = new Error(
    finalClassification.cleanMessage || 'Gemini AI could not extract the docket after automatic retries. Please click "Retry Extraction".'
  );
  genericErr.status = finalClassification.statusCode || 500;
  genericErr.code = finalClassification.errorCode || "AI_EXTRACTION_FAILED";
  throw genericErr;
}
async function extractPageBatchInOneCall(ai, Type, ThinkingLevel, batchPages, totalPages, supplierHint) {
  const parts = [];
  const pageDescriptions = [];
  for (const bp of batchPages) {
    const pNum = bp.pageNumber;
    const payload = bp.payload;
    if (payload.upperDataUrl && payload.lowerDataUrl) {
      const up = parseDataUrl(payload.upperDataUrl);
      const low = parseDataUrl(payload.lowerDataUrl);
      parts.push({ inlineData: { mimeType: up.mimeType, data: up.base64Data } });
      parts.push({ inlineData: { mimeType: low.mimeType, data: low.base64Data } });
      pageDescriptions.push(
        `Page ${pNum} (shown as 2 high-res zoomed halves: UPPER 58% of Page ${pNum} followed by LOWER 58% of Page ${pNum})`
      );
    } else {
      const full = parseDataUrl(payload.fullDataUrl);
      parts.push({ inlineData: { mimeType: full.mimeType, data: full.base64Data } });
      pageDescriptions.push(`Page ${pNum}`);
    }
    if (payload.pdfSelectableText && payload.pdfSelectableText.trim()) {
      parts.push({
        text: `[DIRECT SELECTABLE TEXT EXTRACTED FROM PDF PAGE ${pNum}]:
${payload.pdfSelectableText.slice(0, 18e3)}`
      });
    }
  }
  const systemInstruction = DOCKET_EXTRACTION_SYSTEM_INSTRUCTION;
  const promptText = buildDocketExtractionPrompt(
    pageDescriptions,
    batchPages.map((b) => b.pageNumber),
    totalPages,
    supplierHint
  );
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      docketNumber: { type: Type.STRING },
      supplier: { type: Type.STRING },
      customerName: { type: Type.STRING },
      deliveryDate: { type: Type.STRING },
      orderNumber: { type: Type.STRING },
      jobNumber: { type: Type.STRING },
      carrier: { type: Type.STRING },
      palletCount: { type: Type.INTEGER },
      validationWarnings: { type: Type.ARRAY, items: { type: Type.STRING } },
      pageHeaders: {
        type: Type.ARRAY,
        description: "Per-page docket header metadata used to keep multi-page dockets together and separate distinct dockets.",
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER },
            docketNumber: { type: Type.STRING },
            supplier: { type: Type.STRING },
            customerName: { type: Type.STRING },
            deliveryDate: { type: Type.STRING },
            orderNumber: { type: Type.STRING },
            jobNumber: { type: Type.STRING },
            carrier: { type: Type.STRING },
            palletCount: { type: Type.INTEGER },
            startsNewDocket: { type: Type.BOOLEAN }
          },
          required: ["page"]
        }
      },
      hasPrintedNoColumn: {
        type: Type.BOOLEAN,
        description: "True if the table has a printed No / Item / Pos / Line number column."
      },
      firstVisibleRowNo: {
        type: Type.STRING,
        description: 'The printed "No" of the first visible part row in this batch, or "" if none.'
      },
      lastVisibleRowNo: {
        type: Type.STRING,
        description: 'The printed "No" of the last visible part row at the bottom of this batch, or "" if none.'
      },
      items: {
        type: Type.ARRAY,
        description: "Every physical part row literally visible in the image(s). Empty array [] if no part rows are visible.",
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER, description: "Page number." },
            no: { type: Type.STRING, description: 'Exact printed row "No".' },
            part: { type: Type.STRING, description: "Part Number, Drawing No, or Part Name." },
            desc: { type: Type.STRING, description: "Full part description." },
            rev: { type: Type.STRING, description: "Part revision if present." },
            mat: { type: Type.STRING },
            thk: { type: Type.STRING },
            dim: { type: Type.STRING },
            wt: { type: Type.STRING },
            unit: { type: Type.STRING, description: "Unit of measurement (e.g. EA, PCS, SET)." },
            qty: { type: Type.NUMBER, description: "Quantity of this part (never price)." },
            originalText: { type: Type.STRING, description: "Raw row text snippet if uncertain." },
            confidence: { type: Type.STRING, description: "high, medium, or low." },
            validationWarnings: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["no", "part", "desc", "qty"],
          propertyOrdering: [
            "page",
            "no",
            "part",
            "desc",
            "rev",
            "mat",
            "thk",
            "dim",
            "wt",
            "unit",
            "qty",
            "originalText",
            "confidence",
            "validationWarnings"
          ]
        }
      }
    },
    required: ["items"],
    propertyOrdering: [
      "docketNumber",
      "supplier",
      "customerName",
      "deliveryDate",
      "orderNumber",
      "jobNumber",
      "carrier",
      "palletCount",
      "validationWarnings",
      "pageHeaders",
      "hasPrintedNoColumn",
      "firstVisibleRowNo",
      "lastVisibleRowNo",
      "items"
    ]
  };
  parts.push({ text: promptText });
  const { parsed, modelUsed, fallbackUsed, retryAttempts } = await generateWithRetryAndFallback(
    ai,
    ThinkingLevel,
    parts,
    systemInstruction,
    responseSchema,
    "batch"
  );
  return {
    docketNumber: parsed.docketNumber,
    supplier: parsed.supplier,
    customerName: parsed.customerName,
    deliveryDate: parsed.deliveryDate,
    carrier: parsed.carrier,
    orderNumber: parsed.orderNumber,
    jobNumber: parsed.jobNumber,
    palletCount: parsed.palletCount,
    validationWarnings: Array.isArray(parsed.validationWarnings) ? parsed.validationWarnings : [],
    pageHeaders: Array.isArray(parsed.pageHeaders) ? parsed.pageHeaders : [],
    hasPrintedNoColumn: parsed.hasPrintedNoColumn !== false,
    firstVisibleRowNo: parsed.firstVisibleRowNo,
    lastVisibleRowNo: parsed.lastVisibleRowNo,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    modelUsed,
    fallbackUsed,
    retryAttempts
  };
}
async function recoverMissingRowsBatch(ai, Type, ThinkingLevel, pagesToRecover) {
  if (pagesToRecover.length === 0) return [];
  const parts = [];
  const instructionsPerPage = [];
  for (const entry of pagesToRecover) {
    const pNum = entry.pageNumber;
    const payload = entry.payload;
    if (payload.upperDataUrl && payload.lowerDataUrl) {
      const up = parseDataUrl(payload.upperDataUrl);
      const low = parseDataUrl(payload.lowerDataUrl);
      parts.push({ inlineData: { mimeType: up.mimeType, data: up.base64Data } });
      parts.push({ inlineData: { mimeType: low.mimeType, data: low.base64Data } });
    } else {
      const full = parseDataUrl(payload.fullDataUrl);
      parts.push({ inlineData: { mimeType: full.mimeType, data: full.base64Data } });
    }
    instructionsPerPage.push(
      `- On Page ${pNum}: find and extract rows with printed "No" = [ ${entry.missingNos.join(", ")} ]`
    );
  }
  const systemInstruction = `You are a precision industrial docket row recovery engine. Locate the exact requested row "No" numbers in the provided page images and transcribe them accurately.`;
  const promptText = `TARGETED MISSING ROW RECOVERY:
During the initial pass, the following row numbers in the "No" / "Item" / "Pos" / "Line" column were missed:
${instructionsPerPage.join("\n")}

Scan the provided page images carefully, locate EVERY row whose printed "No" matches one of the numbers listed above, and return its exact details in 'items'.
STRICT RULE: Only return rows that are actually visible in the images.`;
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      items: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            page: { type: Type.INTEGER },
            no: { type: Type.STRING, description: 'Exact printed row "No" from the missing list.' },
            part: { type: Type.STRING, description: "Part Number, Drawing No, or Part Name." },
            desc: { type: Type.STRING, description: "Full part description." },
            rev: { type: Type.STRING },
            mat: { type: Type.STRING },
            thk: { type: Type.STRING },
            dim: { type: Type.STRING },
            wt: { type: Type.STRING },
            qty: { type: Type.NUMBER }
          },
          required: ["no", "part", "desc", "qty"],
          propertyOrdering: ["page", "no", "part", "desc", "rev", "mat", "thk", "dim", "wt", "qty"]
        }
      }
    },
    required: ["items"]
  };
  parts.push({ text: promptText });
  try {
    const { parsed } = await generateWithRetryAndFallback(
      ai,
      ThinkingLevel,
      parts,
      systemInstruction,
      responseSchema,
      "recovery"
    );
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch {
    return [];
  }
}
function normalizeRawBatchItem(it, defaultPageNumber) {
  let pn = String(it.part || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const desc = String(it.desc || "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  if (!pn && !desc) return null;
  if (/^(?:subtotal|sub-total|total|gst|tax|freight|delivery\s*charge|cartage|balance\s*due|amount\s*due|discount|abn|acn|phone|ph:|fax|email|web|bsb|account|page\s*\d+\s*of\s*\d+)$/i.test(
    pn
  ) || /^(?:subtotal|sub-total|gst\s*10%?|total\s*incl|total\s*excl|amount\s*due|balance\s*due|freight\s*charge|bank\s*details|remittance\s*advice|terms\s*and\s*conditions)$/i.test(
    desc
  ) || /^(?:0[2378]\s*\d{4}\s*\d{4}|\(\s*0[2378]\s*\)\s*\d{4}\s*\d{4}|\+61\s*\d[\s\d]{7,10})$/.test(pn) || /^(?:ABN|ACN)\s*[:#]?\s*[\d\s]{9,14}$/i.test(pn)) {
    return null;
  }
  let cleanNo = parseCleanRowNo(it.no);
  if (/^\d{1,4}$/.test(pn) && parseCleanRowNo(pn) === cleanNo && desc.length > 0 || !pn) {
    const codeFromDesc = desc.match(/^([A-Z0-9][A-Z0-9\-_./]{2,22})(?:\s+[-–:]\s+|\s+)(.+)$/i);
    if (codeFromDesc && /\d/.test(codeFromDesc[1])) {
      pn = codeFromDesc[1].trim();
    } else {
      pn = desc.slice(0, 32).trim();
    }
  }
  if (!cleanNo) {
    const pnDashMatch = pn.match(/^(\d{4,10})\s*[-–—]\s*0*(\d{1,4})$/);
    if (pnDashMatch) {
      cleanNo = pnDashMatch[2];
    }
  }
  const rawQty = Number(it.qty);
  const cleanQty = !Number.isNaN(rawQty) && rawQty >= 1 && rawQty <= 99999 ? Math.round(rawQty) : 1;
  const cleanPn = String(pn || desc.slice(0, 28) || "PART").trim().toUpperCase();
  const resolvedPage = typeof it.page === "number" && it.page >= 1 ? it.page : defaultPageNumber;
  const cleanRev = it.rev && String(it.rev).trim() ? String(it.rev).trim() : void 0;
  const cleanMat = it.mat && String(it.mat).trim() ? String(it.mat).trim() : void 0;
  const cleanThk = it.thk && String(it.thk).trim() ? String(it.thk).trim() : void 0;
  const cleanUnit = it.unit && String(it.unit).trim() ? String(it.unit).trim().toUpperCase() : void 0;
  const rawWarnings = Array.isArray(it.validationWarnings) ? it.validationWarnings.map((w) => String(w || "").trim()).filter(Boolean) : [];
  const rawConf = String(it.confidence || "").toLowerCase();
  const confidence = rawConf === "low" ? "low" : rawConf === "medium" ? "medium" : "high";
  return {
    cleanNo,
    item: {
      partNumber: cleanPn,
      itemNumber: cleanNo,
      description: String(desc || cleanPn).trim(),
      revision: cleanRev,
      material: cleanMat,
      thickness: cleanThk,
      dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : void 0,
      weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : void 0,
      quantity: cleanQty,
      unit: cleanUnit,
      palletNumber: "Pallet 1",
      pageNumber: resolvedPage,
      originalText: it.originalText && String(it.originalText).trim() ? String(it.originalText).trim() : void 0,
      confidence,
      validationFlags: rawWarnings.length > 0 ? rawWarnings : void 0,
      validationWarnings: rawWarnings.length > 0 ? rawWarnings : void 0,
      originalOcrValues: {
        partNumber: cleanPn,
        itemNumber: cleanNo,
        description: String(desc || cleanPn).trim(),
        revision: cleanRev,
        quantity: cleanQty,
        material: cleanMat,
        thickness: cleanThk
      }
    }
  };
}
async function extractDocketWithGeminiVision(base64Images, startItemIndex = 1, pageSlices, overrideApiKey, supplierHint) {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings."
    );
  }
  const { GoogleGenAI, Type, ThinkingLevel } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      },
      timeout: 28e3
    }
  });
  const resolvedPayloads = Array.isArray(pageSlices) && pageSlices.length > 0 ? pageSlices : base64Images.map((img) => ({ fullDataUrl: img }));
  const totalPages = resolvedPayloads.length;
  const isGci = isGciSupplierHint(supplierHint);
  const pagesPerBatch = totalPages >= 5 ? 2 : 1;
  const batches = [];
  for (let i = 0; i < totalPages; i += pagesPerBatch) {
    const chunk = [];
    for (let j = i; j < Math.min(totalPages, i + pagesPerBatch); j++) {
      chunk.push({ pageNumber: j + 1, payload: resolvedPayloads[j] });
    }
    batches.push(chunk);
  }
  const batchResponses = [];
  for (let i = 0; i < batches.length; i += 2) {
    const pair = batches.slice(i, i + 2);
    const pairRes = await Promise.all(
      pair.map((b) => extractPageBatchInOneCall(ai, Type, ThinkingLevel, b, totalPages, supplierHint))
    );
    batchResponses.push(...pairRes);
  }
  const pageMetaMap = /* @__PURE__ */ new Map();
  for (let p = 1; p <= totalPages; p++) {
    pageMetaMap.set(p, {
      pageNumber: p,
      explicitDocketNumber: "",
      validationWarnings: [],
      rawItems: []
    });
  }
  let anyPrintedNoColumn = false;
  let modelUsed = DEFAULT_PRIMARY_VISION_MODEL;
  let fallbackUsed = false;
  let totalRetries = 0;
  for (let bIdx = 0; bIdx < batchResponses.length; bIdx++) {
    const bRes = batchResponses[bIdx];
    modelUsed = bRes.modelUsed || modelUsed;
    fallbackUsed = fallbackUsed || Boolean(bRes.fallbackUsed);
    totalRetries += bRes.retryAttempts || 0;
    if (bRes.hasPrintedNoColumn !== false) {
      anyPrintedNoColumn = true;
    }
    const batchPageNums = batches[bIdx].map((b) => b.pageNumber);
    const defaultPage = batchPageNums[0];
    for (const ph of bRes.pageHeaders || []) {
      const pNum = Math.min(totalPages, Math.max(1, Number(ph.page ?? ph.pageNumber) || defaultPage));
      const meta = pageMetaMap.get(pNum);
      const dn = String(ph.docketNumber || "").trim();
      if (dn && !meta.explicitDocketNumber) meta.explicitDocketNumber = dn;
      if (ph.supplier && ph.supplier.trim() && !meta.supplier) meta.supplier = ph.supplier.trim();
      if (ph.customerName && ph.customerName.trim() && !meta.customerName) {
        meta.customerName = ph.customerName.trim();
      }
      if (ph.deliveryDate && !meta.deliveryDate) {
        const trimmedDate = ph.deliveryDate.trim();
        if (isGci) {
          const normDate = normalizeGciDispatchDate(trimmedDate);
          if (normDate) meta.deliveryDate = normDate;
        } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
          meta.deliveryDate = trimmedDate;
        }
      }
      if (ph.orderNumber && ph.orderNumber.trim() && !meta.orderNumber) meta.orderNumber = ph.orderNumber.trim();
      if (ph.jobNumber && ph.jobNumber.trim() && !meta.jobNumber) meta.jobNumber = ph.jobNumber.trim();
      if (ph.carrier && ph.carrier.trim() && !meta.carrier) meta.carrier = ph.carrier.trim();
      if (ph.palletCount && ph.palletCount > 0 && !meta.palletCount) meta.palletCount = ph.palletCount;
      if (ph.startsNewDocket) meta.startsNewDocket = true;
    }
    const firstMeta = pageMetaMap.get(defaultPage);
    if (!firstMeta.explicitDocketNumber && bRes.docketNumber?.trim() && (batchPageNums.length === 1 || (bRes.pageHeaders || []).length === 0)) {
      firstMeta.explicitDocketNumber = bRes.docketNumber.trim();
    }
    if (!firstMeta.supplier && bRes.supplier?.trim()) firstMeta.supplier = bRes.supplier.trim();
    if (!firstMeta.customerName && bRes.customerName?.trim()) {
      firstMeta.customerName = bRes.customerName.trim();
    }
    if (!firstMeta.deliveryDate && bRes.deliveryDate) {
      const trimmedDate = bRes.deliveryDate.trim();
      if (isGci) {
        const normDate = normalizeGciDispatchDate(trimmedDate);
        if (normDate) firstMeta.deliveryDate = normDate;
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(trimmedDate)) {
        firstMeta.deliveryDate = trimmedDate;
      }
    }
    if (!firstMeta.orderNumber && bRes.orderNumber?.trim()) firstMeta.orderNumber = bRes.orderNumber.trim();
    if (!firstMeta.jobNumber && bRes.jobNumber?.trim()) firstMeta.jobNumber = bRes.jobNumber.trim();
    if (!firstMeta.carrier && bRes.carrier?.trim()) firstMeta.carrier = bRes.carrier.trim();
    if (Array.isArray(bRes.validationWarnings) && bRes.validationWarnings.length > 0) {
      firstMeta.validationWarnings.push(...bRes.validationWarnings.map((w) => String(w || "").trim()).filter(Boolean));
    }
    for (const rawIt of bRes.items || []) {
      const targetPage = Math.min(totalPages, Math.max(1, Number(rawIt.page ?? rawIt.pageNumber) || defaultPage));
      const meta = pageMetaMap.get(targetPage);
      meta.rawItems.push({ ...rawIt, page: targetPage });
      const nVal = parseInt(parseCleanRowNo(rawIt.no), 10);
      if (!Number.isNaN(nVal) && nVal > 0 && nVal <= 1500) {
        meta.minRowNo = meta.minRowNo === void 0 ? nVal : Math.min(meta.minRowNo, nVal);
        meta.maxRowNo = meta.maxRowNo === void 0 ? nVal : Math.max(meta.maxRowNo, nVal);
      }
    }
  }
  if (isGci) {
    for (let p = 1; p <= totalPages; p++) {
      const meta = pageMetaMap.get(p);
      const resolved = resolveGciPageHeaderFields(
        {
          docketNumber: meta.explicitDocketNumber,
          jobNumber: meta.jobNumber,
          orderNumber: meta.orderNumber,
          deliveryDate: meta.deliveryDate,
          supplier: meta.supplier,
          validationWarnings: meta.validationWarnings
        },
        {
          selectableText: resolvedPayloads[p - 1]?.pdfSelectableText,
          // Evaluate missingJobNo accurately later if this page turns out to be a continuation page
          isContinuationWithoutHeader: p > 1
        }
      );
      meta.explicitDocketNumber = resolved.docketNumber;
      meta.jobNumber = resolved.jobNumber;
      meta.orderNumber = resolved.orderNumber;
      if (resolved.deliveryDate) meta.deliveryDate = resolved.deliveryDate;
      meta.supplier = "GCI";
      meta.validationWarnings = resolved.validationWarnings;
    }
  }
  const segments = [];
  const normDocketKey = (s) => s.trim().toUpperCase().replace(/\s+/g, "");
  for (let p = 1; p <= totalPages; p++) {
    const meta = pageMetaMap.get(p);
    const explicitKey = normDocketKey(meta.explicitDocketNumber);
    const hasExplicit = explicitKey.length > 0;
    if (segments.length === 0) {
      if (isGci && !hasExplicit) {
        const missingKey = `GCI-MISSING-JOB-P${p}-${Math.floor(100 + Math.random() * 900)}`;
        const missingWarnings = Array.from(
          /* @__PURE__ */ new Set([...meta.validationWarnings, GCI_MISSING_JOB_NO_WARNING])
        );
        segments.push({
          docketKey: missingKey,
          explicitDocketNumber: "",
          hasExplicitDocketNumber: false,
          supplier: "GCI",
          customerName: meta.customerName,
          deliveryDate: meta.deliveryDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: void 0,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: missingWarnings,
          separationUncertain: true,
          separationReason: GCI_MISSING_JOB_NO_WARNING
        });
      } else {
        const fallbackDk = `DK-${Math.floor(1e4 + Math.random() * 9e4)}`;
        segments.push({
          docketKey: hasExplicit ? explicitKey : fallbackDk,
          explicitDocketNumber: meta.explicitDocketNumber || fallbackDk,
          hasExplicitDocketNumber: hasExplicit,
          supplier: meta.supplier || "Steel Fabrication Supplier",
          customerName: meta.customerName,
          deliveryDate: meta.deliveryDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: meta.jobNumber,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: [...meta.validationWarnings],
          separationUncertain: !hasExplicit && totalPages > 1,
          separationReason: !hasExplicit && totalPages > 1 ? "Docket number not detected on page 1 \u2014 verify page boundaries." : void 0
        });
      }
      continue;
    }
    if (hasExplicit) {
      const existingSameDocket = segments.find(
        (seg) => seg.hasExplicitDocketNumber && seg.docketKey === explicitKey
      );
      if (existingSameDocket) {
        existingSameDocket.pageNumbers.push(p);
        existingSameDocket.rawItems.push(...meta.rawItems);
        existingSameDocket.validationWarnings.push(...meta.validationWarnings);
        existingSameDocket.maxRowSeen = Math.max(existingSameDocket.maxRowSeen, meta.maxRowNo || 0);
        if (!existingSameDocket.carrier && meta.carrier) existingSameDocket.carrier = meta.carrier;
        if (!existingSameDocket.orderNumber && meta.orderNumber) existingSameDocket.orderNumber = meta.orderNumber;
        if (!existingSameDocket.customerName && meta.customerName) existingSameDocket.customerName = meta.customerName;
        if (!existingSameDocket.jobNumber && meta.jobNumber) existingSameDocket.jobNumber = meta.jobNumber;
        existingSameDocket.palletCount = Math.max(existingSameDocket.palletCount, meta.palletCount || 1);
      } else {
        segments.push({
          docketKey: explicitKey,
          explicitDocketNumber: meta.explicitDocketNumber,
          hasExplicitDocketNumber: true,
          supplier: meta.supplier || "Steel Fabrication Supplier",
          customerName: meta.customerName,
          deliveryDate: meta.deliveryDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: meta.jobNumber,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: [...meta.validationWarnings],
          separationUncertain: false
        });
      }
      continue;
    }
    const prevSeg = segments[segments.length - 1];
    const rowResetDetected = meta.minRowNo !== void 0 && meta.minRowNo <= 2 && prevSeg.maxRowSeen >= 3;
    const orderChanged = Boolean(meta.orderNumber && prevSeg.orderNumber && meta.orderNumber !== prevSeg.orderNumber);
    const shouldSplitUncertain = Boolean(meta.startsNewDocket || rowResetDetected || orderChanged);
    if (shouldSplitUncertain) {
      if (isGci) {
        const missingKey = `GCI-MISSING-JOB-P${p}-${Math.floor(100 + Math.random() * 900)}`;
        const reason = `Page ${p} appears to start a new GCI docket (${orderChanged ? "Client Order No changed" : rowResetDetected ? "row numbering restarted at 1" : "new header detected"}), but Job No is missing or unreadable. Enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).`;
        prevSeg.separationUncertain = true;
        prevSeg.separationReason = prevSeg.separationReason || "Verify multi-page boundary against adjoining pages.";
        segments.push({
          docketKey: missingKey,
          explicitDocketNumber: "",
          hasExplicitDocketNumber: false,
          supplier: "GCI",
          customerName: meta.customerName || prevSeg.customerName,
          deliveryDate: meta.deliveryDate || prevSeg.deliveryDate,
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: void 0,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: Array.from(/* @__PURE__ */ new Set([...meta.validationWarnings, GCI_MISSING_JOB_NO_WARNING])),
          separationUncertain: true,
          separationReason: reason
        });
      } else {
        const fallbackDk = `DK-REVIEW-${p}-${Math.floor(100 + Math.random() * 900)}`;
        const reason = `Page ${p} appears to start a new docket (${rowResetDetected ? "row numbering restarted at 1" : orderChanged ? "order number changed" : "new header detected"}), but no distinct docket number could be read. Please verify and assign the correct docket number.`;
        prevSeg.separationUncertain = true;
        prevSeg.separationReason = prevSeg.separationReason || "Verify multi-page boundary against adjoining pages.";
        segments.push({
          docketKey: fallbackDk,
          explicitDocketNumber: fallbackDk,
          hasExplicitDocketNumber: false,
          supplier: meta.supplier || prevSeg.supplier,
          customerName: meta.customerName || prevSeg.customerName,
          deliveryDate: meta.deliveryDate || prevSeg.deliveryDate,
          carrier: meta.carrier,
          orderNumber: meta.orderNumber,
          jobNumber: meta.jobNumber,
          palletCount: Math.max(1, meta.palletCount || 1),
          pageNumbers: [p],
          maxRowSeen: meta.maxRowNo || 0,
          rawItems: [...meta.rawItems],
          validationWarnings: [...meta.validationWarnings],
          separationUncertain: true,
          separationReason: reason
        });
      }
    } else {
      prevSeg.pageNumbers.push(p);
      prevSeg.rawItems.push(...meta.rawItems);
      prevSeg.validationWarnings.push(...meta.validationWarnings);
      prevSeg.maxRowSeen = Math.max(prevSeg.maxRowSeen, meta.maxRowNo || 0);
      prevSeg.palletCount = Math.max(prevSeg.palletCount, meta.palletCount || 1);
    }
  }
  const builtDockets = [];
  for (const seg of segments) {
    const segByNo = /* @__PURE__ */ new Map();
    const segUnnumbered = [];
    const segPageMin = /* @__PURE__ */ new Map();
    const segPageMax = /* @__PURE__ */ new Map();
    let segMaxCandidate = 0;
    for (const rawIt of seg.rawItems) {
      const norm = normalizeRawBatchItem(rawIt, seg.pageNumbers[0]);
      if (!norm) continue;
      const numNo = parseInt(norm.cleanNo, 10);
      const itemPage = norm.item.pageNumber || seg.pageNumbers[0];
      if (!Number.isNaN(numNo) && numNo > 0 && numNo <= 1500) {
        if (numNo > segMaxCandidate) segMaxCandidate = numNo;
        segPageMin.set(itemPage, Math.min(segPageMin.get(itemPage) ?? numNo, numNo));
        segPageMax.set(itemPage, Math.max(segPageMax.get(itemPage) ?? numNo, numNo));
        const existing = segByNo.get(numNo);
        if (!existing) {
          segByNo.set(numNo, { ...norm.item, itemNumber: String(numNo) });
        } else if (existing.pageNumber === itemPage) {
          segByNo.set(numNo, {
            ...existing,
            partNumber: existing.partNumber && existing.partNumber !== "PART" ? existing.partNumber : norm.item.partNumber,
            description: norm.item.description.length > existing.description.length ? norm.item.description : existing.description,
            revision: existing.revision || norm.item.revision,
            material: existing.material || norm.item.material,
            thickness: existing.thickness || norm.item.thickness,
            dimensions: existing.dimensions || norm.item.dimensions,
            weight: existing.weight || norm.item.weight,
            quantity: existing.quantity || norm.item.quantity
          });
        } else {
          segUnnumbered.push(norm.item);
        }
      } else {
        segUnnumbered.push(norm.item);
      }
    }
    if (anyPrintedNoColumn && segMaxCandidate > 1 && segMaxCandidate <= 600 && segUnnumbered.length === 0) {
      const missingNos = [];
      for (let n = 1; n <= segMaxCandidate; n++) {
        if (!segByNo.has(n)) missingNos.push(n);
      }
      if (missingNos.length > 0 && missingNos.length <= 60) {
        const missingPerPage = /* @__PURE__ */ new Map();
        for (const mNo of missingNos) {
          let targetP = seg.pageNumbers[0];
          for (const p of seg.pageNumbers) {
            const pMin = segPageMin.get(p) ?? 1;
            const pMax = segPageMax.get(p) ?? segMaxCandidate;
            if (mNo >= pMin && mNo <= pMax) {
              targetP = p;
              break;
            }
          }
          if (!missingPerPage.has(targetP)) missingPerPage.set(targetP, /* @__PURE__ */ new Set());
          missingPerPage.get(targetP).add(mNo);
        }
        const recoveryPayloads = Array.from(missingPerPage.entries()).map(([pNum, set]) => ({
          pageNumber: pNum,
          payload: resolvedPayloads[pNum - 1],
          missingNos: Array.from(set).sort((a, b) => a - b)
        }));
        for (let i = 0; i < recoveryPayloads.length; i += 3) {
          const chunk = recoveryPayloads.slice(i, i + 3);
          const recoveredRaw = await recoverMissingRowsBatch(ai, Type, ThinkingLevel, chunk);
          for (const r of recoveredRaw) {
            const norm = normalizeRawBatchItem(r, chunk[0].pageNumber);
            if (!norm) continue;
            const numNo = parseInt(norm.cleanNo, 10);
            if (!Number.isNaN(numNo) && numNo > 0 && !segByNo.has(numNo)) {
              segByNo.set(numNo, { ...norm.item, itemNumber: String(numNo) });
            }
          }
        }
      }
    }
    const validItems = [];
    const sortedNos = Array.from(segByNo.keys()).sort((a, b) => a - b);
    for (const n of sortedNos) {
      validItems.push(segByNo.get(n));
    }
    let nextSeq = (sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : startItemIndex - 1) + 1;
    for (const unnum of segUnnumbered) {
      validItems.push({ ...unnum, itemNumber: String(nextSeq++) });
    }
    const dedupWarnings = Array.from(new Set(seg.validationWarnings.filter(Boolean)));
    const flaggedCount = validItems.filter((it) => it.confidence === "low").length;
    builtDockets.push({
      docketNumber: seg.explicitDocketNumber,
      supplier: isGci ? "GCI" : seg.supplier,
      customerName: seg.customerName,
      deliveryDate: seg.deliveryDate,
      carrier: seg.carrier,
      orderNumber: seg.orderNumber,
      jobNumber: seg.jobNumber,
      palletCount: seg.palletCount,
      items: validItems,
      confidenceScore: validItems.length > 0 ? seg.separationUncertain || flaggedCount > 0 || isGci && !seg.hasExplicitDocketNumber ? 80 : 100 : 0,
      needsManualReview: validItems.length === 0 || seg.separationUncertain || flaggedCount > 0 || isGci && !seg.hasExplicitDocketNumber,
      separationUncertain: seg.separationUncertain,
      separationReason: seg.separationReason,
      sourcePageNumbers: [...seg.pageNumbers],
      extractionMethod: "gemini-vision",
      extractionEngineLabel: `Gemini (${modelUsed})`,
      aiModelUsed: modelUsed,
      fallbackUsed,
      retryAttempts: totalRetries,
      pagesScanned: seg.pageNumbers.length,
      hasPrintedNoColumn: anyPrintedNoColumn,
      firstVisibleRowNo: sortedNos.length > 0 ? sortedNos[0] : void 0,
      lastVisibleRowNo: sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : void 0,
      flaggedRowCount: flaggedCount,
      validationFlags: dedupWarnings.length > 0 ? dedupWarnings : void 0,
      validationWarnings: dedupWarnings.length > 0 ? dedupWarnings : void 0
    });
  }
  const primary = builtDockets[0] || {
    docketNumber: `DK-${Math.floor(1e4 + Math.random() * 9e4)}`,
    supplier: "Steel Fabrication Supplier",
    deliveryDate: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    palletCount: 1,
    items: [],
    confidenceScore: 0,
    needsManualReview: true,
    extractionMethod: "ai-vision",
    aiModelUsed: modelUsed,
    fallbackUsed,
    retryAttempts: totalRetries,
    pagesScanned: totalPages
  };
  return {
    ...primary,
    pagesScanned: totalPages,
    separatedDockets: builtDockets
  };
}
async function recoverMissingDocketItems(slicePayload, pageNumber, missingNos, overrideApiKey) {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey || !Array.isArray(missingNos) || missingNos.length === 0) {
    return [];
  }
  const { GoogleGenAI, Type, ThinkingLevel } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      },
      timeout: 22e3
    }
  });
  const rawRecovered = await recoverMissingRowsBatch(ai, Type, ThinkingLevel, [
    { pageNumber, payload: slicePayload, missingNos }
  ]);
  const valid = [];
  for (const r of rawRecovered) {
    const norm = normalizeRawBatchItem(r, pageNumber);
    if (!norm) continue;
    const numNo = parseInt(norm.cleanNo, 10);
    if (!Number.isNaN(numNo) && numNo > 0) {
      valid.push({
        ...norm.item,
        itemNumber: String(numNo),
        pageNumber
      });
    }
  }
  return valid;
}
async function extractPartCodeWithGeminiVision(imageDataUrl, knownParts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }
  const { GoogleGenAI, Type, ThinkingLevel } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build"
      },
      timeout: 15e3
    }
  });
  const { mimeType, base64Data } = parseDataUrl(imageDataUrl);
  const knownContext = Array.isArray(knownParts) && knownParts.length > 0 ? `
Active Docket Expected Parts (cross-reference part number or docket "######-<No>" code):
${knownParts.slice(0, 120).map((p) => `- Docket No: ${p.itemNumber} | Part#: ${p.partNumber} (${p.description || ""})`).join("\n")}` : "";
  const promptText = `Examine this industrial part or pallet label photograph and transcribe the literal label details.${knownContext}
Rules:
1. Preserve printed Part Numbers, barcode values (e.g. "482910-3"), or QR text exactly as printed without guessing blurred digits.
2. Extract:
   - detectedCode: primary barcode value, QR text, or Part Number (or "" if unreadable)
   - partNumber: printed Part Number / Drawing No (or "" if none visible)
   - description: part description line if printed (or "")
   - quantity: numeric pallet/label quantity if printed (0 if not explicitly printed)
   - unit: unit like EA, PCS, SET if shown
   - rawText: literal multi-line text visible on the label
   - confidence: "high", "medium", or "low"`;
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      detectedCode: { type: Type.STRING },
      partNumber: { type: Type.STRING },
      description: { type: Type.STRING },
      quantity: { type: Type.NUMBER },
      unit: { type: Type.STRING },
      rawText: { type: Type.STRING },
      confidence: { type: Type.STRING }
    },
    required: ["detectedCode", "rawText", "confidence"]
  };
  const { parsed } = await generateWithRetryAndFallback(
    ai,
    ThinkingLevel,
    [
      { inlineData: { mimeType, data: base64Data } },
      { text: promptText }
    ],
    "Read the barcode, part code, description, quantity, and literal text from the industrial part/pallet label image without fabricating values.",
    responseSchema,
    "label"
  );
  const detectedCode = String(parsed.detectedCode || parsed.partNumber || "").trim();
  const partNumber = parsed.partNumber && String(parsed.partNumber).trim() ? String(parsed.partNumber).trim().toUpperCase() : detectedCode || null;
  const rawQty = Number(parsed.quantity);
  const quantity = !Number.isNaN(rawQty) && rawQty > 0 && rawQty <= 99999 ? Math.round(rawQty) : null;
  return {
    detectedCode,
    partNumber,
    description: parsed.description && String(parsed.description).trim() ? String(parsed.description).trim() : null,
    quantity,
    unit: parsed.unit && String(parsed.unit).trim() ? String(parsed.unit).trim().toUpperCase() : null,
    rawText: String(parsed.rawText || "").trim(),
    confidence: String(parsed.confidence || "high").toLowerCase()
  };
}
var DEFAULT_PRIMARY_VISION_MODEL, DEFAULT_FALLBACK_VISION_MODELS, GEMINI_REQUEST_TIMEOUT_MS, MAX_AUTOMATIC_RETRIES, INITIAL_BACKOFF_MS, OBSOLETE_PRIMARY_MODELS, OBSOLETE_FALLBACK_MODELS, modelQuotaCooldownUntil, MODEL_COOLDOWN_DURATION_MS, MODEL_TRANSIENT_COOLDOWN_MS, DOCKET_EXTRACTION_SYSTEM_INSTRUCTION, GCI_MISSING_JOB_NO_WARNING;
var init_docketOcr = __esm({
  "src/server/docketOcr.ts"() {
    DEFAULT_PRIMARY_VISION_MODEL = "gemini-4-hydrogen";
    DEFAULT_FALLBACK_VISION_MODELS = ["gemini-3.1-flash-lite"];
    GEMINI_REQUEST_TIMEOUT_MS = 22e3;
    MAX_AUTOMATIC_RETRIES = 1;
    INITIAL_BACKOFF_MS = 1800;
    OBSOLETE_PRIMARY_MODELS = /* @__PURE__ */ new Set([
      "gemini-3.8-flash",
      "gemini-1.5-flash",
      "gemini-1.5-pro",
      "gemini-2.0-flash",
      "gemini-pro-vision"
    ]);
    OBSOLETE_FALLBACK_MODELS = /* @__PURE__ */ new Set([
      "gemini-3.8-flash",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-flash-latest",
      "gemini-1.5-flash",
      "gemini-2.0-flash"
    ]);
    modelQuotaCooldownUntil = /* @__PURE__ */ new Map();
    MODEL_COOLDOWN_DURATION_MS = 5 * 60 * 1e3;
    MODEL_TRANSIENT_COOLDOWN_MS = 60 * 1e3;
    DOCKET_EXTRACTION_SYSTEM_INSTRUCTION = `You are a 100%-recall industrial delivery docket, tax invoice, and steel/laser-cutting manifest extraction engine.
Your job is to transcribe EVERY physical part row literally visible across the provided page image(s) and/or extracted PDF text into the JSON 'items' array without skipping or merging any rows.
INDUSTRIAL DOCKET & ANTI-HALLUCINATION RULES:
- Preserve original part numbers (including Laser Central, GCI, and J-series formats), revisions, units, and quantities exactly as printed.
- If a part number wraps across two visual lines inside a narrow column cell, join the continuation text cleanly without adding extra words.
- Never confuse contact phone/fax numbers, ABN numbers, postcodes, dates, bank details, weights (kg), dimensions (mm), or unit prices ($) with part numbers or quantities.
- If a character or digit in a smudged/skewed area is uncertain, record your best literal reading, include the exact raw row snippet in 'originalText', set confidence='low', and explain the uncertainty in 'validationWarnings'. NEVER invent missing rows or guess fabricated codes.
- Only extract physical part rows literally present in the document. If a document is blank or contains no physical part rows, return items: [].`;
    GCI_MISSING_JOB_NO_WARNING = "GCI Job No is missing or unreadable \u2014 verify and enter the printed Job No into Docket / Ref # manually (Client Order No was not substituted).";
  }
});

// server.ts
init_docketOcr();
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import path2 from "path";
import { fileURLToPath } from "url";

// src/server/db/nodeSqliteAdapter.ts
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
var NodeSqlitePreparedStatement = class _NodeSqlitePreparedStatement {
  constructor(stmt, boundValues = []) {
    this.boundValues = [];
    this.stmt = stmt;
    this.boundValues = boundValues;
  }
  bind(...values) {
    return new _NodeSqlitePreparedStatement(this.stmt, values);
  }
  async first(colName) {
    try {
      const row = this.stmt.get(...this.boundValues);
      if (!row) return null;
      if (colName) {
        return row[colName] ?? null;
      }
      return row;
    } catch (err) {
      console.error("NodeSqlitePreparedStatement.first error:", err);
      throw err;
    }
  }
  async run() {
    try {
      const res = this.stmt.run(...this.boundValues);
      return {
        success: true,
        meta: {
          changes: res.changes,
          last_row_id: Number(res.lastInsertRowid)
        }
      };
    } catch (err) {
      console.error("NodeSqlitePreparedStatement.run error:", err);
      throw err;
    }
  }
  async all() {
    try {
      const rows = this.stmt.all(...this.boundValues);
      return {
        success: true,
        results: rows,
        meta: { count: rows.length }
      };
    } catch (err) {
      console.error("NodeSqlitePreparedStatement.all error:", err);
      throw err;
    }
  }
  async raw() {
    const res = await this.all();
    return res.results;
  }
};
var NodeSqliteD1Adapter = class {
  constructor(dbPath, schemaSql) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA journal_mode = WAL;");
    const safeAddCol = (table, colDef) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {
      }
    };
    const runColumnMigrations = () => {
      safeAddCol("users", "employee_code TEXT");
      safeAddCol("users", "pin_salt TEXT");
      safeAddCol("users", "last_login_at TEXT");
      safeAddCol("users", "failed_login_attempts INTEGER NOT NULL DEFAULT 0");
      safeAddCol("users", "locked_until TEXT");
      safeAddCol("users", "created_by TEXT");
      safeAddCol("scan_events", "employee_name TEXT");
      safeAddCol("scan_events", "employee_role TEXT");
      safeAddCol("scan_events", "event_action TEXT DEFAULT 'part_scan'");
      safeAddCol("scan_events", "idempotency_key TEXT");
      safeAddCol("scan_events", "sequence_number INTEGER");
      safeAddCol("deliveries", "version INTEGER NOT NULL DEFAULT 1");
      safeAddCol("delivery_parts", "revision TEXT");
      safeAddCol("delivery_parts", "manually_edited INTEGER NOT NULL DEFAULT 0");
      safeAddCol("delivery_parts", "original_ocr_values TEXT");
      safeAddCol("delivery_parts", "last_edited_by TEXT");
      safeAddCol("delivery_parts", "last_edited_at TEXT");
      safeAddCol("delivery_parts", "version INTEGER NOT NULL DEFAULT 1");
      safeAddCol("delivery_parts", "last_scanned_by_id TEXT");
      safeAddCol("delivery_parts", "last_scanned_by_name TEXT");
    };
    runColumnMigrations();
    if (schemaSql) {
      this.db.exec(schemaSql);
    }
    runColumnMigrations();
    try {
      const tblInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (tblInfo?.sql && tblInfo.sql.includes("CHECK") && (!tblInfo.sql.includes("super_admin") || !tblInfo.sql.includes("supervisor"))) {
        this.db.exec("PRAGMA foreign_keys = OFF;");
        this.db.exec(`
          CREATE TABLE users_new (
            id TEXT PRIMARY KEY,
            employee_name TEXT NOT NULL,
            employee_code TEXT UNIQUE,
            pin_hash TEXT,
            pin_salt TEXT,
            role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('super_admin', 'admin', 'supervisor', 'employee', 'operator')),
            active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
            failed_login_attempts INTEGER NOT NULL DEFAULT 0,
            locked_until TEXT,
            last_login_at TEXT,
            created_by TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO users_new (
            id, employee_name, employee_code, pin_hash, pin_salt, role, active,
            failed_login_attempts, locked_until, last_login_at, created_by, created_at, updated_at
          )
          SELECT
            id, employee_name, employee_code, pin_hash, pin_salt,
            CASE WHEN role IN ('receiver', 'operator') THEN 'employee' ELSE role END,
            active, COALESCE(failed_login_attempts, 0), locked_until, last_login_at, created_by, created_at, updated_at
          FROM users;
          DROP TABLE users;
          ALTER TABLE users_new RENAME TO users;
        `);
        this.db.exec("PRAGMA foreign_keys = ON;");
      }
    } catch {
    }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_activity_at TEXT NOT NULL,
          user_agent TEXT,
          ip_address TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code);
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS idx_scans_user ON scan_events(user_id);
      `);
    } catch {
    }
    const phase5AlterStatements = [
      "ALTER TABLE deliveries ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
      "ALTER TABLE delivery_parts ADD COLUMN version INTEGER NOT NULL DEFAULT 1;",
      "ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_id TEXT;",
      "ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_name TEXT;",
      "ALTER TABLE scan_events ADD COLUMN idempotency_key TEXT;",
      "ALTER TABLE scan_events ADD COLUMN sequence_number INTEGER;"
    ];
    for (const stmt of phase5AlterStatements) {
      try {
        this.db.exec(stmt);
      } catch {
      }
    }
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS realtime_events (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          event_type TEXT NOT NULL,
          delivery_id TEXT,
          part_id TEXT,
          user_id TEXT,
          employee_name TEXT,
          employee_role TEXT,
          delivery_version INTEGER,
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_idempotency ON scan_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_realtime_events_seq ON realtime_events(seq ASC);
        CREATE INDEX IF NOT EXISTS idx_realtime_events_delivery_seq ON realtime_events(delivery_id, seq ASC);
      `);
    } catch {
    }
  }
  prepare(query) {
    const stmt = this.db.prepare(query);
    return new NodeSqlitePreparedStatement(stmt);
  }
  async batch(statements) {
    this.db.exec("BEGIN TRANSACTION;");
    try {
      const results = [];
      for (const st of statements) {
        const res = await st.all();
        results.push(res);
      }
      this.db.exec("COMMIT;");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }
  async exec(query) {
    const start = performance.now();
    this.db.exec(query);
    const duration = performance.now() - start;
    return { count: 1, duration };
  }
};
var singletonInstance = null;
function getLocalDevDatabase(customDbPath) {
  if (!singletonInstance) {
    const rootDir = process.cwd();
    const dbPath = customDbPath || path.resolve(rootDir, ".data", "pallettrack.db");
    const schemaFile = path.resolve(rootDir, "schema.sql");
    let schemaSql = "";
    if (fs.existsSync(schemaFile)) {
      schemaSql = fs.readFileSync(schemaFile, "utf-8");
    }
    singletonInstance = new NodeSqliteD1Adapter(dbPath, schemaSql);
  }
  return singletonInstance;
}

// src/server/auth/crypto.ts
var PBKDF2_ITERATIONS = 1e5;
var PBKDF2_HASH = "SHA-256";
var SALT_BYTE_LENGTH = 16;
var TOKEN_BYTE_LENGTH = 32;
function bufToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}
function hexToBuf(hex) {
  const cleanHex = hex.trim();
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
async function hashPin(pin, existingSaltHex) {
  const enc = new TextEncoder();
  const saltBytes = existingSaltHex ? hexToBuf(existingSaltHex) : crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(pin.trim()),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: PBKDF2_HASH
    },
    keyMaterial,
    256
  );
  return {
    hash: bufToHex(derivedBits),
    salt: bufToHex(saltBytes)
  };
}
async function verifyPin(enteredPin, storedHash, storedSalt) {
  if (!enteredPin || !storedHash || !storedSalt) return false;
  const { hash } = await hashPin(enteredPin, storedSalt);
  return timingSafeEqual(hash, storedHash);
}
function generateSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH));
  return bufToHex(bytes);
}
async function hashSessionToken(token) {
  const enc = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc.encode(token.trim()));
  return bufToHex(hashBuffer);
}
async function verifySetupSecretConstantTime(providedSecret, expectedSecret) {
  const a = (providedSecret || "").trim();
  const b = (expectedSecret || "").trim();
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return timingSafeEqual(bufToHex(hashA), bufToHex(hashB));
}

// src/utils/ignoredQrCodes.ts
var IGNORED_NON_PART_QR_PAYLOADS = [
  "https://www.novacel-solutions.com/qr/46"
];
var IGNORED_NON_PART_QR_PAYLOAD_SET = new Set(IGNORED_NON_PART_QR_PAYLOADS);
function isIgnoredNonPartQrPayload(rawPayload) {
  if (typeof rawPayload !== "string") return false;
  const trimmed = rawPayload.trim();
  if (!trimmed) return false;
  return IGNORED_NON_PART_QR_PAYLOAD_SET.has(trimmed);
}

// src/server/api/palletTrackDbService.ts
var PalletTrackDbService = class _PalletTrackDbService {
  constructor(db) {
    this.db = db;
  }
  /**
   * Helper to format delivery parts from DB row to frontend object
   */
  mapPartRow(row) {
    let parsedOriginalOcr = void 0;
    if (row.original_ocr_values) {
      try {
        parsedOriginalOcr = JSON.parse(row.original_ocr_values);
      } catch {
        parsedOriginalOcr = void 0;
      }
    }
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      partNumber: row.part_number,
      itemNumber: row.item_number,
      docketLineIndex: row.docket_line_index,
      description: row.description,
      revision: row.revision || void 0,
      quantity: row.required_quantity,
      receivedQuantity: row.received_quantity,
      verificationStatus: row.verification_status,
      status: row.status,
      material: row.material || void 0,
      thickness: row.thickness || void 0,
      dimensions: row.dimensions || void 0,
      weight: row.weight || void 0,
      palletNumber: row.pallet_number || void 0,
      scannedAt: row.scanned_at || void 0,
      scannedVia: row.scanned_via || void 0,
      scannedCode: row.scanned_code || void 0,
      lastScannedById: row.last_scanned_by_id || void 0,
      lastScannedByName: row.last_scanned_by_name || void 0,
      notes: row.notes || void 0,
      flaggedForReview: Boolean(row.flagged_for_review),
      ocrConfidence: row.ocr_confidence || void 0,
      manuallyEdited: Boolean(row.manually_edited),
      lastEditedBy: row.last_edited_by || void 0,
      lastEditedAt: row.last_edited_at || void 0,
      originalOcrValues: parsedOriginalOcr,
      version: Number(row.version || 1),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  /**
   * Helper to format scan event from DB row to frontend object
   */
  mapScanRow(row) {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      partId: row.part_id || void 0,
      userId: row.user_id || void 0,
      employeeName: row.employee_name || void 0,
      employeeRole: row.employee_role || void 0,
      eventAction: row.event_action || void 0,
      timestamp: row.timestamp,
      code: row.code,
      codeType: row.scan_type,
      status: row.scan_status,
      quantityAdded: row.quantity_added,
      receivedQuantity: row.received_quantity_after || void 0,
      message: row.scan_result || "",
      rawOcrText: row.raw_ocr_text || void 0
    };
  }
  /**
   * Build chronological multi-user scan attributions for a specific part from scan_events.
   * Ensures subsequent scans by another user NEVER erase prior scanners' attribution.
   */
  buildPartScanAttributions(partId, deliveryScans, partRow) {
    const relevant = deliveryScans.filter(
      (s) => s.part_id === partId && s.scan_status !== "part_added" && s.scan_status !== "part_edited" && s.scan_status !== "part_deleted" && s.scan_status !== "duplicate_blocked"
    ).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const byUser = /* @__PURE__ */ new Map();
    for (const s of relevant) {
      if (s.scan_status === "undo_performed" || Number(s.received_quantity_after) === 0) {
        if (Number(s.received_quantity_after || 0) === 0) {
          byUser.clear();
        }
        continue;
      }
      const empName = (s.employee_name || "").trim() || "Worker";
      const key = s.user_id ? `uid:${s.user_id}` : `name:${empName.toLowerCase()}`;
      const qtyAdded = Number(s.quantity_added) > 0 ? Number(s.quantity_added) : Number(s.received_quantity_after) > 0 && byUser.size === 0 ? Number(s.received_quantity_after) : 0;
      const existing = byUser.get(key);
      if (existing) {
        existing.quantityScanned += qtyAdded;
        existing.lastScannedAt = s.timestamp;
        existing.scanCount += 1;
      } else {
        byUser.set(key, {
          userId: s.user_id || void 0,
          employeeName: empName,
          quantityScanned: qtyAdded,
          lastScannedAt: s.timestamp,
          scanCount: 1
        });
      }
    }
    if (byUser.size === 0 && partRow && (partRow.status === "received" || Number(partRow.received_quantity) > 0) && partRow.last_scanned_by_name) {
      return [
        {
          userId: partRow.last_scanned_by_id || void 0,
          employeeName: partRow.last_scanned_by_name,
          quantityScanned: Number(partRow.received_quantity) || 0,
          lastScannedAt: partRow.scanned_at || partRow.updated_at,
          scanCount: 1
        }
      ];
    }
    return Array.from(byUser.values());
  }
  /**
   * Helper to format delivery header from DB row
   */
  mapDeliveryRow(row, stats, parts = [], scanHistory = []) {
    return {
      id: row.id,
      docketNumber: row.docket_number,
      supplier: row.supplier,
      orderNumber: row.purchase_order_number || void 0,
      purchaseOrderNumber: row.purchase_order_number || void 0,
      deliveryDate: row.delivery_date,
      status: row.delivery_status,
      deliveryStatus: row.delivery_status,
      carrier: row.carrier || void 0,
      palletCount: row.pallet_count,
      supplierProfile: row.supplier_profile || "laser_central",
      notes: row.notes || void 0,
      needsReview: Boolean(row.needs_review),
      separationReason: row.review_reason || void 0,
      version: Number(row.version || 1),
      createdBy: row.created_by || void 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      totalParts: stats?.totalParts ?? parts.length,
      receivedParts: stats?.receivedParts ?? parts.filter((p) => p.status === "received").length,
      verifiedParts: stats?.verifiedParts ?? parts.filter((p) => p.verificationStatus === "verified").length,
      stats: stats || { totalParts: parts.length, receivedParts: 0, verifiedParts: 0 },
      parts,
      scanHistory,
      unexpectedParts: [],
      docketAttachments: []
    };
  }
  /**
   * List all deliveries with aggregated stats, full parts array, and scan attribution
   */
  async listDeliveries() {
    const deliveriesQuery = `
      SELECT d.*,
             COUNT(p.id) AS total_parts,
             SUM(CASE WHEN p.status = 'received' THEN 1 ELSE 0 END) AS received_parts,
             SUM(CASE WHEN p.verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_parts
      FROM deliveries d
      LEFT JOIN delivery_parts p ON d.id = p.delivery_id
      GROUP BY d.id
      ORDER BY d.created_at DESC
    `;
    const res = await this.db.prepare(deliveriesQuery).all();
    const allPartsRes = await this.db.prepare("SELECT * FROM delivery_parts ORDER BY docket_line_index ASC").all();
    const allScansRes = await this.db.prepare("SELECT * FROM scan_events ORDER BY timestamp DESC LIMIT 5000").all();
    const rawScansByDelivery = /* @__PURE__ */ new Map();
    for (const s of allScansRes.results || []) {
      const arr = rawScansByDelivery.get(s.delivery_id) || [];
      arr.push(s);
      rawScansByDelivery.set(s.delivery_id, arr);
    }
    const partsByDelivery = /* @__PURE__ */ new Map();
    for (const p of allPartsRes.results || []) {
      const delScans = rawScansByDelivery.get(p.delivery_id) || [];
      const mapped = {
        ...this.mapPartRow(p),
        scannedByUsers: this.buildPartScanAttributions(p.id, delScans, p)
      };
      const arr = partsByDelivery.get(p.delivery_id) || [];
      arr.push(mapped);
      partsByDelivery.set(p.delivery_id, arr);
    }
    return (res.results || []).map((row) => {
      const parts = partsByDelivery.get(row.id) || [];
      const delScans = (rawScansByDelivery.get(row.id) || []).slice(0, 300).map((s) => this.mapScanRow(s));
      return this.mapDeliveryRow(
        row,
        {
          totalParts: Number(row.total_parts) || parts.length,
          receivedParts: Number(row.received_parts) || parts.filter((p) => p.status === "received").length,
          verifiedParts: Number(row.verified_parts) || parts.filter((p) => p.verificationStatus === "verified").length
        },
        parts,
        delScans
      );
    });
  }
  /**
   * Get single delivery by ID, including parts, attribution, and scan history
   */
  async getDeliveryById(id) {
    const delivery = await this.db.prepare("SELECT * FROM deliveries WHERE id = ?").bind(id).first();
    if (!delivery) return null;
    const partsRes = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC").bind(id).all();
    const scansRes = await this.db.prepare("SELECT * FROM scan_events WHERE delivery_id = ? ORDER BY timestamp DESC LIMIT 500").bind(id).all();
    const rawScans = scansRes.results || [];
    const parts = (partsRes.results || []).map((p) => ({
      ...this.mapPartRow(p),
      scannedByUsers: this.buildPartScanAttributions(p.id, rawScans, p)
    }));
    const scanHistory = rawScans.map((s) => this.mapScanRow(s));
    const totalParts = parts.length;
    const receivedParts = parts.filter((p) => p.status === "received").length;
    const verifiedParts = parts.filter((p) => p.verificationStatus === "verified").length;
    return {
      ...this.mapDeliveryRow(delivery, { totalParts, receivedParts, verifiedParts }, parts, scanHistory),
      parts,
      scanHistory,
      unexpectedParts: [],
      docketAttachments: []
    };
  }
  /**
   * Create a delivery with parts and optional initial scans atomically
   */
  async createDelivery(input) {
    const id = input.id || `del_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const docketNumber = (input.docketNumber || "").trim();
    const supplier = (input.supplier || "Standard Supplier").trim();
    const po = input.purchaseOrderNumber || input.orderNumber || null;
    const deliveryDate = (input.deliveryDate || now.slice(0, 10)).trim();
    const carrier = input.carrier || null;
    const palletCount = Math.max(1, Number(input.palletCount) || 1);
    const supplierProfile = input.supplierProfile || "laser_central";
    const notes = input.notes || null;
    const createdBy = input.createdBy || null;
    if (!docketNumber) {
      throw new Error("docketNumber is required");
    }
    const duplicateDocket = await this.db.prepare("SELECT id, docket_number FROM deliveries WHERE LOWER(TRIM(docket_number)) = LOWER(TRIM(?)) LIMIT 1").bind(docketNumber).first();
    if (duplicateDocket) {
      const dupErr = new Error(
        `Docket #${docketNumber} already exists in the system. Duplicate docket creation is blocked.`
      );
      dupErr.code = "DUPLICATE_DOCKET";
      dupErr.status = 409;
      dupErr.existingDeliveryId = duplicateDocket.id;
      throw dupErr;
    }
    const stmts = [];
    const needsReviewFlag = input.needsReview ? 1 : 0;
    const reviewReason = input.separationReason ? String(input.separationReason).trim() : null;
    stmts.push(
      this.db.prepare(
        `INSERT INTO deliveries (
            id, docket_number, supplier, purchase_order_number, delivery_date,
            delivery_status, carrier, pallet_count, supplier_profile, notes,
            needs_review, review_reason,
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id,
        docketNumber,
        supplier,
        po,
        deliveryDate,
        "receiving",
        carrier,
        palletCount,
        supplierProfile,
        notes,
        needsReviewFlag,
        reviewReason,
        createdBy,
        now,
        now
      )
    );
    const parts = Array.isArray(input.parts) ? input.parts : [];
    parts.forEach((p, idx) => {
      const partId = p.id || `part_${id}_${idx + 1}`;
      const lineIndex = typeof p.docketLineIndex === "number" ? p.docketLineIndex : idx + 1;
      const reqQty = Math.max(0, Math.round(Number(p.quantity ?? 1)));
      const recQty = Math.max(0, Math.round(Number(p.receivedQuantity ?? 0)));
      const status = p.status === "received" || recQty > 0 ? "received" : "outstanding";
      const verStatus = status === "received" ? recQty === reqQty ? "verified" : "quantity_mismatch" : "unscanned";
      const originalOcrObj = p.originalOcrValues || {
        partNumber: p.partNumber.trim().toUpperCase(),
        itemNumber: p.itemNumber.trim(),
        description: p.description.trim(),
        revision: p.revision ? String(p.revision).trim() : void 0,
        quantity: reqQty
      };
      stmts.push(
        this.db.prepare(
          `INSERT INTO delivery_parts (
              id, delivery_id, part_number, item_number, docket_line_index, description, revision,
              required_quantity, received_quantity, verification_status, status,
              material, thickness, dimensions, weight, pallet_number,
              scanned_at, scanned_via, scanned_code, notes, flagged_for_review,
              ocr_confidence, manually_edited, original_ocr_values, last_edited_by, last_edited_at,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          partId,
          id,
          p.partNumber.trim().toUpperCase(),
          p.itemNumber.trim(),
          lineIndex,
          p.description.trim(),
          p.revision ? String(p.revision).trim() : null,
          reqQty,
          recQty,
          verStatus,
          status,
          p.material || null,
          p.thickness || null,
          p.dimensions || null,
          p.weight || null,
          p.palletNumber ? String(p.palletNumber) : null,
          p.scannedAt || null,
          p.scannedVia ? this.normalizeScanType(p.scannedVia) : null,
          p.scannedCode || null,
          p.notes || null,
          p.flaggedForReview ? 1 : 0,
          p.ocrConfidence || null,
          p.manuallyEdited ? 1 : 0,
          JSON.stringify(originalOcrObj),
          p.lastEditedBy || null,
          p.lastEditedAt || null,
          now,
          now
        )
      );
    });
    if (Array.isArray(input.scanHistory)) {
      input.scanHistory.forEach((s) => {
        const scanId = s.id || `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        stmts.push(
          this.db.prepare(
            `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, raw_ocr_text
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            scanId,
            id,
            s.partId || null,
            createdBy,
            s.timestamp || now,
            s.code,
            this.normalizeScanType(s.codeType || "barcode"),
            s.status || "match_success",
            s.quantityAdded ?? 0,
            s.receivedQuantity ?? null,
            s.message || null,
            s.rawOcrText || null
          )
        );
      });
    }
    await this.db.batch(stmts);
    return await this.getDeliveryById(id);
  }
  /**
   * Update delivery header fields (e.g. status, notes, carrier)
   */
  async updateDelivery(id, updates) {
    const existing = await this.db.prepare("SELECT * FROM deliveries WHERE id = ?").bind(id).first();
    if (!existing) {
      throw new Error(`Delivery not found: ${id}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const deliveryStatus = updates.deliveryStatus || updates.status || existing.delivery_status;
    const docketNumber = updates.docketNumber !== void 0 ? updates.docketNumber : existing.docket_number;
    const supplier = updates.supplier !== void 0 ? updates.supplier : existing.supplier;
    const po = updates.purchaseOrderNumber !== void 0 ? updates.purchaseOrderNumber : existing.purchase_order_number;
    const deliveryDate = updates.deliveryDate !== void 0 ? updates.deliveryDate : existing.delivery_date;
    const carrier = updates.carrier !== void 0 ? updates.carrier : existing.carrier;
    const palletCount = updates.palletCount !== void 0 ? updates.palletCount : existing.pallet_count;
    const notes = updates.notes !== void 0 ? updates.notes : existing.notes;
    const needsReview = updates.needsReview !== void 0 ? updates.needsReview ? 1 : 0 : Number(existing.needs_review || 0);
    const reviewReason = updates.separationReason !== void 0 ? updates.separationReason : existing.review_reason ?? null;
    await this.db.prepare(
      `UPDATE deliveries
         SET docket_number = ?, supplier = ?, purchase_order_number = ?, delivery_date = ?,
             delivery_status = ?, carrier = ?, pallet_count = ?, notes = ?,
             needs_review = ?, review_reason = ?,
             version = COALESCE(version, 1) + 1, updated_at = ?
         WHERE id = ?`
    ).bind(
      docketNumber,
      supplier,
      po,
      deliveryDate,
      deliveryStatus,
      carrier,
      palletCount,
      notes,
      needsReview,
      reviewReason,
      now,
      id
    ).run();
    return await this.getDeliveryById(id);
  }
  /**
   * Get all delivery parts for a delivery
   */
  async getDeliveryParts(deliveryId) {
    const res = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC").bind(deliveryId).all();
    return (res.results || []).map((p) => this.mapPartRow(p));
  }
  /**
   * Helper: Determine if an actor has supervisor or administrator privileges
   */
  isSupervisorOrAdmin(role) {
    const r = (role || "").trim().toLowerCase();
    return r === "super_admin" || r === "admin" || r === "supervisor";
  }
  normalizeScanType(raw) {
    const val = (raw || "").trim().toLowerCase();
    if (val === "qr") return "qr";
    if (val === "barcode") return "barcode";
    if (val === "label" || val === "ocr_label") return "ocr_label";
    return "manual";
  }
  /**
   * Determines whether two part entries with the same normalized partNumber represent an
   * accidental duplicate conflict vs. a legitimate multi-line docket split (distinct non-empty
   * Revision or distinct non-empty Pallet allocation).
   */
  isSamePartConflict(existing, incoming) {
    const p1 = String(existing.partNumber || "").trim().toUpperCase();
    const p2 = String(incoming.partNumber || "").trim().toUpperCase();
    if (!p1 || !p2 || p1 !== p2) return false;
    const item1 = String(existing.itemNumber || "").trim();
    const item2 = String(incoming.explicitItemNumber || "").trim();
    if (item1 && item2 && item1 === item2) {
      return true;
    }
    const rev1 = String(existing.revision || "").trim().toUpperCase();
    const rev2 = String(incoming.revision || "").trim().toUpperCase();
    const hasDistinctRevision = rev1 !== "" && rev2 !== "" && rev1 !== rev2;
    const pal1 = String(existing.palletNumber || "").trim().toUpperCase();
    const pal2 = String(incoming.palletNumber || "").trim().toUpperCase();
    const hasDistinctPallet = pal1 !== "" && pal2 !== "" && pal1 !== pal2;
    if (hasDistinctRevision || hasDistinctPallet) {
      return false;
    }
    return true;
  }
  /**
   * Manually add a new part to an existing delivery docket with validation and audit logging
   */
  async addDeliveryPart(deliveryId, input, actor) {
    const delivery = await this.db.prepare("SELECT id, delivery_status FROM deliveries WHERE id = ?").bind(deliveryId).first();
    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }
    const partNumber = String(input.partNumber || "").trim().toUpperCase();
    if (!partNumber) {
      throw new Error("Part Number is required when adding a part.");
    }
    if (partNumber.length > 120) {
      throw new Error("Part Number cannot exceed 120 characters.");
    }
    const rawQty = input.quantity === void 0 || input.quantity === null ? 1 : Number(input.quantity);
    if (!Number.isFinite(rawQty) || rawQty < 1 || rawQty > 1e5) {
      throw new Error("Quantity must be a valid positive number (between 1 and 100,000).");
    }
    const reqQty = Math.max(1, Math.round(rawQty));
    const existingParts = await this.db.prepare(
      "SELECT id, part_number, item_number, docket_line_index, revision, pallet_number FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index DESC"
    ).bind(deliveryId).all();
    const existingList = existingParts.results || [];
    const maxLineIndex = existingList.reduce(
      (max, r) => Math.max(max, Number(r.docket_line_index) || 0),
      0
    );
    const maxItemNum = existingList.reduce((max, r) => {
      const parsed = parseInt(String(r.item_number || "").replace(/\D+/g, ""), 10);
      return Number.isNaN(parsed) ? max : Math.max(max, parsed);
    }, 0);
    const nextIndex = maxLineIndex + 1;
    const explicitItemNumber = String(input.itemNumber || "").trim();
    const itemNumber = explicitItemNumber || String(Math.max(nextIndex, maxItemNum + 1));
    const description = String(input.description || "").trim() || `Part ${partNumber}`;
    const revision = input.revision ? String(input.revision).trim() : null;
    const palletNumber = input.palletNumber !== void 0 && input.palletNumber !== null && String(input.palletNumber).trim() !== "" ? String(input.palletNumber).trim() : null;
    if (!input.allowDuplicatePartNumber) {
      const duplicatePart = existingList.find(
        (r) => this.isSamePartConflict(
          {
            partNumber: r.part_number,
            itemNumber: r.item_number,
            revision: r.revision,
            palletNumber: r.pallet_number
          },
          {
            partNumber,
            explicitItemNumber,
            revision,
            palletNumber
          }
        )
      );
      if (duplicatePart) {
        throw new Error(
          `Duplicate part number "${partNumber}" already exists in this delivery (Docket No. ${duplicatePart.item_number}). Specify a distinct Revision or Pallet Number for multi-line parts, or edit the existing part row.`
        );
      }
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const partId = input.id || `part_${deliveryId}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const actorName = actor?.employeeName || "Authorized User";
    const actorId = actor?.id || null;
    const actorRole = actor?.role || "supervisor";
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const auditMessage = `Manually added part ${partNumber} (No. ${itemNumber}${revision ? `, Rev ${revision}` : ""}) \u2014 "${description}" (Qty ${reqQty}) by ${actorName}`;
    const stmts = [
      this.db.prepare(
        `INSERT INTO delivery_parts (
            id, delivery_id, part_number, item_number, docket_line_index, description, revision,
            required_quantity, received_quantity, verification_status, status,
            material, thickness, dimensions, weight, pallet_number,
            notes, manually_edited, original_ocr_values, last_edited_by, last_edited_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unscanned', 'outstanding', ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`
      ).bind(
        partId,
        deliveryId,
        partNumber,
        itemNumber,
        nextIndex,
        description,
        revision,
        reqQty,
        input.material ? String(input.material).trim() : null,
        input.thickness ? String(input.thickness).trim() : null,
        input.dimensions ? String(input.dimensions).trim() : null,
        input.weight ? String(input.weight).trim() : null,
        input.palletNumber ? String(input.palletNumber).trim() : null,
        input.notes ? String(input.notes).trim() : null,
        actorName,
        now,
        now,
        now
      ),
      this.db.prepare(
        `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, employee_name, employee_role, event_action
          ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_added', ?, 0, ?, ?, ?, 'part_added')`
      ).bind(scanId, deliveryId, partId, actorId, now, partNumber, reqQty, auditMessage, actorName, actorRole),
      this.db.prepare("UPDATE deliveries SET delivery_status = 'receiving', version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?").bind(now, deliveryId)
    ];
    await this.db.batch(stmts);
    const createdPartRow = await this.db.prepare("SELECT * FROM delivery_parts WHERE id = ?").bind(partId).first();
    const updatedDelivery = await this.getDeliveryById(deliveryId);
    return {
      status: "added",
      part: createdPartRow ? this.mapPartRow(createdPartRow) : null,
      delivery: updatedDelivery
    };
  }
  /**
   * Manually edit an existing part on a delivery docket.
   * Preserves original OCR values, keeps scanning/verification status consistent if already scanned,
   * enforces supervisor/admin RBAC when modifying already-scanned parts, and records an audit event in scan_events.
   */
  async updateDeliveryPart(deliveryId, partId, updates, actor) {
    const existing = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId).first();
    if (!existing) {
      throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
    }
    const recQty = Math.max(0, Number(existing.received_quantity) || 0);
    const hasScanEventsRes = await this.db.prepare(
      "SELECT COUNT(*) as count FROM scan_events WHERE delivery_id = ? AND part_id = ? AND scan_status NOT IN ('part_added', 'part_edited', 'part_deleted')"
    ).bind(deliveryId, partId).first();
    const hasScanHistory = Number(hasScanEventsRes?.count || 0) > 0;
    const isScanned = existing.status === "received" || recQty > 0 || hasScanHistory;
    if (isScanned && actor && !this.isSupervisorOrAdmin(actor.role) && !updates.supervisorApproved) {
      throw new Error(
        "Forbidden: Supervisor or Administrator approval is required to edit a part that has already been scanned."
      );
    }
    const newPartNumber = updates.partNumber !== void 0 ? String(updates.partNumber).trim().toUpperCase() : existing.part_number;
    if (!newPartNumber) {
      throw new Error("Part Number cannot be empty.");
    }
    if (newPartNumber.length > 120) {
      throw new Error("Part Number cannot exceed 120 characters.");
    }
    const newItemNumber = updates.itemNumber !== void 0 ? String(updates.itemNumber).trim() || existing.item_number : existing.item_number;
    const newDescription = updates.description !== void 0 ? String(updates.description).trim() : existing.description;
    const newRevision = updates.revision !== void 0 ? updates.revision ? String(updates.revision).trim() : null : existing.revision || null;
    const effectivePalletForDup = updates.palletNumber !== void 0 ? updates.palletNumber !== null && String(updates.palletNumber).trim() !== "" ? String(updates.palletNumber).trim() : null : existing.pallet_number || null;
    if (!updates.allowDuplicatePartNumber && (newPartNumber !== existing.part_number || (newRevision || "") !== (existing.revision || "") || (effectivePalletForDup || "") !== (existing.pallet_number || ""))) {
      const otherRowsRes = await this.db.prepare(
        "SELECT id, part_number, item_number, revision, pallet_number FROM delivery_parts WHERE delivery_id = ? AND id != ? AND UPPER(part_number) = ?"
      ).bind(deliveryId, partId, newPartNumber).all();
      const duplicateRow = (otherRowsRes.results || []).find(
        (r) => this.isSamePartConflict(
          {
            partNumber: r.part_number,
            itemNumber: r.item_number,
            revision: r.revision,
            palletNumber: r.pallet_number
          },
          {
            partNumber: newPartNumber,
            explicitItemNumber: updates.itemNumber !== void 0 ? newItemNumber : null,
            revision: newRevision,
            palletNumber: effectivePalletForDup
          }
        )
      );
      if (duplicateRow) {
        throw new Error(
          `Duplicate part number "${newPartNumber}" already exists in this delivery (Docket No. ${duplicateRow.item_number}). Specify a distinct Revision or Pallet Number for multi-line parts.`
        );
      }
    }
    let newReqQty = existing.required_quantity;
    if (updates.quantity !== void 0 && updates.quantity !== null) {
      const parsedQty = Number(updates.quantity);
      if (!Number.isFinite(parsedQty) || parsedQty < 1 || parsedQty > 1e5) {
        throw new Error("Quantity must be a positive number (between 1 and 100,000).");
      }
      newReqQty = Math.max(1, Math.round(parsedQty));
    }
    const newMaterial = updates.material !== void 0 ? updates.material ? String(updates.material).trim() : null : existing.material;
    const newThickness = updates.thickness !== void 0 ? updates.thickness ? String(updates.thickness).trim() : null : existing.thickness;
    const newDimensions = updates.dimensions !== void 0 ? updates.dimensions ? String(updates.dimensions).trim() : null : existing.dimensions;
    const newWeight = updates.weight !== void 0 ? updates.weight ? String(updates.weight).trim() : null : existing.weight;
    const newPalletNumber = updates.palletNumber !== void 0 ? updates.palletNumber !== null && String(updates.palletNumber).trim() !== "" ? String(updates.palletNumber).trim() : null : existing.pallet_number;
    const newNotes = updates.notes !== void 0 ? updates.notes ? String(updates.notes).trim() : null : existing.notes;
    let originalOcrJson = existing.original_ocr_values;
    if (!originalOcrJson) {
      originalOcrJson = JSON.stringify({
        partNumber: existing.part_number,
        itemNumber: existing.item_number,
        description: existing.description,
        revision: existing.revision || void 0,
        quantity: existing.required_quantity
      });
    }
    const changesSummary = [];
    if (newPartNumber !== existing.part_number) {
      changesSummary.push(`Part#: ${existing.part_number} \u2192 ${newPartNumber}`);
    }
    if (newItemNumber !== existing.item_number) {
      changesSummary.push(`No: ${existing.item_number} \u2192 ${newItemNumber}`);
    }
    if (newDescription !== existing.description) {
      changesSummary.push(`Desc: "${existing.description}" \u2192 "${newDescription}"`);
    }
    if ((newRevision || "") !== (existing.revision || "")) {
      changesSummary.push(`Rev: ${existing.revision || "\u2014"} \u2192 ${newRevision || "\u2014"}`);
    }
    if (newReqQty !== existing.required_quantity) {
      changesSummary.push(
        `Qty: ${existing.required_quantity} \u2192 ${newReqQty}${recQty > 0 ? ` (Received: ${recQty})` : ""}`
      );
    }
    if ((newPalletNumber || "") !== (existing.pallet_number || "")) {
      changesSummary.push(`Pallet: ${existing.pallet_number || "\u2014"} \u2192 ${newPalletNumber || "\u2014"}`);
    }
    if ((newMaterial || "") !== (existing.material || "")) {
      changesSummary.push(`Mat: ${existing.material || "\u2014"} \u2192 ${newMaterial || "\u2014"}`);
    }
    if ((newThickness || "") !== (existing.thickness || "")) {
      changesSummary.push(`Thk: ${existing.thickness || "\u2014"} \u2192 ${newThickness || "\u2014"}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const actorName = actor?.employeeName || "Authorized User";
    const actorId = actor?.id || null;
    const actorRole = actor?.role || "supervisor";
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const auditMessage = changesSummary.length > 0 ? `Manually edited part ${newPartNumber} (No. ${newItemNumber}): ${changesSummary.join("; ")} by ${actorName}` : `Saved part ${newPartNumber} (No. ${newItemNumber}) by ${actorName}`;
    const stmts = [
      this.db.prepare(
        `UPDATE delivery_parts
           SET part_number = ?, item_number = ?, description = ?, revision = ?,
               required_quantity = ?,
               status = CASE WHEN status = 'received' OR received_quantity > 0 THEN 'received' ELSE 'outstanding' END,
               verification_status = CASE
                 WHEN status = 'received' OR received_quantity > 0 THEN
                   CASE WHEN received_quantity = ? THEN 'verified' ELSE 'quantity_mismatch' END
                 ELSE 'unscanned'
               END,
               material = ?, thickness = ?, dimensions = ?, weight = ?, pallet_number = ?,
               notes = ?, manually_edited = 1, original_ocr_values = ?,
               last_edited_by = ?, last_edited_at = ?, updated_at = ?,
               version = COALESCE(version, 1) + 1
           WHERE delivery_id = ? AND id = ?`
      ).bind(
        newPartNumber,
        newItemNumber,
        newDescription,
        newRevision,
        newReqQty,
        newReqQty,
        newMaterial,
        newThickness,
        newDimensions,
        newWeight,
        newPalletNumber,
        newNotes,
        originalOcrJson,
        actorName,
        now,
        now,
        deliveryId,
        partId
      ),
      this.db.prepare(
        `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, employee_name, employee_role, event_action
          ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_edited', 0, ?, ?, ?, ?, 'part_edited')`
      ).bind(
        scanId,
        deliveryId,
        partId,
        actorId,
        now,
        newPartNumber,
        recQty,
        auditMessage,
        actorName,
        actorRole
      ),
      this.db.prepare(
        `UPDATE deliveries
           SET delivery_status = CASE
             WHEN EXISTS (
               SELECT 1 FROM delivery_parts
               WHERE delivery_id = ? AND (status != 'received' OR verification_status != 'verified')
             ) THEN 'receiving'
             ELSE delivery_status
           END,
           updated_at = ?,
           version = COALESCE(version, 1) + 1
           WHERE id = ?`
      ).bind(deliveryId, now, deliveryId)
    ];
    await this.db.batch(stmts);
    const updatedPartRow = await this.db.prepare("SELECT * FROM delivery_parts WHERE id = ?").bind(partId).first();
    const updatedDelivery = await this.getDeliveryById(deliveryId);
    return {
      status: "updated",
      part: updatedPartRow ? this.mapPartRow(updatedPartRow) : null,
      delivery: updatedDelivery
    };
  }
  /**
   * Delete a part from a delivery docket and record an audit trail entry in scan_events.
   * Historical scan events for the deleted part remain intact (part_id set to NULL).
   */
  async deleteDeliveryPart(deliveryId, partId, actor, options) {
    const existing = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId).first();
    if (!existing) {
      throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
    }
    const recQty = Math.max(0, Number(existing.received_quantity) || 0);
    const hasScanEventsRes = await this.db.prepare(
      "SELECT COUNT(*) as count FROM scan_events WHERE delivery_id = ? AND part_id = ? AND scan_status NOT IN ('part_added', 'part_edited', 'part_deleted')"
    ).bind(deliveryId, partId).first();
    const hasScanHistory = Number(hasScanEventsRes?.count || 0) > 0;
    const isScanned = existing.status === "received" || recQty > 0 || hasScanHistory;
    if (isScanned && actor && !this.isSupervisorOrAdmin(actor.role) && !options?.supervisorApproved) {
      throw new Error(
        "Forbidden: Supervisor or Administrator approval is required to delete a part that has already been scanned."
      );
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const actorName = actor?.employeeName || "Authorized User";
    const actorId = actor?.id || null;
    const actorRole = actor?.role || "supervisor";
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const wasScannedNote = isScanned ? ` [Was already scanned: ${recQty}/${existing.required_quantity}]` : "";
    const auditMessage = `Deleted part ${existing.part_number} (No. ${existing.item_number}${existing.revision ? `, Rev ${existing.revision}` : ""}) \u2014 "${existing.description}" (Qty ${existing.required_quantity})${wasScannedNote} by ${actorName}`;
    const stmts = [
      this.db.prepare("UPDATE scan_events SET part_id = NULL WHERE delivery_id = ? AND part_id = ?").bind(deliveryId, partId),
      this.db.prepare("DELETE FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId),
      this.db.prepare(
        `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, employee_name, employee_role, event_action
          ) VALUES (?, ?, NULL, ?, ?, ?, 'manual', 'part_deleted', 0, ?, ?, ?, ?, 'part_deleted')`
      ).bind(scanId, deliveryId, actorId, now, existing.part_number, recQty, auditMessage, actorName, actorRole),
      this.db.prepare("UPDATE deliveries SET version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?").bind(now, deliveryId)
    ];
    await this.db.batch(stmts);
    const updatedDelivery = await this.getDeliveryById(deliveryId);
    return {
      status: "deleted",
      deletedPartId: partId,
      delivery: updatedDelivery
    };
  }
  /**
   * Batch save an entire delivery's parts list atomically in a single D1 transaction
   * (supports multi-row inline edits, additions, and deletions).
   */
  async batchSaveDeliveryParts(deliveryId, partsInput, actor) {
    const delivery = await this.db.prepare("SELECT id FROM deliveries WHERE id = ?").bind(deliveryId).first();
    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }
    if (!Array.isArray(partsInput)) {
      throw new Error("parts array is required");
    }
    const existingRowsRes = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC").bind(deliveryId).all();
    const existingRows = existingRowsRes.results || [];
    const existingById = new Map(existingRows.map((r) => [r.id, r]));
    const incomingIds = /* @__PURE__ */ new Set();
    const validatedBatchItems = [];
    for (let i = 0; i < partsInput.length; i++) {
      const p = partsInput[i];
      const cleanPartNo = String(p?.partNumber || "").trim().toUpperCase();
      if (!cleanPartNo) {
        throw new Error(`Row ${i + 1}: All parts must have a non-empty Part Number.`);
      }
      if (cleanPartNo.length > 120) {
        throw new Error(`Row ${i + 1}: Part Number cannot exceed 120 characters.`);
      }
      const q = Number(p.quantity ?? 1);
      if (!Number.isFinite(q) || q < 1 || q > 1e5) {
        throw new Error(
          `Row ${i + 1}: Invalid quantity for part ${cleanPartNo}: must be between 1 and 100,000.`
        );
      }
      const normRev = p.revision ? String(p.revision).trim() : null;
      const normPallet = p.palletNumber !== void 0 && p.palletNumber !== null && String(p.palletNumber).trim() !== "" ? String(p.palletNumber).trim() : null;
      if (!p.allowDuplicatePartNumber) {
        const conflict = validatedBatchItems.find(
          (prev) => this.isSamePartConflict(prev, {
            partNumber: cleanPartNo,
            explicitItemNumber: p.itemNumber ? String(p.itemNumber).trim() : null,
            revision: normRev,
            palletNumber: normPallet
          })
        );
        if (conflict) {
          throw new Error(
            `Duplicate part number "${cleanPartNo}" found in the parts list. Specify a distinct Revision or Pallet Number for multi-line parts, or combine quantities.`
          );
        }
      }
      validatedBatchItems.push({
        partNumber: cleanPartNo,
        itemNumber: p.itemNumber ? String(p.itemNumber).trim() : null,
        revision: normRev,
        palletNumber: normPallet
      });
      if (p.id) incomingIds.add(p.id);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const actorName = actor?.employeeName || "Authorized User";
    const actorId = actor?.id || null;
    const actorRole = actor?.role || "supervisor";
    const isSupOrAdmin = this.isSupervisorOrAdmin(actor?.role);
    const stmts = [];
    for (const existing of existingRows) {
      if (!incomingIds.has(existing.id)) {
        const recQty = Math.max(0, Number(existing.received_quantity) || 0);
        const isScanned = existing.status === "received" || recQty > 0;
        if (isScanned && actor && !isSupOrAdmin) {
          throw new Error(
            `Forbidden: Supervisor or Administrator approval is required to delete scanned part ${existing.part_number}.`
          );
        }
        const scanId = `ev_${Date.now()}_del_${Math.random().toString(36).slice(2, 6)}`;
        const wasScannedNote = isScanned ? ` [Was already scanned: ${recQty}/${existing.required_quantity}]` : "";
        const auditMessage = `Deleted part ${existing.part_number} (No. ${existing.item_number}${existing.revision ? `, Rev ${existing.revision}` : ""}) \u2014 "${existing.description}" (Qty ${existing.required_quantity})${wasScannedNote} by ${actorName}`;
        stmts.push(
          this.db.prepare("UPDATE scan_events SET part_id = NULL WHERE delivery_id = ? AND part_id = ?").bind(deliveryId, existing.id),
          this.db.prepare("DELETE FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, existing.id),
          this.db.prepare(
            `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, employee_name, employee_role, event_action
              ) VALUES (?, ?, NULL, ?, ?, ?, 'manual', 'part_deleted', 0, ?, ?, ?, ?, 'part_deleted')`
          ).bind(scanId, deliveryId, actorId, now, existing.part_number, recQty, auditMessage, actorName, actorRole)
        );
      }
    }
    for (let idx = 0; idx < partsInput.length; idx++) {
      const item = partsInput[idx];
      const existing = item.id ? existingById.get(item.id) : void 0;
      if (existing) {
        const cleanPartNo = String(item.partNumber).trim().toUpperCase();
        const cleanItemNo = String(item.itemNumber ?? existing.item_number).trim() || existing.item_number;
        const cleanDesc = String(item.description ?? existing.description).trim();
        const cleanRev = item.revision ? String(item.revision).trim() : null;
        const cleanQty = Math.max(1, Math.round(Number(item.quantity ?? existing.required_quantity)));
        const cleanPallet = item.palletNumber !== void 0 && item.palletNumber !== null && String(item.palletNumber).trim() !== "" ? String(item.palletNumber).trim() : null;
        const cleanMat = item.material ? String(item.material).trim() : null;
        const cleanThk = item.thickness ? String(item.thickness).trim() : null;
        const cleanDim = item.dimensions ? String(item.dimensions).trim() : existing.dimensions;
        const cleanWt = item.weight ? String(item.weight).trim() : existing.weight;
        const cleanNotes = item.notes !== void 0 ? item.notes ? String(item.notes).trim() : null : existing.notes;
        const hasChanged = cleanPartNo !== existing.part_number || cleanItemNo !== existing.item_number || cleanDesc !== existing.description || (cleanRev || "") !== (existing.revision || "") || cleanQty !== existing.required_quantity || (cleanPallet || "") !== (existing.pallet_number || "") || (cleanMat || "") !== (existing.material || "") || (cleanThk || "") !== (existing.thickness || "");
        if (hasChanged) {
          const recQty = Math.max(0, Number(existing.received_quantity) || 0);
          const isScanned = existing.status === "received" || recQty > 0;
          if (isScanned && actor && !isSupOrAdmin && !item.supervisorApproved) {
            throw new Error(
              `Forbidden: Supervisor or Administrator approval is required to edit scanned part ${existing.part_number}.`
            );
          }
          let originalOcrJson = existing.original_ocr_values;
          if (!originalOcrJson) {
            originalOcrJson = JSON.stringify({
              partNumber: existing.part_number,
              itemNumber: existing.item_number,
              description: existing.description,
              revision: existing.revision || void 0,
              quantity: existing.required_quantity
            });
          }
          const changesSummary = [];
          if (cleanPartNo !== existing.part_number) changesSummary.push(`Part#: ${existing.part_number} \u2192 ${cleanPartNo}`);
          if (cleanItemNo !== existing.item_number) changesSummary.push(`No: ${existing.item_number} \u2192 ${cleanItemNo}`);
          if (cleanDesc !== existing.description) changesSummary.push(`Desc: "${existing.description}" \u2192 "${cleanDesc}"`);
          if ((cleanRev || "") !== (existing.revision || "")) changesSummary.push(`Rev: ${existing.revision || "\u2014"} \u2192 ${cleanRev || "\u2014"}`);
          if (cleanQty !== existing.required_quantity) {
            changesSummary.push(
              `Qty: ${existing.required_quantity} \u2192 ${cleanQty}${recQty > 0 ? ` (Received: ${recQty})` : ""}`
            );
          }
          if ((cleanPallet || "") !== (existing.pallet_number || "")) changesSummary.push(`Pallet: ${existing.pallet_number || "\u2014"} \u2192 ${cleanPallet || "\u2014"}`);
          if ((cleanMat || "") !== (existing.material || "")) changesSummary.push(`Mat: ${existing.material || "\u2014"} \u2192 ${cleanMat || "\u2014"}`);
          if ((cleanThk || "") !== (existing.thickness || "")) changesSummary.push(`Thk: ${existing.thickness || "\u2014"} \u2192 ${cleanThk || "\u2014"}`);
          const scanId = `ev_${Date.now()}_upd_${idx}_${Math.random().toString(36).slice(2, 6)}`;
          const auditMessage = `Manually edited part ${cleanPartNo} (No. ${cleanItemNo}): ${changesSummary.join("; ")} by ${actorName}`;
          stmts.push(
            this.db.prepare(
              `UPDATE delivery_parts
                 SET part_number = ?, item_number = ?, description = ?, revision = ?,
                     required_quantity = ?,
                     status = CASE WHEN status = 'received' OR received_quantity > 0 THEN 'received' ELSE 'outstanding' END,
                     verification_status = CASE
                       WHEN status = 'received' OR received_quantity > 0 THEN
                         CASE WHEN received_quantity = ? THEN 'verified' ELSE 'quantity_mismatch' END
                       ELSE 'unscanned'
                     END,
                     material = ?, thickness = ?, dimensions = ?, weight = ?, pallet_number = ?,
                     notes = ?, manually_edited = 1, original_ocr_values = ?,
                     last_edited_by = ?, last_edited_at = ?, updated_at = ?
                 WHERE delivery_id = ? AND id = ?`
            ).bind(
              cleanPartNo,
              cleanItemNo,
              cleanDesc,
              cleanRev,
              cleanQty,
              cleanQty,
              cleanMat,
              cleanThk,
              cleanDim,
              cleanWt,
              cleanPallet,
              cleanNotes,
              originalOcrJson,
              actorName,
              now,
              now,
              deliveryId,
              existing.id
            ),
            this.db.prepare(
              `INSERT INTO scan_events (
                  id, delivery_id, part_id, user_id, timestamp, code,
                  scan_type, scan_status, quantity_added, received_quantity_after,
                  scan_result, employee_name, employee_role, event_action
                ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_edited', 0, ?, ?, ?, ?, 'part_edited')`
            ).bind(scanId, deliveryId, existing.id, actorId, now, cleanPartNo, recQty, auditMessage, actorName, actorRole)
          );
        }
      } else {
        const cleanPartNo = String(item.partNumber).trim().toUpperCase();
        const cleanItemNo = String(item.itemNumber || idx + 1).trim();
        const cleanDesc = String(item.description || "").trim() || `Part ${cleanPartNo}`;
        const cleanRev = item.revision ? String(item.revision).trim() : null;
        const cleanQty = Math.max(1, Math.round(Number(item.quantity ?? 1)));
        const partId = item.id || `part_${deliveryId}_manual_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const scanId = `ev_${Date.now()}_add_${idx}_${Math.random().toString(36).slice(2, 6)}`;
        const auditMessage = `Manually added part ${cleanPartNo} (No. ${cleanItemNo}${cleanRev ? `, Rev ${cleanRev}` : ""}) \u2014 "${cleanDesc}" (Qty ${cleanQty}) by ${actorName}`;
        stmts.push(
          this.db.prepare(
            `INSERT INTO delivery_parts (
                id, delivery_id, part_number, item_number, docket_line_index, description, revision,
                required_quantity, received_quantity, verification_status, status,
                material, thickness, dimensions, weight, pallet_number,
                notes, manually_edited, original_ocr_values, last_edited_by, last_edited_at,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'unscanned', 'outstanding', ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`
          ).bind(
            partId,
            deliveryId,
            cleanPartNo,
            cleanItemNo,
            idx + 1,
            cleanDesc,
            cleanRev,
            cleanQty,
            item.material ? String(item.material).trim() : null,
            item.thickness ? String(item.thickness).trim() : null,
            item.dimensions ? String(item.dimensions).trim() : null,
            item.weight ? String(item.weight).trim() : null,
            item.palletNumber ? String(item.palletNumber).trim() : null,
            item.notes ? String(item.notes).trim() : null,
            actorName,
            now,
            now,
            now
          ),
          this.db.prepare(
            `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, employee_name, employee_role, event_action
              ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'part_added', ?, 0, ?, ?, ?, 'part_added')`
          ).bind(scanId, deliveryId, partId, actorId, now, cleanPartNo, cleanQty, auditMessage, actorName, actorRole)
        );
      }
    }
    if (stmts.length > 0) {
      stmts.push(
        this.db.prepare(
          `UPDATE deliveries
             SET delivery_status = CASE
               WHEN EXISTS (
                 SELECT 1 FROM delivery_parts
                 WHERE delivery_id = ? AND (status != 'received' OR verification_status != 'verified')
               ) THEN 'receiving'
               ELSE delivery_status
             END,
             version = COALESCE(version, 1) + 1,
             updated_at = ?
             WHERE id = ?`
        ).bind(deliveryId, now, deliveryId)
      );
      await this.db.batch(stmts);
    }
    const updatedDelivery = await this.getDeliveryById(deliveryId);
    return {
      status: "batch_saved",
      delivery: updatedDelivery
    };
  }
  static {
    this.partReceiveLocks = /* @__PURE__ */ new Map();
  }
  /**
   * Update received quantity for a specific part with atomic scan logging,
   * idempotency key deduplication, per-part concurrency serialization, and
   * strict SQL-level race-condition protection.
   */
  async updatePartReceivedQuantity(deliveryId, partId, input) {
    const lockKey = `${deliveryId}:${partId}`;
    const prevLock = _PalletTrackDbService.partReceiveLocks.get(lockKey) || Promise.resolve();
    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    _PalletTrackDbService.partReceiveLocks.set(
      lockKey,
      prevLock.then(() => currentLock).catch(() => currentLock)
    );
    await prevLock.catch(() => {
    });
    try {
      return await this.executeUpdatePartReceivedQuantityAtomic(deliveryId, partId, input);
    } finally {
      releaseLock();
      if (_PalletTrackDbService.partReceiveLocks.get(lockKey) === currentLock) {
        _PalletTrackDbService.partReceiveLocks.delete(lockKey);
      }
    }
  }
  /**
   * Delete a delivery and its associated parts, scan events, M1 sync rows, and docket group links atomically
   */
  async deleteDelivery(id) {
    await this.ensureSchemaReady();
    const existing = await this.db.prepare("SELECT id, docket_number, delivery_status FROM deliveries WHERE id = ?").bind(id).first();
    if (!existing) {
      return { deleted: false, id };
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM docket_group_items WHERE delivery_id = ?").bind(id),
      this.db.prepare("DELETE FROM scan_events WHERE delivery_id = ?").bind(id),
      this.db.prepare("DELETE FROM delivery_parts WHERE delivery_id = ?").bind(id),
      this.db.prepare("DELETE FROM m1_synchronisations WHERE delivery_id = ?").bind(id),
      this.db.prepare("DELETE FROM deliveries WHERE id = ?").bind(id)
    ]);
    return {
      deleted: true,
      id,
      docketNumber: existing.docket_number,
      previousStatus: existing.delivery_status
    };
  }
  /**
   * Clear ALL delivery dockets, parts, scan events, M1 sync records, and docket groups
   * while preserving users, active sessions, and configuration.
   */
  async clearAllDeliveries() {
    await this.ensureSchemaReady();
    const countRow = await this.db.prepare("SELECT COUNT(*) as count FROM deliveries").first();
    const groupCountRow = await this.db.prepare("SELECT COUNT(*) as count FROM docket_groups").first();
    await this.db.batch([
      this.db.prepare("DELETE FROM docket_group_items"),
      this.db.prepare("DELETE FROM docket_groups"),
      this.db.prepare("DELETE FROM scan_events"),
      this.db.prepare("DELETE FROM delivery_parts"),
      this.db.prepare("DELETE FROM m1_synchronisations"),
      this.db.prepare("DELETE FROM deliveries")
    ]);
    return {
      cleared: true,
      deletedDeliveriesCount: Number(countRow?.count || 0),
      deletedGroupsCount: Number(groupCountRow?.count || 0)
    };
  }
  async executeUpdatePartReceivedQuantityAtomic(deliveryId, partId, input) {
    await this.ensureSchemaReady();
    const cleanIdempotencyKey = typeof input.idempotencyKey === "string" && input.idempotencyKey.trim() ? input.idempotencyKey.trim().slice(0, 128) : null;
    const enteredQty = Number(input.receivedQuantity);
    if (Number.isNaN(enteredQty) || enteredQty < 0) {
      throw new Error("Received quantity cannot be negative or invalid");
    }
    const MAX_CAS_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
      if (cleanIdempotencyKey) {
        const existingScan = await this.db.prepare("SELECT * FROM scan_events WHERE idempotency_key = ? LIMIT 1").bind(cleanIdempotencyKey).first();
        if (existingScan) {
          const currentPart = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId).first();
          const currentDelivery = await this.db.prepare("SELECT version FROM deliveries WHERE id = ?").bind(deliveryId).first();
          const partScansRes2 = await this.db.prepare("SELECT * FROM scan_events WHERE delivery_id = ? AND part_id = ? ORDER BY timestamp ASC").bind(deliveryId, partId).all();
          const scannedByUsers2 = this.buildPartScanAttributions(
            partId,
            partScansRes2.results || [],
            currentPart || void 0
          );
          return {
            duplicate: false,
            idempotentReplay: true,
            status: "updated",
            deliveryVersion: Number(currentDelivery?.version || 1),
            part: currentPart ? {
              ...this.mapPartRow(currentPart),
              scannedByUsers: scannedByUsers2
            } : null,
            scanEvent: this.mapScanRow(existingScan)
          };
        }
      }
      const part = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId).first();
      if (!part) {
        throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const reqQty = Math.max(0, part.required_quantity);
      const currentRecQty = Math.max(0, Number(part.received_quantity) || 0);
      const currentVersion = Number(part.version || 1);
      const isIncrementMode = input.mode === "increment";
      const isScanAttempt = input.scannedVia !== "manual";
      const recQty = isIncrementMode ? currentRecQty + Math.round(enteredQty) : Math.round(enteredQty);
      const targetStatus = input.status || (recQty > 0 ? "received" : "outstanding");
      const isAlreadyFulfilled = part.status === "received" && currentRecQty >= reqQty && reqQty > 0;
      const isRedundantSameScan = isScanAttempt && part.status === "received" && targetStatus === "received" && currentRecQty > 0 && (!isIncrementMode && recQty <= currentRecQty);
      if (isScanAttempt && targetStatus === "received" && (isAlreadyFulfilled || isRedundantSameScan)) {
        const alreadyScannedBy = part.last_scanned_by_name || "Another worker";
        const alreadyScannedAt = part.scanned_at || part.updated_at;
        const dupScanId = `ev_dup_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const dupMsg = `Duplicate scan \u2013 part ${part.part_number} (No. ${part.item_number}) has already been received by ${alreadyScannedBy}`;
        try {
          await this.db.prepare(
            `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, employee_name, employee_role, event_action
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'duplicate_blocked', 0, ?, ?, ?, ?, 'duplicate_blocked')`
          ).bind(
            dupScanId,
            deliveryId,
            partId,
            input.userId || null,
            now,
            input.scannedCode || part.part_number,
            this.normalizeScanType(input.scannedVia || "qr"),
            currentRecQty,
            dupMsg,
            input.employeeName || null,
            input.employeeRole || null
          ).run();
        } catch {
        }
        return {
          duplicate: true,
          status: "duplicate",
          message: "Duplicate scan \u2013 this part has already been received by another worker",
          error: "Duplicate scan \u2013 this part has already been received by another worker",
          detailMessage: dupMsg,
          alreadyScannedBy,
          alreadyScannedAt,
          part: this.mapPartRow(part)
        };
      }
      const isQtyMatch = targetStatus === "received" && recQty === reqQty;
      const verificationStatus = targetStatus === "received" ? isQtyMatch ? "verified" : "quantity_mismatch" : "unscanned";
      const scannedVia = targetStatus === "received" ? this.normalizeScanType(input.scannedVia || "manual") : null;
      const scannedCode = targetStatus === "received" ? input.scannedCode || part.scanned_code || (scannedVia === "qr" ? part.part_number : part.item_number) : null;
      const scannedAt = targetStatus === "received" ? now : null;
      const lastScannedById = targetStatus === "received" ? input.userId || part.last_scanned_by_id || null : null;
      const lastScannedByName = targetStatus === "received" ? input.employeeName || part.last_scanned_by_name || "Worker" : null;
      const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const addedQty = Math.max(0, recQty - currentRecQty);
      const scanStatus = targetStatus === "received" ? isQtyMatch ? "match_success" : "quantity_mismatch" : "undo_performed";
      const scanResultMsg = targetStatus === "received" ? isQtyMatch ? `Verified ${part.part_number} (No. ${part.item_number}) - Qty ${recQty}/${reqQty} matched` : `Quantity mismatch for ${part.part_number}: Received ${recQty} of ${reqQty} required` : `Unticked ${part.part_number} (${part.item_number})`;
      const updateRes = await this.db.prepare(
        `UPDATE delivery_parts
           SET received_quantity = ?, verification_status = ?, status = ?,
               scanned_via = ?, scanned_code = ?, scanned_at = ?,
               last_scanned_by_id = ?, last_scanned_by_name = ?,
               notes = COALESCE(?, notes),
               version = COALESCE(version, 1) + 1,
               updated_at = ?
           WHERE delivery_id = ? AND id = ? AND COALESCE(version, 1) = ?`
      ).bind(
        recQty,
        verificationStatus,
        targetStatus,
        scannedVia,
        scannedCode,
        scannedAt,
        lastScannedById,
        lastScannedByName,
        input.notes || null,
        now,
        deliveryId,
        partId,
        currentVersion
      ).run();
      const rowsChanged = Number(updateRes.meta?.changes ?? 1);
      if (rowsChanged === 0) {
        if (attempt < MAX_CAS_ATTEMPTS) {
          continue;
        }
        const latestPart = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId).first();
        return {
          duplicate: true,
          status: "duplicate",
          message: "Duplicate scan \u2013 this part has already been received by another worker",
          error: "Duplicate scan \u2013 this part has already been received by another worker",
          alreadyScannedBy: latestPart?.last_scanned_by_name || "Another worker",
          alreadyScannedAt: latestPart?.scanned_at || latestPart?.updated_at,
          part: latestPart ? this.mapPartRow(latestPart) : this.mapPartRow(part)
        };
      }
      try {
        await this.db.batch([
          this.db.prepare(
            `INSERT INTO scan_events (
                id, delivery_id, part_id, user_id, timestamp, code,
                scan_type, scan_status, quantity_added, received_quantity_after,
                scan_result, raw_ocr_text, employee_name, employee_role, event_action, idempotency_key
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            scanId,
            deliveryId,
            partId,
            input.userId || null,
            now,
            scannedCode || part.part_number,
            scannedVia || "manual",
            scanStatus,
            addedQty,
            recQty,
            scanResultMsg,
            input.rawOcrText || null,
            input.employeeName || null,
            input.employeeRole || null,
            input.eventAction || (recQty > 0 ? "part_scan" : "part_untick"),
            cleanIdempotencyKey
          ),
          this.db.prepare(
            "UPDATE deliveries SET version = COALESCE(version, 1) + 1, updated_at = ? WHERE id = ?"
          ).bind(now, deliveryId)
        ]);
      } catch (batchErr) {
        if (cleanIdempotencyKey && String(batchErr?.message || "").includes("UNIQUE")) {
          continue;
        }
        throw batchErr;
      }
      const updatedPart = await this.db.prepare("SELECT * FROM delivery_parts WHERE id = ?").bind(partId).first();
      const updatedDeliveryRow = await this.db.prepare("SELECT version, delivery_status FROM deliveries WHERE id = ?").bind(deliveryId).first();
      const statsRow = await this.db.prepare(
        `SELECT
             COUNT(*) as total_count,
             SUM(CASE WHEN status = 'received' THEN 1 ELSE 0 END) as received_count
           FROM delivery_parts
           WHERE delivery_id = ?`
      ).bind(deliveryId).first();
      const totalCount = Number(statsRow?.total_count || 0);
      const receivedCount = Number(statsRow?.received_count || 0);
      const outstandingCount = Math.max(0, totalCount - receivedCount);
      const partScansRes = await this.db.prepare("SELECT * FROM scan_events WHERE delivery_id = ? AND part_id = ? ORDER BY timestamp ASC").bind(deliveryId, partId).all();
      const scannedByUsers = this.buildPartScanAttributions(
        partId,
        partScansRes.results || [],
        updatedPart || void 0
      );
      return {
        duplicate: false,
        status: "updated",
        deliveryVersion: Number(updatedDeliveryRow?.version || 1),
        deliveryStats: {
          totalCount,
          receivedCount,
          outstandingCount
        },
        part: updatedPart ? {
          ...this.mapPartRow(updatedPart),
          scannedByUsers
        } : null,
        scanEvent: {
          id: scanId,
          deliveryId,
          partId,
          userId: input.userId,
          employeeName: input.employeeName,
          employeeRole: input.employeeRole,
          eventAction: input.eventAction || (recQty > 0 ? "part_scan" : "part_untick"),
          timestamp: now,
          code: scannedCode || part.part_number,
          codeType: scannedVia || "manual",
          status: scanStatus,
          quantityAdded: addedQty,
          receivedQuantity: recQty,
          message: scanResultMsg,
          idempotencyKey: cleanIdempotencyKey || void 0
        }
      };
    }
    throw new Error("Failed to commit part quantity after concurrent retries");
  }
  // =========================================================================
  // DOCKET GROUPS (Manually created grouping without merging underlying dockets)
  // =========================================================================
  async listGroups() {
    await this.ensureSchemaReady();
    const groupsRes = await this.db.prepare("SELECT * FROM docket_groups ORDER BY created_at DESC").all();
    const itemsRes = await this.db.prepare("SELECT * FROM docket_group_items ORDER BY added_at ASC").all();
    const deliveryIdsByGroup = /* @__PURE__ */ new Map();
    for (const item of itemsRes.results || []) {
      const arr = deliveryIdsByGroup.get(item.group_id) || [];
      arr.push(item.delivery_id);
      deliveryIdsByGroup.set(item.group_id, arr);
    }
    return (groupsRes.results || []).map((g) => ({
      id: g.id,
      name: g.name,
      deliveryIds: deliveryIdsByGroup.get(g.id) || [],
      createdBy: g.created_by || null,
      createdAt: g.created_at,
      updatedAt: g.updated_at
    }));
  }
  async getGroupById(groupId) {
    await this.ensureSchemaReady();
    const group = await this.db.prepare("SELECT * FROM docket_groups WHERE id = ?").bind(groupId).first();
    if (!group) return null;
    const itemsRes = await this.db.prepare("SELECT delivery_id FROM docket_group_items WHERE group_id = ? ORDER BY added_at ASC").bind(groupId).all();
    return {
      id: group.id,
      name: group.name,
      deliveryIds: (itemsRes.results || []).map((r) => r.delivery_id),
      createdBy: group.created_by || null,
      createdAt: group.created_at,
      updatedAt: group.updated_at
    };
  }
  async createGroup(input) {
    await this.ensureSchemaReady();
    const cleanName = String(input.name || "").trim();
    if (!cleanName) {
      throw new Error("Group name is required.");
    }
    const id = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const uniqueIds = Array.from(
      new Set((Array.isArray(input.deliveryIds) ? input.deliveryIds : []).map((d) => String(d).trim()).filter(Boolean))
    );
    const stmts = [
      this.db.prepare("INSERT INTO docket_groups (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, cleanName, input.createdBy || null, now, now)
    ];
    for (const delId of uniqueIds) {
      const exists = await this.db.prepare("SELECT id FROM deliveries WHERE id = ?").bind(delId).first();
      if (exists) {
        stmts.push(
          this.db.prepare(
            "INSERT OR IGNORE INTO docket_group_items (group_id, delivery_id, added_by, added_at) VALUES (?, ?, ?, ?)"
          ).bind(id, delId, input.createdBy || null, now)
        );
      }
    }
    await this.db.batch(stmts);
    return await this.getGroupById(id);
  }
  async updateGroup(groupId, updates, actorId) {
    await this.ensureSchemaReady();
    const existing = await this.db.prepare("SELECT * FROM docket_groups WHERE id = ?").bind(groupId).first();
    if (!existing) {
      throw new Error(`Docket group not found: ${groupId}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const nextName = updates.name !== void 0 ? String(updates.name).trim() || existing.name : existing.name;
    const stmts = [
      this.db.prepare("UPDATE docket_groups SET name = ?, updated_at = ? WHERE id = ?").bind(nextName, now, groupId)
    ];
    if (Array.isArray(updates.deliveryIds)) {
      stmts.push(
        this.db.prepare("DELETE FROM docket_group_items WHERE group_id = ?").bind(groupId)
      );
      const uniqueIds = Array.from(
        new Set(updates.deliveryIds.map((d) => String(d).trim()).filter(Boolean))
      );
      for (const delId of uniqueIds) {
        const exists = await this.db.prepare("SELECT id FROM deliveries WHERE id = ?").bind(delId).first();
        if (exists) {
          stmts.push(
            this.db.prepare(
              "INSERT OR IGNORE INTO docket_group_items (group_id, delivery_id, added_by, added_at) VALUES (?, ?, ?, ?)"
            ).bind(groupId, delId, actorId || null, now)
          );
        }
      }
    }
    await this.db.batch(stmts);
    return await this.getGroupById(groupId);
  }
  async addDeliveryToGroup(groupId, deliveryId, addedBy) {
    await this.ensureSchemaReady();
    const group = await this.db.prepare("SELECT id FROM docket_groups WHERE id = ?").bind(groupId).first();
    if (!group) throw new Error(`Docket group not found: ${groupId}`);
    const delivery = await this.db.prepare("SELECT id FROM deliveries WHERE id = ?").bind(deliveryId).first();
    if (!delivery) throw new Error(`Delivery docket not found: ${deliveryId}`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await this.db.batch([
      this.db.prepare(
        "INSERT OR IGNORE INTO docket_group_items (group_id, delivery_id, added_by, added_at) VALUES (?, ?, ?, ?)"
      ).bind(groupId, deliveryId, addedBy || null, now),
      this.db.prepare("UPDATE docket_groups SET updated_at = ? WHERE id = ?").bind(now, groupId)
    ]);
    return await this.getGroupById(groupId);
  }
  async removeDeliveryFromGroup(groupId, deliveryId) {
    await this.ensureSchemaReady();
    const group = await this.db.prepare("SELECT id FROM docket_groups WHERE id = ?").bind(groupId).first();
    if (!group) throw new Error(`Docket group not found: ${groupId}`);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await this.db.batch([
      this.db.prepare("DELETE FROM docket_group_items WHERE group_id = ? AND delivery_id = ?").bind(groupId, deliveryId),
      this.db.prepare("UPDATE docket_groups SET updated_at = ? WHERE id = ?").bind(now, groupId)
    ]);
    return await this.getGroupById(groupId);
  }
  async deleteGroup(groupId) {
    await this.ensureSchemaReady();
    const existing = await this.db.prepare("SELECT id, name FROM docket_groups WHERE id = ?").bind(groupId).first();
    if (!existing) {
      return { deleted: false, id: groupId };
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM docket_group_items WHERE group_id = ?").bind(groupId),
      this.db.prepare("DELETE FROM docket_groups WHERE id = ?").bind(groupId)
    ]);
    return { deleted: true, id: groupId, name: existing.name };
  }
  normalizePartMatchCode(raw) {
    return String(raw || "").trim().toUpperCase().replace(/^P(?:ART)?\s*[:#-]?\s*/i, "").trim();
  }
  /**
   * Scan a part code against a manually curated Docket Group.
   * - Identifies which member docket owns the part.
   * - Rejects parts not belonging to any docket in the group.
   * - Requires explicit operator docket allocation (`targetDeliveryId` + `targetPartId`) when >1 docket matches.
   * - Strictly commits using the authenticated server session user.
   */
  async scanGroupPart(groupId, input) {
    const group = await this.getGroupById(groupId);
    if (!group) {
      throw new Error(`Docket group not found: ${groupId}`);
    }
    if (group.deliveryIds.length === 0) {
      return {
        status: "not_found",
        matched: false,
        message: `Group "${group.name}" has no dockets assigned.`
      };
    }
    const cleanCode = String(input.code || "").trim();
    if (!cleanCode) {
      throw new Error("Scanned code is required.");
    }
    if (isIgnoredNonPartQrPayload(cleanCode)) {
      return {
        status: "ignored_non_part_qr",
        matched: false,
        message: "Ignored protective film QR payload."
      };
    }
    if (input.targetDeliveryId && input.targetPartId) {
      if (!group.deliveryIds.includes(input.targetDeliveryId)) {
        throw new Error(
          `Forbidden: Docket ${input.targetDeliveryId} is not a member of group "${group.name}".`
        );
      }
      const delivery = await this.db.prepare("SELECT id, docket_number, supplier FROM deliveries WHERE id = ?").bind(input.targetDeliveryId).first();
      const part = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(input.targetDeliveryId, input.targetPartId).first();
      if (!delivery || !part) {
        throw new Error("Selected target part could not be found on the chosen docket.");
      }
      const qtyToCommit2 = input.receivedQuantity !== void 0 ? Number(input.receivedQuantity) : part.required_quantity;
      const commitRes2 = await this.updatePartReceivedQuantity(delivery.id, part.id, {
        receivedQuantity: qtyToCommit2,
        mode: input.mode,
        idempotencyKey: input.idempotencyKey,
        scannedVia: input.scannedVia || "qr",
        scannedCode: cleanCode,
        status: "received",
        notes: input.notes,
        rawOcrText: input.rawOcrText,
        userId: input.userId,
        employeeName: input.employeeName,
        employeeRole: input.employeeRole,
        eventAction: "group_part_scan"
      });
      return {
        ...commitRes2,
        matched: true,
        deliveryId: delivery.id,
        docketNumber: delivery.docket_number,
        supplier: delivery.supplier,
        groupId
      };
    }
    const placeholders = group.deliveryIds.map(() => "?").join(", ");
    const deliveriesRes = await this.db.prepare(`SELECT id, docket_number, supplier FROM deliveries WHERE id IN (${placeholders})`).bind(...group.deliveryIds).all();
    const partsRes = await this.db.prepare(
      `SELECT * FROM delivery_parts WHERE delivery_id IN (${placeholders}) ORDER BY docket_line_index ASC`
    ).bind(...group.deliveryIds).all();
    const delById = new Map((deliveriesRes.results || []).map((d) => [d.id, d]));
    const normUpper = cleanCode.toUpperCase();
    const normCode = this.normalizePartMatchCode(cleanCode);
    const barcodeIdxMatch = cleanCode.match(/^\d{4,10}-(\d{1,5})$/);
    const docketNoSuffix = barcodeIdxMatch ? String(parseInt(barcodeIdxMatch[1], 10)) : null;
    const candidates = [];
    for (const part of partsRes.results || []) {
      const del = delById.get(part.delivery_id);
      if (!del) continue;
      const pNorm = this.normalizePartMatchCode(part.part_number);
      const pRawUpper = String(part.part_number || "").trim().toUpperCase();
      const itemNorm = String(part.item_number || "").trim();
      let matchedMode = null;
      if (pRawUpper === normUpper || normCode && pNorm === normCode) {
        matchedMode = "exact-part";
      } else if (docketNoSuffix && itemNorm === docketNoSuffix) {
        matchedMode = "docket-no";
      } else if (itemNorm === cleanCode) {
        matchedMode = "exact-item";
      }
      if (matchedMode) {
        candidates.push({
          deliveryId: del.id,
          docketNumber: del.docket_number,
          supplier: del.supplier,
          part,
          matchedMode
        });
      }
    }
    if (candidates.length === 0) {
      return {
        status: "not_found",
        matched: false,
        message: `Part "${cleanCode}" does not belong to any docket in group "${group.name}".`
      };
    }
    const distinctDeliveries = new Set(candidates.map((c) => c.deliveryId));
    if (distinctDeliveries.size > 1 || candidates.length > 1) {
      if (distinctDeliveries.size > 1) {
        return {
          status: "ambiguous",
          ambiguous: true,
          matched: true,
          message: `Part "${cleanCode}" appears in ${distinctDeliveries.size} dockets in group "${group.name}". Please select which docket to allocate this scan to.`,
          conflictCandidates: candidates.map((c) => ({
            deliveryId: c.deliveryId,
            docketNumber: c.docketNumber,
            supplier: c.supplier,
            partId: c.part.id,
            partNumber: c.part.part_number,
            itemNumber: c.part.item_number,
            description: c.part.description,
            requiredQuantity: c.part.required_quantity,
            receivedQuantity: c.part.received_quantity,
            status: c.part.status,
            matchedMode: c.matchedMode
          }))
        };
      }
    }
    const chosen = candidates.find((c) => c.part.status === "outstanding") || candidates[0];
    const qtyToCommit = input.receivedQuantity !== void 0 ? Number(input.receivedQuantity) : chosen.part.required_quantity;
    const commitRes = await this.updatePartReceivedQuantity(chosen.deliveryId, chosen.part.id, {
      receivedQuantity: qtyToCommit,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      scannedVia: input.scannedVia || "qr",
      scannedCode: cleanCode,
      status: "received",
      notes: input.notes,
      rawOcrText: input.rawOcrText,
      userId: input.userId,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      eventAction: "group_part_scan"
    });
    return {
      ...commitRes,
      matched: true,
      deliveryId: chosen.deliveryId,
      docketNumber: chosen.docketNumber,
      supplier: chosen.supplier,
      groupId
    };
  }
  /**
   * Record a scan event directly into the audit log
   */
  async recordScanEvent(deliveryId, input) {
    const delivery = await this.db.prepare("SELECT id FROM deliveries WHERE id = ?").bind(deliveryId).first();
    if (!delivery) {
      throw new Error(`Delivery not found: ${deliveryId}`);
    }
    const now = input.timestamp || (/* @__PURE__ */ new Date()).toISOString();
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const qtyAdded = Math.max(0, Math.round(Number(input.quantityAdded || 0)));
    const normScanType = this.normalizeScanType(input.scanType);
    await this.db.prepare(
      `INSERT INTO scan_events (
          id, delivery_id, part_id, user_id, timestamp, code,
          scan_type, scan_status, quantity_added, received_quantity_after,
          scan_result, raw_ocr_text, employee_name, employee_role, event_action
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      scanId,
      deliveryId,
      input.partId || null,
      input.userId || null,
      now,
      input.code,
      normScanType,
      input.scanStatus,
      qtyAdded,
      input.receivedQuantityAfter ?? null,
      input.scanResult || null,
      input.rawOcrText || null,
      input.employeeName || null,
      input.employeeRole || null,
      input.eventAction || "scan_logged"
    ).run();
    return {
      id: scanId,
      deliveryId,
      partId: input.partId,
      userId: input.userId,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      eventAction: input.eventAction || "scan_logged",
      timestamp: now,
      code: input.code,
      codeType: normScanType,
      status: input.scanStatus,
      quantityAdded: qtyAdded,
      receivedQuantity: input.receivedQuantityAfter,
      message: input.scanResult || ""
    };
  }
  /**
   * Retrieve scan history for a delivery
   */
  async getScanHistory(deliveryId) {
    const res = await this.db.prepare("SELECT * FROM scan_events WHERE delivery_id = ? ORDER BY timestamp DESC LIMIT 500").bind(deliveryId).all();
    return (res.results || []).map((s) => this.mapScanRow(s));
  }
  /**
   * Safe migration helper for existing localStorage / IndexedDB deliveries.
   * Checks for existing deliveries by ID and case-insensitive Docket Number to prevent conflicting duplicates.
   */
  async migrateLocalDeliveries(deliveries) {
    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return { importedCount: 0, skippedCount: 0, importedIds: [], existingIds: [] };
    }
    const importedIds = [];
    const existingIds = [];
    const seenIdsInBatch = /* @__PURE__ */ new Set();
    const seenDocketsInBatch = /* @__PURE__ */ new Set();
    for (const del of deliveries) {
      if (!del || !del.docketNumber) continue;
      const cleanId = (del.id || "").trim();
      const normDocket = del.docketNumber.trim().toLowerCase();
      if (!normDocket) continue;
      if (cleanId && seenIdsInBatch.has(cleanId) || seenDocketsInBatch.has(normDocket)) {
        existingIds.push(cleanId || del.docketNumber);
        continue;
      }
      const existing = await this.db.prepare(
        "SELECT id FROM deliveries WHERE id = ? OR LOWER(TRIM(docket_number)) = LOWER(TRIM(?))"
      ).bind(cleanId, del.docketNumber.trim()).first();
      if (existing) {
        existingIds.push(cleanId || del.docketNumber);
        if (cleanId) seenIdsInBatch.add(cleanId);
        seenDocketsInBatch.add(normDocket);
        continue;
      }
      const created = await this.createDelivery(del);
      if (cleanId) seenIdsInBatch.add(cleanId);
      if (created?.id) seenIdsInBatch.add(created.id);
      seenDocketsInBatch.add(normDocket);
      importedIds.push(created?.id || cleanId || del.docketNumber);
    }
    return {
      importedCount: importedIds.length,
      skippedCount: existingIds.length,
      importedIds,
      existingIds
    };
  }
  static {
    // ==========================================
    // PHASE 2: AUTHENTICATION, SUPER ADMIN & RBAC
    // ==========================================
    this.verifiedDbs = /* @__PURE__ */ new WeakSet();
  }
  static {
    this.inFlightSchemaInit = /* @__PURE__ */ new WeakMap();
  }
  /**
   * Ensures all required D1 tables and columns exist on the connected database.
   * Uses a per-database in-flight Promise mutex and a single-query fast probe so
   * Cloudflare Workers never exceeds subrequest limits or times out on cold starts.
   */
  async ensureSchemaReady() {
    if (_PalletTrackDbService.verifiedDbs.has(this.db)) return;
    const existingPromise = _PalletTrackDbService.inFlightSchemaInit.get(this.db);
    if (existingPromise) {
      return existingPromise;
    }
    const initPromise = this.runSchemaBootstrap().finally(() => {
      _PalletTrackDbService.inFlightSchemaInit.delete(this.db);
    });
    _PalletTrackDbService.inFlightSchemaInit.set(this.db, initPromise);
    return initPromise;
  }
  async probeSchemaColumns() {
    try {
      await this.db.prepare(
        `SELECT
            (SELECT COUNT(*) FROM (SELECT id, employee_code, role, active FROM users LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id FROM sessions LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, revision, manually_edited, original_ocr_values, last_edited_by, last_edited_at, version, last_scanned_by_id, last_scanned_by_name FROM delivery_parts LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, version, needs_review, review_reason FROM deliveries LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, idempotency_key, sequence_number FROM scan_events LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT id, name FROM docket_groups LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT group_id, delivery_id FROM docket_group_items LIMIT 1)) +
            (SELECT COUNT(*) FROM (SELECT seq, id FROM realtime_events LIMIT 1)) AS schema_ready`
      ).first();
      return true;
    } catch {
      return false;
    }
  }
  async runSchemaBootstrap() {
    if (await this.probeSchemaColumns()) {
      _PalletTrackDbService.verifiedDbs.add(this.db);
      return;
    }
    const createStatements = [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        employee_name TEXT NOT NULL,
        employee_code TEXT UNIQUE,
        pin_hash TEXT,
        pin_salt TEXT,
        role TEXT NOT NULL DEFAULT 'employee',
        active INTEGER NOT NULL DEFAULT 1,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_login_at TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        user_agent TEXT,
        ip_address TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        docket_number TEXT NOT NULL,
        supplier TEXT NOT NULL,
        purchase_order_number TEXT,
        delivery_date TEXT NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT 'receiving',
        carrier TEXT,
        pallet_count INTEGER NOT NULL DEFAULT 1,
        supplier_profile TEXT NOT NULL DEFAULT 'laser_central',
        notes TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        needs_review INTEGER NOT NULL DEFAULT 0,
        review_reason TEXT,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS delivery_parts (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        part_number TEXT NOT NULL,
        item_number TEXT NOT NULL,
        docket_line_index INTEGER NOT NULL DEFAULT 1,
        description TEXT NOT NULL,
        revision TEXT,
        required_quantity INTEGER NOT NULL DEFAULT 1,
        received_quantity INTEGER NOT NULL DEFAULT 0,
        verification_status TEXT NOT NULL DEFAULT 'unscanned',
        status TEXT NOT NULL DEFAULT 'outstanding',
        material TEXT,
        thickness TEXT,
        dimensions TEXT,
        weight TEXT,
        pallet_number TEXT,
        scanned_at TEXT,
        scanned_via TEXT,
        scanned_code TEXT,
        last_scanned_by_id TEXT,
        last_scanned_by_name TEXT,
        notes TEXT,
        flagged_for_review INTEGER NOT NULL DEFAULT 0,
        ocr_confidence TEXT,
        manually_edited INTEGER NOT NULL DEFAULT 0,
        original_ocr_values TEXT,
        last_edited_by TEXT,
        last_edited_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS scan_events (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        part_id TEXT REFERENCES delivery_parts(id) ON DELETE SET NULL,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        employee_name TEXT,
        employee_role TEXT,
        event_action TEXT NOT NULL DEFAULT 'part_scan',
        timestamp TEXT NOT NULL,
        code TEXT NOT NULL,
        scan_type TEXT NOT NULL,
        scan_status TEXT NOT NULL,
        quantity_added INTEGER NOT NULL DEFAULT 0,
        received_quantity_after INTEGER,
        scan_result TEXT,
        raw_ocr_text TEXT,
        idempotency_key TEXT,
        sequence_number INTEGER,
        created_at TEXT NOT NULL DEFAULT (DATETIME('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS m1_synchronisations (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        m1_receipt_reference TEXT,
        sync_status TEXT NOT NULL DEFAULT 'pending',
        submission_timestamp TEXT,
        response_info TEXT,
        error_info TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS realtime_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        delivery_id TEXT,
        part_id TEXT,
        user_id TEXT,
        employee_name TEXT,
        employee_role TEXT,
        delivery_version INTEGER,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS docket_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS docket_group_items (
        group_id TEXT NOT NULL REFERENCES docket_groups(id) ON DELETE CASCADE,
        delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (group_id, delivery_id)
      )`
    ];
    const indexStatements = [
      "CREATE INDEX IF NOT EXISTS idx_users_active ON users(active)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_employee_code ON users(employee_code)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)",
      "CREATE INDEX IF NOT EXISTS idx_deliveries_docket ON deliveries(docket_number)",
      "CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(delivery_status)",
      "CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON deliveries(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_parts_delivery ON delivery_parts(delivery_id)",
      "CREATE INDEX IF NOT EXISTS idx_parts_part_number ON delivery_parts(part_number)",
      "CREATE INDEX IF NOT EXISTS idx_parts_item_number ON delivery_parts(item_number)",
      "CREATE INDEX IF NOT EXISTS idx_parts_status ON delivery_parts(delivery_id, status)",
      "CREATE INDEX IF NOT EXISTS idx_scans_delivery ON scan_events(delivery_id)",
      "CREATE INDEX IF NOT EXISTS idx_scans_part ON scan_events(part_id)",
      "CREATE INDEX IF NOT EXISTS idx_scans_user ON scan_events(user_id)",
      "CREATE INDEX IF NOT EXISTS idx_scans_timestamp ON scan_events(timestamp DESC)",
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_events_idempotency ON scan_events(idempotency_key) WHERE idempotency_key IS NOT NULL",
      "CREATE INDEX IF NOT EXISTS idx_m1_delivery ON m1_synchronisations(delivery_id)",
      "CREATE INDEX IF NOT EXISTS idx_realtime_events_seq ON realtime_events(seq ASC)",
      "CREATE INDEX IF NOT EXISTS idx_realtime_events_delivery_seq ON realtime_events(delivery_id, seq ASC)",
      "CREATE INDEX IF NOT EXISTS idx_docket_groups_created_at ON docket_groups(created_at DESC)",
      "CREATE INDEX IF NOT EXISTS idx_docket_group_items_delivery ON docket_group_items(delivery_id)",
      "CREATE INDEX IF NOT EXISTS idx_docket_group_items_group ON docket_group_items(group_id)"
    ];
    const schemaBootstrapStatements = [...createStatements, ...indexStatements];
    try {
      await this.db.exec(`${schemaBootstrapStatements.join(";\n")};`);
    } catch {
      try {
        await this.db.batch(createStatements.map((sql) => this.db.prepare(sql)));
        await this.db.batch(indexStatements.map((sql) => this.db.prepare(sql)));
      } catch {
        for (const sql of schemaBootstrapStatements) {
          try {
            await this.db.prepare(sql).run();
          } catch (e) {
            console.warn("Schema bootstrap notice:", e);
          }
        }
      }
    }
    const allColumnsPresentAfterCreate = await this.probeSchemaColumns();
    if (!allColumnsPresentAfterCreate) {
      const alterCols = [
        { table: "users", col: "employee_code", sql: "ALTER TABLE users ADD COLUMN employee_code TEXT" },
        { table: "users", col: "pin_salt", sql: "ALTER TABLE users ADD COLUMN pin_salt TEXT" },
        { table: "users", col: "last_login_at", sql: "ALTER TABLE users ADD COLUMN last_login_at TEXT" },
        { table: "users", col: "failed_login_attempts", sql: "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0" },
        { table: "users", col: "locked_until", sql: "ALTER TABLE users ADD COLUMN locked_until TEXT" },
        { table: "users", col: "created_by", sql: "ALTER TABLE users ADD COLUMN created_by TEXT" },
        { table: "scan_events", col: "employee_name", sql: "ALTER TABLE scan_events ADD COLUMN employee_name TEXT" },
        { table: "scan_events", col: "employee_role", sql: "ALTER TABLE scan_events ADD COLUMN employee_role TEXT" },
        { table: "scan_events", col: "event_action", sql: "ALTER TABLE scan_events ADD COLUMN event_action TEXT DEFAULT 'part_scan'" },
        { table: "scan_events", col: "idempotency_key", sql: "ALTER TABLE scan_events ADD COLUMN idempotency_key TEXT" },
        { table: "scan_events", col: "sequence_number", sql: "ALTER TABLE scan_events ADD COLUMN sequence_number INTEGER" },
        { table: "deliveries", col: "version", sql: "ALTER TABLE deliveries ADD COLUMN version INTEGER NOT NULL DEFAULT 1" },
        { table: "deliveries", col: "needs_review", sql: "ALTER TABLE deliveries ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0" },
        { table: "deliveries", col: "review_reason", sql: "ALTER TABLE deliveries ADD COLUMN review_reason TEXT" },
        { table: "delivery_parts", col: "revision", sql: "ALTER TABLE delivery_parts ADD COLUMN revision TEXT" },
        { table: "delivery_parts", col: "manually_edited", sql: "ALTER TABLE delivery_parts ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0" },
        { table: "delivery_parts", col: "original_ocr_values", sql: "ALTER TABLE delivery_parts ADD COLUMN original_ocr_values TEXT" },
        { table: "delivery_parts", col: "last_edited_by", sql: "ALTER TABLE delivery_parts ADD COLUMN last_edited_by TEXT" },
        { table: "delivery_parts", col: "last_edited_at", sql: "ALTER TABLE delivery_parts ADD COLUMN last_edited_at TEXT" },
        { table: "delivery_parts", col: "version", sql: "ALTER TABLE delivery_parts ADD COLUMN version INTEGER NOT NULL DEFAULT 1" },
        { table: "delivery_parts", col: "last_scanned_by_id", sql: "ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_id TEXT" },
        { table: "delivery_parts", col: "last_scanned_by_name", sql: "ALTER TABLE delivery_parts ADD COLUMN last_scanned_by_name TEXT" }
      ];
      try {
        const pragmaBatch = await this.db.batch([
          this.db.prepare("PRAGMA table_info(users)"),
          this.db.prepare("PRAGMA table_info(scan_events)"),
          this.db.prepare("PRAGMA table_info(deliveries)"),
          this.db.prepare("PRAGMA table_info(delivery_parts)")
        ]);
        const existingByTable = {
          users: new Set((pragmaBatch[0]?.results || []).map((r) => r.name)),
          scan_events: new Set((pragmaBatch[1]?.results || []).map((r) => r.name)),
          deliveries: new Set((pragmaBatch[2]?.results || []).map((r) => r.name)),
          delivery_parts: new Set((pragmaBatch[3]?.results || []).map((r) => r.name))
        };
        const missingAlters = alterCols.filter(
          (item) => existingByTable[item.table] && existingByTable[item.table].size > 0 && !existingByTable[item.table].has(item.col)
        );
        if (missingAlters.length > 0) {
          await this.db.batch(missingAlters.map((item) => this.db.prepare(item.sql)));
        }
      } catch {
        for (const item of alterCols) {
          try {
            await this.db.prepare(item.sql).run();
          } catch {
          }
        }
      }
    }
    _PalletTrackDbService.verifiedDbs.add(this.db);
  }
  /**
   * Normalizes legacy role names ('operator' / 'receiver') to 'employee' while preserving
   * 'super_admin', 'admin', and 'supervisor'.
   */
  normalizeRole(role) {
    const r = (role || "").trim().toLowerCase();
    if (r === "super_admin") return "super_admin";
    if (r === "admin") return "admin";
    if (r === "supervisor") return "supervisor";
    if (r === "employee" || r === "operator" || r === "receiver") return "employee";
    return "employee";
  }
  /**
   * Check if a Super Admin or Admin exists in the system (first-time setup check)
   */
  async getProvisionStatus() {
    await this.ensureSchemaReady();
    const superAdminRes = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1").first();
    const adminRes = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role IN ('super_admin', 'admin') AND active = 1").first();
    const totalRes = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE pin_hash IS NOT NULL").first();
    let superAdminCount = Number(superAdminRes?.count || 0);
    const adminCount = Number(adminRes?.count || 0);
    const totalCount = Number(totalRes?.count || 0);
    if (superAdminCount === 0 && adminCount > 0) {
      const firstAdmin = await this.db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY created_at ASC LIMIT 1").first();
      if (firstAdmin?.id) {
        await this.db.prepare("UPDATE users SET role = 'super_admin' WHERE id = ?").bind(firstAdmin.id).run();
        superAdminCount = 1;
      }
    }
    return {
      hasSuperAdmin: superAdminCount > 0,
      hasAdmin: superAdminCount > 0 || adminCount > 0,
      adminCount,
      totalUsers: totalCount
    };
  }
  static {
    this.SETUP_GUARD_ID = "__system_setup_guard__";
  }
  static {
    this.MAX_SETUP_ATTEMPTS = 5;
  }
  static {
    this.SETUP_LOCKOUT_MS = 15 * 60 * 1e3;
  }
  // 15 minutes
  /**
   * Provision the initial Super Admin account.
   * - Permanently disabled once a Super Admin or Admin exists.
   * - Fails closed if INITIAL_SETUP_SECRET is missing or weak/predictable.
   * - Rate-limited in D1 (max 5 failed attempts per 15-minute window).
   * - Uses constant-time SHA-256 comparison so secret values never leak.
   */
  async setupInitialAdmin(input) {
    const status = await this.getProvisionStatus();
    if (status.hasSuperAdmin || status.hasAdmin) {
      const err = new Error(
        "Initial Super Admin setup is permanently disabled. A Super Admin already exists."
      );
      err.code = "SETUP_ALREADY_COMPLETED";
      err.status = 403;
      throw err;
    }
    const requiredSecret = (input.expectedSetupSecret || "").trim();
    if (!requiredSecret) {
      const err = new Error(
        "Initial setup is unavailable: INITIAL_SETUP_SECRET is not configured on the server."
      );
      err.code = "SETUP_SECRET_NOT_CONFIGURED";
      err.status = 503;
      throw err;
    }
    const forbiddenDefaults = /* @__PURE__ */ new Set([
      "changeme",
      "secret",
      "password",
      "admin",
      "123456789012"
    ]);
    if (requiredSecret.length < 12 || /^pallettrack-setup-\d+$/i.test(requiredSecret) || forbiddenDefaults.has(requiredSecret.toLowerCase())) {
      const err = new Error(
        "Initial setup is unavailable: Server INITIAL_SETUP_SECRET does not meet minimum security requirements (must be at least 12 characters and not a default placeholder)."
      );
      err.code = "SETUP_SECRET_WEAK";
      err.status = 503;
      throw err;
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const guardRow = await this.db.prepare("SELECT failed_login_attempts, locked_until FROM users WHERE id = ?").bind(_PalletTrackDbService.SETUP_GUARD_ID).first();
    if (guardRow?.locked_until) {
      const lockExpiresMs = new Date(guardRow.locked_until).getTime();
      if (lockExpiresMs > nowMs) {
        const remainingMinutes = Math.max(1, Math.ceil((lockExpiresMs - nowMs) / 6e4));
        const err = new Error(
          `Too many failed setup attempts. Initial provisioning is temporarily locked for ${remainingMinutes} minute(s).`
        );
        err.code = "SETUP_RATE_LIMITED";
        err.status = 429;
        throw err;
      }
    }
    const providedSecret = (input.setupSecret || "").trim();
    const isSecretValid = await verifySetupSecretConstantTime(providedSecret, requiredSecret);
    if (!isSecretValid) {
      const prevFailures = guardRow?.locked_until && new Date(guardRow.locked_until).getTime() <= nowMs ? 0 : Number(guardRow?.failed_login_attempts || 0);
      const nextFailures = prevFailures + 1;
      const newLockedUntil = nextFailures >= _PalletTrackDbService.MAX_SETUP_ATTEMPTS ? new Date(nowMs + _PalletTrackDbService.SETUP_LOCKOUT_MS).toISOString() : null;
      await this.db.prepare(
        `INSERT INTO users (
            id, employee_name, employee_code, pin_hash, pin_salt, role, active,
            failed_login_attempts, locked_until, created_by, created_at, updated_at
          ) VALUES (?, 'System Setup Rate Limit Guard', NULL, NULL, NULL, 'employee', 0, ?, ?, 'SYSTEM', ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            failed_login_attempts = excluded.failed_login_attempts,
            locked_until = excluded.locked_until,
            updated_at = excluded.updated_at`
      ).bind(_PalletTrackDbService.SETUP_GUARD_ID, nextFailures, newLockedUntil, nowIso, nowIso).run();
      if (newLockedUntil) {
        const err2 = new Error(
          "Too many failed setup attempts. Initial provisioning is locked for 15 minutes."
        );
        err2.code = "SETUP_RATE_LIMITED";
        err2.status = 429;
        throw err2;
      }
      const err = new Error("Invalid one-time setup secret key.");
      err.code = "INVALID_SETUP_SECRET";
      err.status = 403;
      throw err;
    }
    const name = (input.employeeName || "").trim();
    const code = (input.employeeCode || "").trim().toUpperCase();
    const pin = (input.pin || "").trim();
    if (!name) throw new Error("Super Admin name is required");
    if (!code) throw new Error("Employee identifier is required");
    if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be exactly 4 numeric digits");
    const { hash, salt } = await hashPin(pin);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const userId = `usr_super_admin_${Date.now()}`;
    await this.db.prepare("DELETE FROM users WHERE id = ?").bind(_PalletTrackDbService.SETUP_GUARD_ID).run();
    await this.db.prepare(
      `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, last_login_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, name, code, hash, salt, "super_admin", 1, 0, null, now, "INITIAL_SETUP", now, now).run();
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1e3).toISOString();
    await this.db.prepare(
      `INSERT INTO sessions (
          id, user_id, created_at, expires_at, last_activity_at, user_agent, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(tokenHash, userId, now, expiresAt, now, input.userAgent || null, input.ipAddress || null).run();
    return {
      user: {
        id: userId,
        employeeName: name,
        employeeCode: code,
        role: "super_admin",
        active: true,
        lastLoginAt: now,
        createdBy: "INITIAL_SETUP",
        createdAt: now
      },
      token,
      expiresAt
    };
  }
  /**
   * Authenticate employee via 4-digit PIN.
   * Enforces 5-attempt rate-limiting lockout and generic error messages.
   */
  async loginWithPin(employeeCode, pin, userAgent, ipAddress) {
    await this.ensureSchemaReady();
    const code = (employeeCode || "").trim().toUpperCase();
    const cleanPin = (pin || "").trim();
    if (!code || !/^\d{4}$/.test(cleanPin)) {
      throw new Error("Invalid employee identifier or PIN");
    }
    const user = await this.db.prepare("SELECT * FROM users WHERE UPPER(employee_code) = ?").bind(code).first();
    if (!user) {
      await hashPin("0000", "00".repeat(16));
      throw new Error("Invalid employee identifier or PIN");
    }
    if (!user.active) {
      throw new Error("This account has been deactivated. Please contact an administrator.");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (user.locked_until) {
      const lockTime = new Date(user.locked_until).getTime();
      if (lockTime > Date.now()) {
        const remainingMinutes = Math.max(1, Math.ceil((lockTime - Date.now()) / 6e4));
        throw new Error(
          `Account locked due to 5 failed attempts. Please try again in ${remainingMinutes} minute(s) or contact an administrator.`
        );
      } else {
        await this.db.prepare("UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?").bind(user.id).run();
        user.failed_login_attempts = 0;
        user.locked_until = null;
      }
    }
    const isValid = await verifyPin(cleanPin, user.pin_hash || "", user.pin_salt || "");
    if (!isValid) {
      const newAttempts = (user.failed_login_attempts || 0) + 1;
      let lockedUntil = null;
      if (newAttempts >= 5) {
        lockedUntil = new Date(Date.now() + 15 * 60 * 1e3).toISOString();
      }
      await this.db.prepare(
        "UPDATE users SET failed_login_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?"
      ).bind(newAttempts, lockedUntil, now, user.id).run();
      if (newAttempts >= 5) {
        throw new Error(
          "Account locked due to 5 consecutive failed attempts. Please try again in 15 minutes or contact an administrator."
        );
      }
      throw new Error("Invalid employee identifier or PIN");
    }
    await this.db.prepare(
      "UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?"
    ).bind(now, now, user.id).run();
    const token = generateSessionToken();
    const tokenHash = await hashSessionToken(token);
    const expiresAt = new Date(Date.now() + 8 * 3600 * 1e3).toISOString();
    await this.db.prepare(
      `INSERT INTO sessions (
          id, user_id, created_at, expires_at, last_activity_at, user_agent, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(tokenHash, user.id, now, expiresAt, now, userAgent || null, ipAddress || null).run();
    return {
      user: {
        id: user.id,
        employeeName: user.employee_name,
        employeeCode: user.employee_code,
        role: this.normalizeRole(user.role),
        active: Boolean(user.active),
        lastLoginAt: now,
        createdAt: user.created_at
      },
      token,
      expiresAt
    };
  }
  /**
   * Validate session token from Cookie or Bearer header.
   * Auto-refreshes last_activity_at and invalidates expired or deactivated sessions.
   */
  async validateSession(token) {
    if (!token || typeof token !== "string") return null;
    await this.ensureSchemaReady();
    const tokenHash = await hashSessionToken(token);
    const row = await this.db.prepare(
      `SELECT s.id as session_id, s.expires_at, s.last_activity_at,
                u.id as user_id, u.employee_name, u.employee_code, u.role, u.active,
                u.locked_until, u.last_login_at, u.created_at
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.id = ?`
    ).bind(tokenHash).first();
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
      return null;
    }
    if (!row.active) {
      await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
      return null;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await this.db.prepare("UPDATE sessions SET last_activity_at = ? WHERE id = ?").bind(now, tokenHash).run();
    return {
      id: row.user_id,
      employeeName: row.employee_name,
      employeeCode: row.employee_code,
      role: this.normalizeRole(row.role),
      active: Boolean(row.active),
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at
    };
  }
  /**
   * Revoke session on explicit logout
   */
  async revokeSession(token) {
    if (!token) return;
    await this.ensureSchemaReady();
    const tokenHash = await hashSessionToken(token);
    await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
  }
  /**
   * List all users (excluding hashes and salts) with activity stats
   */
  async listUsers() {
    await this.ensureSchemaReady();
    const query = `
      SELECT u.id, u.employee_name, u.employee_code, u.role, u.active,
             u.failed_login_attempts, u.locked_until, u.last_login_at,
             u.created_by, u.created_at, u.updated_at,
             COUNT(s.id) as total_scans,
             MAX(s.timestamp) as last_scan_at
      FROM users u
      LEFT JOIN scan_events s ON u.id = s.user_id
      WHERE u.employee_code IS NOT NULL OR u.pin_hash IS NOT NULL
      GROUP BY u.id
      ORDER BY
        CASE u.role
          WHEN 'super_admin' THEN 1
          WHEN 'admin' THEN 2
          WHEN 'supervisor' THEN 3
          ELSE 4
        END ASC,
        u.employee_name ASC
    `;
    const res = await this.db.prepare(query).all();
    return (res.results || []).map((u) => ({
      id: u.id,
      employeeName: u.employee_name,
      employeeCode: u.employee_code || u.id,
      role: this.normalizeRole(u.role),
      active: Boolean(u.active),
      failedLoginAttempts: Number(u.failed_login_attempts) || 0,
      lockedUntil: u.locked_until || null,
      lastLoginAt: u.last_login_at || null,
      createdBy: u.created_by || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      totalScans: Number(u.total_scans) || 0,
      lastScanAt: u.last_scan_at || null
    }));
  }
  /**
   * Create a new user account (Super Admin or Admin).
   * Supports creating unlimited Admin, Supervisor, and Employee accounts.
   * Only a Super Admin can create another Super Admin.
   */
  async createUser(input, actor) {
    await this.ensureSchemaReady();
    const name = (input.employeeName || "").trim();
    const code = (input.employeeCode || "").trim().toUpperCase();
    const pin = (input.pin || "").trim();
    const rawRole = (input.role || "employee").trim().toLowerCase();
    const role = rawRole === "operator" ? "employee" : rawRole;
    if (!name) throw new Error("Employee name is required");
    if (!code) throw new Error("Employee identifier is required");
    if (!["super_admin", "admin", "supervisor", "employee"].includes(role)) {
      throw new Error("Invalid role specified. Allowed roles: super_admin, admin, supervisor, employee");
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new Error("PIN must be exactly 4 numeric digits");
    }
    const status = await this.getProvisionStatus();
    if (!status.hasSuperAdmin && !status.hasAdmin) {
      throw new Error("Initial Super Admin setup must be completed before creating user accounts.");
    }
    if (!actor || actor.role !== "super_admin" && actor.role !== "admin") {
      throw new Error("Forbidden: Administrator privileges are required to create user accounts.");
    }
    if (role === "super_admin" && actor.role !== "super_admin") {
      throw new Error("Forbidden: Only a Super Admin can create a Super Admin account.");
    }
    const existing = await this.db.prepare("SELECT id FROM users WHERE UPPER(employee_code) = ?").bind(code).first();
    if (existing) {
      throw new Error(`An account with identifier "${code}" already exists.`);
    }
    const { hash, salt } = await hashPin(pin);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const userId = `usr_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const createdBy = actor ? `${actor.employeeName} (${actor.employeeCode})` : "SYSTEM";
    await this.db.prepare(
      `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, null, ?, ?, ?)`
    ).bind(userId, name, code, hash, salt, role, createdBy, now, now).run();
    return {
      id: userId,
      employeeName: name,
      employeeCode: code,
      role,
      active: true,
      createdBy,
      createdAt: now,
      updatedAt: now
    };
  }
  /**
   * Update user details (Name, identifier, role, active status).
   * Enforces strict protection so Admin cannot remove, deactivate, or downgrade a Super Admin.
   */
  async updateUser(userId, updates, actor) {
    await this.ensureSchemaReady();
    const existing = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }
    const targetRole = this.normalizeRole(existing.role);
    const requestedRole = updates.role !== void 0 ? this.normalizeRole(updates.role) : targetRole;
    if (targetRole === "super_admin" && actor && actor.role !== "super_admin") {
      throw new Error("Forbidden: Administrators cannot modify, deactivate, or downgrade a Super Admin account.");
    }
    if (requestedRole === "super_admin" && actor && actor.role !== "super_admin") {
      throw new Error("Forbidden: Only a Super Admin can assign the Super Admin role.");
    }
    if (targetRole === "super_admin" && updates.active === false) {
      const otherSuperAdmins = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?").bind(userId).first();
      if ((otherSuperAdmins?.count || 0) <= 0) {
        throw new Error("Cannot deactivate the primary active Super Admin account.");
      }
    }
    if (targetRole === "super_admin" && requestedRole !== "super_admin") {
      const otherSuperAdmins = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?").bind(userId).first();
      if ((otherSuperAdmins?.count || 0) <= 0) {
        throw new Error("Cannot downgrade the primary active Super Admin account.");
      }
    }
    if (updates.employeeCode) {
      const code = updates.employeeCode.trim().toUpperCase();
      const duplicate = await this.db.prepare("SELECT id FROM users WHERE UPPER(employee_code) = ? AND id != ?").bind(code, userId).first();
      if (duplicate) {
        throw new Error(`Employee identifier "${code}" is already in use.`);
      }
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const newName = updates.employeeName !== void 0 ? updates.employeeName.trim() : existing.employee_name;
    const newCode = updates.employeeCode !== void 0 ? updates.employeeCode.trim().toUpperCase() : existing.employee_code;
    const newRole = requestedRole;
    const newActive = updates.active !== void 0 ? updates.active ? 1 : 0 : existing.active;
    await this.db.prepare(
      `UPDATE users
         SET employee_name = ?, employee_code = ?, role = ?, active = ?, updated_at = ?
         WHERE id = ?`
    ).bind(newName, newCode, newRole, newActive, now, userId).run();
    if (newActive === 0) {
      await this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    }
    return {
      id: userId,
      employeeName: newName,
      employeeCode: newCode,
      role: newRole,
      active: Boolean(newActive),
      updatedAt: now
    };
  }
  /**
   * Reset employee 4-digit PIN (Super Admin or Admin).
   * Admin cannot reset a Super Admin's PIN.
   */
  async resetUserPin(userId, newPin, actor) {
    await this.ensureSchemaReady();
    const pin = (newPin || "").trim();
    if (!/^\d{4}$/.test(pin)) {
      throw new Error("PIN must be exactly 4 numeric digits");
    }
    const existing = await this.db.prepare("SELECT id, role FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }
    const targetRole = this.normalizeRole(existing.role);
    if (targetRole === "super_admin" && actor && actor.role !== "super_admin") {
      throw new Error("Forbidden: Administrators cannot reset a Super Admin PIN.");
    }
    const { hash, salt } = await hashPin(pin);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await this.db.prepare(
      `UPDATE users
         SET pin_hash = ?, pin_salt = ?, failed_login_attempts = 0, locked_until = NULL, updated_at = ?
         WHERE id = ?`
    ).bind(hash, salt, now, userId).run();
    await this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    return { success: true, message: "PIN reset successfully." };
  }
  /**
   * Delete an employee account safely while preserving historical scan records.
   * Admin cannot delete a Super Admin. The last active Super Admin cannot be deleted.
   */
  async deleteUser(userId, actor) {
    await this.ensureSchemaReady();
    const existing = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }
    const targetRole = this.normalizeRole(existing.role);
    if (targetRole === "super_admin" && actor && actor.role !== "super_admin") {
      throw new Error("Forbidden: Administrators cannot remove a Super Admin account.");
    }
    if (targetRole === "super_admin") {
      const otherSuperAdmins = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?").bind(userId).first();
      if ((otherSuperAdmins?.count || 0) <= 0) {
        throw new Error("Cannot delete the primary active Super Admin account.");
      }
    }
    await this.db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
    await this.db.prepare("UPDATE scan_events SET user_id = NULL WHERE user_id = ?").bind(userId).run();
    await this.db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
    return { success: true, message: "User deleted successfully while preserving scan audit history." };
  }
};

// src/server/realtime/realtimeHub.ts
var WS_OPEN = 1;
var HEARTBEAT_INTERVAL_MS = 15e3;
var STALE_CONNECTION_TIMEOUT_MS = 45e3;
var PalletTrackRealtimeBroker = class {
  constructor(options) {
    this.clients = /* @__PURE__ */ new Map();
    this.latestSeq = 0;
    this.heartbeatTimer = null;
    this.disableIntervalTimer = Boolean(options?.disableIntervalTimer);
  }
  setDurableObjectForwarder(fn) {
    this.durableObjectForwarder = fn;
  }
  getConnectedClientCount() {
    return this.clients.size;
  }
  isHeartbeatRunning() {
    return this.heartbeatTimer !== null;
  }
  /**
   * Lazily starts the periodic heartbeat timer inside an active request/connection context.
   * Safe against duplicate timers and no-ops when no clients are connected or when Durable Object
   * native alarms are managing the heartbeat schedule.
   */
  startHeartbeat() {
    if (this.disableIntervalTimer) return;
    if (this.heartbeatTimer !== null) return;
    if (this.clients.size === 0) return;
    try {
      this.heartbeatTimer = setInterval(() => {
        this.pruneStaleConnectionsAndPing();
      }, HEARTBEAT_INTERVAL_MS);
      if (typeof this.heartbeatTimer?.unref === "function") {
        this.heartbeatTimer.unref();
      }
    } catch {
      this.heartbeatTimer = null;
    }
  }
  /**
   * Stops and clears the active heartbeat interval timer when no clients remain connected.
   */
  stopHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
  pruneStaleConnectionsAndPing() {
    if (this.clients.size === 0) {
      this.stopHeartbeat();
      return;
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let changed = false;
    const affectedDeliveries = /* @__PURE__ */ new Set();
    for (const [connId, client] of this.clients.entries()) {
      if (client.socket.readyState !== WS_OPEN || nowMs - client.lastPongMs > STALE_CONNECTION_TIMEOUT_MS) {
        affectedDeliveries.add(client.activeDeliveryId);
        try {
          client.socket.close(4e3, "Heartbeat timeout");
        } catch {
        }
        this.clients.delete(connId);
        changed = true;
        continue;
      }
      try {
        client.socket.send(
          JSON.stringify({
            type: "ping",
            timestamp: nowIso,
            latestSeq: this.latestSeq
          })
        );
      } catch {
        affectedDeliveries.add(client.activeDeliveryId);
        this.clients.delete(connId);
        changed = true;
      }
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
    if (changed) {
      for (const delId of affectedDeliveries) {
        this.broadcastPresenceUpdate(delId);
      }
      this.broadcastPresenceUpdate(null);
    }
  }
  /**
   * Register a newly authenticated WebSocket connection
   */
  registerClient(socket, user, sessionToken, initialDeliveryId, lastSeq, db) {
    const connectionId = `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const client = {
      connectionId,
      socket,
      user,
      sessionToken,
      activeDeliveryId: initialDeliveryId || null,
      status: initialDeliveryId ? "viewing" : "dashboard",
      connectedAt: nowIso,
      lastActivityAt: nowIso,
      lastPongMs: Date.now()
    };
    this.clients.set(connectionId, client);
    this.startHeartbeat();
    this.safeSend(socket, {
      type: "connected",
      connectionId,
      user: {
        id: user.id,
        employeeName: user.employeeName,
        employeeCode: user.employeeCode,
        role: user.role
      },
      latestSeq: this.latestSeq,
      currentSequenceNumber: this.latestSeq,
      presence: this.getPresenceSummary(initialDeliveryId || null),
      timestamp: nowIso
    });
    if (db) {
      this.lastDb = db;
      this.getLatestSequenceNumber(db).then(async (latestDbSeq) => {
        if (typeof lastSeq === "number" && lastSeq > 0 && latestDbSeq > lastSeq) {
          const missedEvents = await this.getEventsSince(
            db,
            lastSeq,
            initialDeliveryId || void 0
          );
          if (missedEvents.length > 0) {
            this.safeSend(socket, {
              type: "sync_catchup",
              sinceSeq: lastSeq,
              latestSeq: latestDbSeq,
              presence: this.getPresenceSummary(initialDeliveryId || null),
              events: missedEvents,
              timestamp: (/* @__PURE__ */ new Date()).toISOString()
            });
          }
        } else if (latestDbSeq > 0) {
          this.safeSend(socket, {
            type: "pong",
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            latestSeq: latestDbSeq
          });
        }
      }).catch(() => {
      });
    }
    this.broadcastPresenceUpdate(initialDeliveryId || null);
    if (initialDeliveryId) {
      this.broadcastPresenceUpdate(null);
    }
    return connectionId;
  }
  /**
   * Remove a disconnected client and broadcast updated worker presence
   */
  unregisterClient(connectionId) {
    const existing = this.clients.get(connectionId);
    if (!existing) {
      if (this.clients.size === 0) {
        this.stopHeartbeat();
      }
      return;
    }
    const prevDeliveryId = existing.activeDeliveryId;
    this.clients.delete(connectionId);
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
    this.broadcastPresenceUpdate(prevDeliveryId);
    if (prevDeliveryId !== null) {
      this.broadcastPresenceUpdate(null);
    }
  }
  /**
   * Immediately disconnect all active WebSockets for a deactivated or logged-out user
   */
  disconnectUser(userId, reason = "Session ended or account deactivated") {
    const affectedDeliveries = /* @__PURE__ */ new Set();
    for (const [connId, client] of this.clients.entries()) {
      if (client.user.id === userId) {
        affectedDeliveries.add(client.activeDeliveryId);
        this.safeSend(client.socket, {
          type: "auth_revoked",
          reason,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        try {
          client.socket.close(4003, reason);
        } catch {
        }
        this.clients.delete(connId);
      }
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
    for (const delId of affectedDeliveries) {
      this.broadcastPresenceUpdate(delId);
    }
    if (affectedDeliveries.size > 0) {
      this.broadcastPresenceUpdate(null);
    }
  }
  /**
   * Disconnect a specific session token on logout
   */
  disconnectSessionToken(sessionToken) {
    if (!sessionToken) return;
    const affectedDeliveries = /* @__PURE__ */ new Set();
    for (const [connId, client] of this.clients.entries()) {
      if (client.sessionToken === sessionToken) {
        affectedDeliveries.add(client.activeDeliveryId);
        try {
          client.socket.close(4001, "Logged out");
        } catch {
        }
        this.clients.delete(connId);
      }
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
    for (const delId of affectedDeliveries) {
      this.broadcastPresenceUpdate(delId);
    }
    if (affectedDeliveries.size > 0) {
      this.broadcastPresenceUpdate(null);
    }
  }
  /**
   * Handle incoming WebSocket message from a connected client
   */
  async handleClientMessage(connectionId, rawMessage, db) {
    const client = this.clients.get(connectionId);
    if (!client) return;
    this.startHeartbeat();
    client.lastPongMs = Date.now();
    client.lastActivityAt = (/* @__PURE__ */ new Date()).toISOString();
    let msg;
    try {
      msg = JSON.parse(rawMessage);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ping": {
        const latestSeq = db ? await this.getLatestSequenceNumber(db) : this.latestSeq;
        this.safeSend(client.socket, {
          type: "pong",
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          latestSeq
        });
        break;
      }
      case "pong": {
        break;
      }
      case "join_delivery": {
        const prevDeliveryId = client.activeDeliveryId;
        const nextDeliveryId = typeof msg.deliveryId === "string" && msg.deliveryId.trim() ? msg.deliveryId.trim() : null;
        const nextStatus = msg.status === "scanning" ? "scanning" : nextDeliveryId ? "viewing" : "dashboard";
        client.activeDeliveryId = nextDeliveryId;
        client.status = nextStatus;
        if (prevDeliveryId !== nextDeliveryId) {
          if (prevDeliveryId) this.broadcastPresenceUpdate(prevDeliveryId);
          if (nextDeliveryId) this.broadcastPresenceUpdate(nextDeliveryId);
        } else if (nextDeliveryId) {
          this.broadcastPresenceUpdate(nextDeliveryId);
        }
        this.broadcastPresenceUpdate(null);
        break;
      }
      case "leave_delivery": {
        const prevDeliveryId = client.activeDeliveryId;
        client.activeDeliveryId = null;
        client.status = "dashboard";
        if (prevDeliveryId) {
          this.broadcastPresenceUpdate(prevDeliveryId);
        }
        this.broadcastPresenceUpdate(null);
        break;
      }
      case "worker_status": {
        const nextStatus = msg.status === "scanning" ? "scanning" : client.activeDeliveryId ? "viewing" : "dashboard";
        const statusChanged = client.status !== nextStatus;
        client.status = nextStatus;
        if (typeof msg.lastScanSummary === "string") {
          client.lastScanSummary = msg.lastScanSummary.slice(0, 160);
        }
        if (statusChanged || msg.lastScanSummary) {
          if (client.activeDeliveryId) {
            this.broadcastPresenceUpdate(client.activeDeliveryId);
          }
          this.broadcastPresenceUpdate(null);
        }
        break;
      }
      case "scanning_activity": {
        if (!client.activeDeliveryId) break;
        client.status = "scanning";
        if (typeof msg.summary === "string") {
          client.lastScanSummary = msg.summary.slice(0, 160);
        }
        const activityEvent = {
          id: `rt_act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: "worker:scanning_activity",
          sequenceNumber: this.latestSeq,
          deliveryId: client.activeDeliveryId,
          partId: typeof msg.partId === "string" ? msg.partId : void 0,
          userId: client.user.id,
          employeeName: client.user.employeeName,
          employeeRole: client.user.role,
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          payload: {
            action: msg.action || "scanning",
            partNumber: msg.partNumber,
            itemNumber: msg.itemNumber,
            summary: msg.summary || `${client.user.employeeName} is scanning`
          }
        };
        this.broadcastToDeliveryRoom(client.activeDeliveryId, {
          type: "event",
          event: activityEvent
        });
        this.broadcastPresenceUpdate(client.activeDeliveryId);
        break;
      }
      case "sync_request": {
        if (!db) break;
        this.lastDb = db;
        const sinceSeq = Math.max(0, Number(msg.sinceSeq) || 0);
        const deliveryId = typeof msg.deliveryId === "string" && msg.deliveryId.trim() ? msg.deliveryId.trim() : void 0;
        const missedEvents = await this.getEventsSince(db, sinceSeq, deliveryId);
        const latestSeq = await this.getLatestSequenceNumber(db);
        this.safeSend(client.socket, {
          type: "sync_response",
          sinceSeq,
          latestSeq,
          events: missedEvents,
          presence: this.getPresenceSummary(client.activeDeliveryId),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
        break;
      }
    }
  }
  /**
   * Build live worker presence summary for a specific delivery room and globally
   */
  getPresenceSummary(deliveryId = null) {
    const allDevices = [];
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WS_OPEN) continue;
      allDevices.push({
        connectionId: client.connectionId,
        userId: client.user.id,
        employeeName: client.user.employeeName,
        employeeCode: client.user.employeeCode,
        role: client.user.role,
        activeDeliveryId: client.activeDeliveryId,
        status: client.status,
        connectedAt: client.connectedAt,
        lastActivityAt: client.lastActivityAt,
        lastScanSummary: client.lastScanSummary
      });
    }
    const dedupByUser = (list) => {
      const byUser = /* @__PURE__ */ new Map();
      const rank = { scanning: 3, viewing: 2, dashboard: 1 };
      for (const item of list) {
        const prev = byUser.get(item.userId);
        if (!prev || rank[item.status] > rank[prev.status] || item.lastActivityAt > prev.lastActivityAt) {
          byUser.set(item.userId, item);
        }
      }
      return Array.from(byUser.values());
    };
    const allUniqueWorkers = dedupByUser(allDevices);
    const roomDevices = deliveryId ? allDevices.filter((d) => d.activeDeliveryId === deliveryId) : allDevices;
    const roomUniqueWorkers = dedupByUser(roomDevices);
    return {
      deliveryId,
      connectedWorkersCount: allUniqueWorkers.length,
      deliveryWorkersCount: roomUniqueWorkers.length,
      connectedDevicesCount: roomDevices.length,
      workers: roomUniqueWorkers,
      deliveryWorkers: roomUniqueWorkers,
      allConnectedWorkers: allUniqueWorkers,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  /**
   * Broadcast presence update to clients in a delivery room (or globally if deliveryId is null)
   */
  broadcastPresenceUpdate(deliveryId = null) {
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WS_OPEN) continue;
      if (deliveryId !== null && client.activeDeliveryId !== deliveryId) {
        continue;
      }
      const summary = this.getPresenceSummary(client.activeDeliveryId);
      const event = {
        id: `rt_pres_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        type: "presence:updated",
        sequenceNumber: this.latestSeq,
        deliveryId: client.activeDeliveryId || void 0,
        timestamp: nowIso,
        payload: summary
      };
      this.safeSend(client.socket, {
        type: "event",
        event
      });
    }
  }
  /**
   * Persist an authoritative state-change event to D1 `realtime_events`, assign a monotonic
   * sequenceNumber, update the scanning worker's live activity summary, and broadcast to
   * all connected clients immediately.
   */
  async publishEvent(db, input) {
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const eventId = `rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const payloadJson = JSON.stringify(input.payload || {});
    let seq = this.latestSeq + 1;
    try {
      const insertRes = await db.prepare(
        `INSERT INTO realtime_events (
            id, event_type, delivery_id, part_id, user_id, employee_name, employee_role,
            delivery_version, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        eventId,
        input.type,
        input.deliveryId || null,
        input.partId || null,
        input.userId || null,
        input.employeeName || null,
        input.employeeRole || null,
        input.deliveryVersion ?? null,
        payloadJson,
        nowIso
      ).run();
      const lastRowId = Number(insertRes.meta?.last_row_id);
      if (Number.isFinite(lastRowId) && lastRowId > 0) {
        seq = lastRowId;
      } else {
        const row = await db.prepare("SELECT seq FROM realtime_events WHERE id = ?").bind(eventId).first();
        if (row?.seq) {
          seq = Number(row.seq);
        }
      }
      if (seq > this.latestSeq) {
        this.latestSeq = seq;
      }
      if (seq % 200 === 0 && seq > 2e3) {
        db.prepare("DELETE FROM realtime_events WHERE seq < ?").bind(seq - 2e3).run().catch(() => {
        });
      }
    } catch (err) {
      console.warn("Realtime event persistence fallback notice:", err);
      this.latestSeq = seq;
    }
    if (input.userId && input.deliveryId) {
      let summaryText;
      if (input.type === "part:scanned" || input.type === "quantity:updated") {
        const partNo = input.payload?.part?.partNumber || input.payload?.partNumber || "";
        const recQty = input.payload?.part?.receivedQuantity ?? input.payload?.receivedQuantity;
        const reqQty = input.payload?.part?.quantity ?? input.payload?.requiredQuantity;
        summaryText = `Scanned ${partNo} (${recQty}/${reqQty})`;
      } else if (input.type === "part:duplicate_rejected") {
        const partNo = input.payload?.part?.partNumber || input.payload?.partNumber || "";
        summaryText = `Duplicate scan blocked on ${partNo}`;
      } else if (input.type === "part:added" || input.type === "part:edited") {
        const partNo = input.payload?.part?.partNumber || "";
        summaryText = `Edited ${partNo}`;
      }
      if (summaryText) {
        for (const client of this.clients.values()) {
          if (client.user.id === input.userId) {
            client.lastScanSummary = summaryText;
            client.lastActivityAt = nowIso;
          }
        }
      }
    }
    const event = {
      id: eventId,
      type: input.type,
      sequenceNumber: seq,
      deliveryId: input.deliveryId,
      partId: input.partId,
      userId: input.userId,
      employeeName: input.employeeName,
      employeeRole: input.employeeRole,
      deliveryVersion: input.deliveryVersion,
      timestamp: nowIso,
      payload: input.payload || {}
    };
    this.broadcastEvent(event);
    if (this.durableObjectForwarder) {
      this.durableObjectForwarder(event).catch(() => {
      });
    }
    return event;
  }
  /**
   * Broadcast a RealtimeEvent to all connected authenticated WebSocket clients.
   */
  broadcastEvent(event) {
    if (event.sequenceNumber > this.latestSeq) {
      this.latestSeq = event.sequenceNumber;
    }
    const packet = JSON.stringify({
      type: "event",
      event
    });
    const isRoomScopedOnly = event.type === "worker:scanning_activity" || event.type === "part:duplicate_rejected";
    for (const [connId, client] of this.clients.entries()) {
      if (client.socket.readyState !== WS_OPEN) {
        this.clients.delete(connId);
        continue;
      }
      if (isRoomScopedOnly && event.deliveryId) {
        if (client.activeDeliveryId !== event.deliveryId && client.user.id !== event.userId) {
          continue;
        }
      }
      try {
        client.socket.send(packet);
      } catch {
        this.clients.delete(connId);
      }
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }
  broadcastToDeliveryRoom(deliveryId, message) {
    const packet = JSON.stringify(message);
    for (const [connId, client] of this.clients.entries()) {
      if (client.socket.readyState !== WS_OPEN) {
        this.clients.delete(connId);
        continue;
      }
      if (client.activeDeliveryId === deliveryId) {
        try {
          client.socket.send(packet);
        } catch {
          this.clients.delete(connId);
        }
      }
    }
    if (this.clients.size === 0) {
      this.stopHeartbeat();
    }
  }
  safeSend(socket, payload) {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch {
    }
  }
  /**
   * Query missed events since `sinceSeq` from D1 `realtime_events`
   */
  async getEventsSince(db, sinceSeq, deliveryId) {
    try {
      let rowsRes;
      if (deliveryId) {
        rowsRes = await db.prepare(
          `SELECT * FROM realtime_events
             WHERE seq > ? AND (delivery_id = ? OR delivery_id IS NULL OR event_type LIKE 'delivery:%' OR event_type LIKE 'deliveries:%' OR event_type LIKE 'group:%')
             ORDER BY seq ASC
             LIMIT 300`
        ).bind(sinceSeq, deliveryId).all();
      } else {
        rowsRes = await db.prepare(
          `SELECT * FROM realtime_events
             WHERE seq > ?
             ORDER BY seq ASC
             LIMIT 300`
        ).bind(sinceSeq).all();
      }
      const events = [];
      for (const row of rowsRes.results || []) {
        let parsedPayload = {};
        try {
          parsedPayload = JSON.parse(row.payload);
        } catch {
          parsedPayload = {};
        }
        if (row.seq > this.latestSeq) {
          this.latestSeq = row.seq;
        }
        events.push({
          id: row.id,
          type: row.event_type,
          sequenceNumber: Number(row.seq),
          deliveryId: row.delivery_id || void 0,
          partId: row.part_id || void 0,
          userId: row.user_id || void 0,
          employeeName: row.employee_name || void 0,
          employeeRole: row.employee_role || void 0,
          deliveryVersion: row.delivery_version !== null && row.delivery_version !== void 0 ? Number(row.delivery_version) : void 0,
          timestamp: row.created_at,
          payload: parsedPayload
        });
      }
      return events;
    } catch {
      return [];
    }
  }
  /**
   * Synchronises this isolate's sequence number with D1 and broadcasts any new events
   * written by other Cloudflare Worker isolates since `this.latestSeq` to connected clients.
   */
  async syncFromDatabase(db) {
    const activeDb = db || this.lastDb;
    if (!activeDb) return [];
    this.lastDb = activeDb;
    const prevSeq = this.latestSeq;
    const dbMax = await this.getLatestSequenceNumber(activeDb);
    if (dbMax > prevSeq) {
      const missed = await this.getEventsSince(activeDb, prevSeq);
      for (const ev of missed) {
        this.broadcastEvent(ev);
      }
      return missed;
    }
    return [];
  }
  /**
   * Get the latest sequence number from memory or D1
   */
  async getLatestSequenceNumber(db) {
    this.lastDb = db;
    try {
      const row = await db.prepare("SELECT MAX(seq) as max_seq FROM realtime_events").first();
      const dbMax = Number(row?.max_seq || 0);
      if (dbMax > this.latestSeq) {
        this.latestSeq = dbMax;
      }
    } catch {
    }
    return this.latestSeq;
  }
};
var _realtimeBrokerInstance = null;
function getRealtimeBroker() {
  if (!_realtimeBrokerInstance) {
    _realtimeBrokerInstance = new PalletTrackRealtimeBroker();
  }
  return _realtimeBrokerInstance;
}
var realtimeBroker = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === "constructor") {
        return PalletTrackRealtimeBroker;
      }
      const instance = getRealtimeBroker();
      const value = Reflect.get(instance, prop, instance);
      return typeof value === "function" ? value.bind(instance) : value;
    },
    set(_target, prop, value) {
      const instance = getRealtimeBroker();
      return Reflect.set(instance, prop, value, instance);
    }
  }
);

// src/server/api/palletTrackApiRouter.ts
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
  "Access-Control-Allow-Credentials": "true"
};
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
      ...extraHeaders
    }
  });
}
function errorResponse(message, status = 400, code, extraHeaders = {}) {
  return new Response(
    JSON.stringify({
      error: message,
      code: code || "BAD_REQUEST"
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...CORS_HEADERS,
        ...extraHeaders
      }
    }
  );
}
function extractSessionTokenFromRequest(request) {
  try {
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    if (queryToken && queryToken.trim()) {
      return queryToken.trim();
    }
  } catch {
  }
  const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = request.headers.get("cookie");
  if (cookieHeader) {
    const match = cookieHeader.match(/(?:^|;\s*)pallettrack_session=([^;]+)/);
    if (match) {
      return decodeURIComponent(match[1].trim());
    }
  }
  return null;
}
function extractToken(request) {
  return extractSessionTokenFromRequest(request);
}
function buildSetCookieHeader(token, maxAge = 28800) {
  return `pallettrack_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}
function buildClearCookieHeader() {
  return `pallettrack_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
function isAdminRole(role) {
  return role === "super_admin" || role === "admin";
}
function isSupervisorOrAdminRole(role) {
  const r = (role || "").trim().toLowerCase();
  return r === "super_admin" || r === "admin" || r === "supervisor";
}
function isEmployeeRole(role) {
  return role === "employee" || role === "operator";
}
async function handlePalletTrackApiRequest(request, db, env) {
  const url = new URL(request.url);
  const path3 = url.pathname;
  const method = request.method;
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    });
  }
  if (!path3.startsWith("/api/")) {
    return null;
  }
  const service = new PalletTrackDbService(db);
  const userAgent = request.headers.get("user-agent") || void 0;
  const ipAddress = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || void 0;
  const expectedSetupSecret = env && typeof env === "object" && "INITIAL_SETUP_SECRET" in env ? String(env.INITIAL_SETUP_SECRET ?? "").trim() : typeof process !== "undefined" && process.env?.INITIAL_SETUP_SECRET ? String(process.env.INITIAL_SETUP_SECRET).trim() : "";
  try {
    await service.ensureSchemaReady();
    if (path3 === "/api/health") {
      try {
        const ping = await db.prepare("SELECT 1 as alive").first();
        const prov = await service.getProvisionStatus();
        return jsonResponse({
          status: "ok",
          app: "PartTrack",
          tagline: "Track every part. Every pallet. Every order.",
          database: "Cloudflare D1 (centralised)",
          dbConnected: Boolean(ping),
          hasSuperAdmin: prov.hasSuperAdmin,
          hasAdmin: prov.hasAdmin,
          adminCount: prov.adminCount,
          totalUsers: prov.totalUsers,
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        });
      } catch (err) {
        return jsonResponse(
          {
            status: "degraded",
            app: "PartTrack",
            database: "Cloudflare D1 (error)",
            dbConnected: false,
            error: err?.message,
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          },
          500
        );
      }
    }
    if (path3 === "/api/auth/provision-status" && method === "GET") {
      const status = await service.getProvisionStatus();
      return jsonResponse(status);
    }
    if (path3 === "/api/auth/setup-admin" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!body.employeeName || !body.employeeCode || !body.pin) {
        return errorResponse(
          "Missing required fields: employeeName, employeeCode, and 4-digit pin are required.",
          400,
          "MISSING_FIELDS"
        );
      }
      try {
        const result = await service.setupInitialAdmin({
          employeeName: body.employeeName,
          employeeCode: body.employeeCode,
          pin: body.pin,
          setupSecret: typeof body.setupSecret === "string" ? body.setupSecret : "",
          expectedSetupSecret,
          userAgent,
          ipAddress
        });
        return jsonResponse(
          {
            success: true,
            user: result.user,
            token: result.token,
            expiresAt: result.expiresAt,
            message: "Initial Super Admin provisioned successfully."
          },
          201,
          { "Set-Cookie": buildSetCookieHeader(result.token) }
        );
      } catch (err) {
        const statusCode = typeof err?.status === "number" ? err.status : err?.code === "SETUP_SECRET_NOT_CONFIGURED" || err?.code === "SETUP_SECRET_WEAK" ? 503 : err?.code === "SETUP_RATE_LIMITED" ? 429 : err?.code === "SETUP_ALREADY_COMPLETED" || err?.code === "INVALID_SETUP_SECRET" ? 403 : 400;
        return errorResponse(
          err?.message || "Failed to provision initial Super Admin",
          statusCode,
          err?.code || "SETUP_FAILED"
        );
      }
    }
    if (path3 === "/api/auth/login" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const { employeeCode, pin } = body;
      if (!employeeCode || !pin) {
        return errorResponse("Invalid employee identifier or PIN", 401, "INVALID_CREDENTIALS");
      }
      try {
        const result = await service.loginWithPin(employeeCode, pin, userAgent, ipAddress);
        return jsonResponse(
          {
            success: true,
            user: result.user,
            token: result.token,
            expiresAt: result.expiresAt
          },
          200,
          { "Set-Cookie": buildSetCookieHeader(result.token) }
        );
      } catch (err) {
        const msg = err?.message || "Invalid employee identifier or PIN";
        const isLockout = msg.includes("locked");
        const isDeactivated = msg.includes("deactivated");
        return errorResponse(
          msg,
          isLockout ? 429 : isDeactivated ? 403 : 401,
          isLockout ? "ACCOUNT_LOCKED" : isDeactivated ? "ACCOUNT_DEACTIVATED" : "INVALID_CREDENTIALS"
        );
      }
    }
    if (path3 === "/api/auth/logout" && method === "POST") {
      const token = extractToken(request);
      if (token) {
        realtimeBroker.disconnectSessionToken(token);
        await service.revokeSession(token);
      }
      return jsonResponse(
        { success: true, message: "Logged out successfully." },
        200,
        { "Set-Cookie": buildClearCookieHeader() }
      );
    }
    if (path3 === "/api/auth/session" && method === "GET") {
      const token = extractToken(request);
      if (!token) {
        return errorResponse("No active session token provided", 401, "UNAUTHORIZED");
      }
      const user = await service.validateSession(token);
      if (!user) {
        return errorResponse(
          "Session expired or invalid. Please log in again.",
          401,
          "SESSION_EXPIRED",
          { "Set-Cookie": buildClearCookieHeader() }
        );
      }
      return jsonResponse({
        authenticated: true,
        user
      });
    }
    async function authenticateSession() {
      const prov = await service.getProvisionStatus();
      if (!prov.hasAdmin) {
        return errorResponse(
          "Initial Super Admin setup required before using PartTrack.",
          428,
          "SETUP_REQUIRED"
        );
      }
      const token = extractToken(request);
      if (!token) {
        return errorResponse(
          "Authentication required. Please log in with your 4-digit PIN.",
          401,
          "UNAUTHORIZED"
        );
      }
      const user = await service.validateSession(token);
      if (!user) {
        return errorResponse(
          "Session expired or invalid. Please log in again.",
          401,
          "SESSION_EXPIRED",
          { "Set-Cookie": buildClearCookieHeader() }
        );
      }
      return user;
    }
    if (path3.startsWith("/api/users")) {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (!isAdminRole(currentUser.role)) {
        return errorResponse(
          "Forbidden: Administrator privileges required to manage accounts.",
          403,
          "FORBIDDEN"
        );
      }
      if (path3 === "/api/users" && method === "GET") {
        const users = await service.listUsers();
        return jsonResponse(users);
      }
      if (path3 === "/api/users" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        try {
          const created = await service.createUser(body, currentUser);
          return jsonResponse(created, 201);
        } catch (err) {
          const isForbidden = String(err?.message || "").startsWith("Forbidden:");
          return errorResponse(
            err?.message || "Failed to create account",
            isForbidden ? 403 : 400,
            isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
          );
        }
      }
      const userMatch = path3.match(/^\/api\/users\/([^/]+)(.*)$/);
      if (userMatch) {
        const targetUserId = decodeURIComponent(userMatch[1]);
        const sub = userMatch[2];
        if (sub === "/reset-pin" && method === "POST") {
          const body = await request.json().catch(() => ({}));
          const pinValue = body.pin ?? body.newPin;
          if (!pinValue) {
            return errorResponse("New 4-digit PIN is required.", 400);
          }
          try {
            const res = await service.resetUserPin(targetUserId, pinValue, currentUser);
            realtimeBroker.disconnectUser(targetUserId, "PIN reset by administrator");
            return jsonResponse(res);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to reset PIN",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
        if ((sub === "" || sub === "/") && (method === "PATCH" || method === "PUT")) {
          const body = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateUser(targetUserId, body, currentUser);
            if (body.active === false || !updated.active) {
              realtimeBroker.disconnectUser(targetUserId, "Account deactivated by administrator");
            }
            return jsonResponse(updated);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to update user",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
        if ((sub === "" || sub === "/") && method === "DELETE") {
          try {
            const deleted = await service.deleteUser(targetUserId, currentUser);
            realtimeBroker.disconnectUser(targetUserId, "Account deleted by administrator");
            return jsonResponse(deleted);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to delete user",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
      }
    }
    if (path3 === "/api/realtime/events" && method === "GET") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const sinceSeq = Math.max(0, Number(url.searchParams.get("sinceSeq")) || 0);
      const deliveryId = url.searchParams.get("deliveryId") || void 0;
      const events = await realtimeBroker.getEventsSince(db, sinceSeq, deliveryId);
      const latestSeq = await realtimeBroker.getLatestSequenceNumber(db);
      const presence = realtimeBroker.getPresenceSummary(deliveryId || null);
      return jsonResponse({
        events,
        latestSeq,
        presence,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    if (path3 === "/api/realtime/presence" && method === "GET") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const deliveryId = url.searchParams.get("deliveryId") || null;
      const presence = realtimeBroker.getPresenceSummary(deliveryId);
      const latestSeq = await realtimeBroker.getLatestSequenceNumber(db);
      return jsonResponse({
        presence,
        latestSeq,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
    }
    if (path3 === "/api/deliveries/processing" && method === "POST") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (isEmployeeRole(currentUser.role)) {
        return errorResponse("Forbidden: Employees cannot upload new deliveries.", 403, "FORBIDDEN");
      }
      const body = await request.json().catch(() => ({}));
      const rtEvent = await realtimeBroker.publishEvent(db, {
        type: "delivery:processing",
        userId: currentUser.id,
        employeeName: currentUser.employeeName,
        employeeRole: currentUser.role,
        payload: {
          status: body.status || "processing",
          fileName: body.fileName || "Delivery Docket",
          fileCount: Number(body.fileCount) || 1,
          employeeName: currentUser.employeeName
        }
      });
      return jsonResponse({
        success: true,
        sequenceNumber: rtEvent.sequenceNumber
      });
    }
    if (path3 === "/api/deliveries/migrate" && method === "POST") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (isEmployeeRole(currentUser.role)) {
        return errorResponse("Forbidden: Employee role cannot trigger data migration.", 403, "FORBIDDEN");
      }
      const body = await request.json().catch(() => ({}));
      const { deliveries } = body;
      if (!Array.isArray(deliveries)) {
        return errorResponse('Expected an array of deliveries to migrate in "deliveries" field.', 400);
      }
      const result = await service.migrateLocalDeliveries(deliveries);
      return jsonResponse({
        success: true,
        message: `Migration complete: ${result.importedCount} imported, ${result.skippedCount} skipped (already in database).`,
        ...result
      });
    }
    if (path3 === "/api/deliveries") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (method === "GET") {
        const list = await service.listDeliveries();
        return jsonResponse(list);
      }
      if (method === "POST") {
        if (isEmployeeRole(currentUser.role)) {
          return errorResponse(
            "Forbidden: Employees cannot create new deliveries. Contact your supervisor or administrator.",
            403,
            "FORBIDDEN"
          );
        }
        const body = await request.json().catch(() => null);
        if (!body || !body.docketNumber) {
          return errorResponse("Missing required delivery docketNumber", 400);
        }
        body.createdBy = currentUser.id;
        try {
          const created = await service.createDelivery(body);
          if (created) {
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: "delivery:created",
              deliveryId: created.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: created.version || 1,
              payload: {
                delivery: created,
                createdByName: currentUser.employeeName
              }
            });
            return jsonResponse({ ...created, sequenceNumber: rtEvent.sequenceNumber }, 201);
          }
          return jsonResponse(created, 201);
        } catch (err) {
          if (err?.code === "DUPLICATE_DOCKET" || err?.status === 409) {
            return new Response(
              JSON.stringify({
                error: err.message,
                code: "DUPLICATE_DOCKET",
                existingDeliveryId: err.existingDeliveryId
              }),
              {
                status: 409,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS }
              }
            );
          }
          throw err;
        }
      }
    }
    if (path3 === "/api/deliveries/clear-all" && method === "POST") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (!isSupervisorOrAdminRole(currentUser.role)) {
        return errorResponse(
          "Forbidden: Only Super Admin, Admin, or Supervisor roles can clear all dockets.",
          403,
          "FORBIDDEN"
        );
      }
      const cleared = await service.clearAllDeliveries();
      const rtEvent = await realtimeBroker.publishEvent(db, {
        type: "deliveries:cleared",
        userId: currentUser.id,
        employeeName: currentUser.employeeName,
        employeeRole: currentUser.role,
        payload: {
          deletedDeliveriesCount: cleared.deletedDeliveriesCount,
          clearedBy: currentUser.employeeName
        }
      });
      return jsonResponse({
        success: true,
        deletedDeliveries: cleared.deletedDeliveriesCount,
        deletedGroups: cleared.deletedGroupsCount,
        ...cleared,
        sequenceNumber: rtEvent.sequenceNumber
      });
    }
    const deliveryPathMatch = path3.match(/^\/api\/deliveries\/([^/]+)(.*)$/);
    if (deliveryPathMatch) {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      const deliveryId = decodeURIComponent(deliveryPathMatch[1]);
      const subPath = deliveryPathMatch[2];
      if (subPath === "" || subPath === "/") {
        if (method === "GET") {
          const delivery = await service.getDeliveryById(deliveryId);
          if (!delivery) {
            return errorResponse(`Delivery not found: ${deliveryId}`, 404, "NOT_FOUND");
          }
          return jsonResponse(delivery);
        }
        if (method === "PUT" || method === "PATCH") {
          if (isEmployeeRole(currentUser.role)) {
            return errorResponse(
              "Forbidden: Employees cannot modify delivery headers or status.",
              403,
              "FORBIDDEN"
            );
          }
          const body = await request.json().catch(() => ({}));
          const prevDelivery = await service.getDeliveryById(deliveryId);
          const updated = await service.updateDelivery(deliveryId, body);
          if (updated) {
            const prevStatus = prevDelivery?.status || prevDelivery?.deliveryStatus;
            const nextStatus = updated.status || updated.deliveryStatus;
            const eventType = prevDelivery && prevStatus !== "completed" && nextStatus === "completed" ? "delivery:completed" : prevDelivery && prevStatus === "completed" && nextStatus === "receiving" ? "delivery:reopened" : "delivery:updated";
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: eventType,
              deliveryId: updated.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: updated.version || 1,
              payload: {
                delivery: updated,
                status: nextStatus,
                updatedByName: currentUser.employeeName
              }
            });
            return jsonResponse({ ...updated, sequenceNumber: rtEvent.sequenceNumber });
          }
          return jsonResponse(updated);
        }
        if (method === "DELETE") {
          if (!isSupervisorOrAdminRole(currentUser.role)) {
            return errorResponse(
              "Forbidden: Only Super Admin, Admin, or Supervisor roles can delete dockets.",
              403,
              "FORBIDDEN"
            );
          }
          if (url.searchParams.get("completedOnly") === "1") {
            const targetDel = await service.getDeliveryById(deliveryId);
            if (!targetDel) {
              return errorResponse(`Delivery not found: ${deliveryId}`, 404, "NOT_FOUND");
            }
            const isDone = targetDel.status === "completed" || targetDel.parts.length > 0 && targetDel.parts.every(
              (p) => p.status === "received" && (p.verificationStatus === "verified" || (p.receivedQuantity ?? 0) >= Math.max(1, p.quantity ?? 1))
            );
            if (!isDone) {
              return errorResponse(
                "Only completed dockets can be deleted individually. Complete all parts or use Clear All Dockets.",
                409,
                "INCOMPLETE_DOCKET_DELETE_BLOCKED"
              );
            }
          }
          const deleted = await service.deleteDelivery(deliveryId);
          if (!deleted || !deleted.deleted) {
            return errorResponse(`Delivery not found: ${deliveryId}`, 404, "NOT_FOUND");
          }
          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: "delivery:deleted",
            deliveryId,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            payload: {
              deliveryId,
              docketNumber: deleted.docketNumber,
              deletedBy: currentUser.employeeName
            }
          });
          return jsonResponse({
            success: true,
            deleted: true,
            id: deliveryId,
            docketNumber: deleted.docketNumber,
            sequenceNumber: rtEvent.sequenceNumber
          });
        }
      }
      if (subPath === "/parts" || subPath === "/parts/") {
        if (method === "GET") {
          const parts = await service.getDeliveryParts(deliveryId);
          return jsonResponse(parts);
        }
        if (method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (!body || !String(body.partNumber || "").trim()) {
            return errorResponse("Part Number is required when adding a part.", 400);
          }
          try {
            const added = await service.addDeliveryPart(deliveryId, body, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: "part:added",
              deliveryId,
              partId: added.part?.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: added.delivery?.version || 1,
              payload: {
                part: added.part,
                delivery: added.delivery,
                actorName: currentUser.employeeName
              }
            });
            return jsonResponse({ ...added, sequenceNumber: rtEvent.sequenceNumber }, 201);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to add part to delivery",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
        if (method === "PUT") {
          const body = await request.json().catch(() => ({}));
          const partsArray = Array.isArray(body) ? body : body?.parts;
          if (!Array.isArray(partsArray)) {
            return errorResponse('Expected an array of parts in "parts" field.', 400);
          }
          try {
            const saved = await service.batchSaveDeliveryParts(deliveryId, partsArray, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: "parts:batch_saved",
              deliveryId,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: saved.delivery?.version || 1,
              payload: {
                delivery: saved.delivery,
                actorName: currentUser.employeeName
              }
            });
            return jsonResponse({ ...saved, sequenceNumber: rtEvent.sequenceNumber }, 200);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to save parts list",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
      }
      const partReceiveMatch = subPath.match(/^\/parts\/([^/]+)\/(?:receive|quantity)$/);
      if (partReceiveMatch && (method === "POST" || method === "PUT")) {
        const partId = decodeURIComponent(partReceiveMatch[1]);
        const body = await request.json().catch(() => ({}));
        if (typeof body.receivedQuantity === "undefined") {
          return errorResponse("receivedQuantity is required", 400);
        }
        if (isEmployeeRole(currentUser.role) && body.scannedVia === "manual" && body.overrideAllowed === false) {
          return errorResponse("Forbidden: Employees cannot manually override quantities.", 403, "FORBIDDEN");
        }
        const receivePayload = {
          ...body,
          scannedVia: body.scannedVia || body.scanType || "qr",
          scannedCode: body.scannedCode || body.code,
          userId: currentUser.id,
          employeeName: currentUser.employeeName,
          employeeRole: currentUser.role,
          eventAction: body.eventAction || (Number(body.receivedQuantity) > 0 ? "part_receive" : "part_untick")
        };
        const result = await service.updatePartReceivedQuantity(deliveryId, partId, receivePayload);
        if (result.duplicate) {
          await realtimeBroker.publishEvent(db, {
            type: "part:duplicate_rejected",
            deliveryId,
            partId,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            payload: {
              part: result.part,
              alreadyScannedBy: result.alreadyScannedBy,
              alreadyScannedAt: result.alreadyScannedAt,
              attemptedBy: currentUser.employeeName,
              message: result.message
            }
          });
          return jsonResponse(result, 409);
        }
        if (!result.idempotentReplay) {
          const isUndo = result.part?.status === "outstanding" || Number(result.part?.receivedQuantity) === 0;
          const isPartialQtyUpdate = !isUndo && result.part?.verificationStatus === "quantity_mismatch" && Number(result.part?.receivedQuantity) < Number(result.part?.quantity);
          const eventType = isUndo ? "part:scan_reversed" : body.scannedVia === "manual" || isPartialQtyUpdate ? "quantity:updated" : "part:scanned";
          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: eventType,
            deliveryId,
            partId,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            deliveryVersion: result.deliveryVersion || 1,
            payload: {
              part: result.part,
              scanEvent: result.scanEvent,
              scannedByName: currentUser.employeeName,
              receivedQuantity: result.part?.receivedQuantity,
              requiredQuantity: result.part?.quantity,
              deliveryStats: result.deliveryStats,
              deliveryVersion: result.deliveryVersion || 1
            }
          });
          return jsonResponse({ ...result, sequenceNumber: rtEvent.sequenceNumber }, 200);
        }
        return jsonResponse(result, 200);
      }
      const partItemMatch = subPath.match(/^\/parts\/([^/]+)\/?$/);
      if (partItemMatch) {
        const partId = decodeURIComponent(partItemMatch[1]);
        if (method === "PATCH" || method === "PUT") {
          const body = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateDeliveryPart(deliveryId, partId, body, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: "part:edited",
              deliveryId,
              partId,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: updated.delivery?.version || 1,
              payload: {
                part: updated.part,
                delivery: updated.delivery,
                actorName: currentUser.employeeName
              }
            });
            return jsonResponse({ ...updated, sequenceNumber: rtEvent.sequenceNumber }, 200);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to update part",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
        if (method === "DELETE") {
          try {
            const deleted = await service.deleteDeliveryPart(deliveryId, partId, {
              id: currentUser.id,
              employeeName: currentUser.employeeName,
              role: currentUser.role
            });
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: "part:deleted",
              deliveryId,
              partId,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: deleted.delivery?.version || 1,
              payload: {
                deletedPartId: deleted.deletedPartId,
                delivery: deleted.delivery,
                actorName: currentUser.employeeName
              }
            });
            return jsonResponse({ ...deleted, sequenceNumber: rtEvent.sequenceNumber }, 200);
          } catch (err) {
            const isForbidden = String(err?.message || "").startsWith("Forbidden:");
            return errorResponse(
              err?.message || "Failed to delete part",
              isForbidden ? 403 : 400,
              isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
            );
          }
        }
      }
      if (subPath === "/scans" || subPath.startsWith("/scans/")) {
        if (method === "DELETE" || method === "PUT" || method === "PATCH") {
          return errorResponse(
            "Forbidden: Audit scan history is immutable and cannot be modified or erased.",
            403,
            "AUDIT_HISTORY_IMMUTABLE"
          );
        }
        if (subPath === "/scans" && method === "GET") {
          const scans = await service.getScanHistory(deliveryId);
          return jsonResponse(scans);
        }
        if (subPath === "/scans" && method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (!body.code || !body.scanType) {
            return errorResponse("code and scanType are required", 400);
          }
          const scanPayload = {
            ...body,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            eventAction: body.eventAction || "scan_logged"
          };
          const scan = await service.recordScanEvent(deliveryId, scanPayload);
          return jsonResponse(scan, 201);
        }
      }
    }
    if (path3 === "/api/groups") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (method === "GET") {
        const groups = await service.listGroups();
        return jsonResponse(groups);
      }
      if (method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!body?.name || !String(body.name).trim()) {
          return errorResponse("Group name is required.", 400);
        }
        const created = await service.createGroup({
          name: String(body.name).trim(),
          deliveryIds: Array.isArray(body.deliveryIds) ? body.deliveryIds : [],
          createdBy: currentUser.id
        });
        const rtEvent = await realtimeBroker.publishEvent(db, {
          type: "group:created",
          userId: currentUser.id,
          employeeName: currentUser.employeeName,
          employeeRole: currentUser.role,
          payload: { group: created, actorName: currentUser.employeeName }
        });
        return jsonResponse({ ...created, sequenceNumber: rtEvent.sequenceNumber }, 201);
      }
    }
    const groupMatch = path3.match(/^\/api\/groups\/([^/]+)(.*)$/);
    if (groupMatch) {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      const groupId = decodeURIComponent(groupMatch[1]);
      const subPath = groupMatch[2] || "";
      if (subPath === "" || subPath === "/") {
        if (method === "GET") {
          const group = await service.getGroupById(groupId);
          if (!group) {
            return errorResponse(`Docket group not found: ${groupId}`, 404, "NOT_FOUND");
          }
          return jsonResponse(group);
        }
        if (method === "PATCH" || method === "PUT") {
          const body = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateGroup(
              groupId,
              {
                name: body.name,
                deliveryIds: Array.isArray(body.deliveryIds) ? body.deliveryIds : void 0
              },
              currentUser.id
            );
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: "group:updated",
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              payload: { group: updated, actorName: currentUser.employeeName }
            });
            return jsonResponse({ ...updated, sequenceNumber: rtEvent.sequenceNumber });
          } catch (err) {
            return errorResponse(err?.message || "Failed to update docket group", 404, "NOT_FOUND");
          }
        }
        if (method === "DELETE") {
          const deleted = await service.deleteGroup(groupId);
          if (!deleted.deleted) {
            return errorResponse(`Docket group not found: ${groupId}`, 404, "NOT_FOUND");
          }
          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: "group:deleted",
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            payload: { groupId, name: deleted.name, deletedBy: currentUser.employeeName }
          });
          return jsonResponse({
            success: true,
            id: groupId,
            sequenceNumber: rtEvent.sequenceNumber
          });
        }
      }
      if (subPath === "/dockets" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const idsToAdd = Array.isArray(body?.deliveryIds) ? body.deliveryIds : body?.deliveryId ? [body.deliveryId] : [];
        if (idsToAdd.length === 0) {
          return errorResponse("deliveryId or deliveryIds is required.", 400);
        }
        try {
          let updatedGroup = null;
          for (const dId of idsToAdd) {
            updatedGroup = await service.addDeliveryToGroup(groupId, String(dId), currentUser.id);
          }
          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: "group:updated",
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            payload: { group: updatedGroup, actorName: currentUser.employeeName }
          });
          return jsonResponse({ ...updatedGroup, sequenceNumber: rtEvent.sequenceNumber });
        } catch (err) {
          return errorResponse(err?.message || "Failed to add docket to group", 404, "NOT_FOUND");
        }
      }
      const removeMemberMatch = subPath.match(/^\/dockets\/([^/]+)\/?$/);
      if (removeMemberMatch && method === "DELETE") {
        const deliveryIdToRemove = decodeURIComponent(removeMemberMatch[1]);
        try {
          const updatedGroup = await service.removeDeliveryFromGroup(groupId, deliveryIdToRemove);
          const rtEvent = await realtimeBroker.publishEvent(db, {
            type: "group:updated",
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role,
            payload: { group: updatedGroup, actorName: currentUser.employeeName }
          });
          return jsonResponse({ ...updatedGroup, sequenceNumber: rtEvent.sequenceNumber });
        } catch (err) {
          return errorResponse(err?.message || "Failed to remove docket from group", 404, "NOT_FOUND");
        }
      }
      if (subPath === "/scan" && method === "POST") {
        const body = await request.json().catch(() => ({}));
        const scannedCode = String(body?.code ?? body?.scannedCode ?? "").trim();
        if (!scannedCode) {
          return errorResponse("Scanned part code is required.", 400);
        }
        try {
          const result = await service.scanGroupPart(groupId, {
            code: scannedCode,
            scannedVia: body.scannedVia || body.scanType || "qr",
            receivedQuantity: body.receivedQuantity !== void 0 ? Number(body.receivedQuantity) : void 0,
            mode: body.mode,
            targetDeliveryId: typeof body.targetDeliveryId === "string" ? body.targetDeliveryId : void 0,
            targetPartId: typeof body.targetPartId === "string" ? body.targetPartId : void 0,
            idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : void 0,
            notes: typeof body.notes === "string" ? body.notes : void 0,
            rawOcrText: typeof body.rawOcrText === "string" ? body.rawOcrText : void 0,
            userId: currentUser.id,
            employeeName: currentUser.employeeName,
            employeeRole: currentUser.role
          });
          if (result.status === "not_found") {
            return new Response(
              JSON.stringify({
                ...result,
                code: "PART_NOT_IN_GROUP",
                error: result.message
              }),
              {
                status: 404,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS }
              }
            );
          }
          if (result.status === "ambiguous") {
            return new Response(
              JSON.stringify({
                ...result,
                candidates: result.conflictCandidates || result.candidates || [],
                code: "AMBIGUOUS_GROUP_PART",
                error: result.message
              }),
              {
                status: 409,
                headers: { "Content-Type": "application/json", ...CORS_HEADERS }
              }
            );
          }
          if (result.duplicate) {
            await realtimeBroker.publishEvent(db, {
              type: "part:duplicate_rejected",
              deliveryId: result.deliveryId,
              partId: result.part?.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              payload: {
                part: result.part,
                alreadyScannedBy: result.alreadyScannedBy,
                alreadyScannedAt: result.alreadyScannedAt,
                attemptedBy: currentUser.employeeName,
                message: result.message
              }
            });
            return jsonResponse(result, 409);
          }
          if (!result.idempotentReplay && result.part && result.deliveryId) {
            const eventType = body.scannedVia === "manual" || result.part.verificationStatus === "quantity_mismatch" && Number(result.part.receivedQuantity) < Number(result.part.quantity) ? "quantity:updated" : "part:scanned";
            const rtEvent = await realtimeBroker.publishEvent(db, {
              type: eventType,
              deliveryId: result.deliveryId,
              partId: result.part.id,
              userId: currentUser.id,
              employeeName: currentUser.employeeName,
              employeeRole: currentUser.role,
              deliveryVersion: result.deliveryVersion || 1,
              payload: {
                part: result.part,
                scanEvent: result.scanEvent,
                scannedByName: currentUser.employeeName,
                receivedQuantity: result.part.receivedQuantity,
                requiredQuantity: result.part.quantity,
                deliveryStats: result.deliveryStats,
                deliveryVersion: result.deliveryVersion || 1,
                groupId
              }
            });
            return jsonResponse({ ...result, sequenceNumber: rtEvent.sequenceNumber }, 200);
          }
          return jsonResponse(result, 200);
        } catch (err) {
          const isForbidden = String(err?.message || "").startsWith("Forbidden:");
          return errorResponse(
            err?.message || "Group scan failed",
            isForbidden ? 403 : 400,
            isForbidden ? "FORBIDDEN" : "BAD_REQUEST"
          );
        }
      }
    }
    return null;
  } catch (err) {
    console.error("PartTrack API Error:", err);
    return errorResponse(err?.message || "Internal database server error", 500, "INTERNAL_ERROR");
  }
}

// server.ts
dotenv.config({ quiet: true });
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
var __filename = fileURLToPath(import.meta.url);
var __dirname = path2.dirname(__filename);
var app = express();
var PORT = Number(process.env.PORT) || 3e3;
app.use(express.json({ limit: "35mb" }));
app.use((req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=*, microphone=*, geolocation=*");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});
app.use(express.static(path2.resolve(__dirname, "public")));
var localDb = getLocalDevDatabase();
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/deliveries") || req.path.startsWith("/api/groups") || req.path.startsWith("/api/users") || req.path.startsWith("/api/auth") || req.path.startsWith("/api/realtime") || req.path === "/api/health") {
    try {
      const url = `${req.protocol}://${req.get("host") || "localhost:3000"}${req.originalUrl}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
      }
      const body = req.method !== "GET" && req.method !== "HEAD" && req.body ? JSON.stringify(req.body) : void 0;
      const webReq = new Request(url, {
        method: req.method,
        headers,
        body
      });
      const webRes = await handlePalletTrackApiRequest(webReq, localDb, process.env);
      if (webRes) {
        res.status(webRes.status);
        webRes.headers.forEach((val, key) => {
          res.setHeader(key, val);
        });
        const responseText = await webRes.text();
        return res.send(responseText);
      }
    } catch (err) {
      console.error("API router error in server.ts:", err);
      return res.status(500).json({ error: err?.message || "Server database error" });
    }
  }
  next();
});
app.get("/api/export-project-zip", async (_req, res) => {
  try {
    let addDirectory = function(currentPath, zipFolder) {
      const items = fs2.readdirSync(currentPath, { withFileTypes: true });
      for (const item of items) {
        if (ignoredNames.has(item.name)) continue;
        const itemFullPath = path2.join(currentPath, item.name);
        if (item.isDirectory()) {
          const sub = zipFolder.folder(item.name);
          if (sub) addDirectory(itemFullPath, sub);
        } else if (item.isFile()) {
          const stat = fs2.statSync(itemFullPath);
          if (stat.size < 10 * 1024 * 1024) {
            const fileContent = fs2.readFileSync(itemFullPath);
            zipFolder.file(item.name, fileContent);
          }
        }
      }
    };
    const JSZipModule = (await import("jszip")).default;
    const fs2 = await import("fs");
    const zip = new JSZipModule();
    const rootDir = process.cwd();
    const ignoredNames = /* @__PURE__ */ new Set([
      "node_modules",
      "dist",
      "build",
      "server.js",
      ".data",
      ".git",
      ".tempmediaStorage",
      ".aistudio",
      ".DS_Store"
    ]);
    addDirectory(rootDir, zip);
    const zipBuffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="parttrack-app-source.zip"');
    res.send(zipBuffer);
  } catch (err) {
    console.error("Error generating project zip:", err);
    res.status(500).json({ error: "Failed to generate project zip", details: err?.message });
  }
});
app.post("/api/extract-docket", async (req, res) => {
  try {
    const { images, startItemIndex, pageSlices, supplierHint } = req.body || {};
    if ((!Array.isArray(images) || images.length === 0) && (!Array.isArray(pageSlices) || pageSlices.length === 0)) {
      return res.status(400).json({ error: "No docket images provided." });
    }
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({
        error: "Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings or Cloudflare Pages project secrets.",
        code: "MISSING_GEMINI_API_KEY"
      });
    }
    const startIdx = typeof startItemIndex === "number" && startItemIndex > 0 ? startItemIndex : 1;
    const result = await extractDocketWithGeminiVision(
      Array.isArray(images) ? images : [],
      startIdx,
      Array.isArray(pageSlices) ? pageSlices : void 0,
      void 0,
      typeof supplierHint === "string" ? supplierHint : void 0
    );
    return res.status(200).json(result);
  } catch (err) {
    const { classifyGeminiError: classifyGeminiError2 } = await Promise.resolve().then(() => (init_docketOcr(), docketOcr_exports));
    const classification = classifyGeminiError2(err);
    console.error(
      `Gemini AI docket extraction error [${classification.errorCode} / HTTP ${classification.statusCode}]:`,
      classification.cleanMessage
    );
    const errorMessage = classification.errorCode === "MISSING_GEMINI_API_KEY" ? "Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings." : classification.errorCode === "GEMINI_AUTH_ERROR" ? `Gemini API authentication or permission error (HTTP ${classification.statusCode}): ${classification.cleanMessage}` : classification.errorCode === "GEMINI_INVALID_MODEL" ? `Designated Gemini model is unavailable or invalid (HTTP 404): ${classification.cleanMessage}` : classification.errorCode === "GEMINI_QUOTA_EXHAUSTED" ? `Gemini API quota exceeded (HTTP 429): ${classification.cleanMessage}` : classification.cleanMessage || "Gemini AI docket extraction failed.";
    return res.status(classification.statusCode).json({
      error: errorMessage,
      code: classification.errorCode,
      retryable: classification.isRetryableAvailabilityError || classification.isTimeout
    });
  }
});
app.post("/api/recover-docket-items", async (req, res) => {
  try {
    const { slicePayload, pageNumber, missingNos } = req.body || {};
    if (!slicePayload || !Array.isArray(missingNos) || missingNos.length === 0) {
      return res.status(200).json({ items: [] });
    }
    const items = await recoverMissingDocketItems(
      slicePayload,
      Number(pageNumber) || 1,
      missingNos
    );
    return res.status(200).json({ items });
  } catch (err) {
    console.warn("Targeted row recovery warning:", err?.message || err);
    return res.status(200).json({ items: [] });
  }
});
app.post("/api/read-part-label", async (req, res) => {
  try {
    const { imageDataUrl, image, imageBase64, mimeType, knownParts, docketParts } = req.body || {};
    const resolvedImage = typeof imageDataUrl === "string" && imageDataUrl ? imageDataUrl : typeof image === "string" && image ? image : typeof imageBase64 === "string" && imageBase64 ? `data:${mimeType || "image/jpeg"};base64,${imageBase64}` : "";
    if (!resolvedImage) {
      return res.status(400).json({ error: "No part label image provided." });
    }
    const partsList = Array.isArray(knownParts) ? knownParts : Array.isArray(docketParts) ? docketParts.map((p) => ({
      itemNumber: String(p.no || p.itemNumber || ""),
      partNumber: String(p.partNumber || ""),
      description: String(p.description || "")
    })) : void 0;
    const result = await extractPartCodeWithGeminiVision(resolvedImage, partsList);
    return res.status(200).json({
      ...result,
      scannedCode: result.detectedCode
    });
  } catch (err) {
    const { classifyGeminiError: classifyGeminiError2 } = await Promise.resolve().then(() => (init_docketOcr(), docketOcr_exports));
    const classification = classifyGeminiError2(err);
    return res.status(classification.statusCode).json({
      error: classification.cleanMessage || "Failed to read part label.",
      code: classification.errorCode,
      retryable: classification.isRetryableAvailabilityError || classification.isTimeout
    });
  }
});
app.all("/api/*", (req, res) => {
  return res.status(404).json({
    error: `API route not found: ${req.path}`,
    code: "NOT_FOUND"
  });
});
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path2.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path2.resolve(__dirname, "dist", "index.html"));
    });
  }
  const httpServer = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const dbService = new PalletTrackDbService(localDb);
  httpServer.on("upgrade", (req, socket, head) => {
    try {
      const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost:3000"}`);
      if (reqUrl.pathname !== "/api/realtime/ws") {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, async (ws) => {
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === "string") headers.set(k, v);
            else if (Array.isArray(v)) v.forEach((val) => headers.append(k, val));
          }
          const webReq = new Request(reqUrl.toString(), { headers });
          const token = extractSessionTokenFromRequest(webReq);
          if (!token) {
            ws.send(
              JSON.stringify({
                type: "auth_error",
                code: "UNAUTHORIZED",
                error: "Authentication required for real-time synchronisation."
              })
            );
            ws.close(4001, "Unauthorized: Missing session token");
            return;
          }
          const user = await dbService.validateSession(token);
          if (!user || !user.active) {
            ws.send(
              JSON.stringify({
                type: "auth_error",
                code: "SESSION_INVALID",
                error: "Invalid, expired, or deactivated session."
              })
            );
            ws.close(4001, "Unauthorized: Invalid or expired session");
            return;
          }
          const initialDeliveryId = reqUrl.searchParams.get("deliveryId") || null;
          const lastSeq = Number(reqUrl.searchParams.get("lastSeq")) || 0;
          const connectionId = realtimeBroker.registerClient(
            ws,
            user,
            token,
            initialDeliveryId,
            lastSeq,
            localDb
          );
          ws.on("message", (data) => {
            const text = typeof data === "string" ? data : data.toString("utf-8");
            realtimeBroker.handleClientMessage(connectionId, text, localDb).catch(() => {
            });
          });
          ws.on("close", () => {
            realtimeBroker.unregisterClient(connectionId);
          });
          ws.on("error", () => {
            realtimeBroker.unregisterClient(connectionId);
          });
        } catch {
          try {
            ws.close(4e3, "Internal connection error");
          } catch {
          }
        }
      });
    } catch {
      socket.destroy();
    }
  });
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`PartTrack server running on http://localhost:${PORT}`);
  });
}
startServer();
