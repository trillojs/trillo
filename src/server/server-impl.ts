import express, { Application, Express } from "express";
import rateLimit from 'express-rate-limit';
import fs from "fs";
import { Window } from "happy-dom";
import * as http from 'http';
import path from "path";
import { compileDoc, PageError } from "../compiler/page-compiler";
import { DomElement } from "../preprocessor/dom";
import { HtmlDocument } from "../preprocessor/htmldom";
import Preprocessor, { EMBEDDED_INCLUDE_FNAME } from "../preprocessor/preprocessor";
import { PROPS_SCRIPT_ID, RUNTIME_SCRIPT_ID } from "../runtime/page";
import exitHook from "./exit-hook";
import { STDLIB } from "./stdlib";

const SERVER_PAGE_TIMEOUT = 2000;
const CLIENT_JS_FILE = 'client.js';
const SERVER_NOCLIENT_PARAM = '__noclient';
const CONFIG_FILE = '.reflectjs.json';

export interface ServerProps {
  port?: number,
  rootPath: string,
  assumeHttps?: boolean,
  trustProxy?: boolean,
  pageLimit?: TrafficLimit,
  init?: (props: ServerProps, app: Application) => void,
  logger?: (type: string, msg: string) => void,
  mute?: boolean,
  clientJsFilePath?: string,
  serverPageTimeout?: number,
  normalizeText?: boolean,
}

export interface TrafficLimit {
  windowMs: number,
  maxRequests: number,
}

interface Config {
  routes?: Array<{ regex: string, path: string }>,
}

// https://expressjs.com/en/advanced/best-practice-performance.html
export default class ServerImpl {
  props: ServerProps;
  compiledPages: Map<string, CompiledPage>;
  serverPageTimeout: number;
  normalizeText: boolean;
  server: http.Server;
  clientJs?: string;
  config: Config;
  routes: Array<{ regex: RegExp, path: string }>;
  routings: Map<string, string>;

  constructor(props: ServerProps, cb?: (port: number) => void) {
    this.props = props;
    this.compiledPages = new Map();
    this.normalizeText = props.normalizeText !== undefined ? props.normalizeText : true;
    this.serverPageTimeout = props.serverPageTimeout ?? SERVER_PAGE_TIMEOUT;
    const app = express();

    const configFile = path.join(props.rootPath, CONFIG_FILE);
    try {
      const text = fs.readFileSync(configFile)
      this.config = JSON.parse(text.toString());
      this.log('info', this.config);
    } catch (ex: any) {
      this.log('warn', `no ${CONFIG_FILE} found`);
      this.config = {}
    }
    this.routes = (this.config.routes ?? []).map(route => ({
      regex: new RegExp(route.regex),
      path: route.path
    }));
    this.routings = new Map();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    if (props.trustProxy) {
      // see https://expressjs.com/en/guide/behind-proxies.html
      app.set('trust proxy', 1);
    }

    props.init && props.init(props, app);
    this.init(props, app);

    // serve static content
    app.use(express.static(props.rootPath));

    const listenCB = () => {
      const port = (this.server.address() as any).port;
      if (cb) {
        cb(port);
      } else {
        this.log('info', `${this.getTimestamp()}: START `
          + `http://localhost:${port} [${props.rootPath}]`);
      }
    }

    this.server = props.port
      ? app.listen(props.port, listenCB)
      : app.listen(listenCB);

    exitHook(() => {
      this.log('info', 'WILL EXIT');
    });

    process.on('uncaughtException', (err) => {
      this.log('error', err.stack ? err.stack : `${err}`);
    });
  }

  close() {
    this.server.close();
  }

  log(type: 'error' | 'warn' | 'info' | 'debug', msg: any) {
    if (!this.props.mute) {
      if (this.props.logger) {
        this.props.logger(type, msg);
      } else {
        switch (type) {
          case 'error': console.error(msg); break;
          case 'warn': console.warn(msg); break;
          case 'info': console.info(msg); break;
          case 'debug': console.debug(msg); break;
          default: console.log(msg);
        }
      }
    }
  }

  static setLimiter(limit: TrafficLimit, paths: Array<string>, app: Application) {
    const limiter = rateLimit({
      windowMs: limit.windowMs,
      max: limit.maxRequests,
      standardHeaders: true,
      legacyHeaders: false,
    });
    for (var path of paths) {
      app.use(path, limiter);
    }
  }

