import React from 'react';
import { DeliveryPart, Delivery } from '../types/delivery';

export interface PartSearchResult {
  part: DeliveryPart;
  deliveryId?: string;
  docketNumber?: string;
  supplier?: string;
  carrier?: string;
  orderNumber?: string;
  score: number;
  matchedFields: Array<'partNumber' | 'itemNumber' | 'description' | 'material' | 'supplier' | 'notes'>;
}

/**
 * Normalises a string for fast case-insensitive comparison
 */
export function normaliseSearchString(str?: string | null): string {
  if (!str) return '';
  return str.trim().toLowerCase();
}

/**
 * Breaks query into tokens so multi-term searches like "stainless 2048" or "bracket mount" work
 */
export function parseSearchTokens(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [];
  // Split on whitespace while keeping whole digits or words
  return trimmed.split(/\s+/).filter(Boolean);
}

/**
 * Calculates match score and detects whether all query tokens match any of the part's fields.
 * Essential rule: Substring matching matches ANYWHERE in the field (especially last 4 digits).
 */
export function matchPartWithQuery(
  part: DeliveryPart,
  query: string,
  extraContext?: { docketNumber?: string; supplier?: string; carrier?: string }
): { isMatch: boolean; score: number; matchedFields: PartSearchResult['matchedFields'] } {
  const cleanQuery = query.trim().toLowerCase();
  if (!cleanQuery) {
    return { isMatch: true, score: 0, matchedFields: [] };
  }

  const tokens = parseSearchTokens(cleanQuery);
  if (tokens.length === 0) {
    return { isMatch: true, score: 0, matchedFields: [] };
  }

  const pNum = (part.partNumber || '').toLowerCase();
  const iNum = (part.itemNumber || '').toLowerCase();
  const desc = (part.description || '').toLowerCase();
  const mat = [part.material, part.thickness, part.dimensions].filter(Boolean).join(' ').toLowerCase();
  const notes = (part.notes || '').toLowerCase();
  const supplier = (extraContext?.supplier || '').toLowerCase();
  const docket = (extraContext?.docketNumber || '').toLowerCase();

  const matchedFieldsSet = new Set<PartSearchResult['matchedFields'][number]>();
  let totalScore = 0;

  // Every token must match at least one searchable field
  for (const token of tokens) {
    let tokenMatched = false;

    // 1. Part Number Check (Highest priority)
    if (pNum) {
      if (pNum === token) {
        matchedFieldsSet.add('partNumber');
        totalScore += 100;
        tokenMatched = true;
      } else if (pNum.endsWith(token)) {
        // Last 4 digits match or suffix match! (Critical business requirement)
        matchedFieldsSet.add('partNumber');
        totalScore += 90;
        tokenMatched = true;
      } else if (pNum.startsWith(token)) {
        matchedFieldsSet.add('partNumber');
        totalScore += 80;
        tokenMatched = true;
      } else if (pNum.includes(token)) {
        // Substring anywhere (e.g. 3 middle digits or BRK in LASER-BRK-2048)
        matchedFieldsSet.add('partNumber');
        totalScore += 75;
        tokenMatched = true;
      } else {
        // Test alphanumeric only (stripping hyphens/spaces: user typing "BRK2048" matches "BRK-2048")
        const strippedPNum = pNum.replace(/[^a-z0-9]/g, '');
        const strippedToken = token.replace(/[^a-z0-9]/g, '');
        if (strippedToken && strippedPNum.includes(strippedToken)) {
          matchedFieldsSet.add('partNumber');
          totalScore += 70;
          tokenMatched = true;
        }
      }
    }

    // 2. Item Number Check (Docket line barcode reference)
    if (iNum && iNum.includes(token)) {
      matchedFieldsSet.add('itemNumber');
      totalScore += 65;
      tokenMatched = true;
    }

    // 3. Description Check (Keywords like bracket, mount, stainless, plate anywhere)
    if (desc) {
      if (desc.includes(token)) {
        matchedFieldsSet.add('description');
        // Bonus if it matches as a distinct word boundary
        const wordRegex = new RegExp(`\\b${escapeRegExp(token)}`, 'i');
        totalScore += wordRegex.test(desc) ? 60 : 50;
        tokenMatched = true;
      }
    }

    // 4. Material / Spec / Thickness
    if (mat && mat.includes(token)) {
      matchedFieldsSet.add('material');
      totalScore += 40;
      tokenMatched = true;
    }

    // 5. Supplier / Customer Context
    if ((supplier && supplier.includes(token)) || (docket && docket.includes(token))) {
      matchedFieldsSet.add('supplier');
      totalScore += 30;
      tokenMatched = true;
    }

    // 6. Notes
    if (notes && notes.includes(token)) {
      matchedFieldsSet.add('notes');
      totalScore += 20;
      tokenMatched = true;
    }

    if (!tokenMatched) {
      return { isMatch: false, score: 0, matchedFields: [] };
    }
  }

  return {
    isMatch: true,
    score: totalScore,
    matchedFields: Array.from(matchedFieldsSet),
  };
}

