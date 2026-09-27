/**
 * Crop folk-art source to playable 15×15 grid, export game assets + PWA icons.
 *
 * Usage:
 *   node scripts/prepare-board-art.mjs
 *   node scripts/prepare-board-art.mjs --debug-grid
 *
 * Tune CROP_INSET until public/images/folk-ludo-board-grid-debug.png aligns.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

/** Default source: repo assets folder or Cursor workspace copy. */
const DEFAULT_SOURCE = path.join(
  ROOT,
  "assets",
  "folk-ludo-board-source.png",
);

const OUT_DIR = path.join(ROOT, "public", "images");
const ICON_DIR = path.join(ROOT, "public", "icons");
const BOARD_SIZE = 1500;
const CELL = 100;

/**
 * Normalized crop from each edge (0..1) to remove decorative scalloped frame.
 * Tune with --debug-grid output.
 */
const CROP_INSET = {
  left: 0.055,
  top: 0.055,
  right: 0.055,
  bottom: 0.055,
};

const YARD_SLOTS = {
  red: [
    [1.5, 1.5],
    [3.5, 1.5],
    [1.5, 3.5],
    [3.5, 3.5],
  ],
  green: [
    [10.5, 1.5],
    [12.5, 1.5],
    [10.5, 3.5],
    [12.5, 3.5],
  ],
  yellow: [
    [10.5, 10.5],
    [12.5, 10.5],
    [10.5, 12.5],
    [12.5, 12.5],
  ],
  blue: [
    [1.5, 10.5],
    [3.5, 10.5],
    [1.5, 12.5],
    [3.5, 12.5],
  ],
};

/** Track cells (col, row) — subset for debug dots at starts + center path. */
const TRACK_SAMPLE = [
  [1, 6],
  [6, 0],
  [8, 6],
  [6, 14],
  [6, 6],
  [7, 7],
  [8, 8],
];

function resolveSource() {
  const arg = process.argv.find((a) => a.startsWith("--source="));
  if (arg) return arg.slice("--source=".length);
  if (fs.existsSync(DEFAULT_SOURCE)) return DEFAULT_SOURCE;
  const cursorAsset = path.join(
    process.env.USERPROFILE ?? "",
    ".cursor",
    "projects",
    "c-Users-divsi-Desktop-ludo",
    "assets",
    "c__Users_divsi_AppData_Roaming_Cursor_User_workspaceStorage_ee6ae50c042b41b8151cd8a0f47a7d9c_images_ChatGPT_Image_Sep_27__2026__08_30_09_PM-816b82bd-abc8-4731-add9-984c7cfd7ba7.jpg",
  );
  if (fs.existsSync(cursorAsset)) return cursorAsset;
  throw new Error(
    `Source PNG not found. Place file at ${DEFAULT_SOURCE} or pass --source=PATH`,
  );
}

async function cropToPlayfield(inputPath) {
  const meta = await sharp(inputPath).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const left = Math.round(w * CROP_INSET.left);
  const top = Math.round(h * CROP_INSET.top);
  const width = Math.round(w * (1 - CROP_INSET.left - CROP_INSET.right));
  const height = Math.round(h * (1 - CROP_INSET.top - CROP_INSET.bottom));
  const side = Math.min(width, height);
  const cx = left + width / 2;
  const cy = top + height / 2;
  const extractLeft = Math.max(0, Math.round(cx - side / 2));
  const extractTop = Math.max(0, Math.round(cy - side / 2));
  const extractWidth = Math.min(side, w - extractLeft);
  const extractHeight = Math.min(side, h - extractTop);

  return sharp(inputPath)
    .extract({
      left: extractLeft,
      top: extractTop,
      width: extractWidth,
      height: extractHeight,
    })
    .resize(BOARD_SIZE, BOARD_SIZE, { fit: "fill" })
    .modulate({ brightness: 1.02, saturation: 1.04 })
    .sharpen({ sigma: 0.6 });
}

