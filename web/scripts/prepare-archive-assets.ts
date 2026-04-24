import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
	CanvasRenderingContext2D,
	DOMMatrix,
	Image,
	Path2D,
	createCanvas,
} from "@napi-rs/canvas";
import pdf from "pdf-parse";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

type ArchiveRecord = {
	title: string;
	slug: string;
	date: string;
	volumeName: string;
	regionalVariant: string;
	sourcePdf: string;
	coverImage: string;
	pageImages: string[];
	extractedText: string;
	draftAbstract: string;
};

type TextItem = {
	str?: string;
	transform?: number[];
	height?: number;
	width?: number;
	hasEOL?: boolean;
};

const DEFAULT_INPUT_DIR =
	"C:/Users/jonbr/source/repos/freedom-times-content/original-freedom-times-pdf/split";
const DEFAULT_OUTPUT_DIR = ".generated/archive-import";
const ABSTRACT_MAX_LENGTH = 320;

Object.assign(globalThis, {
	Image,
	Path2D,
	DOMMatrix,
	CanvasRenderingContext2D,
});

function getArgValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

function slugToTitle(slug: string): string {
	const parts = slug.split("-");
	if (parts.length >= 4 && /^\d{4}$/.test(parts[0] ?? "")) {
		const date = parts.slice(0, 3).join("-");
		const rest = parts.slice(3).map(capitalizeWord).join(" ");
		return `${date} ${rest}`;
	}
	return parts.map(capitalizeWord).join(" ");
}

