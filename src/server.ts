import express, { Application, Express } from "express";
import rateLimit from 'express-rate-limit';
import fs from "fs";
import * as http from 'http';
import path from "path";
import exitHook from "./service/exit-hook";
import { PageSet } from "./service/pageset";
import { Routing } from "./service/routing";

export const SERVER_PAGE_TIMEOUT = 2000;
export const CLIENT_JS_FILE = 'client.js';
export const SERVER_NOCLIENT_PARAM = '__noclient';

export interface ServerProps {
  port?: number,
  rootPath: string,
  assumeHttps?: boolean,
  trustProxy?: boolean,
  pageLimit?: TrafficLimit,
  init?: (props: ServerProps, app: Application) => void,
  logger?: (type: string, msg: string) => void,
  mute?: boolean,
  serverPageTimeout?: number,
  normalizeText?: boolean,
  // reserved, used for testing
  __clientJsFilePath?: string,
  __willServePage?: (url: URL) => void;
}

export interface TrafficLimit {
  windowMs: number,
  maxRequests: number,
}

// https://expressjs.com/en/advanced/best-practice-performance.html
export class Server {
  props: ServerProps;
  pageSet: PageSet;
  server: http.Server;

  constructor(props: ServerProps, cb?: (port: number) => void) {
    this.props = props;
    this.pageSet = new PageSet(props);
    const app = express();

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
      new Routing(props.rootPath, (instance) => {
        this.pageSet.setRouting(instance);
        const port = (this.server.address() as any).port;
        if (cb) {
          cb(port);
        } else {
          this.log('info', `${this.getTimestamp()}: START `
            + `http://localhost:${port} [${props.rootPath}]`);
        }
      })
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
      Server.setLimiter(props.pageLimit, ['*', '*.html'], app);
    }

    // externally redirect requests for directories to <dir>/index
    // internally redirect requests to files w/o suffix to <file>.html
    app.get("*", async (req, res, next) => {
      if (/^[^\.]+$/.test(req.url)) {
        // no suffix
        var base = `http${props.assumeHttps ? 's' : ''}://${req.headers.host}`;
        var url = new URL(req.url, base);
        var pathname = path.join(props.rootPath, url.pathname);
        try {
          const stat = await fs.promises.stat(pathname);
          if (!stat.isDirectory()) {
            throw '';
          }
          if (url.pathname.endsWith('/')) {
            url.pathname += 'index.html';
            req.url = url.toString();
            next('route');
          } else {
            url.pathname += '/index';
            res.redirect(url.toString());
          }
        } catch (ex: any) {
          url.pathname += '.html';
          req.url = url.toString();
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
      try {
        this.props.__willServePage && this.props.__willServePage(url);
        const filePath = this.pageSet.routing?.getFilePath(url.pathname) ?? url.pathname;
        const page = await that.pageSet.getPage(url, req.originalUrl, filePath);
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
  }
}
