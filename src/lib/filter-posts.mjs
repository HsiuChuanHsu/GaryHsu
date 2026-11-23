export function filterPostRows(rows, type) {
  let visible = 0;
  for (const row of rows) {
    row.hidden = Boolean(type && row.dataset.postType !== type);
    if (!row.hidden) visible++;
  }
  return visible;
}

export function sortPostRows(rows, sort, key = 'postType') {
  const types = key === 'postCategory' ? ['work', 'personal'] : ['InGuide', 'InSolve', 'InInput', 'InSpec', ''];
  const rank = (row) => {
    const index = types.indexOf(row.dataset[key]);
    return index < 0 ? types.length : index;
  };
  return [...rows].sort((a, b) =>
    (sort === 'category' ? rank(a) - rank(b) : 0)
    || b.dataset.postDate.localeCompare(a.dataset.postDate));
}
