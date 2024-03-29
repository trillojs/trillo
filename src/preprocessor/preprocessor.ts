import { promises as fsPromises } from "fs"; // node >= 10.1
// import fsPromises from "fs/promises"; // node >= 14
import path from "path";
import { ELEMENT_NODE, TEXT_NODE } from "./dom";
import { HtmlDocument, HtmlElement, HtmlNode, HtmlPos, HtmlText } from "./htmldom";
import HtmlParser, { HtmlException } from "./htmlparser";

export const EMBEDDED_INCLUDE_FNAME = ':embedded:';

const INCLUDE_TAG = ':INCLUDE';
const IMPORT_TAG = ':IMPORT';
const INCLUDE_SRC = 'src';
const INCLUDE_AS = 'as';

const DEFINE_TAG = ':DEFINE';
const DEFINE_ARG = 'tag';
const SLOT_TAG = ':SLOT';
const SLOT_ARG = 'name';
const SLOT_ATTR = ':slot';

export const MARKDOWN_TAG = ':MARKDOWN';
const MARKDOWN_DEFAULT_CLASS = 'trillo-markdown';

const MAX_RECURSIONS = 100;

interface Definition {
  name1: string,
  name2: string,
  e: HtmlElement,
  ext?: Definition,
}

export interface SourcePos {
  fname: string,
  line1: number,
  column1: number,
  line2: number,
  column2: number,
}

export interface VirtualFile {
  fname: string,
  content: string,
}

export default class Preprocessor {
  rootPath: string;
  parser: HtmlParser;
  sources: Array<string>;
  macros: Map<string, Definition>;
  virtualFiles: Map<string, string>|undefined;

  constructor(rootPath: string, virtualFiles?: Array<VirtualFile>) {
    this.rootPath = rootPath;
    this.parser = new HtmlParser();
    this.sources = [];
    this.macros = new Map();
    if (virtualFiles) {
      this.virtualFiles = new Map();
      for (var v of virtualFiles) {
        var filePath = path.normalize(path.join(rootPath, v.fname));;
        this.virtualFiles.set(filePath, v.content);
      }
    }
  }

  reset(virtualFiles?: Array<VirtualFile>) {
    this.parser = new HtmlParser();
    this.sources = [];
    this.macros = new Map();
    if (virtualFiles) {
      this.virtualFiles = new Map();
      for (var v of virtualFiles) {
        var filePath = path.normalize(path.join(this.rootPath, v.fname));;
        this.virtualFiles.set(filePath, v.content);
      }
    }
    return this;
  }

  async read(fname: string, embeddedInclude?: string): Promise<HtmlDocument | undefined> {
    if (!embeddedInclude) {
      // by specifying `embeddedInclude` we ensure `<head>` and `<body>`
      embeddedInclude = '<lib></lib>';
    }
    var ret = await this.readFile(fname, 0);
    if (ret) {
      if (embeddedInclude != null) {
        domEnsureHeadAndBody(ret);
        var head = domGetTop(ret, 'HEAD');
        if (head) {
          var inc = this.parser.parseDoc(embeddedInclude, EMBEDDED_INCLUDE_FNAME);
          if (inc.firstElementChild) {
            this.include(inc.firstElementChild as HtmlElement, head as HtmlElement, undefined);
          }
          this.joinAdjacentTexts(head);
        }
      }
      this.processMarkdownDirectives(ret);
      this.processMacros(ret);
    }
    return ret;
  }

  getOrigin(i: number): string {
    var fname = (i >= 0 && i < this.parser.origins.length
        ? this.parser.origins[i]
        : '');
    fname.startsWith(this.rootPath)
        ? fname = fname.substr(this.rootPath.length)
        : null;
    return fname;
  }

