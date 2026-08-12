/* Render-only module for the Past entries card. Data comes from store.js;
 * wiring (delete handlers, inline confirms) stays in ui.js. */

export function formatDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function renderHistory(listEl, rows, { onDelete }) {
  listEl.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    li.className = 'history-row';
    if (row.thumb) {
      const img = document.createElement('img');
      img.src = row.thumb;
      img.alt = '';
      img.className = 'history-thumb';
      li.appendChild(img);
    }
    const main = document.createElement('div');
    main.className = 'history-main';
    const date = document.createElement('div');
    date.className = 'history-date';
    date.textContent = formatDate(row.savedAt);
    const counts = document.createElement('div');
    counts.className = 'history-counts';
    counts.textContent = row.total + ' word' + (row.total === 1 ? '' : 's') + ' · ' +
      row.pageCount + (row.pageCount === 1 ? ' page' : ' pages') +
      (row.pageCount > 1 ? ' (' + row.perPageCounts.join(' + ') + ')' : '');
    main.append(date, counts);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pill-button pill-ghost history-delete';
    del.textContent = 'Delete';
    del.setAttribute('aria-label', 'Delete entry from ' + formatDate(row.savedAt) + ', ' + row.total + ' words');
    del.addEventListener('click', () => onDelete(row, del));
    li.append(main, del);
    listEl.appendChild(li);
  }
}
