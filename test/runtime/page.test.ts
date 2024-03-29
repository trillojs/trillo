import { assert } from "chai";
import { GlobalWindow, Window } from "happy-dom";
import { BODY_SCOPE_NAME, DOM_ID_ATTR, HEAD_SCOPE_NAME, Page, PageProps, ROOT_SCOPE_NAME } from "../../src/runtime/page";
import { Scope, ScopeProps } from "../../src/runtime/scope";

describe('runtime: page', () => {

  it('should create an empty page', () => {
    const page = baseApp(null);
    assert.exists(page.dom);
    assert.equal(scopeCount(page), 3);
    assert.equal(page.root.dom, page.doc.documentElement);
    assert.equal(page.root.children[0].dom, page.doc.head);
    assert.equal(page.root.children[1].dom, page.doc.body);
    assert.equal(page.root.values[ROOT_SCOPE_NAME].props.val, page.root.proxy);
    assert.equal(page.root.values[HEAD_SCOPE_NAME].props.val, page.root.children[0].proxy);
    assert.equal(page.root.values[BODY_SCOPE_NAME].props.val, page.root.children[1].proxy);
    assert.equal(
      page.getMarkup(),
      `<!DOCTYPE html><html ${DOM_ID_ATTR}="0">` +
      `<head ${DOM_ID_ATTR}="1"></head>` +
      `<body ${DOM_ID_ATTR}="2"></body>` +
      `</html>`
    );
  });

  it('should create a simple page', () => {
    const page = baseApp(null, props => {
      addScope(props, [1], {
        id: '3',
        markup: `<span>hi</span>`
      });
    });
    assert.exists(page.dom);
    assert.equal(scopeCount(page), 4);
    assert.equal(page.root.dom, page.doc.documentElement);
    assert.equal(page.root.children[0].dom, page.doc.head);
    assert.equal(page.root.children[1].dom, page.doc.body);
    assert.equal(page.root.children[1].children[0].dom.tagName, 'SPAN');
    assert.equal(
      page.getMarkup(),
      `<!DOCTYPE html><html ${DOM_ID_ATTR}="0">` +
      `<head ${DOM_ID_ATTR}="1"></head>` +
      `<body ${DOM_ID_ATTR}="2"><span ${DOM_ID_ATTR}="3">hi</span></body>` +
      `</html>`
    );
  });

});

// =============================================================================
// utils
// =============================================================================

function scopeCount(page: Page): number {
  let ret = 0;
  function f(scope: Scope) {
    ret++;
    scope.children?.forEach(f);
  }
  f(page.root);
  return ret;
}

export function baseApp(markup: string | null, cb?: (props: PageProps) => void): Page {
  const win = new Window();
  const doc = win.document;
  doc.documentElement.setAttribute(DOM_ID_ATTR, '0');
  doc.head.setAttribute(DOM_ID_ATTR, '1');
  doc.body.setAttribute(DOM_ID_ATTR, '2');
  markup && win.document.write(markup);
  const props: PageProps = {
    root: {
      id: '0',
      name: ROOT_SCOPE_NAME,
      children: [{
        id: '1',
        name: HEAD_SCOPE_NAME
      }, {
        id: '2',
        name: BODY_SCOPE_NAME
      }]
    }
  }
  cb ? cb(props) : null;
  return new Page(win as any, doc.documentElement as unknown as Element, props);
}

export function addScope(props: PageProps, pos: number[], scope: ScopeProps) {
  let parent: ScopeProps | undefined = props.root;
  for (const i of pos) {
    parent = itemAt(i, parent?.children);
  }
  if (parent) {
    parent.children ? null : parent.children = [];
    parent.children.push(scope);
  }
}

export function itemAt(i: number, a?: any[]): any {
  return (a && a.length > i ? a[i] : null);
}