function buildGridSvg() {
  const lines = [];
  for (let i = 0; i <= 15; i++) {
    const p = i * CELL;
    lines.push(
      `<line x1="${p}" y1="0" x2="${p}" y2="${BOARD_SIZE}" stroke="rgba(255,0,80,0.35)" stroke-width="2"/>`,
    );
    lines.push(
      `<line x1="0" y1="${p}" x2="${BOARD_SIZE}" y2="${p}" stroke="rgba(255,0,80,0.35)" stroke-width="2"/>`,
    );
  }
  const dots = [];
  for (const slots of Object.values(YARD_SLOTS)) {
    for (const [col, row] of slots) {
      const x = col * CELL;
      const y = row * CELL;
      dots.push(
        `<circle cx="${x}" cy="${y}" r="14" fill="none" stroke="rgba(0,120,255,0.9)" stroke-width="4"/>`,
      );
    }
  }
  for (const [c, r] of TRACK_SAMPLE) {
    dots.push(
      `<circle cx="${c * CELL + CELL / 2}" cy="${r * CELL + CELL / 2}" r="10" fill="rgba(0,200,80,0.7)"/>`,
    );
  }
  dots.push(
    `<circle cx="${7 * CELL + CELL / 2}" cy="${7 * CELL + CELL / 2}" r="18" fill="none" stroke="rgba(255,180,0,0.95)" stroke-width="5"/>`,
  );
  return Buffer.from(
    `<svg width="${BOARD_SIZE}" height="${BOARD_SIZE}" xmlns="http://www.w3.org/2000/svg">${lines.join("")}${dots.join("")}</svg>`,
  );
}

async function main() {
  const debugGrid = process.argv.includes("--debug-grid");
  const source = resolveSource();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(ICON_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "assets"), { recursive: true });

  if (!fs.existsSync(DEFAULT_SOURCE)) {
    fs.copyFileSync(source, DEFAULT_SOURCE);
  }

  const pipeline = await cropToPlayfield(source);

  const pngPath = path.join(OUT_DIR, "folk-ludo-board.png");
  const webpPath = path.join(OUT_DIR, "folk-ludo-board.webp");
  const metaPath = path.join(OUT_DIR, "folk-ludo-board.meta.json");

  await pipeline
    .clone()
    .png({
      compressionLevel: 9,
      effort: 10,
      palette: true,
      colors: 180,
      quality: 78,
    })
    .toFile(pngPath);

  await pipeline.clone().webp({ quality: 82, effort: 6 }).toFile(webpPath);

  if (debugGrid) {
    const debugPath = path.join(OUT_DIR, "folk-ludo-board-grid-debug.png");
    await sharp(pngPath)
      .composite([{ input: buildGridSvg(), blend: "over" }])
      .toFile(debugPath);
    console.log("Wrote", debugPath);
  }

  const iconBase = sharp(pngPath).extract({
    left: Math.round(BOARD_SIZE * 0.28),
    top: Math.round(BOARD_SIZE * 0.28),
    width: Math.round(BOARD_SIZE * 0.44),
    height: Math.round(BOARD_SIZE * 0.44),
  });

  await iconBase.clone().resize(192, 192).png().toFile(path.join(ICON_DIR, "icon-192.png"));
  await iconBase.clone().resize(512, 512).png().toFile(path.join(ICON_DIR, "icon-512.png"));

  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        source: path.basename(source),
        cropInset: CROP_INSET,
        outputSize: BOARD_SIZE,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  const pngStat = fs.statSync(pngPath);
  const webpStat = fs.statSync(webpPath);
  console.log("Source:", source);
  console.log("Wrote", pngPath, `(${(pngStat.size / 1024).toFixed(0)} KB)`);
  console.log("Wrote", webpPath, `(${(webpStat.size / 1024).toFixed(0)} KB)`);
  console.log("Wrote PWA icons in", ICON_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
