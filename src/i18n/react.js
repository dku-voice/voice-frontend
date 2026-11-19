import React from 'react';
import { translate } from './index.js';

// Localize the React render result, not the DOM. Element types/keys, refs, event
// handlers, selected option IDs and controlled input values stay untouched.
// External SDK iframe contents are intentionally outside this boundary.
export function localizeTree(node, language) {
  if (language === 'ko') return node;
  if (typeof node === 'string') return translate(node, language);
  if (Array.isArray(node)) return node.map((child) => localizeTree(child, language));
  if (!React.isValidElement(node)) return node;
  const props = {};
  for (const name of ['title', 'alt', 'placeholder', 'aria-label']) {
    if (typeof node.props[name] === 'string') props[name] = translate(node.props[name], language);
  }
  if (node.props.children !== undefined) props.children = localizeTree(node.props.children, language);
  return React.cloneElement(node, props);
}
