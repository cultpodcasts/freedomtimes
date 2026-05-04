import {
	DETAILS_CLOSE_PATTERN,
	parseDetailsSummary,
	normalizeTagLine,
	TRANSLATE_DETAILS_OPEN_PATTERN,
} from './translateDetails';

export type ProcessedPortableNode =
	| { type: 'portable'; value: unknown[] }
	| { type: 'details'; summary: string; value: unknown[] };

export type LegacyContentBlock =
	| { type: 'heading'; level: 2 | 3 | 4; text: string }
	| { type: 'paragraph'; text: string }
	| { type: 'details'; summary: string; text: string }
	| { type: 'video'; value: Record<string, unknown> }
	| { type: 'audio'; value: Record<string, unknown> };

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function plainTextFromPortableBlock(block: unknown): string | null {
	if (!block || typeof block !== 'object') {
		return null;
	}
	const record = block as Record<string, unknown>;

	if (record._type === 'block' && Array.isArray(record.children)) {
		const text = record.children
			.map((child) => {
				if (!child || typeof child !== 'object') {
					return '';
				}
				return readString((child as Record<string, unknown>).text) ?? '';
			})
			.join('')
			.trim();
		return text.length > 0 ? text : '';
	}

	const directText = readString(record.text) ?? readString(record.value);
	if (directText) {
		return directText;
	}

	if (Array.isArray(record.children)) {
		const text = record.children
			.map((child) => {
				if (typeof child === 'string') {
					return child;
				}
				if (!child || typeof child !== 'object') {
					return '';
				}
				const childRecord = child as Record<string, unknown>;
				return readString(childRecord.text) ?? readString(childRecord.value) ?? '';
			})
			.join('')
			.trim();
		return text.length > 0 ? text : '';
	}

	const strings: string[] = [];
	const collectStrings = (value: unknown, depth = 0) => {
		if (depth > 6 || value == null) {
			return;
		}
		if (typeof value === 'string') {
			const trimmed = value.trim();
			if (trimmed) {
				strings.push(trimmed);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) {
				collectStrings(item, depth + 1);
			}
			return;
		}
		if (typeof value === 'object') {
			for (const nested of Object.values(value as Record<string, unknown>)) {
				collectStrings(nested, depth + 1);
			}
		}
	};
	collectStrings(record);
	if (strings.length > 0) {
		return strings.join(' ');
	}

	return null;
}

function isDetailsClosingBlock(block: unknown): boolean {
	const innerText = normalizeTagLine(plainTextFromPortableBlock(block));
	if (!innerText) {
		return false;
	}
	const collapsed = innerText.toLowerCase().replace(/\s+/g, '');
	return (
		DETAILS_CLOSE_PATTERN.test(innerText)
		|| collapsed.includes('</details>')
		|| collapsed.includes('<\\/details>')
	);
}

export function buildPortableRenderNodes(value: unknown[] | null): ProcessedPortableNode[] {
	if (!value || value.length === 0) {
		return [];
	}
	const nodes: ProcessedPortableNode[] = [];
	let portableBuffer: unknown[] = [];

	const flushPortable = () => {
		if (portableBuffer.length > 0) {
			nodes.push({ type: 'portable', value: portableBuffer });
			portableBuffer = [];
		}
	};

	for (let i = 0; i < value.length; i++) {
		const node = value[i];
		const text = normalizeTagLine(plainTextFromPortableBlock(node));
		const lowerText = text.toLowerCase();
		const isTranslateOpen = text ? TRANSLATE_DETAILS_OPEN_PATTERN.test(text) : false;
		if (isTranslateOpen) {
			const summaryFromCurrent = parseDetailsSummary(text);
			const summaryCandidateRaw = i + 1 < value.length ? plainTextFromPortableBlock(value[i + 1]) : null;
			const summary = summaryFromCurrent ?? parseDetailsSummary(summaryCandidateRaw);
			if (!summary) {
				portableBuffer.push(node);
				continue;
			}

			const detailsBody: unknown[] = [];
			let foundClose = false;
			let j = i + 2;
			// Closing `</details>` must be its own PT block (plain text). Without it, the
			// open/summary/body lines render as literal paragraphs instead of <details>.
			while (j < value.length) {
				if (isDetailsClosingBlock(value[j])) {
					foundClose = true;
					break;
				}
				detailsBody.push(value[j]);
				j++;
			}
			if (!foundClose) {
				portableBuffer.push(node);
				continue;
			}

			flushPortable();
			nodes.push({
				type: 'details',
				summary: summary || 'Show translation',
				value: detailsBody,
			});
			i = j;
			continue;
		}
		portableBuffer.push(node);
	}

	flushPortable();
	return nodes;
}

export function parseLegacyTextContent(value: string): LegacyContentBlock[] {
	const blocks: LegacyContentBlock[] = [];
	const lines = value.split('\n');
	const videoPattern = /^<!--ec:block\s+(\{.*\})\s+-->$/;
	let paragraphBuffer: string[] = [];
	let inDetails = false;
	let detailsSummary = '';
	let detailsBuffer: string[] = [];

	const flushParagraph = () => {
		const text = paragraphBuffer.join(' ').trim();
		if (text.length > 0) {
			blocks.push({ type: 'paragraph', text });
		}
		paragraphBuffer = [];
	};

	const flushDetails = () => {
		const text = detailsBuffer.join(' ').trim();
		blocks.push({
			type: 'details',
			summary: detailsSummary.trim() || 'Show translation',
			text,
		});
		inDetails = false;
		detailsSummary = '';
		detailsBuffer = [];
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		const normalizedLine = normalizeTagLine(line);

		if (inDetails) {
			if (!line) {
				detailsBuffer.push('');
				continue;
			}
			if (DETAILS_CLOSE_PATTERN.test(normalizedLine)) {
				flushDetails();
				continue;
			}
			const summary = parseDetailsSummary(normalizedLine);
			if (summary) {
				detailsSummary = summary;
				continue;
			}
			detailsBuffer.push(line);
			continue;
		}

		if (!line) {
			flushParagraph();
			continue;
		}

		if (TRANSLATE_DETAILS_OPEN_PATTERN.test(normalizedLine)) {
			flushParagraph();
			inDetails = true;
			detailsSummary = '';
			detailsBuffer = [];
			continue;
		}

		const videoMatch = line.match(videoPattern);
		if (videoMatch) {
			flushParagraph();
			try {
				const parsed = JSON.parse(videoMatch[1]);
				if (parsed && typeof parsed === 'object') {
					const t = (parsed as Record<string, unknown>)._type;
					if (t === 'video') {
						blocks.push({ type: 'video', value: parsed as Record<string, unknown> });
						continue;
					}
					if (t === 'audio') {
						blocks.push({ type: 'audio', value: parsed as Record<string, unknown> });
						continue;
					}
				}
			} catch {
				// Fall through to paragraph mode if parsing fails.
			}
		}

		const headingMatch = line.match(/^(#{2,4})\s+(.+)$/);
		if (headingMatch) {
			flushParagraph();
			const level = headingMatch[1].length as 2 | 3 | 4;
			blocks.push({ type: 'heading', level, text: headingMatch[2].trim() });
			continue;
		}

		paragraphBuffer.push(line);
	}

	if (inDetails) {
		flushDetails();
	}

	flushParagraph();
	return blocks;
}
