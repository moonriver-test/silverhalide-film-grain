/* 打包入口：只做 re-export，供 esbuild 打成 IIFE 供 UXP 面板使用。
 * UXP 的面板脚本走 `<script src>` 老式加载，不认 ESM，所以必须打包。 */

export {
  applyGrain,
  generateGrainField,
  buildAmplitudeLUTs,
  amplitudeAt,
  gammaForPeak,
  clusterSigma,
  autoEnvelopeStride,
  autoFineStride,
  SIGMA_GRAIN_RATIO,
  ENVELOPE_STRIDE,
  CHROMA_FINE_STRIDE,
} from './grain.mjs';

export {
  FILM_STOCKS,
  GAUGES,
  STOPS,
  filmsByGroup,
  filmById,
  gaugeById,
  equivalentIso,
  grainIndex,
  resolveFilmParams,
} from './film.mjs';

export {
  decodePixels,
  encodePixels,
  applyGrainBanded,
  processImage,
  depthMax,
  allocBuffer,
  parseBitDepth,
} from './io.mjs';

export {
  encodePNG,
  pngToDataUrl,
  packRGB8,
} from './png.mjs';

/* 徽章色路与文案 —— 面板用纯 CSS 拼装徽章（UXP 的 SVG 支持不可靠，见 pinart.mjs 文件头），
   颜色与文字统一从这里取，保证与预览稿同源。 */
export {
  COLORWAYS,
  colorwayFor,
  colorwayOf,
  badgeText,
  colorwayCensus,
  groupKind,
  pinMarkup,
} from './pinart.mjs';