  // ---------------------------------------------------------------------------
  // private
  // ---------------------------------------------------------------------------

  private getTimestamp(): string {
    const d = new Date();
    return d.getFullYear() + '-'
        + ('' + (d.getMonth() + 1)).padStart(2, '0') + '-'
        + ('' + d.getDate()).padStart(2, '0') + ' '
        + ('' + d.getHours()).padStart(2, '0') + ':'
        + ('' + d.getMinutes()).padStart(2, '0') + ':'
        + ('' + d.getSeconds()).padStart(2, '0');
  }

  private init(props: ServerProps, app: Express) {
    // limit page requests rate
    if (props.pageLimit) {
      ServerImpl.setLimiter(props.pageLimit, ['*', '*.html'], app);
    }

    // externally redirect requests for directories to <dir>/index
    // internally redirect requests to files w/o suffix to <file>.html
    app.get("*", async (req, res, next) => {
      if (/^[^\.]+$/.test(req.url)) {
        // no suffix
        var base = `http://${req.headers.host}`;
        var url = new URL(req.url, base);
        var pathname = path.join(props.rootPath, url.pathname);
        try {
          const stat = await fs.promises.stat(pathname);
          if (!stat.isDirectory()) {
            throw '';
          }
          if (url.pathname.endsWith('/')) {
            req.url = path.join(req.url, 'index.html');
            next('route');
          } else {
            res.redirect(req.url + '/index');
          }
        } catch (ex: any) {
          req.url = req.url + '.html';
          next('route');
        }
      } else {
        // has suffix
        next('route');
      }
    });

    // serve pages
    const that = this;
    app.get('*.html', async (req, res) => {
      var base = `http://${req.headers.host}`;
      var url = new URL(req.url, base);
      url.protocol = (props.assumeHttps ? 'https' : req.protocol);
      url.hostname = req.hostname;
      const pathname = this.route(url.pathname);
      try {
        const page = await that.getPage(url, pathname);
        if (page.errors) {
          throw page.errors.map(pe => `${pe.type}: ${pe.msg}`).join('\n');
        }
        res.header("Content-Type",'text/html');
        res.send(page.output ?? '');
      } catch (err: any) {
        res.header("Content-Type",'text/plain');
        res.send(`${err}`);
        that.log('error', `${that.getTimestamp()}: `
          + `ERROR ${url.toString()}: ${err}`);
      }
    });

    // load client runtime
    const p = props.clientJsFilePath ?? path.resolve(__dirname, CLIENT_JS_FILE);
    this.clientJs = '\n' + fs.readFileSync(p, { encoding: 'utf8'});
  }

  route(src: string): string {
    let dst = this.routings.get(src);

    if (dst) {
      return dst;
    }

    for (let route of this.routes) {
      // if (route.regex.test(src)) {
      //   dst = route.path;
      //   break;
      // }
      const res = route.regex.exec(src);
      if (res) {
        const sp = route.path.split(/\(\*\)/g);
        const dp = [sp[0]];
        for (let i = 1; i < sp.length; i++) {
          res.length > i && dp.push(res[i]);
          dp.push(sp[i]);
        }
        dst = dp.join('');
        break;
      }
    }
    if (dst) {
      this.log('debug', `routing "${src}" to "${dst}"`);
      this.routings.set(src, dst);
      return dst;
    }

    this.routings.set(src, src);
    return src;
  }

  async getPage(url: URL, pathname: string): Promise<ExecutedPage> {
    const compiledPage = await this.getCompiledPage(url, pathname);
    if (compiledPage.errors && compiledPage.errors.length > 0) {
      return {
        compiledPage: compiledPage,
        output: '',
        errors: compiledPage.errors.slice()
      }
    }
    return this.executePage(url, compiledPage);
  }

  async getCompiledPage(url: URL, pathname: string): Promise<CompiledPage> {
    const cachedPage = this.compiledPages.get(pathname);
    if (cachedPage && await this.isCompiledPageFresh(cachedPage)) {
      return cachedPage;
    }
    const ret = await this.compilePage(url, pathname);
    if (!ret.errors || !ret.errors.length) {
      this.compiledPages.set(pathname, ret);
    }
    return ret;
  }

