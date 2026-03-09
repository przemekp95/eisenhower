import { CanvasSource, Texture } from 'pixi.js';

let didInstall = false;

export function needsPixiFirefoxWorkarounds(userAgent?: string) {
  const resolvedUserAgent =
    userAgent ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');

  return /firefox/i.test(resolvedUserAgent);
}

function createPixelTexture(
  doc: Document,
  fillStyle: string,
  label: 'EMPTY' | 'WHITE'
) {
  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;

  const context = canvas.getContext('2d');

  if (!context) {
    return null;
  }

  context.clearRect(0, 0, 1, 1);
  context.fillStyle = fillStyle;
  context.fillRect(0, 0, 1, 1);

  return new Texture({
    source: new CanvasSource({
      resource: canvas,
      width: 1,
      height: 1,
      alphaMode: 'premultiplied-alpha',
      label,
    }),
    label,
  });
}

export function installPixiFirefoxWorkarounds(
  userAgent?: string,
  doc?: Document | null
) {
  if (didInstall || !needsPixiFirefoxWorkarounds(userAgent)) {
    return false;
  }

  const resolvedDocument =
    doc === undefined ? (typeof document !== 'undefined' ? document : null) : doc;

  if (!resolvedDocument) {
    return false;
  }

  const emptyTexture = createPixelTexture(
    resolvedDocument,
    'rgba(0, 0, 0, 0)',
    'EMPTY'
  );
  const whiteTexture = createPixelTexture(resolvedDocument, '#ffffff', 'WHITE');

  if (!emptyTexture || !whiteTexture) {
    return false;
  }

  Object.assign(Texture, {
    EMPTY: emptyTexture,
    WHITE: whiteTexture,
  });

  Texture.EMPTY.destroy = () => undefined;
  Texture.WHITE.destroy = () => undefined;

  didInstall = true;

  return true;
}

export function resetPixiFirefoxWorkaroundsForTests() {
  didInstall = false;
}
