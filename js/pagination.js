/**
 * Client-side pagination helpers (slice arrays already loaded in memory).
 */

/**
 * @template T
 * @param {T[]} items
 * @param {number} pageIndex0
 * @param {number} pageSize
 */
export function paginateSlice(items, pageIndex0, pageSize) {
  const total = items.length;
  const pageCount = total === 0 ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const idx = Math.min(Math.max(0, pageIndex0), pageCount - 1);
  const start = idx * pageSize;
  const slice = items.slice(start, start + pageSize);
  return {
    slice,
    total,
    pageCount,
    pageIndex: idx,
    pageSize,
    startIndex: total === 0 ? 0 : start + 1,
    endIndex: start + slice.length,
  };
}

/**
 * @param {HTMLElement | null} container
 * @param {{ pageIndex: number, pageSize: number, total: number, onPageChange: (nextPageIndex0: number) => void }} opts
 */
export function mountPaginationBar(container, opts) {
  const { pageIndex, pageSize, total, onPageChange } = opts;
  if (!container) return;
  if (total === 0 || total <= pageSize) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  const pageCount = Math.ceil(total / pageSize);
  const idx = Math.min(Math.max(0, pageIndex), pageCount - 1);
  const start = idx * pageSize;
  const from = start + 1;
  const to = Math.min(total, start + pageSize);
  container.hidden = false;
  container.innerHTML = `<div class="pagination-bar">
  <span class="pagination-meta muted small">Showing ${from}–${to} of ${total}</span>
  <div class="pagination-actions">
    <button type="button" class="btn btn-secondary btn-small pagination-prev" ${idx <= 0 ? "disabled" : ""} aria-label="Previous page">Previous</button>
    <span class="pagination-page muted small">Page ${idx + 1} of ${pageCount}</span>
    <button type="button" class="btn btn-secondary btn-small pagination-next" ${idx >= pageCount - 1 ? "disabled" : ""} aria-label="Next page">Next</button>
  </div>
</div>`;
  container.querySelector(".pagination-prev")?.addEventListener("click", () => {
    if (idx > 0) onPageChange(idx - 1);
  });
  container.querySelector(".pagination-next")?.addEventListener("click", () => {
    if (idx < pageCount - 1) onPageChange(idx + 1);
  });
}