/**
 * Searches a list of parts for matching queries with scoring and sorting.
 */
export function filterPartsSmart(
  parts: DeliveryPart[],
  query: string,
  extraContext?: { docketNumber?: string; supplier?: string }
): DeliveryPart[] {
  const clean = query.trim();
  if (!clean) return parts;

  const scored: Array<{ part: DeliveryPart; score: number }> = [];

  for (const part of parts) {
    const res = matchPartWithQuery(part, clean, extraContext);
    if (res.isMatch) {
      scored.push({ part, score: res.score });
    }
  }

  // Sort descending by relevance score
  scored.sort((a, b) => b.score - a.score);
  return scored.map((item) => item.part);
}

/**
 * Searches across ALL stored deliveries in the warehouse to find matching parts.
 */
export function searchAllDeliveriesParts(
  deliveries: Delivery[],
  query: string
): PartSearchResult[] {
  const clean = query.trim();
  if (!clean) return [];

  const results: PartSearchResult[] = [];

  for (const delivery of deliveries) {
    const parts = delivery.parts || [];
    for (const part of parts) {
      const match = matchPartWithQuery(part, clean, {
        docketNumber: delivery.docketNumber,
        supplier: delivery.supplier,
        carrier: delivery.carrier,
      });

      if (match.isMatch) {
        results.push({
          part,
          deliveryId: delivery.id,
          docketNumber: delivery.docketNumber,
          supplier: delivery.supplier,
          carrier: delivery.carrier,
          orderNumber: delivery.orderNumber,
          score: match.score,
          matchedFields: match.matchedFields,
        });
      }
    }
  }

  // Sort by highest relevance score
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Checks whether a delivery (docket number, supplier, order number, carrier, notes, or any of its parts)
 * matches a smart search query.
 */
export function deliveryMatchesSmartQuery(delivery: Delivery, query: string): boolean {
  const clean = query.trim().toLowerCase();
  if (!clean) return true;

  const tokens = parseSearchTokens(clean);
  if (tokens.length === 0) return true;

  const headerHaystack = [
    delivery.docketNumber,
    delivery.supplier,
    delivery.orderNumber,
    delivery.carrier,
    delivery.notes,
    delivery.deliveryDate,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Check if all tokens match the delivery header directly
  const allMatchHeader = tokens.every((token) => headerHaystack.includes(token));
  if (allMatchHeader) return true;

  // Check if any part in the delivery matches the query
  for (const part of delivery.parts || []) {
    const res = matchPartWithQuery(part, clean, {
      docketNumber: delivery.docketNumber,
      supplier: delivery.supplier,
      carrier: delivery.carrier,
    });
    if (res.isMatch) return true;
  }

  return false;
}

/**
 * Escapes characters for safe regular expression building
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Splits text into segments indicating whether each segment matches the search query.
 */
export function highlightSegments(
  text: string,
  query: string
): Array<{ text: string; isMatch: boolean }> {
  if (!text) return [];
  const tokens = parseSearchTokens(query);
  if (tokens.length === 0) {
    return [{ text, isMatch: false }];
  }

  // Build regex matching any of the tokens (case-insensitive)
  const pattern = tokens.map(escapeRegExp).join('|');
  if (!pattern) {
    return [{ text, isMatch: false }];
  }

  const regex = new RegExp(`(${pattern})`, 'gi');
  const parts = text.split(regex);

  return parts
    .filter((p) => p.length > 0)
    .map((seg) => ({
      text: seg,
      isMatch: tokens.some((t) => t.toLowerCase() === seg.toLowerCase()),
    }));
}

/**
 * High-performance React Component to highlight matching substrings in text.
 */
export const HighlightMatch: React.FC<{
  text?: string | null;
  query: string;
  className?: string;
  highlightClassName?: string;
}> = ({ text, query, className = '', highlightClassName }) => {
  if (!text) return null;
  if (!query || !query.trim()) {
    return <span className={className}>{text}</span>;
  }

  const segments = highlightSegments(text, query);
  const defaultHighlightClass =
    highlightClassName ||
    'bg-cyan-500/30 text-cyan-200 font-extrabold px-0.5 rounded shadow-[0_0_6px_rgba(0,168,255,0.4)]';

  return (
    <span className={className}>
      {segments.map((seg, idx) =>
        seg.isMatch ? (
          <mark key={idx} className={`${defaultHighlightClass} not-italic`}>
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={idx}>{seg.text}</React.Fragment>
        )
      )}
    </span>
  );
};
