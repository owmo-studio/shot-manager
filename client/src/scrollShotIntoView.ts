/** Keep keyboard-selected cards comfortably inside the grid's own viewport. */
export function scrollShotIntoView(card: HTMLElement) {
    const viewport = card.closest<HTMLElement>("[data-shot-scroll]");
    if (!viewport) return;
    const bounds = viewport.getBoundingClientRect();
    const visibleTop = bounds.top + viewport.clientTop;
    const visibleBottom = visibleTop + viewport.clientHeight;
    const margin = 20;
    const cardBounds = card.getBoundingClientRect();
    let targetTop = cardBounds.top;

    const day = card.closest<HTMLElement>("[data-shot-day]");
    const firstCard = day?.querySelector<HTMLElement>("[data-shot-card] > button");
    const heading = day?.querySelector<HTMLElement>("h3");
    if (firstCard && heading && Math.abs(firstCard.getBoundingClientRect().top - cardBounds.top) < 8) {
        const headingTop = heading.getBoundingClientRect().top;
        // Include the date whenever the heading and full card fit together.
        if (cardBounds.bottom - headingTop <= viewport.clientHeight - margin * 2) targetTop = headingTop;
    }

    let offset = 0;
    if (targetTop < visibleTop + margin) offset = targetTop - visibleTop - margin;
    else if (cardBounds.bottom > visibleBottom - margin) offset = cardBounds.bottom - visibleBottom + margin;
    if (offset) viewport.scrollBy({ top: offset, behavior: "instant" });
}
