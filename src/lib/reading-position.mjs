export function readingPosition(headings, boundary) {
  let chapter = '';
  let section = '';
  for (const heading of headings) {
    if (heading.top > boundary) break;
    if (heading.level === 2) {
      chapter = heading.text;
      section = '';
    } else {
      section = heading.text;
    }
  }
  return [chapter, section];
}