  //TODO: optimaze case of repeated calls with growing position, for the compiler
  getSourcePos(htmlPos?: HtmlPos): SourcePos | undefined {
    var ret: SourcePos | undefined;
    if (htmlPos) {
      var fname = this.getOrigin(htmlPos.origin);
      if (fname != null) {
        ret = { fname: fname, line1: 1, column1: 1, line2: 1, column2: 1 };
        var src = this.sources[htmlPos.origin], i = 0, j;
        while ((j = src.indexOf('\n', i)) >= 0) {
          if (j >= htmlPos.i1) {
            ret.column1 = Math.max(0, (htmlPos.i1 - i) + 1);
            break;
          }
          i = j + 1;
          ret.line1++;
        }
        ret.line2 = ret.line1;
        while ((j = src.indexOf('\n', i)) >= 0) {
          if (j > htmlPos.i2) {
            ret.column2 = Math.max(0, (htmlPos.i2 - i) + 1);
            break;
          }
          i = j + 1;
          ret.line2++;
        }
      }
    }
    return ret;
  }

  // =========================================================================
  // includes
  // =========================================================================

  private async readFile(
    fname: string,
    nesting: number,
    currPath?: string,
    once = false,
    includedBy?: HtmlElement
  ): Promise<HtmlDocument | undefined> {
    if (nesting >= MAX_RECURSIONS) {
      throw new PreprocessorError(`Too many nested includes/imports "${fname}"`);
    }
    var ret: HtmlDocument;
    fname.startsWith('/') ? currPath = undefined : null;
    !currPath ? currPath = this.rootPath : null;
    var filePath = path.normalize(path.join(currPath, fname));
    currPath = path.dirname(filePath);
    if (!filePath.startsWith(this.rootPath)) {
      throw new PreprocessorError(`Forbidden file path "${fname}"`);
    }
    if (once && this.parser.origins.indexOf(filePath) >= 0) {
      return undefined;
    }
    var text;
    try {
      if (this.virtualFiles?.has(filePath)) {
        text = this.virtualFiles.get(filePath) as string;
      } else {
        text = await fsPromises.readFile(filePath, {encoding: 'utf8'});
      }
    } catch (ex:any) {
      var msg = `Could not read file "${fname}"`;
      var f = (includedBy
          ? this.parser.origins[includedBy.pos.origin]
          : undefined);
      var pos = (includedBy ? includedBy.pos.i1 : undefined);
      throw new PreprocessorError(msg, f, this.rootPath, pos);
    }
    var extension = path.extname(filePath).toLowerCase();
    if (extension === '.html' || extension === '.htm') {
      // module inclusion
      try {
        this.sources.push(text.endsWith('\n') ? text : text + '\n');
        ret = this.parser.parseDoc(text, filePath);
        await this.processIncludes(ret, currPath, nesting);
      } catch (ex:any) {
        if (ex instanceof HtmlException) {
          throw new PreprocessorError(ex.msg, ex.fname, this.rootPath,
              ex.pos, ex.row, ex.col);
        }
        if (ex instanceof PreprocessorError) {
          throw ex;
        }
        throw new PreprocessorError('' + ex);
      }
    } else {
      // textual inclusion
      var origin = this.parser.origins.length;
      this.sources.push(text.endsWith('\n') ? text : text + '\n');
      this.parser.origins.push(filePath);
      ret = new HtmlDocument(origin);
      var root = new HtmlElement(ret.ownerDocument as HtmlDocument, ret, 'lib',
          0, 0, origin);
      new HtmlText(root.ownerDocument as HtmlDocument, root, text, 0, 0, origin, false);
    }
    return ret;
  }

  private async processIncludes(doc: HtmlDocument, currPath: string, nesting: number) {
    var tags = new Set([INCLUDE_TAG, IMPORT_TAG]);
    // tags.add(INCLUDE_TAG);
    // tags.add(IMPORT_TAG);
    var includes = lookupTags(doc, tags);
    for (var e of includes) {
      var src = e.getAttribute(INCLUDE_SRC);
      if (src && (src = src.trim()).length > 0) {
        var as = e.getAttribute(INCLUDE_AS);
        await this.processInclude(e, src, e.tagName === IMPORT_TAG, currPath, nesting, as);
      } else {
        throw new HtmlException(
          'Missing "src" attribute', this.parser.origins[e.pos.origin],
          e.pos.i1, this.sources[e.pos.origin]
        );
      }
    }
  }