function capitalizeWord(word: string): string {
	if (!word) return word;
	if (word.toUpperCase() === word) return word;
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function extractDateFromName(filename: string): string {
	const match = filename.match(/^(\d{4}-\d{2}-\d{2})/);
	if (!match) {
		throw new Error(`Could not extract date from filename: ${filename}`);
	}
	return `${match[1]}T00:00:00.000Z`;
}

function sanitizeSegment(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		|| 'unknown';
}

function deriveEditionMetadata(slug: string): { volumeName: string; regionalVariant: string } {
	const tokens = slug.split('-');
	const bodyTokens = tokens.slice(3);
	const freedomTimesIndex = bodyTokens.findIndex(
		(token, index) => token === 'freedom' && bodyTokens[index + 1] === 'times',
	);
	const prefix = freedomTimesIndex >= 0 ? bodyTokens.slice(0, freedomTimesIndex) : bodyTokens;

	let volumeName = 'main-edition';
	let regionalVariant = 'default';

	const volumeIndex = prefix.findIndex((token) => /^vol(?:ume)?(?:-?\d+)?$/i.test(token));
	if (volumeIndex >= 0) {
		const part = prefix[volumeIndex + 1];
		volumeName = part ? `${prefix[volumeIndex]}-${part}` : prefix[volumeIndex];
	}

	const regionalTokens = prefix.filter((_, index) => index !== volumeIndex && index !== volumeIndex + 1);
	if (regionalTokens.length > 0) {
		regionalVariant = regionalTokens.join('-');
	}

	return {
		volumeName: sanitizeSegment(volumeName),
		regionalVariant: sanitizeSegment(regionalVariant),
	};
}

function sanitizeText(text: string): string {
	return text
		.replace(/\r/g, "\n")
		.replace(/\u0000/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function buildDraftAbstract(text: string, filename: string): string {
	const lines = sanitizeText(text)
		.split(/\n+/)
		.map((line) => line.trim())
		.filter((line) => line.length > 30)
		.filter((line) => !/^page\s+\d+$/i.test(line))
		.filter((line) => !/^freedom times$/i.test(line));

	const joined = lines.join(" ").replace(/\s+/g, " ").trim();
	if (!joined) {
		return `Archive issue for ${extractDateFromName(filename).slice(0, 10)}.`;
	}

	const sentenceMatch = joined.match(/(.{80,320}?[.!?])(?=\s|$)/);
	const candidate = sentenceMatch?.[1] ?? joined.slice(0, ABSTRACT_MAX_LENGTH);
	return candidate.trim();
}

async function renderAllPages(
	pdfBuffer: Buffer,
	outputDir: string,
	baseName: string,
): Promise<{ coverImage: string; pageImages: string[] }> {
	const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
	const document = await loadingTask.promise;
	const pageImages: string[] = [];

	for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
		const page = await document.getPage(pageNumber);
		const viewport = page.getViewport({ scale: 2 });
		const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
		const context = canvas.getContext('2d');
		const filename = `${baseName}--page-${String(pageNumber).padStart(3, '0')}.png`;
		const outputPath = path.join(outputDir, filename);

		await page.render({
			canvasContext: context,
			viewport,
		}).promise;

		await writeFile(outputPath, canvas.toBuffer('image/png'));
		await page.cleanup();
		pageImages.push(outputPath);
	}

	await document.destroy();

	if (pageImages.length === 0) {
		throw new Error('PDF has no pages to render');
	}

	return {
		coverImage: pageImages[0],
		pageImages,
	};
}

async function extractPageOneText(pdfBuffer: Buffer): Promise<string> {
	const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
	const document = await loadingTask.promise;
	const page = await document.getPage(1);
	const content = await page.getTextContent();
	const items = (content.items as TextItem[])
		.map((item) => item.str?.trim() ?? "")
		.filter(Boolean);
	await page.cleanup();
	await document.destroy();
	return items.join("\n");
}

async function processPdf(inputDir: string, outputDir: string, fileName: string): Promise<ArchiveRecord> {
	const sourcePdf = path.join(inputDir, fileName);
	const slug = fileName.replace(/\.pdf$/i, "");
	const date = extractDateFromName(fileName);
	const title = slugToTitle(slug);
	const { volumeName, regionalVariant } = deriveEditionMetadata(slug);
	const recordDir = path.join(outputDir, slug);
	const extractedText = path.join(recordDir, "text.txt");
	const imageBaseName = `${slug}--vol-${volumeName}--region-${regionalVariant}`;

	await mkdir(recordDir, { recursive: true });
	const pdfBuffer = await readFile(sourcePdf);
	const parsed = await pdf(pdfBuffer);
	const firstPageText = await extractPageOneText(pdfBuffer);
	const mergedText = sanitizeText(`${firstPageText}\n\n${parsed.text}`);
	const draftAbstract = buildDraftAbstract(mergedText, fileName);
	const { coverImage, pageImages } = await renderAllPages(pdfBuffer, recordDir, imageBaseName);

	await writeFile(extractedText, mergedText, "utf8");

	return {
		title,
		slug,
		date,
		volumeName,
		regionalVariant,
		sourcePdf,
		coverImage,
		pageImages,
		extractedText,
		draftAbstract,
	};
}

async function main(): Promise<void> {
	const inputDir = path.resolve(getArgValue("--input") ?? DEFAULT_INPUT_DIR);
	const outputDir = path.resolve(getArgValue("--output") ?? DEFAULT_OUTPUT_DIR);

	const inputStat = await stat(inputDir);
	if (!inputStat.isDirectory()) {
		throw new Error(`Input path is not a directory: ${inputDir}`);
	}

	await rm(outputDir, { recursive: true, force: true });
	await mkdir(outputDir, { recursive: true });

	const fileNames = (await readdir(inputDir))
		.filter((entry) => entry.toLowerCase().endsWith(".pdf"))
		.sort((left, right) => left.localeCompare(right));

	if (fileNames.length === 0) {
		throw new Error(`No PDFs found in ${inputDir}`);
	}

	const records: ArchiveRecord[] = [];
	for (const fileName of fileNames) {
		records.push(await processPdf(inputDir, outputDir, fileName));
		console.log(`Prepared ${fileName}`);
	}

	await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(records, null, 2), "utf8");
	console.log(`Prepared ${records.length} archive PDFs into ${outputDir}`);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});