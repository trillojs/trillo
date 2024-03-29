import { assert } from "chai";
import * as happy from 'happy-dom';
import { JSDOM } from 'jsdom';
import puppeteer, { Browser } from "puppeteer";
import { normalizeText } from "../../src/preprocessor/util";
import { Server } from "../../src/server";
import { DOMWindow } from "jsdom";

let server: Server;
let baseUrl: string;
let browser: Browser;
let servedPages = 0;

describe("server: stdlib", function () {
  this.timeout(10000);

  before((done) => {
    server = new Server({
      rootPath: process.cwd() + '/test/server/stdlib',
      __clientJsFilePath: process.cwd() + '/dist/client.js',
      mute: true,
      __willServePage: (url) => servedPages++,
    }, (portNr) => {
      baseUrl = `http://localhost:${portNr}`;
      puppeteer.launch({
        headless: true,
        devtools: false,
      }).then(b => {
        browser = b;
        done();
      });
    });
  });

  after(async () => {
    await browser.close();
    await server.close();
  });

  describe("<:data-source>", () => {

    it(`auto-get.html`, async () => {
      const win = await loadPage(`${baseUrl}/data-source/auto-get.html`);
      const span = win.document.getElementById('theSpan');
      assert.equal(span?.textContent, 'OK');
    })

    it(`non-auto-get.html`, async () => {
      const win = await loadPage(`${baseUrl}/data-source/non-auto-get.html`);
      const span = win.document.getElementById('theSpan');
      assert.equal(span?.textContent, '');
    })

  });

  describe("<:on-off> w/ passive content", async () => {

    it(`off, noclient`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-passive-1.html?__noclient`);
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <template id="theTemplate" data-trillo="4">
        <div id="theDiv">hi there</div>
        </template>
        </body>`
      ));
    })

    it(`off`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-passive-1.html`);
      Array.from(win.document.getElementsByTagName('script')).forEach(e => e.remove());
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <template id="theTemplate" data-trillo="4">
        <div id="theDiv">hi there</div>
        </template>
        </body>`
      ));
    })

    it(`on, noclient`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-passive-1.html?__noclient&on=true`);
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <div id="theDiv" data-trillo-from="4">hi there</div>` +
        `<template id="theTemplate" data-trillo="4"></template>
        </body>`
      ));
    })

    it(`on`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-passive-1.html?on=true`);
      Array.from(win.document.getElementsByTagName('script')).forEach(e => e.remove());
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <div id="theDiv" data-trillo-from="4">hi there</div>` +
        `<template id="theTemplate" data-trillo="4"></template>
        </body>`
      ));
    })

  });

  describe("<:on-off> w/ active content", async () => {

    it(`off, noclient`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-active-1.html?__noclient`);
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <template id="theTemplate" data-trillo="4">
        <div id="theDiv" data-trillo="5">hello <span><!---t0--><!---/--></span></div>
        </template>
        </body>`
      ));
    })

    it(`off`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-active-1.html`);
      Array.from(win.document.getElementsByTagName('script')).forEach(e => e.remove());
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <template id="theTemplate" data-trillo="4">
        <div id="theDiv" data-trillo="5">hello <span><!---t0--><!---/--></span></div>
        </template>
        </body>`
      ));
    })

    it(`on, noclient`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-active-1.html?__noclient&on=true`);
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <div id="theDiv" data-trillo="5" data-trillo-from="4">hello ` +
        `<span><!---t0-->there<!---/--></span>` +
        `</div><template id="theTemplate" data-trillo="4"></template>
        </body>`
      ));
    })

    it(`on, client`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-active-1.html?on=true`);
      Array.from(win.document.getElementsByTagName('script')).forEach(e => e.remove());
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <div id="theDiv" data-trillo="5" data-trillo-from="4">hello ` +
        `<span><!---t0-->there<!---/--></span>` +
        `</div><template id="theTemplate" data-trillo="4"></template>
        </body>`
      ));
    })

    it(`on, client, repeated`, async () => {
      const win = await loadPage(`${baseUrl}/on-off/on-off-active-2.html?on=true`);
      Array.from(win.document.getElementsByTagName('script')).forEach(e => e.remove());
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <div id="theDiv" data-trillo="5" data-trillo-from="4">hello ` +
        `<span data-trillo="6"><!---t0-->there<!---/--></span>` +
        `</div><template id="theTemplate" data-trillo="4"></template>
        </body>`
      ));
      const option = win.trillo_page.root.proxy.body.option;
      option.on = false;
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <template id="theTemplate" data-trillo="4">` +
        `<div id="theDiv" data-trillo="5" data-trillo-from="4">hello ` +
        `<span data-trillo="6"><!---t0-->there<!---/--></span>` +
        `</div></template>
        </body>`
      ));
      option.on = true;
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <div id="theDiv" data-trillo="5" data-trillo-from="4">hello ` +
        `<span data-trillo="6"><!---t0-->there<!---/--></span>` +
        `</div><template id="theTemplate" data-trillo="4"></template>
        </body>`
      ));
      option.on = false;
      assert.equal(normalizeText(win.document.body.outerHTML), normalizeText(
        `<body data-trillo="3">
        <template id="theTemplate" data-trillo="4">` +
        `<div id="theDiv" data-trillo="5" data-trillo-from="4">hello ` +
        `<span data-trillo="6"><!---t0-->there<!---/--></span>` +
        `</div></template>
        </body>`
      ));
    })

  });

  describe("<:page-router>", async function() {
    // increase default timeout (from 2000)
    // because we're using puppeteer w/ headless chrome
    // and first launch on CI servers can take time
    this.timeout(10000);

    it(`shouldn't intercept pages w/o :URLPATH attribute`, async () => {
      const page = await browser.newPage();
      await page.goto(`${baseUrl}/page-router`);
      assert.equal(await page.title(), 'page-router/index.html');
      await page.click('#goToOther');
      assert.equal(await page.title(), 'page-router/other.html');
      await page.close();
    });

    it(`should intercept pages w/ :URLPATH attribute`, async () => {
      const page = await browser.newPage();
      const count1 = servedPages;
      await page.goto(`${baseUrl}/page-router/dummy`);
      assert.equal(servedPages, count1 + 1);
      await page.click('#goto-dummy2');
      assert.equal(servedPages, count1 + 1);
      assert.equal(await page.title(), 'page-router/app.html');
      assert.equal(await page.$eval('#path', e => e.textContent), '/page-router/dummy2');
      await page.close();
    });

    it(`shouldn't intercept pages in EXTURLS`, async () => {
      const page = await browser.newPage();
      const count1 = servedPages;
      await page.goto(`${baseUrl}/page-router/dummy`);
      assert.equal(servedPages, count1 + 1);
      await page.click('#goto-index');
      assert.equal(servedPages, count1 + 2);
      assert.equal(await page.title(), 'page-router/index.html');
      await page.close();
    });

    it(`should display alternative content w/ :on-off (1)`, async () => {
      let win: DOMWindow;

      win = await loadPage(`${baseUrl}/page-router/on-off-1?__noclient`);
      assert.equal(win.document.querySelector('body div')?.textContent, 'Index');
      win.close();

      win = await loadPage(`${baseUrl}/page-router/on-off-1/index?__noclient`);
      assert.equal(win.document.querySelector('body div')?.textContent, 'Index');
      win.close();

      win = await loadPage(`${baseUrl}/page-router/on-off-1/doc?__noclient`);
      assert.equal(win.document.querySelector('body div')?.textContent, 'Doc');
      win.close();

      win = await loadPage(`${baseUrl}/page-router/on-off-1/inexistent?__noclient`);
      assert.notExists(win.document.querySelector('body div'));
      win.close();
    });

    it(`should display alternative content w/ :on-off (2)`, async () => {
      let win: DOMWindow;

      win = await loadPage(`${baseUrl}/page-router/on-off-2?__noclient`);
      assert.equal(win.document.querySelector('body div h1')?.textContent, 'Quick Start');
      win.close();

      win = await loadPage(`${baseUrl}/page-router/on-off-2/introduction?__noclient`);
      assert.equal(win.document.querySelector('body div h1')?.textContent, 'Introduction');
      win.close();
    });

  });

});

async function loadPage(url: string): Promise<DOMWindow> {
  // we're using JSDOM for simulating the client, because
  // `isServer` is true when the environment is happy-dom
  const dom = await JSDOM.fromURL(url, { runScripts: "dangerously" });
  return dom.window;
}
