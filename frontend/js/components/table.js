// Таблица, которая на узком экране становится стопкой карточек (CSS: .cqa-table--cards).
// Явные роли сохраняют табличную семантику, когда CSS меняет display; подписи полей видны только в карточках.
export function cardTable(table) {
  table.classList.add('cqa-table--cards');
  table.setAttribute('role', 'table');
  for (const group of table.querySelectorAll('thead, tbody')) group.setAttribute('role', 'rowgroup');
  for (const row of table.querySelectorAll('thead tr')) row.setAttribute('role', 'row');
  for (const cell of table.querySelectorAll('thead th')) cell.setAttribute('role', 'columnheader');
  return table;
}

export function labelRow(tr, columns) {
  tr.setAttribute('role', 'row');
  [...tr.children].forEach((cell, index) => {
    cell.setAttribute('role', cell.tagName === 'TH' ? 'rowheader' : 'cell');
    const label = columns[index];
    if (!label) return;
    const node = document.createElement('span');
    node.className = 'cqa-mobile-label';
    node.setAttribute('aria-hidden', 'true');
    node.textContent = label;
    cell.prepend(node);
  });
  return tr;
}
