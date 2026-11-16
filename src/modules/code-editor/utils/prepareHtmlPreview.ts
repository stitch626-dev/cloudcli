import { api } from '@/shared/api';

const MAX_RESOURCES = 48;
const MAX_RESOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const RESOURCE_CONCURRENCY = 4;
const PREVIEW_ORIGIN = 'https://cloudcli-preview.invalid';

// The iframe has an opaque origin. Its document receives only asset bytes,
// never authenticated URLs, cookies or the parent's authorization token.
const PREVIEW_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data: https:",
  "style-src 'unsafe-inline' data: https:",
  'img-src data: https:',
  'font-src data: https:',
  'media-src data: https:',
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const blobToDataUrl = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const blobToText = (blob: Blob): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

/** Used by useHtmlPreviewDocument to package a bounded set of local HTML assets for an isolated iframe. */
export async function prepareHtmlPreview(
  content: string,
  filePath: string,
  projectId: string | undefined,
  projectPath: string | undefined,
  signal: AbortSignal,
): Promise<{ srcDoc: string; missingResources: number; requiresDevelopmentServer: boolean }> {
  const document = new DOMParser().parseFromString(content, 'text/html');
  // Build-tool entrypoints can be valid HTML while rendering an empty shell
  // without their project server. Surface that limitation instead of implying
  // that an empty iframe is the finished preview.
  const requiresDevelopmentServer = [...document.querySelectorAll('script[src]')].some((script) => {
    const source = script.getAttribute('src')?.trim() ?? '';
    const isLocal = source !== '' && !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source);
    return isLocal && (script.getAttribute('type')?.toLowerCase() === 'module' || /\.(?:tsx?|jsx)(?:[?#]|$)/i.test(source));
  });
  const resources = new Map<string, Promise<string>>();
  let totalBytes = 0;
  let activeRequests = 0;
  let missingResources = 0;
  const waitingRequests: Array<() => void> = [];

  const loadBlob = async (path: string) => {
    if (activeRequests >= RESOURCE_CONCURRENCY) {
      await new Promise<void>((resolve) => waitingRequests.push(resolve));
    } else {
      activeRequests += 1;
    }
    try {
      signal.throwIfAborted();
      if (!projectId) throw new Error('Missing project identifier');
      const response = await api.readFileBlob(projectId, path, { signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Unable to read preview resource');
      }
      const length = Number(response.headers?.get('content-length'));
      if (length > MAX_RESOURCE_BYTES || totalBytes + length > MAX_TOTAL_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Preview resource is too large');
      }
      // The file endpoint streams without Content-Length. Enforce both limits
      // as chunks arrive instead of buffering an arbitrarily large file first.
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let resourceBytes = 0;
        const abortRead = () => { void reader.cancel(signal.reason).catch(() => undefined); };
        signal.addEventListener('abort', abortRead, { once: true });
        try {
          while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            if (resourceBytes + value.byteLength > MAX_RESOURCE_BYTES || totalBytes + value.byteLength > MAX_TOTAL_BYTES) {
              throw new Error('Preview resources exceed the size limit');
            }
            resourceBytes += value.byteLength;
            totalBytes += value.byteLength;
            // Copy only accepted bytes; the stream may reuse its chunk buffer.
            const chunk = new Uint8Array(value.byteLength);
            chunk.set(value);
            chunks.push(chunk);
          }
          return new Blob(chunks, { type: response.headers?.get('content-type') ?? '' });
        } catch (error) {
          await reader.cancel(error).catch(() => undefined);
          throw error;
        } finally {
          signal.removeEventListener('abort', abortRead);
          reader.releaseLock();
        }
      }
      // Non-streaming response adapters (including lightweight test mocks).
      const blob = await response.blob();
      if (blob.size > MAX_RESOURCE_BYTES || totalBytes + blob.size > MAX_TOTAL_BYTES) {
        throw new Error('Preview resources exceed the size limit');
      }
      totalBytes += blob.size;
      return blob;
    } finally {
      const next = waitingRequests.shift();
      if (next) next();
      else activeRequests -= 1;
    }
  };

  const resolveAssetPath = (reference: string, ownerPath: string) => {
    const value = reference.trim();
    if (!value || value.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
    // Root-relative website paths refer to the workspace, never CloudCLI's API.
    if (value.startsWith('/') && !projectPath) return null;
    const resolved = new URL(value.startsWith('/') ? `${projectPath}${value}` : value, `${PREVIEW_ORIGIN}${ownerPath}`);
    const path = decodeURIComponent(resolved.pathname);
    if (projectPath && path !== projectPath && !path.startsWith(`${projectPath.replace(/\/$/, '')}/`)) {
      throw new Error('Preview resource is outside the project');
    }
    return { path, fragment: resolved.hash };
  };

  const rewriteCss = async (css: string, ownerPath: string, depth: number): Promise<string> => {
    // Resolve CSS URLs against the stylesheet, not against the HTML document.
    const references = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
    const replacements = await Promise.all(references.map(async (match) =>
      `url("${await assetUrl(match[2], ownerPath, depth + 1)}")`));
    for (let index = references.length - 1; index >= 0; index -= 1) {
      const match = references[index];
      css = css.slice(0, match.index) + replacements[index] + css.slice(match.index! + match[0].length);
    }
    // Quoted @imports are uncommon but must not silently point at the app URL.
    const imports = [...css.matchAll(/@import\s+(['"])([^'"]+)\1/gi)];
    const imported = await Promise.all(imports.map(async (match) =>
      `@import url("${await assetUrl(match[2], ownerPath, depth + 1)}")`));
    for (let index = imports.length - 1; index >= 0; index -= 1) {
      const match = imports[index];
      css = css.slice(0, match.index) + imported[index] + css.slice(match.index! + match[0].length);
    }
    return css;
  };

  const assetUrl = async (reference: string, ownerPath: string, depth = 0): Promise<string> => {
    try {
      const resolved = resolveAssetPath(reference, ownerPath);
      if (!resolved) {
        // Do not let unresolved relative URLs inherit the IDE's authenticated origin.
        return /^(?:https?:|data:|#|\/\/)/i.test(reference.trim()) ? reference : 'data:,';
      }
      if (depth > 3) throw new Error('Preview stylesheet nesting limit reached');
      const isStylesheet = /\.css$/i.test(resolved.path);
      // Include CSS depth to break circular @imports without awaiting ourselves.
      const key = isStylesheet ? `${resolved.path}:${depth}` : resolved.path;
      if (!resources.has(key)) {
        if (resources.size >= MAX_RESOURCES) throw new Error('Too many preview resources');
        resources.set(key, (async () => {
          const blob = await loadBlob(resolved.path);
          if (isStylesheet) {
            return blobToDataUrl(new Blob([await rewriteCss(await blobToText(blob), resolved.path, depth)], { type: 'text/css' }));
          }
          const type = /\.(?:m?js)$/i.test(resolved.path) ? 'text/javascript' : blob.type;
          return blobToDataUrl(type ? blob.slice(0, blob.size, type) : blob);
        })());
      }
      return `${await resources.get(key)}${resolved.fragment}`;
    } catch (error) {
      if (signal.aborted) throw error;
      missingResources += 1;
      return 'data:,';
    }
  };

  // A document-supplied base or refresh must not replace the isolated preview.
  document.querySelectorAll('base, meta[http-equiv]').forEach((element) => element.remove());
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = PREVIEW_POLICY;
  const referrer = document.createElement('meta');
  referrer.name = 'referrer';
  referrer.content = 'no-referrer';
  document.head.prepend(policy, referrer);

  const updates: Promise<void>[] = [];
  for (const element of document.querySelectorAll('[src], [poster], link[href]')) {
    for (const attribute of ['src', 'poster', 'href']) {
      const reference = element.getAttribute(attribute);
      if (reference === null || (attribute === 'href' && element.tagName !== 'LINK')) continue;
      updates.push(assetUrl(reference, filePath).then((value) => { element.setAttribute(attribute, value); }));
    }
  }
  for (const element of document.querySelectorAll('style, [style]')) {
    if (element.tagName === 'STYLE') {
      updates.push(rewriteCss(element.textContent ?? '', filePath, 0).then((css) => { element.textContent = css; }));
    }
    if (element.hasAttribute('style')) {
      updates.push(rewriteCss(element.getAttribute('style') ?? '', filePath, 0).then((css) => { element.setAttribute('style', css); }));
    }
  }
  // srcset needs a complete parser (data URLs contain commas); use the resolved
  // fallback src rather than accidentally requesting relative URLs from the IDE.
  document.querySelectorAll('[srcset]').forEach((element) => element.removeAttribute('srcset'));
  await Promise.all(updates);
  signal.throwIfAborted();
  return { srcDoc: `<!doctype html>\n${document.documentElement.outerHTML}`, missingResources, requiresDevelopmentServer };
}
