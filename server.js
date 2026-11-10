// server.ts
import express from "express";
import dotenv from "dotenv";
import path2 from "path";
import { fileURLToPath } from "url";

// src/server/docketOcr.ts
var PRIMARY_VISION_MODEL = "gemini-3.8-flash";
var FALLBACK_VISION_MODELS = ["gemini-3.1-flash-lite", "gemini-flash-latest"];
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
async function generateWithRateLimitProtection(ai, ThinkingLevel, parts, systemInstruction, responseSchema) {
  let lastError = null;
  for (let round = 1; round <= 4; round++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25e3);
    try {
      const response = await ai.models.generateContent({
        model: PRIMARY_VISION_MODEL,
        contents: { parts },
        config: {
          systemInstruction,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          responseMimeType: "application/json",
          responseSchema,
          abortSignal: controller.signal
        }
      });
      clearTimeout(timer);
      const text = (response.text ?? "").trim();
      if (text) return text;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const errStr = String(err?.message || err || "");
      const isRateLimit = err?.status === 429 || errStr.includes("429") || errStr.includes("RESOURCE_EXHAUSTED") || errStr.includes("quota");
      if (isRateLimit) {
        for (const fallbackModel of FALLBACK_VISION_MODELS) {
          const fbController = new AbortController();
          const fbTimer = setTimeout(() => fbController.abort(), 12e3);
          try {
            const fbRes = await ai.models.generateContent({
              model: fallbackModel,
              contents: { parts },
              config: {
                systemInstruction,
                responseMimeType: "application/json",
                responseSchema,
                abortSignal: fbController.signal
              }
            });
            clearTimeout(fbTimer);
            const fbText = (fbRes.text ?? "").trim();
            if (fbText) return fbText;
          } catch {
            clearTimeout(fbTimer);
          }
        }
        if (round < 4) {
          const delayMatch = errStr.match(/retryDelay"?\s*:\s*"?(\d+)s/i);
          const suggestedSec = delayMatch ? parseInt(delayMatch[1], 10) : 0;
          const waitMs = suggestedSec > 0 && suggestedSec <= 25 ? (suggestedSec + 1) * 1e3 : round * 6500;
          await sleep(waitMs);
          continue;
        }
      } else if (round < 3) {
        await sleep(400 * round);
        continue;
      }
    }
  }
  const rawMsg = String(lastError?.message || lastError || "");
  if (rawMsg.includes("429") || rawMsg.includes("RESOURCE_EXHAUSTED")) {
    throw new Error(
      'Gemini AI Free Tier rate limit (15 requests/min) reached. Please wait 30 seconds and click "Retry with Gemini AI".'
    );
  }
  throw new Error(rawMsg || "Gemini AI could not process the docket image.");
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
            mat: { type: Type.STRING },
            thk: { type: Type.STRING },
            dim: { type: Type.STRING },
            wt: { type: Type.STRING },
            qty: { type: Type.NUMBER, description: "Quantity of this part (never price)." }
          },
          required: ["no", "part", "desc", "qty"],
          propertyOrdering: ["page", "no", "part", "desc", "mat", "thk", "dim", "wt", "qty"]
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
  const text = await generateWithRateLimitProtection(
    ai,
    ThinkingLevel,
    parts,
    systemInstruction,
    responseSchema
  );
  const parsed = JSON.parse(text);
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
    items: Array.isArray(parsed.items) ? parsed.items : []
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
            mat: { type: Type.STRING },
            thk: { type: Type.STRING },
            dim: { type: Type.STRING },
            wt: { type: Type.STRING },
            qty: { type: Type.NUMBER }
          },
          required: ["no", "part", "desc", "qty"],
          propertyOrdering: ["page", "no", "part", "desc", "mat", "thk", "dim", "wt", "qty"]
        }
      }
    },
    required: ["items"]
  };
  parts.push({ text: promptText });
  try {
    const text = await generateWithRateLimitProtection(
      ai,
      ThinkingLevel,
      parts,
      systemInstruction,
      responseSchema
    );
    const parsed = JSON.parse(text);
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
  return {
    cleanNo,
    item: {
      partNumber: cleanPn,
      itemNumber: cleanNo,
      description: String(desc || cleanPn).trim(),
      material: it.mat && String(it.mat).trim() ? String(it.mat).trim() : void 0,
      thickness: it.thk && String(it.thk).trim() ? String(it.thk).trim() : void 0,
      dimensions: it.dim && String(it.dim).trim() ? String(it.dim).trim() : void 0,
      weight: it.wt && String(it.wt).trim() ? String(it.wt).trim() : void 0,
      quantity: cleanQty,
      palletNumber: "Pallet 1",
      pageNumber: resolvedPage,
      confidence: "high"
    }
  };
}
async function extractDocketWithGeminiVision(base64Images, startItemIndex = 1, pageSlices, overrideApiKey) {
  const apiKey = overrideApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings.");
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
  for (let bIdx = 0; bIdx < batchResponses.length; bIdx++) {
    const bRes = batchResponses[bIdx];
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
    aiModelUsed: PRIMARY_VISION_MODEL,
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
    const text = await generateWithRateLimitProtection(
      ai,
      ThinkingLevel,
      [
        { inlineData: { mimeType, data: base64Data } },
        { text: promptText }
      ],
      "Read the barcode or part code from the image.",
      responseSchema
    );
    const parsed = JSON.parse(text || "{}");
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
    safeAddCol("scan_events", "employee_name TEXT");
    safeAddCol("scan_events", "employee_role TEXT");
    safeAddCol("scan_events", "event_action TEXT DEFAULT 'part_scan'");
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

// src/server/api/palletTrackDbService.ts
var PalletTrackDbService = class {
  constructor(db) {
    this.db = db;
  }
  /**
   * Helper to format delivery parts from DB row to frontend object
   */
  mapPartRow(row) {
    return {
      id: row.id,
      deliveryId: row.delivery_id,
      partNumber: row.part_number,
      itemNumber: row.item_number,
      docketLineIndex: row.docket_line_index,
      description: row.description,
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
    const createdBy = input.createdBy || "usr_receiver_default";
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
      stmts.push(
        this.db.prepare(
          `INSERT INTO delivery_parts (
              id, delivery_id, part_number, item_number, docket_line_index, description,
              required_quantity, received_quantity, verification_status, status,
              material, thickness, dimensions, weight, pallet_number,
              scanned_at, scanned_via, scanned_code, notes, flagged_for_review,
              ocr_confidence, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          partId,
          id,
          p.partNumber.trim().toUpperCase(),
          p.itemNumber.trim(),
          lineIndex,
          p.description.trim(),
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
        input.userId || "usr_receiver_default",
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
      input.userId || "usr_receiver_default",
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
  // ==========================================
  // PHASE 2: AUTHENTICATION & USER MANAGEMENT
  // ==========================================
  /**
   * Check if any administrator exists in the system (first-time setup check)
   */
  async getProvisionStatus() {
    const adminRes = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1").first();
    const totalRes = await this.db.prepare("SELECT COUNT(*) as count FROM users").first();
    const adminCount = Number(adminRes?.count || 0);
    const totalCount = Number(totalRes?.count || 0);
    return {
      hasAdmin: adminCount > 0,
      totalUsers: totalCount
    };
  }
  /**
   * Provision the initial Administrator account.
   * Can ONLY be run once when no administrators exist.
   */
  async setupInitialAdmin(input) {
    const status = await this.getProvisionStatus();
    if (status.hasAdmin) {
      throw new Error("Initial admin setup is permanently disabled. Administrator already exists.");
    }
    const name = (input.employeeName || "").trim();
    const code = (input.employeeCode || "").trim().toUpperCase();
    const pin = (input.pin || "").trim();
    if (!name) throw new Error("Employee name is required");
    if (!code) throw new Error("Employee identifier is required");
    if (!/^\d{4}$/.test(pin)) throw new Error("PIN must be exactly 4 numeric digits");
    const { hash, salt } = await hashPin(pin);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const userId = `usr_admin_${Date.now()}`;
    await this.db.prepare(
      `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, last_login_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, name, code, hash, salt, "admin", 1, 0, null, now, now, now).run();
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
        role: "admin",
        active: true,
        lastLoginAt: now,
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
        role: user.role,
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
      role: row.role,
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
    const tokenHash = await hashSessionToken(token);
    await this.db.prepare("DELETE FROM sessions WHERE id = ?").bind(tokenHash).run();
  }
  /**
   * List all users (excluding hashes and salts) with activity stats
   */
  async listUsers() {
    const query = `
      SELECT u.id, u.employee_name, u.employee_code, u.role, u.active,
             u.failed_login_attempts, u.locked_until, u.last_login_at,
             u.created_at, u.updated_at,
             COUNT(s.id) as total_scans,
             MAX(s.timestamp) as last_scan_at
      FROM users u
      LEFT JOIN scan_events s ON u.id = s.user_id
      GROUP BY u.id
      ORDER BY u.employee_name ASC
    `;
    const res = await this.db.prepare(query).all();
    return (res.results || []).map((u) => ({
      id: u.id,
      employeeName: u.employee_name,
      employeeCode: u.employee_code,
      role: u.role,
      active: Boolean(u.active),
      failedLoginAttempts: Number(u.failed_login_attempts) || 0,
      lockedUntil: u.locked_until || null,
      lastLoginAt: u.last_login_at || null,
      createdAt: u.created_at,
      updatedAt: u.updated_at,
      totalScans: Number(u.total_scans) || 0,
      lastScanAt: u.last_scan_at || null
    }));
  }
  /**
   * Create a new employee account (Administrator only)
   */
  async createUser(input) {
    const name = (input.employeeName || "").trim();
    const code = (input.employeeCode || "").trim().toUpperCase();
    const pin = (input.pin || "").trim();
    const role = input.role || "operator";
    if (!name) throw new Error("Employee name is required");
    if (!code) throw new Error("Employee identifier is required");
    if (!["admin", "supervisor", "operator"].includes(role)) {
      throw new Error("Invalid role specified");
    }
    if (!/^\d{4}$/.test(pin)) {
      throw new Error("PIN must be exactly 4 numeric digits");
    }
    const existing = await this.db.prepare("SELECT id FROM users WHERE UPPER(employee_code) = ?").bind(code).first();
    if (existing) {
      throw new Error(`An employee with identifier "${code}" already exists.`);
    }
    const { hash, salt } = await hashPin(pin);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const userId = `usr_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await this.db.prepare(
      `INSERT INTO users (
          id, employee_name, employee_code, pin_hash, pin_salt, role, active,
          failed_login_attempts, locked_until, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, null, ?, ?)`
    ).bind(userId, name, code, hash, salt, role, now, now).run();
    return {
      id: userId,
      employeeName: name,
      employeeCode: code,
      role,
      active: true,
      createdAt: now,
      updatedAt: now
    };
  }
  /**
   * Update employee details (Name, identifier, role, active status)
   */
  async updateUser(userId, updates) {
    const existing = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }
    if (existing.role === "admin" && updates.active === false) {
      const activeAdmins = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?").bind(userId).first();
      if ((activeAdmins?.count || 0) <= 0) {
        throw new Error("Cannot deactivate the last remaining active Administrator.");
      }
    }
    if (existing.role === "admin" && updates.role && updates.role !== "admin") {
      const activeAdmins = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?").bind(userId).first();
      if ((activeAdmins?.count || 0) <= 0) {
        throw new Error("Cannot demote the last remaining active Administrator.");
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
    const newRole = updates.role !== void 0 ? updates.role : existing.role;
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
   * Reset employee 4-digit PIN (Administrator only).
   * Automatically clears any existing lockouts and revokes active sessions.
   */
  async resetUserPin(userId, newPin) {
    const pin = (newPin || "").trim();
    if (!/^\d{4}$/.test(pin)) {
      throw new Error("PIN must be exactly 4 numeric digits");
    }
    const existing = await this.db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
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
   */
  async deleteUser(userId) {
    const existing = await this.db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first();
    if (!existing) {
      throw new Error(`User not found: ${userId}`);
    }
    if (existing.role === "admin") {
      const activeAdmins = await this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND active = 1 AND id != ?").bind(userId).first();
      if ((activeAdmins?.count || 0) <= 0) {
        throw new Error("Cannot delete the last remaining active Administrator.");
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
async function handlePalletTrackApiRequest(request, db) {
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
  try {
    if (path3 === "/api/health") {
      try {
        const ping = await db.prepare("SELECT 1 as alive").first();
        const prov = await service.getProvisionStatus();
        return jsonResponse({
          status: "ok",
          app: "PalletTrack",
          database: "Cloudflare D1 (centralised)",
          dbConnected: Boolean(ping),
          hasAdmin: prov.hasAdmin,
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
          400
        );
      }
      try {
        const result = await service.setupInitialAdmin({
          employeeName: body.employeeName,
          employeeCode: body.employeeCode,
          pin: body.pin,
          userAgent,
          ipAddress
        });
        return jsonResponse(
          {
            success: true,
            user: result.user,
            token: result.token,
            expiresAt: result.expiresAt,
            message: "Initial Administrator provisioned successfully."
          },
          201,
          { "Set-Cookie": buildSetCookieHeader(result.token) }
        );
      } catch (err) {
        return errorResponse(err.message || "Failed to provision initial administrator", 400);
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
      const token = extractToken(request);
      if (!token) {
        const prov = await service.getProvisionStatus();
        if (!prov.hasAdmin) {
          return errorResponse(
            "Initial Administrator setup required before using PalletTrack.",
            428,
            "SETUP_REQUIRED"
          );
        }
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
      if (currentUser.role !== "admin") {
        return errorResponse(
          "Forbidden: Administrator privileges required to manage employee accounts.",
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
          const created = await service.createUser(body);
          return jsonResponse(created, 201);
        } catch (err) {
          return errorResponse(err?.message || "Failed to create employee", 400);
        }
      }
      const userMatch = path3.match(/^\/api\/users\/([^/]+)(.*)$/);
      if (userMatch) {
        const targetUserId = decodeURIComponent(userMatch[1]);
        const sub = userMatch[2];
        if (sub === "/reset-pin" && method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (!body.pin) {
            return errorResponse("New 4-digit PIN is required.", 400);
          }
          try {
            const res = await service.resetUserPin(targetUserId, body.pin);
            return jsonResponse(res);
          } catch (err) {
            return errorResponse(err?.message || "Failed to reset PIN", 400);
          }
        }
        if ((sub === "" || sub === "/") && (method === "PATCH" || method === "PUT")) {
          const body = await request.json().catch(() => ({}));
          try {
            const updated = await service.updateUser(targetUserId, body);
            return jsonResponse(updated);
          } catch (err) {
            return errorResponse(err?.message || "Failed to update user", 400);
          }
        }
        if ((sub === "" || sub === "/") && method === "DELETE") {
          try {
            const deleted = await service.deleteUser(targetUserId);
            return jsonResponse(deleted);
          } catch (err) {
            return errorResponse(err?.message || "Failed to delete user", 400);
          }
        }
      }
    }
    if (path3 === "/api/deliveries/migrate" && method === "POST") {
      const authResult = await authenticateSession();
      if (authResult instanceof Response) return authResult;
      const currentUser = authResult;
      if (currentUser.role === "operator") {
        return errorResponse("Forbidden: Operator role cannot trigger data migration.", 403, "FORBIDDEN");
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
        if (currentUser.role === "operator") {
          return errorResponse(
            "Forbidden: Operators cannot create new deliveries. Contact your supervisor or administrator.",
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
          if (currentUser.role === "operator") {
            return errorResponse(
              "Forbidden: Operators cannot modify delivery headers or status.",
              403,
              "FORBIDDEN"
            );
          }
          const body = await request.json().catch(() => ({}));
          const updated = await service.updateDelivery(deliveryId, body);
          return jsonResponse(updated);
        }
      }
      if (subPath === "/parts" && method === "GET") {
        const parts = await service.getDeliveryParts(deliveryId);
        return jsonResponse(parts);
      }
      const partReceiveMatch = subPath.match(/^\/parts\/([^/]+)\/(?:receive|quantity)$/);
      if (partReceiveMatch && (method === "POST" || method === "PUT")) {
        const partId = decodeURIComponent(partReceiveMatch[1]);
        const body = await request.json().catch(() => ({}));
        if (typeof body.receivedQuantity === "undefined") {
          return errorResponse("receivedQuantity is required", 400);
        }
        if (currentUser.role === "operator" && body.scannedVia === "manual" && body.overrideAllowed === false) {
          return errorResponse("Forbidden: Operators cannot manually override quantities.", 403, "FORBIDDEN");
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
      if (subPath === "/scans") {
        if (method === "GET") {
          const scans = await service.getScanHistory(deliveryId);
          return jsonResponse(scans);
        }
        if (method === "POST") {
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  if (req.path.startsWith("/api/deliveries") || req.path.startsWith("/api/users") || req.path === "/api/health") {
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
      const webRes = await handlePalletTrackApiRequest(webReq, localDb);
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
    return res.status(isMissingKey ? 503 : 500).json({
      error: isMissingKey ? "Gemini AI API key is not configured on the server. Please set GEMINI_API_KEY in your server environment settings." : rawMsg || "Gemini AI docket extraction failed.",
      code: isMissingKey ? "MISSING_GEMINI_API_KEY" : "AI_EXTRACTION_FAILED"
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
