/**
 * Chip colours. Same hash as the pre-link chips so a subject keeps its colour
 * when it becomes a link.
 */

function hashString(input: string): number {
	let hash = 2166136261;
	for (const char of input) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function subjectChipStyle(subject: string): string {
	const hash = hashString(subject.toLowerCase().trim());
	const hue = hash % 360;
	const saturation = 62 + (hash % 14);
	const lightness = 90 - (hash % 8);
	const borderLightness = 46 - (hash % 8);
	const textLightness = 28 - (hash % 6);
	const bg = `hsl(${hue} ${saturation}% ${lightness}%)`;
	const border = `hsl(${hue} ${Math.max(45, saturation - 12)}% ${borderLightness}%)`;
	const text = `hsl(${hue} ${Math.max(40, saturation - 18)}% ${textLightness}%)`;
	return `--subject-chip-bg: ${bg}; --subject-chip-border: ${border}; --subject-chip-text: ${text};`;
}
