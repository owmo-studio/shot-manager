import type { ClipAttributes } from './organization';
import { ingestAttributes } from './ingestion';

export interface LibraryReceiptReference { libraryPath: string }
export type PublishedClipState = 'synced' | 'changes-pending' | 'unverified' | 'new';

export interface PublishedStateEvidence {
    libraryConfigured: boolean;
    presenceKnown: boolean;
    existing: boolean;
    complete: boolean;
    proxyRequired: boolean;
    proxyPresent: boolean;
    receiptMatches: boolean;
    signatureMatches: boolean;
}

/**
 * Compare descriptive clip data using the persisted shape rather than the
 * mutable ShotOrganization object. Skip and selection state are deliberately
 * excluded by ingestAttributes().
 */
export function attributesEqual(left: ClipAttributes | undefined, right: ClipAttributes | undefined): boolean {
    if (!left || !right) return left === right;
    return JSON.stringify(ingestAttributes(left)) === JSON.stringify(ingestAttributes(right));
}

export function valuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

/** Missing baselines are meaningful: there is nothing trusted to compare. */
export function attributesChanged(left: ClipAttributes | undefined, right: ClipAttributes | undefined): boolean {
    return !left || !right ? left !== right : !attributesEqual(left, right);
}

export function thumbnailChanged(currentDigest?: string, baselineDigest?: string): boolean {
    return !!currentDigest && !!baselineDigest && currentDigest !== baselineDigest;
}

/** A staged thumbnail is pending until it matches a verified published asset. */
export function thumbnailDraftChanged(draftDigest?: string, published = false, baselineDigest?: string): boolean {
    return !!draftDigest && (!published || draftDigest !== baselineDigest);
}

export function receiptMatchesLibrary(receipt: LibraryReceiptReference | undefined, libraryPath: string | null): boolean {
    return !!receipt && !!libraryPath && receipt.libraryPath === libraryPath;
}

/**
 * Classify remote evidence without treating an unavailable Library as empty.
 * This is intentionally independent of UI wording and queue locks.
 */
export function publishedClipState(evidence: PublishedStateEvidence): PublishedClipState | undefined {
    if (!evidence.libraryConfigured || !evidence.presenceKnown) return evidence.receiptMatches ? 'unverified' : undefined;
    if (!evidence.existing) return 'new';
    return evidence.complete && (!evidence.proxyRequired || evidence.proxyPresent) && evidence.receiptMatches && evidence.signatureMatches
        ? 'synced'
        : 'changes-pending';
}

export function descriptiveStateChanged(
    attributes: ClipAttributes | undefined,
    baseline: ClipAttributes | undefined,
    thumbnailDigest?: string,
    baselineThumbnailDigest?: string,
): boolean {
    return attributesChanged(attributes, baseline) || thumbnailChanged(thumbnailDigest, baselineThumbnailDigest);
}
