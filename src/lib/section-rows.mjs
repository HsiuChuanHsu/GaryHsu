export default {
  name: 'section-rows',
  before(tree, context) {
    const children = [];
    let content;

    for (const node of tree.children) {
      if (node.type === 'element' && ['h1', 'h2', 'h3'].includes(node.tagName)) {
        content = undefined;
      }
      if (node.type === 'element' && node.tagName === 'h3') {
        content = { type: 'element', tagName: 'div', properties: { className: ['section-content'] }, children: [] };
        children.push({ type: 'element', tagName: 'section', properties: { className: ['section-row'] }, children: [node, content] });
      } else {
        (content ? content.children : children).push(node);
      }
    }

    context.setField(tree, 'children', children);
  },
};
