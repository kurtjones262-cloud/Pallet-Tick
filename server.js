// server.ts
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

// src/server/docketOcr.ts
var PRIMARY_VISION_MODEL = "gemini-3.1-flash-lite";
var FALLBACK_VISION_MODELS = ["gemini-3.8-flash", "gemini-flash-latest"];
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
                ...fallbackModel === "gemini-3.8-flash" ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {},
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

// server.ts
dotenv.config({ quiet: true });
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
var __filename = fileURLToPath(import.meta.url);
var __dirname = path.dirname(__filename);
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
app.use(express.static(path.resolve(__dirname, "public")));
app.use("/tesseract", express.static(path.resolve(__dirname, "node_modules/tesseract.js/dist")));
app.get("/api/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    app: "PartTrack",
    runtime: "node-express",
    offlineOcrReady: true,
    engine: "tesseract.js-wasm-local",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.get("/api/export-project-zip", async (_req, res) => {
  try {
    let addDirectory = function(currentPath, zipFolder) {
      const items = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const item of items) {
        if (ignoredNames.has(item.name)) continue;
        const itemFullPath = path.join(currentPath, item.name);
        if (item.isDirectory()) {
          const sub = zipFolder.folder(item.name);
          if (sub) addDirectory(itemFullPath, sub);
        } else if (item.isFile()) {
          const stat = fs.statSync(itemFullPath);
          if (stat.size < 10 * 1024 * 1024) {
            const fileContent = fs.readFileSync(itemFullPath);
            zipFolder.file(item.name, fileContent);
          }
        }
      }
    };
    const JSZipModule = (await import("jszip")).default;
    const fs = await import("fs");
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
    res.setHeader("Content-Disposition", 'attachment; filename="parttrack-app-source.zip"');
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
    app.use(express.static(path.resolve(__dirname, "dist")));
    app.get("*", (_req, res) => {
      res.sendFile(path.resolve(__dirname, "dist", "index.html"));
    });
  }
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`PartTrack server running on http://localhost:${PORT}`);
  });
}
startServer();