  private async processInclude(
    e: HtmlElement, src: string, once: boolean, currPath: string, nesting: number,
    as?: string
  ) {
    var parent = e.parentElement as HtmlElement;
    var before = undefined;
    if (parent) {
      var i = parent.children.indexOf(e) + 1;
      before = (i < parent.children.length ? parent.children[i] : undefined);
      e.remove();
      var doc = await this.readFile(src, nesting + 1, currPath, once, e);
      if (doc != null) {
        var root = doc.getFirstElementChild();
        if (root) {
          if (as) {
            this.embed(root as HtmlElement, parent, before, as)
          } else {
            this.include(root as HtmlElement, parent, before);
          }
        }
      }
      this.joinAdjacentTexts(parent);
    }
  }

  private embed(root: HtmlElement, parent: HtmlElement, before: HtmlNode | undefined, as: string) {
    const parts = as?.split(/\s+/) as string[];
    if (parts.length > 0 && root.firstChild?.nodeType === TEXT_NODE) {
      const t = root.firstChild.remove() as HtmlText;
      const e = parent.ownerDocument?.createElement(parts[0]) as HtmlElement;
      e.appendChild(t);
      t.escape = false;
      parent.addChild(e, before);
      for (let i = 1; i < parts.length; i++) {
        const attr = parts[i].split('=');
        const key = attr[0].trim();
        if (key.length > 0) {
          let val = attr.length > 1 ? attr[1].trim() : '""';
          if ((val.startsWith('"') && val.endsWith('"')) ||
              (val.startsWith("'") && val.endsWith("'"))) {
            val = val.substring(1, val.length - 1);
          }
          e.setAttribute(key, val);
        }
      }
    }
  }

  private include(root: HtmlElement, parent: HtmlElement, before?: HtmlNode) {
    for (var n of root.children.slice()) {
      parent.addChild(n.remove(), before);
    }
    // cascade root attributes
    root.attributes.forEach((a, k) => {
      if (a && !parent.attributes.has(k)) {
        parent.attributes.set(k, a);
      }
    });
  }

  // =========================================================================
  // markdown
  // =========================================================================
  mdAttrs = require('markdown-it-attrs');
  mdAnchor = require('markdown-it-anchor');
  mdHighlight = require('markdown-it-highlightjs');
  md = require('markdown-it')()
      .set({ html: true })
      .use(this.mdAttrs)
      .use(this.mdAnchor, { permalink: this.mdAnchor.permalink.headerLink() })
      .use(this.mdHighlight);

  private processMarkdownDirectives(doc: HtmlDocument) {
    var ee = lookupTags(doc, new Set<string>([MARKDOWN_TAG]));
    for (var e of ee) {
      this.processMarkdownDirective(e);
    }
  }

  private processMarkdownDirective(e: HtmlElement) {
    const p = e.parentElement as HtmlElement;
    const src = e.innerHTML;
    const dst = this.md.render(src);
    e.innerHTML = dst;
    if (!e.getAttribute('class')) {
      e.setAttribute('class', MARKDOWN_DEFAULT_CLASS);
    }
    // while (e.firstChild) {
    //   p.insertBefore(e.firstChild.remove(), e);
    // }
    // e.remove();
  }

  // =========================================================================
  // macros
  // =========================================================================

  private processMacros(doc: HtmlDocument) {
    this.collectMacros(doc, 0);
    this.expandMacros(doc, 0);
  }

  // -------------------------------------------------------------------------
  // collect
  // -------------------------------------------------------------------------

  private collectMacros(p: HtmlElement, nesting: number) {
    var macros = lookupTags(p, new Set<string>([DEFINE_TAG]));
    for (var e of macros) {
      this.collectMacro(e, nesting);
    }
  }

