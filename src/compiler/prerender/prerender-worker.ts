import * as d from '../../declarations';
import { catchError, normalizePath } from '@utils';
import { getPrerenderConfig, normalizeHref } from './prerender-config';
import { MockWindow, cloneWindow, serializeNodeToHtml } from '@mock-doc';
import { patchNodeGlobal, patchWindowGlobal } from './prerender-global-patch';
import fs from 'fs';
import path from 'path';


export async function prerenderWorker(prerenderRequest: d.PrerenderRequest) {
  // worker thread!
  const results: d.PrerenderResults = {
    diagnostics: [],
    anchorUrls: null,
    filePath: prerenderRequest.writeToFilePath
  };

  try {
    const base = new URL(prerenderRequest.url, 'http://hydrate.stenciljs.com');
    const originUrl = base.href;
    const win = getWindow(prerenderRequest.templateId, originUrl);
    const doc = win.document;

    // webpack work-around/hack
    const requireFunc = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require;
    const hydrateApp = requireFunc(prerenderRequest.hydrateAppFilePath);

    const prerenderConfig = getPrerenderConfig(results.diagnostics, prerenderRequest.prerenderConfigPath) as d.HydrateConfig;

    if (typeof prerenderConfig.beforeHydrate === 'function') {
      try {
        const rtn = prerenderConfig.beforeHydrate(doc, base);
        if (rtn != null) {
          await rtn;
        }
      } catch (e) {
        catchError(results.diagnostics, e);
      }
    }

    const hydrateOpts: d.HydrateOptions = {
      url: originUrl,
      approximateLineWidth: 100,
      collapseBooleanAttributes: true,
      removeAttributeQuotes: true,
      removeEmptyAttributes: true
    };

    if (typeof prerenderConfig.hydrateOptions === 'function') {
      try {
        const userOpts = prerenderConfig.hydrateOptions(base);
        Object.assign(hydrateOpts, userOpts);
      } catch (e) {
        catchError(results.diagnostics, e);
      }
    }

    // parse the html to dom nodes, hydrate the components, then
    // serialize the hydrated dom nodes back to into html
    const hydrateResults = await hydrateApp.hydrateDocument(doc, hydrateOpts) as d.HydrateResults;
    results.diagnostics.push(...hydrateResults.diagnostics);

    if (typeof prerenderConfig.afterHydrate === 'function') {
      try {
        const rtn = prerenderConfig.afterHydrate(doc, base);
        if (rtn != null) {
          await rtn;
        }
      } catch (e) {
        catchError(results.diagnostics, e);
      }
    }

    const html = serializeNodeToHtml(doc, {
      approximateLineWidth: hydrateOpts.approximateLineWidth,
      collapseBooleanAttributes: hydrateOpts.collapseBooleanAttributes,
      pretty: hydrateOpts.prettyHtml,
      removeAttributeQuotes: hydrateOpts.removeAttributeQuotes,
      removeEmptyAttributes: hydrateOpts.removeEmptyAttributes
    });

    results.anchorUrls = crawlAnchorsForNextUrls(prerenderConfig, results.diagnostics, base, hydrateResults.anchors);

    if (typeof prerenderConfig.filePath === 'function') {
      try {
        const userWriteToFilePath = prerenderConfig.filePath(base, results.filePath);
        if (typeof userWriteToFilePath === 'string') {
          results.filePath = userWriteToFilePath;
        }
      } catch (e) {
        catchError(results.diagnostics, e);
      }
    }

    await writePrerenderedHtml(results, html);

  } catch (e) {
    // ahh man! what happened!
    catchError(results.diagnostics, e);
  }

  return results;
}


function writePrerenderedHtml(results: d.PrerenderResults, html: string) {
  ensureDir(results.filePath);

  return new Promise(resolve => {
    fs.writeFile(results.filePath, html, err => {
      if (err != null) {
        results.filePath = null;
        catchError(results.diagnostics, err);
      }
      resolve();
    });
  });
}


const ensuredDirs = new Set<string>();

function ensureDir(p: string) {
  const allDirs: string[] = [];

  while (true) {
    p = normalizePath(path.dirname(p));
    if (typeof p === 'string' && p.length > 0 && p !== '/' && !p.endsWith(':/')) {
      allDirs.push(p);
    } else {
      break;
    }
  }

  allDirs.reverse();

  for (let i = 0; i < allDirs.length; i++) {
    const dir = allDirs[i];
    if (!ensuredDirs.has(dir)) {
      ensuredDirs.add(dir);

      try {
        fs.mkdirSync(dir);
      } catch (e) {}
    }
  }
}

const templateWindows = new Map<string, Window>();

function getWindow(templateId: string, originUrl: string) {
  let templateWindow = templateWindows.get(templateId);
  if (templateWindow == null) {
    const templateHtml = fs.readFileSync(templateId, 'utf8');
    templateWindow = new MockWindow(templateHtml) as any;
    templateWindows.set(templateId, templateWindow);
  }

  const win = cloneWindow(templateWindow);

  patchNodeGlobal(global, originUrl);
  patchWindowGlobal(global, win);

  return win;
}


function crawlAnchorsForNextUrls(prerenderConfig: d.HydrateConfig, diagnostics: d.Diagnostic[], base: URL, parsedAnchors: d.HydrateAnchorElement[]) {
  if (!Array.isArray(parsedAnchors) || parsedAnchors.length === 0) {
    return [];
  }

  return parsedAnchors
    .filter(anchor => prerenderConfig.filterAnchor(anchor, base))
    .map(anchor => prerenderConfig.normalizeUrl(anchor.href, base))
    .filter(url => prerenderConfig.filterUrl(url, base))
    .map(url => normalizeHref(prerenderConfig, diagnostics, url))
    .reduce((hrefs, href) => {
      if (!hrefs.includes(href)) {
        hrefs.push(href);
      }
      return hrefs;
    }, [] as string[])
    .sort(sortHrefs);
}


function sortHrefs(a: string, b: string) {
  const partsA = a.split('/').length;
  const partsB = b.split('/').length;
  if (partsA < partsB) return -1;
  if (partsA > partsB) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}


declare const __webpack_require__: any;
declare const __non_webpack_require__: any;
