#!/usr/bin/env tsx

import { execFile } from "node:child_process";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type ApiSet = {
  code: string;
  name: string;
};

type ApiCard = {
  id: string;
  external_id: string;
  name: string;
  slug: string;
  rules_text: string | null;
  flavor_text: string | null;
  set: ApiSet | null;
  collector_number: string;
  rarity: string | null;
  image_url: string | null;
  boss_art_url: string | null;
  faction: string | null;
  card_type: string;
  sub_type: string | null;
  level: string | null;
  health: number | null;
  attack: number | null;
  attack_cost: number | null;
  token_cost: number | null;
  weapon_level: number | null;
  weapon_wield_cost: number | null;
  weapon_attack_boost: number | null;
  ability_1: string | null;
  ability_2: string | null;
  artist: string | null;
  is_promo: boolean;
  legality: string | null;
};

type ApiPage = {
  items: ApiCard[];
  total: number;
  limit: number;
  offset: number;
};

type NodeFileError = Error & {
  code?: string;
};

type ArcadeCard = {
  id: string;
  isToken: false;
  face: {
    front: {
      name: string;
      type: string;
      cost: number;
      image: string;
      isHorizontal: false;
    };
  };
  cost: number;
  name: string;
  type: string;
  Subtype: string | null;
  Faction: string | null;
  Level: string | null;
  Health: number | null;
  Attack: number | null;
  AttackCost: number | null;
  TokenCost: number | null;
  WeaponLevel: number | null;
  WeaponWieldCost: number | null;
  WeaponAttackCost: number | null;
  Artist: string | null;
  Rarity: string | null;
  Set: string[];
  _legal: string[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const apiUrl =
  process.env.CARDS_API_URL ??
  "https://api.netdeck.gg/api/cards/ca?limit=100&offset=0";
const outputPath =
  process.env.CARDS_OUTPUT_PATH ??
  path.join(repoRoot, "CataclysmArcade_Cards.json");
const imageDir =
  process.env.CARDS_IMAGE_DIR ?? path.join(repoRoot, "cards");
const publicCardImageBase =
  process.env.PUBLIC_CARD_IMAGE_BASE ??
  "https://balbi.github.io/TCGA-Cataclysm-Arcade/cards";
const imageMagickBin = process.env.IMAGE_MAGICK_BIN ?? "magick";
const maxCardImageHeight = Number(process.env.MAX_CARD_IMAGE_HEIGHT ?? "600");

const skipImages = process.argv.includes("--skip-images");
const forceImages = process.argv.includes("--force-images");
const execFileAsync = promisify(execFile);

function titleCase(value: string | null): string | null {
  if (!value) {
    return value;
  }

  return value
    .split(/([ -])/)
    .map((part) =>
      /^[a-z]/.test(part) ? part[0].toUpperCase() + part.slice(1) : part,
    )
    .join("");
}

function imageFileName(card: ApiCard): string {
  return `${card.collector_number.replace(/\s+/g, "_")}.webp`;
}

function publicImageUrl(card: ApiCard): string {
  return `${publicCardImageBase.replace(/\/$/, "")}/${imageFileName(card)}`;
}

function cardCost(card: ApiCard): number {
  return card.token_cost ?? 0;
}

function setLabel(card: ApiCard): string[] {
  if (!card.set) {
    return [];
  }

  return [`${card.set.code} - ${card.set.name}`];
}

function legalFormats(card: ApiCard): string[] {
  const apiLegality = card.legality?.trim().toLowerCase();
  return apiLegality === "legal" ? ["Standard"] : [];
}

function toArcadeCard(card: ApiCard): ArcadeCard {
  const cost = cardCost(card);

  return {
    id: card.collector_number,
    isToken: false,
    face: {
      front: {
        name: card.name,
        type: card.card_type,
        cost,
        image: publicImageUrl(card),
        isHorizontal: false,
      },
    },
    cost,
    name: card.name,
    type: card.card_type,
    Subtype: card.sub_type,
    Faction: card.faction,
    Level: card.level,
    Health: card.health,
    Attack: card.attack,
    AttackCost: card.attack_cost,
    TokenCost: card.token_cost,
    WeaponLevel: card.weapon_level,
    WeaponWieldCost: card.weapon_wield_cost,
    WeaponAttackCost: card.weapon_attack_boost,
    Artist: card.artist,
    Rarity: titleCase(card.rarity),
    Set: setLabel(card),
    _legal: legalFormats(card),
  };
}

function collectorNumberSort(a: ApiCard, b: ApiCard): number {
  return a.collector_number.localeCompare(b.collector_number, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function pageUrl(offset: number, limit: number): string {
  const url = new URL(apiUrl);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  return url.toString();
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Request failed (${response.status} ${response.statusText}): ${url}`);
  }

  return (await response.json()) as T;
}

async function fetchAllCards(): Promise<ApiCard[]> {
  const configuredUrl = new URL(apiUrl);
  const limit = Number(configuredUrl.searchParams.get("limit") ?? "100");
  const cards: ApiCard[] = [];
  let offset = Number(configuredUrl.searchParams.get("offset") ?? "0");
  let total = Number.POSITIVE_INFINITY;

  while (cards.length < total) {
    const page = await fetchJson<ApiPage>(pageUrl(offset, limit));

    if (!Array.isArray(page.items)) {
      throw new Error(`Unexpected API response at offset ${offset}: missing items array`);
    }

    cards.push(...page.items);
    total = page.total;

    console.log(
      `Fetched ${cards.length}/${total} cards from offset ${offset} with limit ${limit}`,
    );

    if (page.items.length === 0) {
      break;
    }

    offset += page.items.length;
  }

  return cards;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if ((error as NodeFileError).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function imageHeight(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(imageMagickBin, [
    "identify",
    "-format",
    "%h",
    filePath,
  ]);
  return Number(stdout.trim());
}

async function resizeImageToMaxHeight(filePath: string): Promise<void> {
  const height = await imageHeight(filePath);

  if (height <= maxCardImageHeight) {
    return;
  }

  const tempPath = `${filePath}.${process.pid}.tmp.webp`;

  try {
    await execFileAsync(imageMagickBin, [
      filePath,
      "-auto-orient",
      "-resize",
      `x${maxCardImageHeight}>`,
      tempPath,
    ]);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  console.log(
    `Resized ${path.relative(repoRoot, filePath)} to max height ${maxCardImageHeight}px`,
  );
}

async function downloadImage(card: ApiCard): Promise<void> {
  if (!card.image_url) {
    throw new Error(`Card ${card.collector_number} is missing image_url`);
  }

  const targetPath = path.join(imageDir, imageFileName(card));

  if (!forceImages && (await fileExists(targetPath))) {
    await resizeImageToMaxHeight(targetPath);
    return;
  }

  const response = await fetch(card.image_url);

  if (!response.ok) {
    throw new Error(
      `Image download failed for ${card.collector_number} (${response.status} ${response.statusText})`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(targetPath, bytes);
  await resizeImageToMaxHeight(targetPath);
  console.log(`Downloaded ${path.relative(repoRoot, targetPath)}`);
}

async function downloadImages(cards: ApiCard[]): Promise<void> {
  await mkdir(imageDir, { recursive: true });

  for (const card of cards) {
    await downloadImage(card);
  }
}

async function writeCardsJson(cards: ApiCard[]): Promise<void> {
  const sortedCards = [...cards].sort(collectorNumberSort);
  const output: Record<string, ArcadeCard> = {};

  for (const card of sortedCards) {
    output[card.collector_number] = toArcadeCard(card);
  }

  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${sortedCards.length} cards to ${path.relative(repoRoot, outputPath)}`);
}

async function main(): Promise<void> {
  const cards = await fetchAllCards();

  if (!skipImages) {
    await downloadImages(cards);
  }

  await writeCardsJson(cards);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