  async compilePage(url: URL, pathname: string): Promise<CompiledPage> {
    const ret: CompiledPage = {
      tstamp: Date.now(),
      files: [],
      output: '<html></html>'
    };
    try {
      const fname = decodeURIComponent(pathname);
      const pre = new Preprocessor(this.props.rootPath);
      const doc = await pre.read(fname, STDLIB);
      if (!doc) {
        throw `failed to load page "${pathname}"`;
      }
      ret.files = pre.parser.origins;
      const { js, errors } = compileDoc(doc);
      if (errors.length > 0) {
        throw errors;
      }

      const propsScript: DomElement = doc.createElement('script');
      propsScript.setAttribute('id', PROPS_SCRIPT_ID);
      propsScript.setAttribute('type', 'text/json');
      propsScript.appendChild(doc.createTextNode(`\n${js}\n`));
      doc.body?.appendChild(propsScript);
      doc.body?.appendChild(doc.createTextNode('\n'));

      ret.output = doc.toString(false, false, this.normalizeText);
    } catch (err: any) {
      if (Array.isArray(err)) {
        ret.errors = err;
      } else {
        ret.errors = [{ type: 'error', msg: `${err}` }];
      }
    }
    return ret;
  }

  async isCompiledPageFresh(compiledPage: CompiledPage): Promise<boolean> {
    for (const file of compiledPage.files) {
      if (file === EMBEDDED_INCLUDE_FNAME) {
        continue;
      }
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtime.valueOf() > compiledPage.tstamp) {
          return false;
        }
      } catch (err: any) {
        return false;
      }
    }
    return true;
  }

  async executePage(url: URL, compiledPage: CompiledPage): Promise<ExecutedPage> {
    const ret: ExecutedPage = { compiledPage: compiledPage };
    try {
      const win = new Window({
        url: url.toString(),
        // https://github.com/capricorn86/happy-dom/tree/master/packages/happy-dom#settings
        settings: {
          disableJavaScriptFileLoading: true,
          disableJavaScriptEvaluation: false,
          disableCSSFileLoading: true,
          enableFileSystemHttpRequests: false
        }
      } as any);

      // server side we don't support delays longer than zero
      const origSetTimeout = win.setTimeout;
      win.setTimeout = (callback, delay) => {
        return (delay ?? 0) < 1 ? origSetTimeout(callback, 0) : {} as NodeJS.Timeout;
      };
      win.setInterval = (callback, delay) => ({} as NodeJS.Timeout);

      const outdoc = win.document;
      outdoc.write(compiledPage.output);

      const runtimeScript = outdoc.createElement('script');
      runtimeScript.id = RUNTIME_SCRIPT_ID;
      runtimeScript.appendChild(outdoc.createTextNode(this.clientJs));
      outdoc.body.appendChild(runtimeScript);
      outdoc.body.appendChild(outdoc.createTextNode('\n'));

      let tmp: Window | null = win;
      await Promise.race([
        win.happyDOM.whenAsyncComplete(),
        new Promise<void>(resolve => {
          setTimeout(() => {
            tmp?.happyDOM.cancelAsync();
            resolve();
          }, this.serverPageTimeout);
        })
      ]);
      tmp = null;

      await new Promise(resolve => setTimeout(resolve, 0));
      if (url.searchParams.has(SERVER_NOCLIENT_PARAM)) {
        // if we remove the runtime script without clearing its content first
        // it's executed again -- clearly an happy-dom bug
        runtimeScript.removeChild(runtimeScript.firstChild);
        runtimeScript.remove();
        outdoc.getElementById(PROPS_SCRIPT_ID).remove();
      }
      ret.output = `<!DOCTYPE html>\n` + outdoc.documentElement.outerHTML;
    } catch (err: any) {
      if (Array.isArray(err)) {
        ret.errors = err;
      } else {
        ret.errors = [{ type: 'error', msg: `${err}` }];
      }
    }
    return ret;
  }
}

type CompiledPage = {
  tstamp: number,
  files: string[],
  output: string,
  errors?: PageError[]
}

type ExecutedPage = {
  compiledPage: CompiledPage,
  output?: string,
  errors?: PageError[]
}
