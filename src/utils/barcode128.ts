/**
 * src/utils/barcode128.ts
 * Pure TypeScript Code-128 1D Barcode SVG Generator
 * Generates sharp, standards-compliant Code-128 barcodes as SVG data URLs / SVG strings.
 * Compatible with all standard 1D Laser barcode scanners (Honeywell, Zebra, Datalogic, Generic USB lasers).
 */

const CODE128_PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213", // 0-9
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132", // 10-19
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211", // 20-29
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313", // 30-39
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331", // 40-49
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111", // 50-59
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214", // 60-69
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111", // 70-79
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141", // 80-89
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141", // 90-99
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112" // 100-106 (Start A, B, C, Stop)
];

const START_B = 104;
const STOP = 106;

/**
 * Encodes an ASCII string (or numeric barcode) into a Code-128B pattern.
 */
export function generateCode128Svg(text: string, height = 48, barWidth = 2): string {
  const clean = String(text).trim();
  if (!clean) return "";

  const codes: number[] = [START_B];
  let checkSum = START_B;

  for (let i = 0; i < clean.length; i++) {
    const charCode = clean.charCodeAt(i);
    // Map ASCII 32..126 to Code 128B index (code = charCode - 32)
    const val = charCode >= 32 && charCode <= 126 ? charCode - 32 : 0;
    codes.push(val);
    checkSum += val * (i + 1);
  }

  const checkDigit = checkSum % 103;
  codes.push(checkDigit);
  codes.push(STOP);

  // Convert codes to black and white bar widths
  let patternStr = "";
  for (const c of codes) {
    if (c >= 0 && c < CODE128_PATTERNS.length) {
      patternStr += CODE128_PATTERNS[c];
    }
  }

  // Render bars as SVG rects
  let currentX = 10; // Left quiet zone
  const rects: string[] = [];

  for (let i = 0; i < patternStr.length; i++) {
    const width = parseInt(patternStr[i], 10) * barWidth;
    const isBar = i % 2 === 0; // Even index = bar (black), Odd = space (white)
    if (isBar) {
      rects.push(`<rect x="${currentX}" y="0" width="${width}" height="${height}" fill="#000000" />`);
    }
    currentX += width;
  }

  const totalWidth = currentX + 10; // Right quiet zone

  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalWidth} ${height + 18}" width="100%" height="${height + 18}" style="background:#ffffff;">
      ${rects.join("")}
      <text x="${totalWidth / 2}" y="${height + 14}" text-anchor="middle" font-family="monospace" font-size="12" font-weight="bold" fill="#000000">${clean}</text>
    </svg>
  `.trim();
}

/**
 * Returns an SVG data URL for Code-128
 */
export function generateCode128DataUrl(text: string, height = 48, barWidth = 2): string {
  const svg = generateCode128Svg(text, height, barWidth);
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
