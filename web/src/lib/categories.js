/** Options for a category drop-down: each top-level category, then its sub-categories indented. */
export function categoryOptions(cats) {
  const tops = cats.filter((c) => !c.parentId).sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const t of tops) {
    out.push({ key: t.id, value: t.name, label: t.name, top: true });
    for (const s of cats.filter((c) => c.parentId === t.id).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ key: s.id, value: s.name, label: `${t.name} › ${s.name}`, parent: t.name });
    }
  }
  return out;
}