  private collectMacro(e: HtmlElement, nesting: number) {
    var tag = e.getAttribute(DEFINE_ARG);
    if (!tag || (tag = tag.trim()).length === 0) {
      throw new HtmlException(
        this.parser.origins[e.pos.origin], 'Missing "tag" attribute',
        e.pos.i1, this.sources[e.pos.origin]
      );
    }
    var columnPrefix = tag.startsWith(':');
    columnPrefix ? tag = tag.substr(1) : null;
    var names = tag.split(':');
    names.length < 2 ? names.push('div') : null;
    if (!/^[_a-zA-Z0-9]+-[-:_a-zA-Z0-9]+$/.test(names[0])
      || !/^[-_a-zA-Z0-9]+$/.test(names[1])) {
      throw new HtmlException(
        this.parser.origins[e.pos.origin],
        'Bad "tag" attribute (missing "-" in custom tag name)',
        e.pos.i1, this.sources[e.pos.origin]
      );
    }
    columnPrefix ? names[0] = ':' + names[0] : null;
    names[0] = names[0].toUpperCase();
    names[1] = names[1].toUpperCase();
    var parent = e.parentElement as HtmlElement;
    if (parent) {
      e.remove();
      this.joinAdjacentTexts(parent);
    }
    e.setAttribute(DEFINE_ARG, undefined);
    this.expandMacros(e, nesting);
    this.macros.set(names[0], {
      name1: names[0],
      name2: names[1],
      e: e,
      ext: this.macros.get(names[1])
    });
  }

  private collectSlots(p: HtmlElement) {
    var ret = new Map<string, HtmlElement>();
    var tags = new Set<string>();
    tags.add(SLOT_TAG);
    var slots = lookupTags(p, tags);
    for (var e of slots) {
      var s = e.getAttribute(SLOT_ARG);
      var names = (s ? s.split(',') : undefined);
      if (names) {
        for (var i in names) {
          var name = names[i];
          if ((name = name.trim()).length < 1
            || ret.has(name)) {
            throw new HtmlException(
              this.parser.origins[e.pos.origin],
              'Bad/duplicated "name" attribute',
              e.pos.i1, this.sources[e.pos.origin]
            );
          }
          ret.set(name, e);
        }
      }
    }
    if (!ret.has('default')) {
      var e = new HtmlElement(p.ownerDocument as HtmlDocument, p, SLOT_TAG,
          p.pos.i1, p.pos.i2, p.pos.origin);
      e.setAttribute(SLOT_ARG, 'default');
      ret.set('default', e);
    }
    return ret;
  }

  // -------------------------------------------------------------------------
  // expand
  // -------------------------------------------------------------------------

  private expandMacros(p: HtmlElement, nesting: number) {
    var that = this;
    function f(p: HtmlElement) {
      var ret = false;
      for (var n of p.children.slice()) {
        if (n.nodeType === ELEMENT_NODE) {
          var name = (n as HtmlElement).tagName;
          var def = that.macros.get(name);
          if (def != null) {
            var e = that.expandMacro(n as HtmlElement, def, nesting);
            p.addChild(e, n);
            n.remove();
            ret = true;
          } else {
            that.expandMacros(n as HtmlElement, nesting);
          }
        }
      }
      return ret;
    }
    if (f(p)) {
      this.joinAdjacentTexts(p);
    }
  }

  private expandMacro(use: HtmlElement, def: Definition, nesting: number): HtmlElement {
    if (nesting >= MAX_RECURSIONS) {
      var err = new HtmlException(
        this.parser.origins[use.pos.origin],
        '',
        use.pos.i1,
        this.sources[use.pos.origin]
      );
      throw new PreprocessorError(
        `Too many nested macros "${use.tagName}"`, err.fname, this.rootPath,
        err.pos, err.row, err.col
      );
    }
    var ret: any = null;
    if (def.ext != null) {
      var e = new HtmlElement(def.e.ownerDocument as HtmlDocument, undefined, def.e.tagName,
          use.pos.i1, use.pos.i2, use.pos.origin);
      def.e.attributes.forEach(a => {
        var a2 = e.setAttribute(a.name, a.value, a.quote,
          a.pos1?.i1, a.pos1?.i2, a.pos1?.origin);
        a2 ? a2.pos2 = a.pos1 : null;
      });
      e.innerHTML = def.e.innerHTML;
      ret = this.expandMacro(e, def.ext, nesting + 1);
    } else {
      ret = new HtmlElement(def.e.ownerDocument as HtmlDocument, undefined, def.name2,
          use.pos.i1, use.pos.i2, use.pos.origin);
      def.e.attributes.forEach(a => {
        var a2 = ret.setAttribute(a.name, a.value, a.quote,
          a.pos1?.i1, a.pos1?.i2, a.pos1?.origin);
        a2 ? a2.pos2 = a.pos1 : null;
      });
      ret.innerHTML = def.e.innerHTML;
    }
    this.populateMacro(use, ret, nesting);
    return ret;
  }

