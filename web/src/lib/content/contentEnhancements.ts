function trimLinkWhitespace(root: ParentNode): void {
	const contentLinks = root.querySelectorAll('a');
	for (const link of contentLinks) {
		const first = link.firstChild;
		if (first && first.nodeType === Node.TEXT_NODE) {
			first.textContent = (first.textContent ?? '').replace(/^\s+/, '');
		}
		const last = link.lastChild;
		if (last && last.nodeType === Node.TEXT_NODE) {
			last.textContent = (last.textContent ?? '').replace(/\s+$/, '');
		}
	}
}

function parseSummaryText(raw: string): string | null {
	const match = raw.match(/<summary(?:\s+[^>]*)?>(?:<strong>)?(.+?)(?:<\/strong>)?<\/summary>/i);
	if (match) {
		return match[1].trim();
	}
	return raw.toLowerCase().includes('show english translation') ? 'Show English translation' : null;
}

function upgradeTranslateDetailsBlocks(root: ParentNode): void {
	const contentRoots = root.querySelectorAll<HTMLElement>('.portable-content, .legacy-content');
	for (const contentRoot of contentRoots) {
		const nodes = Array.from(contentRoot.children) as HTMLElement[];
		for (let i = 0; i < nodes.length; i++) {
			const openNode = nodes[i];
			const openText = (openNode.textContent ?? '').trim().toLowerCase();
			const isOpen =
				openText.includes('<details')
				&& openText.includes('translate')
				&& openNode.tagName.toLowerCase() === 'p';
			if (!isOpen) {
				continue;
			}

			const summaryNode = nodes[i + 1];
			if (!summaryNode) {
				continue;
			}
			const summaryText = parseSummaryText((summaryNode.textContent ?? '').trim());
			if (!summaryText) {
				continue;
			}

			const bodyNodes: HTMLElement[] = [];
			let closeIndex = -1;
			for (let j = i + 2; j < nodes.length; j++) {
				const candidate = nodes[j];
				const text = (candidate.textContent ?? '').trim().toLowerCase();
				if (text.includes('</details')) {
					closeIndex = j;
					break;
				}
				bodyNodes.push(candidate);
			}
			if (closeIndex === -1) {
				continue;
			}

			const details = document.createElement('details');
			details.className = 'legacy-details translation';
			const summary = document.createElement('summary');
			summary.textContent = summaryText;
			details.appendChild(summary);
			for (const bodyNode of bodyNodes) {
				details.appendChild(bodyNode);
			}

			openNode.replaceWith(details);
			summaryNode.remove();
			nodes[closeIndex]?.remove();

			i = closeIndex;
		}
	}
}

function initSlideshows(root: ParentNode): void {
	const slideshows = root.querySelectorAll('[data-slideshow]');
	for (const slideshow of slideshows) {
		const slides = Array.from(slideshow.querySelectorAll<HTMLElement>('[data-slide]'));
		if (slides.length === 0) {
			continue;
		}

		const prev = slideshow.querySelector<HTMLButtonElement>('.slide-nav.prev');
		const next = slideshow.querySelector<HTMLButtonElement>('.slide-nav.next');
		const status = slideshow.querySelector<HTMLElement>('[data-slide-current]');
		let current = 0;

		const render = () => {
			slides.forEach((slide, index) => {
				slide.classList.toggle('is-active', index === current);
			});
			if (status) {
				const currentSlide = slides[current];
				const pageNumber = currentSlide?.dataset.pageNumber;
				status.textContent = pageNumber ?? String(current + 1);
			}
		};

		prev?.addEventListener('click', (event) => {
			event.preventDefault();
			current = (current - 1 + slides.length) % slides.length;
			render();
		});

		next?.addEventListener('click', (event) => {
			event.preventDefault();
			current = (current + 1) % slides.length;
			render();
		});

		render();
	}
}

export function initContentEnhancements(rootSelector = '.content-card'): void {
	const contentRoot = document.querySelector(rootSelector);
	if (!contentRoot) {
		return;
	}

	upgradeTranslateDetailsBlocks(contentRoot);
	trimLinkWhitespace(contentRoot);
	initSlideshows(contentRoot);
}
