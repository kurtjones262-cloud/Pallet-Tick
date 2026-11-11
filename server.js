// server.ts
import express from "express";
import dotenv from "dotenv";
import path2 from "path";
import { fileURLToPath } from "url";

// src/server/docketOcr.ts
var DEFAULT_PRIMARY_VISION_MODEL = "gemini-3.8-flash";
var DEFAULT_FALLBACK_VISION_MODELS = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite-preview",
  "gemini-flash-latest"
];
var MAX_AUTOMATIC_RETRIES = 3;
var INITIAL_BACKOFF_MS = 2e3;
function resolveConfiguredVisionModels(envOverride) {
  const procEnv = typeof process !== "undefined" && process.env ? process.env : {};
  const rawPrimary = typeof envOverride?.GEMINI_PRIMARY_MODEL === "string" && envOverride.GEMINI_PRIMARY_MODEL.trim() || typeof procEnv.GEMINI_PRIMARY_MODEL === "string" && procEnv.GEMINI_PRIMARY_MODEL.trim() || DEFAULT_PRIMARY_VISION_MODEL;
  const rawFallbacks = typeof envOverride?.GEMINI_FALLBACK_MODEL === "string" && envOverride.GEMINI_FALLBACK_MODEL.trim() || typeof envOverride?.GEMINI_FALLBACK_MODELS === "string" && envOverride.GEMINI_FALLBACK_MODELS.trim() || typeof procEnv.GEMINI_FALLBACK_MODEL === "string" && procEnv.GEMINI_FALLBACK_MODEL.trim() || typeof procEnv.GEMINI_FALLBACK_MODELS === "string" && procEnv.GEMINI_FALLBACK_MODELS.trim() || DEFAULT_FALLBACK_VISION_MODELS.join(",");
  const fallbackModels = rawFallbacks.split(",").map((m) => m.trim()).filter((m) => Boolean(m) && m !== rawPrimary);
  return {
    primaryModel: rawPrimary,
    fallbackModels: fallbackModels.length > 0 ? fallbackModels : [...DEFAULT_FALLBACK_VISION_MODELS]
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
  const payload = JSON.stringify({ timestamp, component: "PalletTrack-OCR", event, ...sanitizedMeta });
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
  const jitter = Math.floor(Math.random() * 650);
  return Math.min(2e4, exponentialDelay + jitter);
}
var modelQuotaCooldownUntil = /* @__PURE__ */ new Map();
var MODEL_COOLDOWN_DURATION_MS = 10 * 60 * 1e3;
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
  const isHighDemand503 = statusCode === 503 || /503|UNAVAILABLE|high demand|overloaded|service unavailable|temporarily unavailable|capacity/i.test(
    rawMessage
  );
  const isRateLimit = statusCode === 429 || /429|RESOURCE_EXHAUSTED|rate limit|quota|too many requests/i.test(rawMessage);
  const isModelDailyQuotaExhausted = isRateLimit && /GenerateRequestsPerDayPerProjectPerModel|free_tier_requests|requests per day limit exceeded|limit:\s*0\b|Please retry in \d+h/i.test(
    rawMessage
  );
  const isTemporary5xx = statusCode === 500 || statusCode === 502 || statusCode === 504 || /500|502|504|INTERNAL|DEADLINE_EXCEEDED|bad gateway|gateway timeout|timed out|AbortError|fetch failed/i.test(
    rawMessage
  );
  if (!statusCode) {
    if (isHighDemand503) statusCode = 503;
    else if (isRateLimit) statusCode = 429;
    else if (isTemporary5xx) statusCode = 502;
  }
  return {
    statusCode: statusCode || 500,
    isRetryableAvailabilityError: isHighDemand503 || isRateLimit || isTemporary5xx,
    isRateLimit,
    isHighDemand503,
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
    if (typeof parsed.detectedCode !== "string") {
      throw new Error("Malformed label OCR response: missing detectedCode string field.");
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
  let lastStatusCode = 500;
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
      const timeoutMs = isFallbackModel ? 22e3 : 26e3;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const config = {
          systemInstruction,
          responseMimeType: "application/json",
          responseSchema,
          abortSignal: controller.signal
        };
        if (ThinkingLevel && (currentModel.includes("3.8") || currentModel.includes("argon"))) {
          config.thinkingConfig = { thinkingLevel: ThinkingLevel.MEDIUM };
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
        lastError = err;
        const classification = classifyGeminiError(err);
        lastStatusCode = classification.statusCode;
        const isValidationFailure = String(err?.message || "").includes("Malformed") || String(err?.message || "").includes("Incomplete OCR") || String(err?.message || "").includes("Invalid OCR item");
        logOcrEvent("warn", "extraction_attempt_failed", {
          model: currentModel,
          isFallback: isFallbackModel,
          attempt: retry + 1,
          maxAttemptsForModel: maxRetriesForModel + 1,
          statusCode: classification.statusCode,
          isRetryable: classification.isRetryableAvailabilityError || isValidationFailure,
          reason: classification.cleanMessage
        });
        if (!classification.isRetryableAvailabilityError && !isValidationFailure && (classification.statusCode === 400 || classification.statusCode === 401 || classification.statusCode === 403)) {
          const permErr = new Error(classification.cleanMessage);
          permErr.status = classification.statusCode;
          permErr.code = classification.statusCode === 401 || classification.statusCode === 403 ? "GEMINI_AUTH_ERROR" : "GEMINI_BAD_REQUEST";
          throw permErr;
        }
        if (classification.statusCode === 404 && !classification.isRetryableAvailabilityError && !isValidationFailure || classification.isModelDailyQuotaExhausted && mIdx < candidateModels.length - 1) {
          if (useCooldownMemory) {
            modelQuotaCooldownUntil.set(currentModel, Date.now() + MODEL_COOLDOWN_DURATION_MS);
          }
          logOcrEvent("info", "model_daily_quota_or_404_fast_failover", {
            exhaustedModel: currentModel,
            nextModel: candidateModels[mIdx + 1],
            statusCode: classification.statusCode
          });
          break;
        }
        if (retry < maxRetriesForModel) {
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
      }
    }
  }
  logOcrEvent("error", "all_models_and_retries_exhausted", {
    primaryModel,
    fallbackModels: fallbackModels.join(","),
    totalRetryAttempts,
    lastStatusCode,
    error: String(lastError?.message || lastError || "Unknown error").slice(0, 240)
  });
  const finalClassification = classifyGeminiError(lastError);
  if (finalClassification.isHighDemand503) {
    const busyErr = new Error(
      `Gemini AI is currently experiencing high demand (HTTP 503) after ${totalRetryAttempts} automatic retries and fallback to ${fallbackModels[0] || "secondary model"}. Your uploaded docket has been preserved \u2014 please click "Retry Extraction" in a moment.`
    );
    busyErr.status = 503;
    busyErr.code = "GEMINI_HIGH_DEMAND_503";
    throw busyErr;
  }
  if (finalClassification.isRateLimit) {
    const rateErr = new Error(
      `Gemini AI rate limit reached (HTTP 429) after ${totalRetryAttempts} automatic retries. Your uploaded docket has been preserved \u2014 please wait a few seconds and click "Retry Extraction".`
    );
    rateErr.status = 429;
    rateErr.code = "GEMINI_RATE_LIMIT_429";
    throw rateErr;
  }
  throw new Error(
    finalClassification.cleanMessage || 'Gemini AI could not extract the docket after automatic retries. Please click "Retry Extraction".'
  );
}
async function extractPageBatchInOneCall(ai, Type, ThinkingLevel, batchPages, totalPages) {
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
  const systemInstruction = `You are a 100%-recall industrial delivery docket, tax invoice, and laser-cutting manifest extraction engine.
Your job is to transcribe EVERY single physical part row literally visible across the provided page image(s) and/or extracted PDF text into the JSON 'items' array without skipping or merging any rows.
STRICT ANTI-HALLUCINATION RULE: Only extract rows and text that are literally present in the provided document. Never invent, guess, or fabricate parts, codes, descriptions, materials, thicknesses, dimensions, or quantities. If a document is blank or contains no physical part rows, return an empty items array [].`;
  const promptText = `Examine ${pageDescriptions.join(" and ")} (out of ${totalPages} total pages) and extract EVERY physical part row literally visible in the table in top-to-bottom order. If the image is blank or has no part rows, return items: [].

MANDATORY 100%-RECALL EXTRACTION RULES:
1. RECORD FIRST & LAST VISIBLE ROW NUMBERS:
   - Look at the first visible part row in this batch and record its printed "No" in 'firstVisibleRowNo', and look at the very last visible part row at the bottom of this batch and record its printed "No" in 'lastVisibleRowNo' (or "" if no part rows are visible).
2. EXTRACT EVERY SINGLE PART ROW FROM TOP TO BOTTOM:
   - Do NOT skip any row. Every single numbered row in the table is a distinct part that MUST have its own entry in 'items'.
   - Notice each page is shown as an UPPER half and a LOWER half with a small overlap in the middle so every row is large and clear. Read continuously from the top of the UPPER half to the bottom of the LOWER half without duplicating the overlap rows and without skipping any row.
   - Do NOT merge two separate numbered rows into one item.
3. IGNORE NON-PART LINES:
   - Ignore document header barcodes, consignment notes, and column headers.
   - On Tax Invoices, ignore non-physical charge/summary lines (Freight, Delivery, Setup, Pallet Fee, Subtotal, GST, Tax, Total, Balance Due).
4. FIELD MAPPING FOR EACH PART ROW:
   - page: The page number (${batchPages.map((b) => b.pageNumber).join(" or ")}) this row is on.
   - no: The exact printed number in the "No" / "No." / "Item" / "Pos" / "Line" / "#" column for this row. Never restart numbering at "1" on the lower half or on subsequent pages if printed row numbers continue across the document.
   - part: The Part Number, Drawing Number, Mark, Code, or DXF/Profile Name written on the row. If the table only has ONE text column (e.g. "Description" or "Part / Description"), put the part code/name in 'part' and the full text in 'desc'. NEVER put the row number in 'part'.
   - desc: The full part description or name written on the row.
   - rev: Drawing revision / Rev code if shown on the row (e.g. "A", "01", "Rev B"), else "".
   - mat: Material grade ONLY if written on the row, else "".
   - thk: Thickness ONLY if written on the row, else "".
   - dim: Dimensions/length/size ONLY if written on the row, else "".
   - wt: Weight ONLY if written on the row, else "".
   - qty: Integer quantity for this part row (convert invoice decimals like 4.00 to 4; never use Unit Price $ or Line Total $).`;
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      docketNumber: { type: Type.STRING },
      supplier: { type: Type.STRING },
      deliveryDate: { type: Type.STRING },
      orderNumber: { type: Type.STRING },
      carrier: { type: Type.STRING },
      palletCount: { type: Type.INTEGER },
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
            qty: { type: Type.NUMBER, description: "Quantity of this part (never price)." }
          },
          required: ["no", "part", "desc", "qty"],
          propertyOrdering: ["page", "no", "part", "desc", "rev", "mat", "thk", "dim", "wt", "qty"]
        }
      }
    },
    required: ["items"],
    propertyOrdering: [
      "docketNumber",
      "supplier",
      "deliveryDate",
      "orderNumber",
      "carrier",
      "palletCount",
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
    deliveryDate: parsed.deliveryDate,
    carrier: parsed.carrier,
    orderNumber: parsed.orderNumber,
    palletCount: parsed.palletCount,
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
  let pn = String(it.part || "").trim();
  const desc = String(it.desc || "").trim();
  if (!pn && !desc) return null;
  if (/^(?:subtotal|sub-total|total|gst|tax|freight|delivery\s*charge|cartage|balance\s*due|amount\s*due|discount)$/i.test(
    pn
  ) || /^(?:subtotal|sub-total|gst\s*10%?|total\s*incl|total\s*excl|amount\s*due|balance\s*due|freight\s*charge)$/i.test(
    desc
  )) {
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
      palletNumber: "Pallet 1",
      pageNumber: resolvedPage,
      confidence: "high",
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
async function extractDocketWithGeminiVision(base64Images, startItemIndex = 1, pageSlices, overrideApiKey) {
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
      pair.map((b) => extractPageBatchInOneCall(ai, Type, ThinkingLevel, b, totalPages))
    );
    batchResponses.push(...pairRes);
  }
  const globalByNo = /* @__PURE__ */ new Map();
  const unnumberedItems = [];
  const pageMinNo = /* @__PURE__ */ new Map();
  const pageMaxNo = /* @__PURE__ */ new Map();
  let anyPrintedNoColumn = false;
  let globalMaxCandidate = 0;
  let modelUsed = DEFAULT_PRIMARY_VISION_MODEL;
  let fallbackUsed = false;
  let totalRetries = 0;
  for (let bIdx = 0; bIdx < batchResponses.length; bIdx++) {
    const bRes = batchResponses[bIdx];
    modelUsed = bRes.modelUsed || modelUsed;
    fallbackUsed = fallbackUsed || Boolean(bRes.fallbackUsed);
    totalRetries += bRes.retryAttempts || 0;
    const defaultPage = batches[bIdx][0].pageNumber;
    if (bRes.hasPrintedNoColumn !== false) {
      anyPrintedNoColumn = true;
    }
    const fNo = parseInt(parseCleanRowNo(bRes.firstVisibleRowNo), 10);
    const lNo = parseInt(parseCleanRowNo(bRes.lastVisibleRowNo), 10);
    if (!Number.isNaN(fNo) && fNo > 0) {
      pageMinNo.set(defaultPage, Math.min(pageMinNo.get(defaultPage) ?? fNo, fNo));
      if (fNo > globalMaxCandidate && fNo <= 1500) globalMaxCandidate = fNo;
    }
    if (!Number.isNaN(lNo) && lNo > 0) {
      const lastPageInBatch = batches[bIdx][batches[bIdx].length - 1].pageNumber;
      pageMaxNo.set(lastPageInBatch, Math.max(pageMaxNo.get(lastPageInBatch) ?? lNo, lNo));
      if (lNo > globalMaxCandidate && lNo <= 1500) globalMaxCandidate = lNo;
    }
    for (const rawIt of bRes.items || []) {
      const norm = normalizeRawBatchItem(rawIt, defaultPage);
      if (!norm) continue;
      const numNo = parseInt(norm.cleanNo, 10);
      const itemPage = norm.item.pageNumber || defaultPage;
      if (!Number.isNaN(numNo) && numNo > 0 && numNo <= 1500) {
        if (numNo > globalMaxCandidate) globalMaxCandidate = numNo;
        pageMinNo.set(itemPage, Math.min(pageMinNo.get(itemPage) ?? numNo, numNo));
        pageMaxNo.set(itemPage, Math.max(pageMaxNo.get(itemPage) ?? numNo, numNo));
        const existing = globalByNo.get(numNo);
        if (!existing) {
          globalByNo.set(numNo, { ...norm.item, itemNumber: String(numNo) });
        } else if (existing.pageNumber === itemPage) {
          globalByNo.set(numNo, {
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
          unnumberedItems.push(norm.item);
        }
      } else {
        unnumberedItems.push(norm.item);
      }
    }
  }
  if (anyPrintedNoColumn && globalMaxCandidate > 1 && globalMaxCandidate <= 600 && unnumberedItems.length === 0) {
    const missingNos = [];
    for (let n = 1; n <= globalMaxCandidate; n++) {
      if (!globalByNo.has(n)) {
        missingNos.push(n);
      }
    }
    if (missingNos.length > 0 && missingNos.length <= 60) {
      const missingPerPage = /* @__PURE__ */ new Map();
      const assignToPage = (pNum, val) => {
        if (pNum < 1 || pNum > totalPages) return;
        if (!missingPerPage.has(pNum)) missingPerPage.set(pNum, /* @__PURE__ */ new Set());
        missingPerPage.get(pNum).add(val);
      };
      for (const mNo of missingNos) {
        let matched = false;
        for (let p = 1; p <= totalPages; p++) {
          const pMin = pageMinNo.get(p) ?? 1;
          const pMax = pageMaxNo.get(p) ?? globalMaxCandidate;
          if (mNo >= pMin && mNo <= pMax) {
            assignToPage(p, mNo);
            matched = true;
          }
        }
        if (!matched) {
          for (let p = 1; p < totalPages; p++) {
            const pMax = pageMaxNo.get(p);
            const nextMin = pageMinNo.get(p + 1);
            if (pMax !== void 0 && nextMin !== void 0 && mNo > pMax && mNo < nextMin) {
              assignToPage(p, mNo);
              assignToPage(p + 1, mNo);
              matched = true;
            }
          }
        }
        if (!matched) {
          assignToPage(mNo <= (pageMaxNo.get(1) ?? 50) ? 1 : totalPages, mNo);
        }
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
          if (!Number.isNaN(numNo) && numNo > 0 && !globalByNo.has(numNo)) {
            globalByNo.set(numNo, {
              ...norm.item,
              itemNumber: String(numNo)
            });
          }
        }
      }
    }
  }
  const validItems = [];
  const sortedNos = Array.from(globalByNo.keys()).sort((a, b) => a - b);
  for (const n of sortedNos) {
    validItems.push(globalByNo.get(n));
  }
  let nextSeq = (sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : startItemIndex - 1) + 1;
  for (const unnum of unnumberedItems) {
    validItems.push({
      ...unnum,
      itemNumber: String(nextSeq++)
    });
  }
  const rawDocketNo = batchResponses.find((p) => p.docketNumber && p.docketNumber.trim())?.docketNumber || `DK-${Math.floor(1e4 + Math.random() * 9e4)}`;
  const cleanedDocketNumber = rawDocketNo.trim();
  const supplier = batchResponses.find((p) => p.supplier && p.supplier.trim())?.supplier?.trim() || "Steel Fabrication Supplier";
  const rawDate = batchResponses.find(
    (p) => p.deliveryDate && /^\d{4}-\d{2}-\d{2}$/.test(p.deliveryDate.trim())
  )?.deliveryDate;
  const deliveryDate = rawDate ? rawDate.trim() : (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const carrier = batchResponses.find((p) => p.carrier && p.carrier.trim())?.carrier?.trim();
  const orderNumber = batchResponses.find((p) => p.orderNumber && p.orderNumber.trim())?.orderNumber?.trim();
  const maxPalletCount = Math.max(
    1,
    ...batchResponses.map((p) => parseInt(String(p.palletCount || 1), 10) || 1)
  );
  return {
    docketNumber: cleanedDocketNumber,
    supplier,
    deliveryDate,
    carrier,
    orderNumber,
    palletCount: maxPalletCount,
    items: validItems,
    confidenceScore: validItems.length > 0 ? 100 : 0,
    needsManualReview: validItems.length === 0,
    extractionMethod: "ai-vision",
    aiModelUsed: modelUsed,
    fallbackUsed,
    retryAttempts: totalRetries,
    pagesScanned: totalPages,
    hasPrintedNoColumn: anyPrintedNoColumn,
    firstVisibleRowNo: sortedNos.length > 0 ? sortedNos[0] : void 0,
    lastVisibleRowNo: sortedNos.length > 0 ? sortedNos[sortedNos.length - 1] : void 0
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
Active Docket Expected Parts (cross-reference the number after "-" against the Docket No):
${knownParts.slice(0, 120).map((p) => `- Docket No: ${p.itemNumber} | Part#: ${p.partNumber} (${p.description || ""})`).join("\n")}` : "";
  const promptText = `Read the barcode value (formatted as "######-<No>", e.g. "482910-3" or "123456-02", where the numbers after the "-" is the "No" on the delivery docket), QR code text, or Part Number shown on this part label photo.${knownContext}
Return ONLY the barcode string (e.g. "482910-3") or Part Number in 'detectedCode'.`;
  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      detectedCode: {
        type: Type.STRING,
        description: "The decoded barcode text, Part Number, or Item Number on the label."
      },
      confidence: {
        type: Type.STRING,
        description: "high, medium, or low"
      }
    },
    required: ["detectedCode"]
  };
  try {
    const { parsed } = await generateWithRetryAndFallback(
      ai,
      ThinkingLevel,
      [
        { inlineData: { mimeType, data: base64Data } },
        { text: promptText }
      ],
      "Read the barcode or part code from the image.",
      responseSchema,
      "label"
    );
    return {
      detectedCode: String(parsed.detectedCode || "").trim(),
      confidence: String(parsed.confidence || "high")
    };
  } catch {
    return { detectedCode: "", confidence: "low" };
  }
}

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
    if (schemaSql) {
      this.db.exec(schemaSql);
    }
    const safeAddCol = (table, colDef) => {
      try {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`);
      } catch {
      }
    };
    safeAddCol("users", "employee_code TEXT");
    safeAddCol("users", "pin_salt TEXT");
    safeAddCol("users", "last_login_at TEXT");
    safeAddCol("users", "failed_login_attempts INTEGER NOT NULL DEFAULT 0");
    safeAddCol("users", "locked_until TEXT");
    safeAddCol("users", "created_by TEXT");
    safeAddCol("scan_events", "employee_name TEXT");
    safeAddCol("scan_events", "employee_role TEXT");
    safeAddCol("scan_events", "event_action TEXT DEFAULT 'part_scan'");
    safeAddCol("delivery_parts", "revision TEXT");
    safeAddCol("delivery_parts", "manually_edited INTEGER NOT NULL DEFAULT 0");
    safeAddCol("delivery_parts", "original_ocr_values TEXT");
    safeAddCol("delivery_parts", "last_edited_by TEXT");
    safeAddCol("delivery_parts", "last_edited_at TEXT");
    try {
      const tblInfo = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
      if (tblInfo?.sql && tblInfo.sql.includes("CHECK") && !tblInfo.sql.includes("super_admin")) {
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
      notes: row.notes || void 0,
      flaggedForReview: Boolean(row.flagged_for_review),
      ocrConfidence: row.ocr_confidence || void 0,
      manuallyEdited: Boolean(row.manually_edited),
      lastEditedBy: row.last_edited_by || void 0,
      lastEditedAt: row.last_edited_at || void 0,
      originalOcrValues: parsedOriginalOcr,
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
   * Helper to format delivery header from DB row
   */
  mapDeliveryRow(row, stats, parts = []) {
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
      createdBy: row.created_by || void 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stats: stats || { totalParts: parts.length, receivedParts: 0, verifiedParts: 0 },
      parts,
      scanHistory: [],
      unexpectedParts: [],
      docketAttachments: []
    };
  }
  /**
   * List all deliveries with aggregated stats and full parts array
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
    const partsByDelivery = /* @__PURE__ */ new Map();
    for (const p of allPartsRes.results || []) {
      const arr = partsByDelivery.get(p.delivery_id) || [];
      arr.push(this.mapPartRow(p));
      partsByDelivery.set(p.delivery_id, arr);
    }
    return (res.results || []).map((row) => {
      const parts = partsByDelivery.get(row.id) || [];
      return this.mapDeliveryRow(
        row,
        {
          totalParts: Number(row.total_parts) || parts.length,
          receivedParts: Number(row.received_parts) || parts.filter((p) => p.status === "received").length,
          verifiedParts: Number(row.verified_parts) || parts.filter((p) => p.verificationStatus === "verified").length
        },
        parts
      );
    });
  }
  /**
   * Get single delivery by ID, including parts and scan history
   */
  async getDeliveryById(id) {
    const delivery = await this.db.prepare("SELECT * FROM deliveries WHERE id = ?").bind(id).first();
    if (!delivery) return null;
    const partsRes = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? ORDER BY docket_line_index ASC").bind(id).all();
    const scansRes = await this.db.prepare("SELECT * FROM scan_events WHERE delivery_id = ? ORDER BY timestamp DESC LIMIT 300").bind(id).all();
    const parts = (partsRes.results || []).map((p) => this.mapPartRow(p));
    const scanHistory = (scansRes.results || []).map((s) => this.mapScanRow(s));
    const totalParts = parts.length;
    const receivedParts = parts.filter((p) => p.status === "received").length;
    const verifiedParts = parts.filter((p) => p.verificationStatus === "verified").length;
    return {
      ...this.mapDeliveryRow(delivery, { totalParts, receivedParts, verifiedParts }, parts),
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
    const stmts = [];
    stmts.push(
      this.db.prepare(
        `INSERT INTO deliveries (
            id, docket_number, supplier, purchase_order_number, delivery_date,
            delivery_status, carrier, pallet_count, supplier_profile, notes,
            created_by, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          p.scannedVia || null,
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
            s.codeType || "barcode",
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
    await this.db.prepare(
      `UPDATE deliveries
         SET docket_number = ?, supplier = ?, purchase_order_number = ?, delivery_date = ?,
             delivery_status = ?, carrier = ?, pallet_count = ?, notes = ?, updated_at = ?
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
      this.db.prepare("UPDATE deliveries SET delivery_status = 'receiving', updated_at = ? WHERE id = ?").bind(now, deliveryId)
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
               last_edited_by = ?, last_edited_at = ?, updated_at = ?
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
           updated_at = ?
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
      this.db.prepare("UPDATE deliveries SET updated_at = ? WHERE id = ?").bind(now, deliveryId)
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
  /**
   * Update received quantity for a specific part with atomic scan logging and strict duplicate protection
   */
  async updatePartReceivedQuantity(deliveryId, partId, input) {
    const part = await this.db.prepare("SELECT * FROM delivery_parts WHERE delivery_id = ? AND id = ?").bind(deliveryId, partId).first();
    if (!part) {
      throw new Error(`Part ${partId} not found in delivery ${deliveryId}`);
    }
    const enteredQty = Number(input.receivedQuantity);
    if (Number.isNaN(enteredQty) || enteredQty < 0) {
      throw new Error("Received quantity cannot be negative or invalid");
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const reqQty = Math.max(0, part.required_quantity);
    const recQty = Math.round(enteredQty);
    const targetStatus = input.status || (recQty > 0 ? "received" : "outstanding");
    const isScanAttempt = input.scannedVia !== "manual";
    if (isScanAttempt && part.status === "received" && targetStatus === "received" && part.received_quantity > 0) {
      return {
        duplicate: true,
        status: "duplicate",
        message: "This part has already been scanned into this delivery.",
        part: this.mapPartRow(part)
      };
    }
    const isQtyMatch = targetStatus === "received" && recQty === reqQty;
    const verificationStatus = targetStatus === "received" ? isQtyMatch ? "verified" : "quantity_mismatch" : "unscanned";
    const scannedVia = targetStatus === "received" ? input.scannedVia || "manual" : null;
    const scannedCode = targetStatus === "received" ? input.scannedCode || part.scanned_code || (scannedVia === "qr" ? part.part_number : part.item_number) : null;
    const scannedAt = targetStatus === "received" ? now : null;
    const scanId = `ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const addedQty = Math.max(0, recQty - part.received_quantity);
    const scanStatus = targetStatus === "received" ? isQtyMatch ? "match_success" : "quantity_mismatch" : "undo_performed";
    const scanResultMsg = targetStatus === "received" ? isQtyMatch ? `Verified ${part.part_number} (No. ${part.item_number}) - Qty ${recQty}/${reqQty} matched` : `Quantity mismatch for ${part.part_number}: Received ${recQty} of ${reqQty} required` : `Unticked ${part.part_number} (${part.item_number})`;
    const stmts = [
      this.db.prepare(
        `UPDATE delivery_parts
           SET received_quantity = ?, verification_status = ?, status = ?,
               scanned_via = ?, scanned_code = ?, scanned_at = ?, notes = COALESCE(?, notes),
               updated_at = ?
           WHERE delivery_id = ? AND id = ?`
      ).bind(
        recQty,
        verificationStatus,
        targetStatus,
        scannedVia,
        scannedCode,
        scannedAt,
        input.notes || null,
        now,
        deliveryId,
        partId
      ),
      this.db.prepare(
        `INSERT INTO scan_events (
            id, delivery_id, part_id, user_id, timestamp, code,
            scan_type, scan_status, quantity_added, received_quantity_after,
            scan_result, raw_ocr_text, employee_name, employee_role, event_action
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        input.eventAction || (recQty > 0 ? "part_scan" : "part_untick")
      ),
      this.db.prepare("UPDATE deliveries SET updated_at = ? WHERE id = ?").bind(now, deliveryId)
    ];
    await this.db.batch(stmts);
    const updatedPart = await this.db.prepare("SELECT * FROM delivery_parts WHERE id = ?").bind(partId).first();
    return {
      duplicate: false,
      status: "updated",
      part: updatedPart ? this.mapPartRow(updatedPart) : null,
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
        message: scanResultMsg
      }
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
      input.scanType,
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
      codeType: input.scanType,
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
   * Checks for existing deliveries by ID and Docket Number to prevent conflicting duplicates.
   */
  async migrateLocalDeliveries(deliveries) {
    if (!Array.isArray(deliveries) || deliveries.length === 0) {
      return { importedCount: 0, skippedCount: 0, importedIds: [], existingIds: [] };
    }
    const importedIds = [];
    const existingIds = [];
    for (const del of deliveries) {
      if (!del || !del.docketNumber) continue;
      const existing = await this.db.prepare("SELECT id FROM deliveries WHERE id = ? OR docket_number = ?").bind(del.id || "", del.docketNumber).first();
      if (existing) {
        existingIds.push(del.id || del.docketNumber);
        continue;
      }
      await this.createDelivery(del);
      importedIds.push(del.id || del.docketNumber);
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
   * Uses a per-database in-flight Promise mutex so concurrent requests await the same
   * initialization and never race or conflict with Wrangler migrations.
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
  async runSchemaBootstrap() {
    try {
      await this.db.prepare("SELECT id, employee_code, role, active FROM users LIMIT 1").first();
      await this.db.prepare("SELECT id FROM sessions LIMIT 1").first();
      await this.db.prepare("SELECT id, revision, manually_edited, original_ocr_values, last_edited_by, last_edited_at FROM delivery_parts LIMIT 1").first();
      _PalletTrackDbService.verifiedDbs.add(this.db);
      return;
    } catch {
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
        notes TEXT,
        flagged_for_review INTEGER NOT NULL DEFAULT 0,
        ocr_confidence TEXT,
        manually_edited INTEGER NOT NULL DEFAULT 0,
        original_ocr_values TEXT,
        last_edited_by TEXT,
        last_edited_at TEXT,
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
      )`
    ];
    for (const sql of createStatements) {
      try {
        await this.db.prepare(sql).run();
      } catch (e) {
        console.warn("Schema bootstrap table notice:", e);
      }
    }
    const alterCols = [
      "ALTER TABLE users ADD COLUMN employee_code TEXT",
      "ALTER TABLE users ADD COLUMN pin_salt TEXT",
      "ALTER TABLE users ADD COLUMN last_login_at TEXT",
      "ALTER TABLE users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE users ADD COLUMN locked_until TEXT",
      "ALTER TABLE users ADD COLUMN created_by TEXT",
      "ALTER TABLE scan_events ADD COLUMN employee_name TEXT",
      "ALTER TABLE scan_events ADD COLUMN employee_role TEXT",
      "ALTER TABLE scan_events ADD COLUMN event_action TEXT DEFAULT 'part_scan'",
      "ALTER TABLE delivery_parts ADD COLUMN revision TEXT",
      "ALTER TABLE delivery_parts ADD COLUMN manually_edited INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE delivery_parts ADD COLUMN original_ocr_values TEXT",
      "ALTER TABLE delivery_parts ADD COLUMN last_edited_by TEXT",
      "ALTER TABLE delivery_parts ADD COLUMN last_edited_at TEXT"
    ];
    for (const sql of alterCols) {
      try {
        await this.db.prepare(sql).run();
      } catch {
      }
    }
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
      "CREATE INDEX IF NOT EXISTS idx_m1_delivery ON m1_synchronisations(delivery_id)"
    ];
    for (const sql of indexStatements) {
      try {
        await this.db.prepare(sql).run();
      } catch {
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
function extractToken(request) {
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
function buildSetCookieHeader(token, maxAge = 28800) {
  return `pallettrack_session=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}
function buildClearCookieHeader() {
  return `pallettrack_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}
function isAdminRole(role) {
  return role === "super_admin" || role === "admin";
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
          app: "PalletTrack",
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
            app: "PalletTrack",
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
          "Initial Super Admin setup required before using PalletTrack.",
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
        const created = await service.createDelivery(body);
        return jsonResponse(created, 201);
      }
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
          const updated = await service.updateDelivery(deliveryId, body);
          return jsonResponse(updated);
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
            return jsonResponse(added, 201);
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
            return jsonResponse(saved, 200);
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
          userId: currentUser.id,
          employeeName: currentUser.employeeName,
          employeeRole: currentUser.role,
          eventAction: body.eventAction || (Number(body.receivedQuantity) > 0 ? "part_receive" : "part_untick")
        };
        const result = await service.updatePartReceivedQuantity(deliveryId, partId, receivePayload);
        if (result.duplicate) {
          return jsonResponse(result, 409);
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
            return jsonResponse(updated, 200);
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
            return jsonResponse(deleted, 200);
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
    return null;
  } catch (err) {
    console.error("PalletTrack API Error:", err);
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
app.use("/tesseract", express.static(path2.resolve(__dirname, "node_modules/tesseract.js/dist")));
var localDb = getLocalDevDatabase();
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/deliveries") || req.path.startsWith("/api/users") || req.path.startsWith("/api/auth") || req.path === "/api/health") {
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
    res.setHeader("Content-Disposition", 'attachment; filename="pallettick-app-source.zip"');
    res.send(zipBuffer);
  } catch (err) {
    console.error("Error generating project zip:", err);
    res.status(500).json({ error: "Failed to generate project zip", details: err?.message });
  }
});
app.post("/api/extract-docket", async (req, res) => {
  try {
    const { images, startItemIndex, pageSlices } = req.body || {};
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
      Array.isArray(pageSlices) ? pageSlices : void 0
    );
    return res.status(200).json(result);
  } catch (err) {
    const rawMsg = err?.message || String(err || "");
    console.error("Gemini AI docket extraction error:", rawMsg);
    const isMissingKey = rawMsg.includes("GEMINI_API_KEY");
    const isRateLimited = err?.status === 429 || err?.code === "GEMINI_RATE_LIMIT_429" || rawMsg.includes("429") || rawMsg.includes("RESOURCE_EXHAUSTED");
    const isHighDemand = !isMissingKey && (err?.status === 503 || err?.code === "GEMINI_HIGH_DEMAND_503" || rawMsg.includes("503") || rawMsg.toLowerCase().includes("high demand") || rawMsg.toLowerCase().includes("overloaded"));
    const httpStatus = isMissingKey ? 503 : isHighDemand ? 503 : isRateLimited ? 429 : 500;
    const errorCode = isMissingKey ? "MISSING_GEMINI_API_KEY" : isHighDemand ? "GEMINI_HIGH_DEMAND_503" : isRateLimited ? "GEMINI_RATE_LIMIT_429" : err?.code || "AI_EXTRACTION_FAILED";
    return res.status(httpStatus).json({
      error: isMissingKey ? "Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings." : rawMsg || "Gemini AI docket extraction failed.",
      code: errorCode,
      retryable: !isMissingKey
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
    const { image, imageBase64, mimeType, knownParts, docketParts } = req.body || {};
    const resolvedImage = typeof image === "string" && image ? image : typeof imageBase64 === "string" && imageBase64 ? `data:${mimeType || "image/jpeg"};base64,${imageBase64}` : "";
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
    return res.status(500).json({
      error: err?.message || "Failed to read part label."
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
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PalletTick server running on http://localhost:${PORT}`);
  });
}
startServer();