  private populateMacro(src: HtmlElement, dst: HtmlElement, nesting: number) {
    src.attributes.forEach(a => {
      var a2 = dst.setAttribute(a.name, a.value, a.quote,
          a.pos1?.i1, a.pos1?.i2, a.pos1?.origin);
      a2 ? a2.pos2 = a.pos1 : null;
    });
    var slots = this.collectSlots(dst);
    for (var n of src.children.slice()) {
      var slotName = 'default', s;
      if (n.nodeType === ELEMENT_NODE
        && ((s = (n as HtmlElement).getAttribute(SLOT_ATTR)))) {
        slotName = s;
      }
      var slot = slots.get(slotName);
      if (slot) {
        (slot.parentElement as HtmlElement | undefined)?.addChild(n, slot);
      } else {
        var err = new HtmlException(
          this.parser.origins[n.pos.origin],
          '',
          n.pos.i1,
          this.sources[n.pos.origin]
        );
        throw new PreprocessorError(
          `unknown slot "${slotName}"`, err.fname, this.rootPath,
          err.pos, err.row, err.col
        );
      }
    }
    slots.forEach(e => {
      var p = e.parentElement as HtmlElement;
      if (p) {
        e.remove();
        this.joinAdjacentTexts(p);
      }
    });
    this.expandMacros(dst, nesting + 1);
  }

  // =========================================================================
  // util
  // =========================================================================

  // this was required by aremel1 which identified text nodes by index and so
  // needed the index be consistent in the server and in the client (adjacent
  // text nodes would become a single one when transferred to the browser)
  private joinAdjacentTexts(e: HtmlElement) {
    var prevTextNode: HtmlText | undefined = undefined;
    for (var n of e.children.slice()) {
      if (n.nodeType === TEXT_NODE) {
        if (prevTextNode != null) {
          prevTextNode.nodeValue += (n as HtmlText).nodeValue;
          n.remove();
        } else {
          prevTextNode = n as HtmlText;
        }
      } else {
        prevTextNode = undefined;
      }
    }
  }

}

export class PreprocessorError {
  msg: string;
  fname?: string;
  pos?: number;
  row?: number;
  col?: number;

  constructor(
    msg: string, fname?: string, rootPath?: string,
    pos?: number, row?: number, col?: number
  ) {
    this.msg = msg;
    this.fname = (rootPath && fname && fname.startsWith(rootPath)
      ? fname.substr(rootPath.length + (rootPath.endsWith('/') ? 0 : 1))
      : fname);
    this.pos = (pos ? pos : 0);
    this.row = row;
    this.col = col;
  }

  toString() {
    return this.fname
      ? `${this.fname}:${this.row} col ${this.col}: ${this.msg}`
      : this.msg;
  }
}

// =============================================================================
// util
// =============================================================================

export function domGetTop(doc:HtmlDocument, name:string): HtmlElement | undefined {
  var root = doc.getFirstElementChild() as HtmlElement;
  if (root) {
    for (var n of root.children) {
      if (n.nodeType === ELEMENT_NODE && (n as HtmlElement).tagName === name) {
        return n as HtmlElement;
      }
    }
  }
  return undefined;
}

export function lookupTags(p: HtmlElement, tags: Set<string>): Array<HtmlElement> {
  var ret = new Array<HtmlElement>();
  function f(p: HtmlElement) {
    for (var n of p.children) {
      if (n.nodeType === ELEMENT_NODE) {
        if (tags.has((n as HtmlElement).tagName)) {
          ret.push(n as HtmlElement);
        } else {
          f(n as HtmlElement);
        }
      }
    }
  }
  f(p);
  return ret;
}

function domEnsureHeadAndBody(doc: HtmlDocument) {
  var e = doc.getFirstElementChild() as HtmlElement | undefined, body, head;
  if (!(body = domGetTop(doc, 'BODY'))) {
    body = new HtmlElement(doc, e, 'BODY', 0, 0, doc.pos.origin);
  }
  if (!(head = domGetTop(doc, 'HEAD'))) {
    head = new HtmlElement(doc, undefined, 'HEAD', 0, 0, doc.pos.origin);
    e?.addChild(head, body);
  }
}
